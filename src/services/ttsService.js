import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as googleTTS from 'google-tts-api';
import { segmentForSynthesis, findEnglishTerms, aEspanolDeMexico } from './lexicon.js';
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
async function synthSegment(text, outPath, voiceKey, prosody, lang, fallbackVoiceKey) {
  const MIN_BYTES = 1024;

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