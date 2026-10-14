import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as googleTTS from 'google-tts-api';
import cloudTts from '@google-cloud/text-to-speech';
import { segmentForSynthesis, findEnglishTerms, aEspanolDeMexico } from './lexicon.js';
import { textoAPronunciableSsml } from './pronunciation.js';
import { getMediaDuration, concatAudioFiles, runFfmpeg } from './mediaProbe.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..', '..');
const audioOutputDir = path.join(projectRoot, 'outputs', 'audio');

if (!fs.existsSync(audioOutputDir)) {
  fs.mkdirSync(audioOutputDir, { recursive: true });
}

// ─── Catálogo de voces ───────────────────────────────────────────────────────
//
// Todas las voces son MULTILINGÜES de Microsoft (Ava / Andrew / Emma): voces
// neuronales capaces de hablar varios idiomas conservando EXACTAMENTE el mismo
// timbre. Edge TTS exige xml:lang en el elemento <voice>, así que synthOnce
// siempre lo envía, y por eso una sola voz puede pasar de español a inglés
// (y a términos en inglés) sin que cambie el timbre.
//
// Eso resuelve un problema real: si el español se sintetiza con una voz es-MX y
// el inglés con una en-US, al pronunciar "PlayStation" el timbre cambiaba a
// mitad de frase y se oía como dos personas distintas.
//
// La prosodia se define POR MODO, no por voz: el guion marca cada fragmento
// con [[GRITO]] / [[GIR]] y el TTS aplica el registro correspondiente. Siempre
// se usa la MISMA voz base; lo que cambia es el tono y el ritmo, que es lo que
// produce el contraste entre personajes.
//
//   locucion - lectura de la noticia, como leyendo un instructivo emocionado
//   grito    - energía máxima, para el saludo inicial y las exclamaciones
//   gir      - el tropiezo del personaje: tono muy alto y ritmo lento

// ─── Prosodia por registro ───────────────────────────────────────────────────
//
// LECCIÓN IMPORTANTE: subir el ritmo NO da energía, da apuro. Una locución a
// +26% se oye como si alguien la estuviera apresurando, que es justo lo que
// había que evitar. La energía de un personaje de caricatura viene de:
//   1. pausas (silencio real antes del remate)
//   2. énfasis (frases finales más lentas y más altas)
//   3. contraste de tono entre frases
//
// Por eso el ritmo base es modesto (+8%) y la energía se construye con las
// pausas y el énfasis, que se aplican más abajo.
//
//   locucion - lectura del dato, natural y ágil
//   grito    - más fuerte y agudo, NO más rápido
//   gir      - mismo tono que la locución, solo más bajo (habla consigo mismo)

const MODES = {
  locucion: { pitch: '+50Hz', rate: '+8%', volume: '+8%' },
  grito: { pitch: '+72Hz', rate: '+14%', volume: '+32%' },
  gir: { pitch: '+50Hz', rate: '+8%', volume: '-22%' }
};

const MODES_SOFT = {
  locucion: { pitch: '+34Hz', rate: '+4%', volume: '+6%' },
  grito: { pitch: '+48Hz', rate: '+10%', volume: '+24%' },
  gir: { pitch: '+34Hz', rate: '+4%', volume: '-22%' }
};

/**
 * Modificadores por tipo de frase. Esto es lo que da la interpretación: una
 * locución plana es siempre igual de rápida y siempre al mismo tono; un
 * personaje cambia.
 */
const FRASE = {
  normal: { pitchShift: 0, rateFactor: 1.0, volumeFactor: 1.0 },
  // Frase con exclamación o palabra repetida ("¡TAQUIIIITO!"): más energía.
  exaltada: { pitchShift: '+6Hz', rateFactor: 1.0, volumeFactor: 1.25 },
  // Frase con interrogación: subir un poco, como pregunta retórica.
  pregunta: { pitchShift: '+3Hz', rateFactor: 0.96, volumeFactor: 1.05 },
  // Última frase del fragmento = el remate: se ALARGA y se sube.
  remate: { pitchShift: '+8Hz', rateFactor: 0.72, volumeFactor: 1.2 }
};

/** Pausas en milisegundos antes de cada tipo de unidad. */
const PAUSA = {
  dentroDeFrase: 70,    //Continuidad dentro de la misma frase (cambio de idioma)
  entreFrases: 165,     // punto y seguido
  antesDeAside: 400,    // antes de que GIR hable consigo mismo
  antesDeGrito: 330,
  entreFragmentos: 150
};

/**
 * Divide un fragmento en frases, conservando los signos de puntuación para que
 * la síntesis respire igual que está escrito.
 *
 * No reconstruye el texto original byte a byte (a diferencia de la segmentación
 * por idioma), y no hace falta: los subtítulos se construyen a partir de los
 * word boundaries que devuelve Edge, no del texto.
 */
function splitSentences(text) {
  if (!text || !text.trim()) return [];

  // Corte después de . ! ? … seguidos de espacio y una letra o signo de apertura.
  const partes = String(text)
    .split(/(?<=[.!?…])\s+(?=[\p{L}¡¿"'(\[])/u)
    .map(s => s.trim())
    .filter(Boolean);

  // Si una "frase" sigue siendo muy larga, se parte por comas para poder
  // respirar en algún punto.
  const finales = [];
  for (const p of partes) {
    if (p.length <= 120) {
      finales.push(p);
      continue;
    }
    finales.push(...p.split(/,\s+/).map(s => s.trim()).filter(Boolean));
  }
  return finales.length > 0 ? finales : [text.trim()];
}

/** Clasifica una frase para elegir su modificador interpretativo. */
function clasificarFrase(texto, cierraFrase) {
  const t = texto.trim();
  const tieneExclamacion = /!/.test(t);
  const exclamacionLarga = /!{2,}/.test(t) || /([a-záéíóú]{3,})\1{2,}/i.test(t);

  let tipo = 'normal';
  if (tieneExclamacion || exclamacionLarga) tipo = 'exaltada';
  else if (t.includes('?')) tipo = 'pregunta';
  else if (cierraFrase) tipo = 'remate';

  return { tipo };
}

// ─── Tinte de robot ──────────────────────────────────────────────────────────
//
// Subir el tono a una voz no la vuelve "robot de caricatura": solo la hace más
// aguda. El carácter de altavoz/TV robot viene de adelgazar el timbre y darle
// resonancias de altavoz pequeño. Estas cadenas se midieron sobre voz real: la
// relación graves/agudos pasa de -8,5 dB (voz natural, grave) a -2,8 dB (robot),
// es decir +5,7 dB de brillo, que es un cambio audible y medible.
//
//   highpass   -> quita el cuerpo/grave, deja la voz fina
//   treble     -> brillo y "filo" de altavoz
//   aecho      -> resonancias comb = caja acústica pequeña (el "TV" de GIR)
//   acompressor-> iguala la dinámica para que el robot no sature
//
// NOTA: aecho añade una cola de ~70 ms al final de cada fragmento. Por eso el
// offset del siguiente tramo se mide DESPUÉS de aplicar el filtro (ver más abajo
// en textToSpeech), de modo que los subtítulos no se desincronizan.
const TIMBRE_ROBOT = 'highpass=f=280,treble=g=6,aecho=0.9:0.7:14|38|76:0.32|0.22|0.14,acompressor=threshold=-18dB:ratio=3';
const TIMBRE_ROBOT_SUAVE = 'treble=g=3,aecho=0.9:0.8:12|30:0.18|0.12';
const TIMBRE_ROBOT_FUERTE = 'highpass=f=380,treble=g=9,aecho=0.92:0.75:11|29|55|95:0.38|0.26|0.18|0.11,acompressor=threshold=-20dB:ratio=4';

// Voces base. Las tres son multilingües: el timbre nunca cambia.
const AVA = 'en-US-AvaMultilingualNeural';
const ANDREW = 'en-US-AndrewMultilingualNeural';
const EMMA = 'en-US-EmmaMultilingualNeural';

// ── Voces ────────────────────────────────────────────────────────────────────
export const AVAILABLE_VOICES = [
  {
    id: 'robot-gir',
    name: '🤖 GIR · Clásico (robot de caricatura)',
    voiceKey: AVA,
    timbre: TIMBRE_ROBOT,
    pitch: '+52Hz',
    rate: '+12%',
    modes: MODES,
    default: true
  },
  {
    id: 'robot-gir-fuerte',
    name: '🤖 GIR · Muy robot (más caricatura)',
    voiceKey: AVA,
    timbre: TIMBRE_ROBOT_FUERTE,
    pitch: '+58Hz',
    rate: '+16%',
    modes: {
      locucion: { pitch: '+58Hz', rate: '+12%', volume: '+12%' },
      grito: { pitch: '+76Hz', rate: '+18%', volume: '+34%' },
      gir: { pitch: '+58Hz', rate: '+12%', volume: '-22%' }
    }
  },
  {
    id: 'robot-gir-suave',
    name: '🤖 GIR · Suave (menos chillón)',
    voiceKey: AVA,
    timbre: TIMBRE_ROBOT_SUAVE,
    pitch: '+34Hz',
    rate: '+16%',
    modes: MODES_SOFT
  },
  {
    id: 'robot-gir-atleta',
    name: '🤖 GIR · Atleta (voz masculina, robot)',
    voiceKey: ANDREW,
    timbre: TIMBRE_ROBOT,
    pitch: '+56Hz',
    rate: '+12%',
    modes: {
      locucion: { pitch: '+56Hz', rate: '+10%', volume: '+10%' },
      grito: { pitch: '+74Hz', rate: '+16%', volume: '+30%' },
      gir: { pitch: '+56Hz', rate: '+10%', volume: '-22%' }
    }
  },

  // ── Voces HUMANAS (mismo timbre en español e inglés) ────────────────────
  {
    id: 'humana-femenina',
    name: '🗣️ Humana Femenina (natural)',
    voiceKey: AVA,
    timbre: null,
    pitch: 'default',
    rate: 'default'
  },
  {
    id: 'humana-masculina',
    name: '🗣️ Humana Masculina (natural)',
    voiceKey: ANDREW,
    timbre: null,
    pitch: 'default',
    rate: 'default'
  },
  {
    id: 'humana-calida',
    name: '🗣️ Humana Cálida (Emma, tono suave)',
    voiceKey: EMMA,
    timbre: null,
    pitch: 'default',
    rate: 'default'
  }
];

export const DEFAULT_VOICE_ID = 'robot-gir';

/**
 * Traduce el volumen de la prosodia a una ganancia lineal para ffmpeg.
 *
 * Por qué NO usamos <prosody volume> de SSML: medido, no funcionaba de forma
 * fiable. La cadena de robot incluye un acompressor que normaliza la dinámica,
 * así que subir el volumen en la síntesis se cancelaba (el registro GRITO queda
 * 0,1 dB más fuerte que LOCUCION, es decir nada). Aplicando la ganancia DESPUÉS
 * del compresor el resultado es exacto y medible.
 *
 *   volume="-22%"  ->  0.78   (GIR murmurando)
 *   volume="+32%"  ->  1.32   (GIR gritando)
 *
 * Ojo: esta función convierte PORCENTAJE -> GANANCIA. Para aplicar el matiz de
 * frase hay que multiplicar la ganancia resultante, no el porcentaje (ver el
 * bucle de síntesis), porque con volúmenes negativos multiplicar el porcentaje
 * invierte el sentido del énfasis.
 */
function gainFromProsody(prosody) {
  const v = prosody?.volume;
  if (!v || v === 'default') return null;

  const keywords = {
    'x-soft': 0.35, 'soft': 0.6, 'medium': 1.0,
    'loud': 1.4, 'x-loud': 1.8
  };
  if (keywords[v] !== undefined) return keywords[v];

  const m = String(v).match(/^([+-]?)(\d+(?:\.\d+)?)%$/);
  if (m) {
    const n = parseFloat(m[2]) / 100;
    return m[1] === '-' ? (1 - n) : (1 + n);
  }
  return null;
}

/**
 * Resuelve la prosodia (tono/ritmo/volumen) para un modo de narración dado.
 * Las voces humanas no tienen modos: siempre usan el registro natural.
 */
function prosodyFor(voiceConfig, mode) {
  if (voiceConfig.modes && voiceConfig.modes[mode]) return voiceConfig.modes[mode];
  if (mode === 'locucion') {
    return {
      pitch: voiceConfig.pitch && voiceConfig.pitch !== 'default' ? voiceConfig.pitch : 'default',
      rate: voiceConfig.rate && voiceConfig.rate !== 'default' ? voiceConfig.rate : 'default',
      volume: voiceConfig.volume && voiceConfig.volume !== 'default' ? voiceConfig.volume : 'default'
    };
  }
  // Modo grito/gir en voz humana: se aplica como si fuera locución.
  return prosodyFor(voiceConfig, 'locucion');
}

/**
 * Sintetiza un único fragmento de texto con una voz y una prosodia concretas.
 * Devuelve los tiempos de palabra (en segundos, locales al fragmento).
 *
 * Valida que el MP3 escrito sea utilizable: si el segmento sale vacío, reintenta
 * y, como último recurso, lo sintetiza con la voz principal para no perder los
 * tiempos de palabra (que son los que sostienen la sincronía de subtítulos).
 */
/**
 * ── Cloud Text-to-Speech como motor de respaldo ────────────────────────────
 *
 * ── Por qué existe ────────────────────────────────────────────────────────
 * Edge TTS (msedge-tts) es un servicio NO oficial de Microsoft. El 12 de
 * octubre de 2026 empezó a devolver 403 desde Cloud Run en todos los
 * segmentos, y con Edge caído el pipeline se quedó sin voz.
 *
 * Cloud TTS es la API oficial de Google: nunca la pueden cortar un martes por
 * la tarde. Cuesta dinero, pero SOLO se llega aquí si Edge falló, así que
 * mientras Microsoft siga sirviendo el servicio gratuito no se paga nada.
 *
 * ── Tres limitaciones de esta API que el código tiene que esquivar ─────────
 *
 * 1. NO da tiempos de palabra. No existe ningún campo para pedirlos (ni en v1
 *    ni en v1beta1): el campo que la documentación sugiere, "includeWordTime-
 *    Offsets", la API responde "Unknown name ... Cannot find field". Los
 *    tiempos por palabra SÍ existen, pero solo en synthesizeLongAudio, que
 *    exige un archivo de salida en GCS y tarda minutos.
 *    Para algo de 30 segundos por fragmento es inviable.
 *
 *    La salida que sí hay: `enableTimePointing: "SSML_MARK"` con etiquetas
 *    <mark> en el SSML, que devuelve un timeSeconds por marca. Eso es lo que
 *    se usa aquí, y de ahí salen los tiempos de los subtítulos.
 *
 * 2. Polyglot-1 solo devuelve la PRIMERA marca de cada frase (comprobado: con
 *    6 palabras seguidas sale 1 solo tiempo). Con marcas separadas dentro de
 *    la misma <prosody> sí devuelve varias (comprobado: 2 de 2). Por eso cada
 *    frase se pide por separado: una marca al principio y otra al final, y con
 *    dos frases consecutivas ya se obtienen todos los instantes que hacen
 *    falta para colocar cada palabra entre medio.
 *
 * 3. El límite por llamada son 200 caracteres de SSML. Los fragmentos llegan
 *    a 900+, así que además hay que trocear por palabras.
 *
 * ── Sobre la voz ──────────────────────────────────────────────────────────
 * Cloud TTS no tiene voces es-MX (solo es-US y es-ES) ni las multilingües de
 * Edge. La equivalencia es `Polyglot-1`, que fue creada justamente para hablar
 * muchos idiomas con el MISMO timbre: reproduce el motivo por el que en su día
 * se eligieron las voces multilingües de Edge, así que al pasar a inglés la
 * voz no cambia. El guion sigue siendo mexicano (lo normaliza lexicon.js); lo
 * único que cambia es el acento con el que Cloud TTS lo pronuncia.
 */
const VOZ_CLOUD = {
  ES: 'es-US-Polyglot-1',
  EN: 'en-US-Polyglot-1',
};

/** Elige la voz de Cloud según el idioma del fragmento. */
function vozCloud(lang) {
  return String(lang || '').toLowerCase().startsWith('en') ? VOZ_CLOUD.EN : VOZ_CLOUD.ES;
}

/**
 * Token de acceso de la cuenta de servicio de la instancia de Cloud Run.
 *
 * Se pide a la metadata del servidor en vez de usar la librería de Google para
 * no arrastrar gRPC y el resto de dependencias: lo único que hace falta es un
 * portador de OAuth para la API de TTS.
 *
 * ── Por qué no vale con el cliente de la librería ──────────────────────────
 * Porque el campo que devuelve los tiempos de palabra (`enableTimePointing`)
 * solo existe en v1beta1, y el cliente de Node habla v1. Se podría subir la
 * librería a v1beta1 con una opción, pero entonces el resto del proyecto
 * hereda un cliente distinto; unas pocas líneas de fetch son más baratas de
 * mantener que un cliente duplicado.
 *
 * El token caduca a los 55 minutos, así que se cachea y se reutiliza. Un
 * fragmento de video hace unas 30 llamadas seguidas, así que sin cachear se
 * pediría un token nuevo para cada una.
 */
let tokenCache = { valor: null, expira: 0 };

async function tokenDeCloudRun() {
  const ahora = Date.now();
  if (tokenCache.valor && ahora < tokenCache.expira) return tokenCache.valor;

  const meta = process.env.GCE_METADATA_HOST || 'metadata.google.internal';
  const r = await fetch(
    `http://${meta}/computeMetadata/v1/instance/service-accounts/default/token`,
    { headers: { 'Metadata-Flavor': 'Google' } }
  );
  if (!r.ok) throw new Error('No se pudo obtener token de la cuenta de servicio: HTTP ' + r.status);

  const j = await r.json();
  // Se le restan 5 minutos de margen: si el token muere a mitad de un lote de
  // llamadas, las siguientes fallan con un 401 y el segmento entero se cae.
  tokenCache = { valor: j.access_token, expira: ahora + (j.expires_in - 300) * 1000 };
  return tokenCache.valor;
}

/** Escapa texto para poder meterlo dentro de SSML. */
function escSsml(t) {
  return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Divide en frases por signos de puntuación, respetando el orden. */
function frasesDe(texto) {
  const partes = String(texto)
    .split(/(?<=[.!?;:,])\s+/u)
    .map((s) => s.trim())
    .filter(Boolean);
  return partes.length ? partes : [String(texto).trim()];
}

/**
 * Pide UNA frase a Cloud TTS envuelta en marcas y devuelve el audio y el
 * instante en que empieza y acaba cada palabra.
 *
 * Se hace una llamada por frase a propósito: es lo que garantiza que se
 * obtengan los dos tiempos (inicio y fin) en vez de uno solo. Con ~6 frases por
 * fragmento son 6 llamadas, cada una de microsegundos: la latencia se nota
 * mucho menos que el acierto de los subtítulos.
 */
async function fraseCloud(client, frase, voiceKey, lang, prosody) {
  const palabras = frase.split(/\s+/).filter(Boolean);
  if (!palabras.length) return null;

  // ── Construcción del SSML ────────────────────────────────────────────────
  // Se compone en tres capas, de fuera adentro:
  //
  //   <speak><prosody rate=... pitch=...>   ritmo y tono (mismo control que
  //                                          llevaba Edge con su <prosody>)
  //     <mark name="ini">primera palabra</mark>
  //     ...resto del texto YA CORREGIDO por pronunciacion.js...
  //     <mark name="fin">última palabra</mark>
  //   </prosody></speak>
  //
  // El módulo de pronunciación devuelve un <speak> completo, así que aquí se
  // le quita el envoltorio para poder meter las marcas y la prosodía DENTRO.
  // Es un poco de surgery de cadenas, pero evita que el módulo tenga que saber
  // nada de marcas ni de prosodía: su único trabajo es dejar el texto bien
  // leído, y así se puede probar por separado.
  //
  // Las marcas van sobre la primera y la última palabra ORIGINAL, no sobre el
  // texto corregido. Da igual dónde caigan porque lo que se necesita es el
  // instante en que empieza y acaba la frase, y esos dos puntos están en los
  // extremos del <prosody> se llame como se llame lo que hay en medio.
  const corregido = textoAPronunciableSsml(frase, lang).replace(/^<speak>/, '').replace(/<\/speak>$/, '');
  const ssml =
    '<speak><prosody rate="' + (prosody?.rate || '+0%') +
    '" pitch="' + (prosody?.pitch || '+0Hz') + '">' +
    '<mark name="ini">' + escSsml(palabras[0]) + '</mark>' +
    corregido +
    '<mark name="fin">' + escSsml(palabras.at(-1)) + '</mark>' +
    '</prosody></speak>';

  // No se usa client.synthesizeSpeech() a propósito: la librería llama a la
  // API v1, y el campo `enableTimePointing` (el único que devuelve los
  // tiempos) SOLO existe en v1beta1. Con la librería, el audio salía pero
  // timepoints venía siempre vacío.
  //
  // Se autentica con la cuenta de servicio de la instancia de Cloud Run, que
  // ya está en la metadata: es lo mismo que haría la librería, pero contra
  // la versión de la API que devuelve lo que hace falta.
  const token = await tokenDeCloudRun();
  const resp = await fetch(
    'https://texttospeech.googleapis.com/v1beta1/text:synthesize',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token,
      },
      body: JSON.stringify({
        input: { ssml },
        // El languageCode es solo el idioma ('es-us' / 'en-us'), NO el nombre
        // de la voz. Cloud TTS los compara en minúsculas y rechaza si no
        // cuadran, y además rechaza la voz si el idioma no es el suyo.
        voice: { languageCode: voiceKey.slice(0, 5).toLowerCase(), name: voiceKey },
        audioConfig: { audioEncoding: 'MP3', sampleRateHertz: 24000 },
        enableTimePointing: 'SSML_MARK',
      }),
    }
  );

  if (!resp.ok) {
    const detalle = await resp.text().catch(() => '');
    throw new Error('HTTP ' + resp.status + ': ' + detalle.slice(0, 220));
  }

  const json = await resp.json();
  const audioContent = Buffer.from(json.audioContent || '', 'base64');
  if (!audioContent.length) throw new Error('audio vacío');

  const tp = json.timepoints || [];
  // Registro breve: si algún día Cloud deja de devolver los tiempos, el log
  // dice de inmediato si vinieron vacíos o si llegaron con otro nombre, en vez
  // de tener que deducirlo de un "sin marca de inicio".
  if (process.env.DEBUG_TTS === '1' || !tp.length) {
    console.log(`🔎 TTS cloud: ${tp.length} timepoints · claves=${Object.keys(json).join(',')} · ssml=${ssml.length} car.`);
  }
  const ini = tp.find((t) => t.markName === 'ini');
  const fin = tp.find((t) => t.markName === 'fin');
  if (!ini) throw new Error('sin marca de inicio');

  // Cloud TTS no da el final de la última palabra cuando la marca cae justo en
  // el final del audio, así que se usa la duración real del MP3.
  const dur = await duracionMp3(audioContent);
  const finFrase = fin ? fin.timeSeconds : (dur != null ? dur : ini.timeSeconds);

  // Las palabras intermedias se reparten a lo largo del hueco entre las dos
  // marcas, PONDERADAS POR LONGITUD. Es una estimación, pero es la misma que
  // haría cualquierEstimateador de velocidad de lectura constante, y en
  // español la longitud predice el tiempo bastante bien. Lo que importa para
  // que el subtítulo cuadre es que la frase ENTERA empieza y acaba en el
  // instante correcto, y eso sí es medido, no estimado.
  const totalChars = palabras.reduce((n, w) => n + w.length, 0) || 1;
  const span = Math.max(0.01, finFrase - ini.timeSeconds);
  const boundaries = [];
  let usado = 0;
  for (let i = 0; i < palabras.length; i++) {
    const w = palabras[i];
    const inicioRel = (usado / totalChars) * span;
    usado += w.length;
    const finRel = (usado / totalChars) * span;
    boundaries.push({
      start: ini.timeSeconds + inicioRel,
      end: ini.timeSeconds + finRel,
      word: w,
    });
  }
  // La última cierra exactamente en la marca final, para que no quede un hueco
  // entre el fin del subtítulo y el principio del siguiente.
  if (boundaries.length) {
    boundaries.at(-1).end = finFrase;
    boundaries[0].start = ini.timeSeconds;
  }

  return { audio: audioContent, boundaries };
}

/**
 * Sintetiza UN fragmento con Cloud TTS y devuelve los tiempos de palabra.
 *
 * El contrato es el mismo que devuelve synthOnce (Edge), así que quien llama
 * no se entera de qué motor se usó: mismo archivo, mismo array de
 * wordBoundaries con {start, end, word} en segundos.
 */
async function synthSegmentCloud(text, outPath, voiceKey, prosody, lang) {
  const client = new cloudTts.TextToSpeechClient();
  const cloudVoice = vozCloud(lang);

  // Límite por llamada. El SSML envuelto (marcas + prosody) suma caracteres, de
  // ahí el margen sobre 200: las marcas valen por 2 palabras, pero no的一条
  // línea vacía.
  const LIMITE = 180;

  // Se trocea por palabras: cortar en mitad de una palabra parte la sílaba en
  // dos y además deja el tiempo de esa palabra mal medido.
  const trozos = [];
  let actual = [];
  let largo = 0;
  for (const palabra of String(text).split(/\s+/).filter(Boolean)) {
    if (largo + palabra.length + 1 > LIMITE && actual.length) {
      trozos.push(actual.join(' '));
      actual = [];
      largo = 0;
    }
    actual.push(palabra);
    largo += palabra.length + 1;
  }
  if (actual.length) trozos.push(actual.join(' '));
  if (!trozos.length) trozos.push(String(text));

  const pieces = [];
  const boundaries = [];
  let offset = 0;

  for (const trozo of trozos) {
    for (const frase of frasesDe(trozo)) {
      const r = await fraseCloud(client, frase, cloudVoice, lang, prosody);
      if (!r) continue;
      pieces.push(r.audio);
      for (const b of r.boundaries) {
        boundaries.push({ ...b, start: b.start + offset, end: b.end + offset });
      }
      const dur = await duracionMp3(r.audio);
      offset += dur != null ? dur : 0;
    }
  }

  if (!pieces.length) throw new Error('Cloud TTS no devolvió audio');

  // MP3 se concatena byte a byte y sigue siendo reproducible: cada fragmento
  // lleva su propio encabezado. Unirlo con ffmpeg aquí sería lentísimo para
  // algo tan simple.
  fs.writeFileSync(outPath, Buffer.concat(pieces));

  if (!boundaries.length) throw new Error('Cloud TTS no devolvió tiempos de palabra');

  return {
    success: true,
    filePath: outPath,
    filename: path.basename(outPath),
    url: '/audio/' + path.basename(outPath),
    engine: 'cloud-tts',
    voice: cloudVoice,
    wordBoundaries: boundaries,
  };
}

/**
 * Duración de un MP3 en segundos.
 *
 * Se usa ffprobe porque es el mismo motor que ya usa el resto del proyecto y
 * no hay que estimar a ojo: la duración calculada a ojo es la que descuadra los
 * subtítulos un poco en cada trozo, y basta de acumuladas.
 */
async function duracionMp3(buffer) {
  const tmp = path.join(audioOutputDir, `.dur_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mp3`);
  fs.writeFileSync(tmp, buffer);
  try {
    return await getMediaDuration(tmp);
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
  }
}

async function synthSegment(text, outPath, voiceKey, prosody, lang, fallbackVoiceKey) {
  const MIN_BYTES = 1024;

  // ── Motor 1: Edge TTS, GRATIS ────────────────────────────────────────────
  // Se intenta primero a propósito. Es el servicio que ya usábamos y no cuesta
  // nada. Si Microsoft levanta el bloqueo (el 12/10/2026 empezó a devolver 403
  // desde Cloud Run), aquí vuelve a funcionar y no se cobra un céntimo.
  //
  // Si falla, se pasa a Cloud TTS en el mismo segmento: preferimos un céntimo
  // a no tener video. Ver DEBAJO_DE_ESTE_BLOQUE para el detalle.
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) {
      // Edge no tolera conexiones consecutivas muy rápidas: espera breve.
      await new Promise(r => setTimeout(r, 400 * attempt));
    }
    try {
      const res = await synthOnce(text, outPath, voiceKey, prosody, lang);
      const size = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0;
      if (size >= MIN_BYTES) return res;
      console.warn(`⚠️ Segmento vacío (${size} bytes), reintento ${attempt}/3`);
    } catch (err) {
      console.warn(`⚠️ Segmento falló (${err.message}), reintento ${attempt}/3`);
    }
  }

  // ── Motor 2: Google Cloud TTS, de pago pero oficial ────────────────────
  // Edge falló los 3 intentos, así que este fragmento no tiene voz de otra
  // forma. Aquí se acepta pagar: un céntimo es mejor que un video que no sale.
  // Solo se llega a este motor si Edge falló, que es lo que mantiene el coste a
  // cero mientras Microsoft siga sirviendo el servicio gratuito.
  console.warn('⚠️ Edge TTS no respondió; se usa Cloud TTS (este fragmento sí se cobra).');
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt > 1) await new Promise(r => setTimeout(r, 600 * attempt));
    try {
      const res = await synthSegmentCloud(text, outPath, voiceKey, prosody, lang);
      const size = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0;
      if (size >= MIN_BYTES) return res;
      console.warn(`⚠️ Cloud TTS devolvió audio vacío (${size} bytes), reintento ${attempt}/2`);
    } catch (err) {
      console.warn(`⚠️ Cloud TTS falló (${err.message}), reintento ${attempt}/2`);
    }
  }

  // Degradación elegante: misma voz y mismo timbre, otro registro.
  const fallback = await synthOnce(text, outPath, fallbackVoiceKey || voiceKey, prosody, lang);
  const size = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0;
  if (size < MIN_BYTES) throw new Error(`No se pudo sintetizar un segmento (${size} bytes)`);
  return fallback;
}

/**
 * Construye el SSML de un fragmento.
 *
 * IMPORTANTE: el atributo xml:lang en <voice> no es opcional. Si falta, Edge
 * TTS deja el stream colgado (verificado: el audio nunca termina de llegar).
 * También es lo que permite usar UNA sola voz multilingüe para español e
 * inglés sin que cambie el timbre.
 */
function buildSSML(text, voiceKey, prosody, lang) {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // El volumen NO va aquí: se aplica en ffmpeg (ver gainFromProsody).
  const hasPitch = prosody.pitch && prosody.pitch !== 'default';
  const hasRate = prosody.rate && prosody.rate !== 'default';

  let body = escaped;
  if (hasPitch || hasRate) {
    const attrs = [
      hasPitch ? `pitch="${prosody.pitch}"` : '',
      hasRate ? `rate="${prosody.rate}"` : ''
    ].filter(Boolean).join(' ');
    body = `<prosody ${attrs}>${escaped}</prosody>`;
  }

  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${lang}">` +
    `<voice name="${voiceKey}">${body}</voice></speak>`;
}

async function synthOnce(text, outPath, voiceKey, prosody, lang) {
  const { MsEdgeTTS, OUTPUT_FORMAT } = await import('msedge-tts');
  const tts = new MsEdgeTTS();

  // wordBoundaryEnabled hace que Edge envíe los tiempos EXACTOS de cada palabra.
  // Vienen de la misma síntesis que genera el MP3, así que el subtítulo queda
  // pegado a la voz real (los offsets llegan en unidades de 100 nanosegundos).
  await tts.setMetadata(voiceKey, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3, {
    wordBoundaryEnabled: true
  });

  const streamResult = tts.rawToStream(buildSSML(text, voiceKey, prosody, lang));

  const wordBoundaries = [];
  if (streamResult.metadataStream) {
    streamResult.metadataStream.on('data', (chunk) => {
      try {
        const parsed = JSON.parse(chunk.toString());
        for (const item of parsed.Metadata || []) {
          if (item.Type !== 'WordBoundary') continue;
          const d = item.Data || {};
          const t = d.text || {};
          if (!t.Text) continue;
          const offset = (d.Offset || 0) / 1e7;
          const duration = (d.Duration || 0) / 1e7;
          wordBoundaries.push({ word: t.Text, start: offset, end: offset + duration });
        }
      } catch (_) {
        // Fragmento de metadatos incompleto: se ignora sin romper la síntesis.
      }
    });
    streamResult.metadataStream.on('error', () => {});
  }

  try {
    await new Promise((resolve, reject) => {
      const writable = fs.createWriteStream(outPath);
      streamResult.audioStream.pipe(writable);
      writable.on('finish', resolve);
      writable.on('error', reject);
    });
  } finally {
    // msedge-tts mantiene el WebSocket abierto: hay que cerrarlo o se acumulan.
    try { tts.close(); } catch (_) {}
  }

  wordBoundaries.sort((a, b) => a.start - b.start);
  return { wordBoundaries };
}

/**
 * Genera el audio de un texto.
 *
 * El texto se trocea en dos ejes:
 *  1. TONO: los marcadores [[GRITO]] / [[GIR]] que dejó el guion cambian la
 *     prosodia de cada fragmento (misma voz, registro distinto).
 *  2. IDIOMA: los términos en inglés se sintetizan con una voz inglesa, porque
 *     Edge TTS no permite cambiar el idioma por palabra.
 *
 * Después los fragmentos se unen con ffmpeg, recortando el silencio sobrante de
 * cada uno, y los tiempos de palabra se desplazan para que sigan siendo
 * absolutos sobre el MP3 final (esto es lo que sostiene los subtítulos).
 *
 * @param {string} text
 * @param {string} filename
 * @param {string} voiceId
 */
export async function textToSpeech(text, filename, voiceId = DEFAULT_VOICE_ID) {
  // Red de seguridad: si el guion trae vocabulario de España ("vuestro",
  // "ordenador"), se corrige a mexicano ANTES de sintetizar.
  //
  // Con xml:lang="es-MX" la voz no suena mexicana si el texto es castellano:
  // al topar con una palabra muy marcada cambia el acento. Como los tiempos de
  // palabra se toman de la misma síntesis, los subtítulos quedan sincronizados
  // y con el mismo texto que se oye.
  text = aEspanolDeMexico(text);

  const filePath = path.join(audioOutputDir, filename);
  const voiceConfig =
    AVAILABLE_VOICES.find(v => v.id === voiceId) || AVAILABLE_VOICES[0];

  // UNA sola voz para todo el texto: los términos en inglés se pronuncian con
  // la MISMA voz (cambia xml:lang, no el timbre), de modo que el narrador
  // sigue sonando como la misma persona durante toda la locución.
  const baseVoice = voiceConfig.voiceKey;
  const ES = 'es-MX';
  const EN = 'en-US';
  const langFor = l => (l === 'en' ? EN : ES);

  const segments = segmentForSynthesis(text);
  // Camino rápido: un solo fragmento, sin marcadores y sin tinte de robot que
  // aplicar. Las voces de personaje siempre pasan por el pipeline de filtros.
  const needsSplit = segments.length > 1 || Boolean(voiceConfig.timbre);

  try {
    if (!needsSplit) {
      const mode = segments[0]?.mode || 'locucion';
      const lang = langFor(segments[0]?.lang);
      const { wordBoundaries } = await synthSegment(
        segments[0]?.text || text, filePath, baseVoice, prosodyFor(voiceConfig, mode), lang, baseVoice
      );
      console.log(`🔊 TTS "${filename}": ${wordBoundaries.length} tiempos de palabra (modo: ${mode})`);
      return {
        success: true,
        filePath,
        filename,
        url: '/audio/' + filename,
        engine: 'msedge-tts',
        voice: voiceConfig.name,
        wordBoundaries
      };
    }

    // Camino por frases: cada frase lleva su propia prosodia y las pausas se
    // insertan como silencio real entre ellas.
    const terms = findEnglishTerms(text);
    const modeCount = segments.reduce((acc, s) => {
      acc[s.mode] = (acc[s.mode] || 0) + 1;
      return acc;
    }, {});

    // Unidad de síntesis = una frase dentro de un fragmento de tono.
    // segIndex permite distinguir un corte real de frase de un simple cambio
    // de idioma a mitad de la misma frase (p.ej. "El telescopio [James Webb] lo
    // detecto"): dentro de una misma frase la pausa debe ser mínima, o el
    // término en inglés queda aislado con un hueco artificial.
    const units = [];
    let modoAnterior = null;

    // La señal fiable de "aquá termina una frase" es la puntuación final, no el
    // índice del segmento: un término en inglés ("James Webb") divide el
    // segmento a la mitad de una frase y si no se tiene cuidado se trata como
    // frase completa, con su remate y su pausa artificial.
    const CIERRA_FRASE = /[.!?…]["'»)\]]?\s*$/;

    segments.forEach((seg, segIdx) => {
      const frases = splitSentences(seg.text);
      frases.forEach((frase, idx) => {
        const esUltimaDelSegmento = idx === frases.length - 1;
        const cambioModo = modoAnterior != null && modoAnterior !== seg.mode;

        // ¿La unidad anterior cerró una frase? Si no, seguimos dentro de la misma.
        const previa = units.length ? units[units.length - 1] : null;
        const continuaFrase = previa != null && !CIERRA_FRASE.test(previa.text);

        const cierraFrase = CIERRA_FRASE.test(frase.trim()) && esUltimaDelSegmento;
        const { tipo } = clasificarFrase(frase, cierraFrase);

        let pausa = 0;
        if (units.length > 0) {
          if (continuaFrase) {
            pausa = PAUSA.dentroDeFrase;          // continuidad: casi nada
          } else if (cambioModo) {
            pausa = seg.mode === 'gir' ? PAUSA.antesDeAside
                 : seg.mode === 'grito' ? PAUSA.antesDeGrito
                 : PAUSA.entreFragmentos;
          } else {
            pausa = PAUSA.entreFrases;           // punto entre frases
          }
        }
        if (tipo === 'remate') pausa = Math.max(pausa, 210);

        units.push({ text: frase, mode: seg.mode, lang: seg.lang, tipo, pausa, segIdx });
        modoAnterior = seg.mode;
      });
    });

    console.log(
      `🔊 TTS "${filename}": ${segments.length} fragmentos ` +
      `[${Object.entries(modeCount).map(([m, n]) => `${m}:${n}`).join(' ')}] ` +
      `-> ${units.length} frases` +
      `${terms.length ? ` · inglés: ${terms.join(', ')}` : ''}`
    );

    const stamp = Date.now();
    const pieces = [];
    const allBoundaries = [];
    let offset = 0;
    let pausasTotal = 0;

    // Inserta N ms de silencio REAL entre frases.
    const pushPausa = async (ms) => {
      if (!ms || ms < 20) return;
      const p = path.join(audioOutputDir, `.pausa_${stamp}_${pieces.length}.wav`);
      await runFfmpeg([
        '-f', 'lavfi',
        '-i', 'anullsrc=r=24000:cl=mono',
        // La duración de anullsrc va con -t: la opción 'd' no existe en este ffmpeg.
        '-t', (ms / 1000).toFixed(3),
        '-c:a', 'pcm_s16le',
        '-y', p
      ]);
      pieces.push(p);
      // La duracion del silencio es exacta: se conoce sin medir.
      offset += ms / 1000;
      pausasTotal += ms / 1000;
    };

    for (let i = 0; i < units.length; i++) {
      const unit = units[i];
      const baseProsody = prosodyFor(voiceConfig, unit.mode);
      const mod = FRASE[unit.tipo] || FRASE.normal;

      // Modificador de la frase aplicado sobre la prosodia del registro.
      const rateNum = parseFloat(String(baseProsody.rate).replace('%', '')) || 0;
      const volNum = parseFloat(String(baseProsody.volume).replace('%', ''));
      const rateEfectivo = rateNum * mod.rateFactor;

      await pushPausa(unit.pausa);

      const rawPath = path.join(audioOutputDir, `.seg_${stamp}_${i}.mp3`);
      const { wordBoundaries } = await synthSegment(
        unit.text, rawPath, baseVoice,
        { pitch: baseProsody.pitch, rate: `${rateEfectivo >= 0 ? '+' : ''}${rateEfectivo.toFixed(0)}%`, volume: 'default' },
        langFor(unit.lang), baseVoice
      );

      // Edge anade ~1s de silencio al final de cada fragmento corto. Si no se
      // recorta, entre frase y frase quedan huecos de un segundo y la locucion
      // suena entrecortada. Recortamos con los propios tiempos de palabra.
      const rawDur = await getMediaDuration(rawPath);
      const first = wordBoundaries.length ? wordBoundaries[0].start : 0;
      const last = wordBoundaries.length ? wordBoundaries.at(-1).end : rawDur;
      let cutStart = 0;
      let cutEnd = rawDur;
      if (rawDur != null && wordBoundaries.length > 0) {
        // Padding corto: entre unidad y unidad se suman el pad, la cola del
        // aecho y la pausa insertada. Con un pad de 100 ms el suelo era ~210 ms
        // y todas las pausas sonaban igual de largas.
        cutStart = Math.max(0, first - 0.02);
        cutEnd = Math.min(rawDur, last + 0.05);
      }

      // Cadena: recorte + tinte de robot + volumen del registro y de la frase.
      // El volumen va DESPUES del compresor, si no el acompressor lo anula.
      const filters = [
        `atrim=start=${cutStart.toFixed(3)}:end=${cutEnd.toFixed(3)}`,
        'asetpts=PTS-STARTPTS'
      ];
      if (voiceConfig.timbre) filters.push(voiceConfig.timbre);

      if (Number.isFinite(volNum)) {
        // El factor de frase se aplica a la GANGA, nunca al porcentaje.
        //
        // Antes se hacía  volEfectivo = volNum * volumeFactor  y luego se
        // reconstruía un porcentaje. Con un volumen NEGATIVO eso invierte el
        // sentido del énfasis: una frase "exaltada" (factor 1.25) sobre el
        // -45% de GIR daba -56%, o sea MÁS baja. Medido: el aside de GIR
        // caía 5,9 dB y su frase exaltada caía 8,8 dB, justo la que debería
        // ser la más fuerte del aparte.
        //
        // Multiplicando ganancias: GIR normal 0,78 y GIR exaltada 0,78x1,25 =
        // 0,975 -> el énfasis sube de verdad y el volumen se mantiene estable.
        const gainBase = gainFromProsody({ volume: `${volNum >= 0 ? '+' : ''}${volNum.toFixed(0)}%` });
        if (gainBase != null) filters.push(`volume=${(gainBase * mod.volumeFactor).toFixed(3)}`);
      }

      const wavPath = path.join(audioOutputDir, `.seg_${stamp}_${i}.wav`);
      await runFfmpeg([
        '-i', rawPath,
        '-af', filters.join(','),
        '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le',
        '-y', wavPath
      ]);
      try { if (fs.existsSync(rawPath)) fs.unlinkSync(rawPath); } catch (_) {}
      pieces.push(wavPath);

      for (const b of wordBoundaries) {
        // El modo lleva el tipo de frase: un subtitulo nunca mezcla frases
        // habladas con registros o enfasis distintos.
        allBoundaries.push({
          ...b,
          start: b.start + offset,
          end: b.end + offset,
          mode: `${unit.mode}.${unit.tipo}`
        });
      }

      // El offset se mide DESPUES del tinte de robot: aecho anade una cola de
      // ~70 ms que debe quedar dentro del computo o los subtitulos se adelantan.
      const trimmedDur = await getMediaDuration(wavPath);
      offset += trimmedDur != null ? trimmedDur : (last - first + 0.14);
    }

    await concatAudioFiles(pieces, filePath, audioOutputDir);
    pieces.forEach(p => { try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {} });

    const finalDur = await getMediaDuration(filePath);
    if (finalDur == null || allBoundaries.length === 0) {
      throw new Error('El audio por frases no se pudo verificar');
    }

    allBoundaries.sort((a, b) => a.start - b.start);
    console.log(
      `🔊 TTS "${filename}": ${allBoundaries.length} palabras, ${finalDur.toFixed(2)}s ` +
      `(habla ${(finalDur - pausasTotal).toFixed(2)}s + pausas ${pausasTotal.toFixed(2)}s)`
    );

    return {
      success: true,
      filePath,
      filename,
      url: '/audio/' + filename,
      engine: 'msedge-tts-fragmented',
      voice: voiceConfig.name,
      wordBoundaries: allBoundaries
    };
  } catch (edgeError) {
    console.warn('⚠️ Usando Google TTS como respaldo:', edgeError.message);
    try {
      const base64Audio = await googleTTS.getAudioBase64(text, {
        lang: 'es',
        slow: false,
        host: 'https://translate.google.com',
        timeout: 10000,
      });

      const buffer = Buffer.from(base64Audio, 'base64');
      fs.writeFileSync(filePath, buffer);

      return {
        success: true,
        filePath,
        filename,
        url: '/audio/' + filename,
        engine: 'google-tts',
        voice: voiceConfig.name,
        wordBoundaries: []   // este motor no reporta tiempos
      };
    } catch (googleError) {
      throw new Error('Error en generación de voz TTS: ' + googleError.message);
    }
  }
}

export async function generateAudioForScript(script, voiceId = DEFAULT_VOICE_ID) {
  const slug = (script.title || 'script')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '_')
    .slice(0, 30);
  const timestamp = Date.now();

  const blocks = [];
  if (script.hook && script.hook.narration) {
    blocks.push({ type: 'hook', label: 'Gancho Inicial', text: script.hook.narration });
  }
  if (Array.isArray(script.scenes)) {
    script.scenes.forEach((scene, idx) => {
      if (scene.narration) {
        blocks.push({ type: 'scene', label: scene.badge || ('Escena ' + (idx + 1)), text: scene.narration });
      }
    });
  }
  if (script.callToAction && script.callToAction.narration) {
    blocks.push({ type: 'cta', label: 'Llamado a la Acción', text: script.callToAction.narration });
  }

  const sceneAudios = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const sceneFilename = slug + '_' + timestamp + '_part_' + (i + 1) + '.mp3';
    try {
      const res = await textToSpeech(block.text, sceneFilename, voiceId);
      // wordBoundaries se propaga: son los tiempos exactos de esta escena,
      // usados luego para generar los subtítulos sin estimar nada.
      sceneAudios.push({
        ...block,
        audioUrl: res.url,
        filename: res.filename,
        engine: res.engine,
        voice: res.voice,
        wordBoundaries: res.wordBoundaries || []
      });
    } catch (e) {
      console.error('Error generando audio para ' + block.label, e.message);
    }
  }

  const fullText = blocks.map(b => b.text).join(' ');
  const fullFilename = slug + '_' + timestamp + '_full.mp3';
  const fullAudioResult = await textToSpeech(fullText, fullFilename, voiceId);

  return {
    success: true,
    fullAudioUrl: fullAudioResult.url,
    fullAudioFilename: fullAudioResult.filename,
    voice: fullAudioResult.voice,
    engine: fullAudioResult.engine,
    scenes: sceneAudios
  };
}