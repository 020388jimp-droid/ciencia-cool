// src/services/lexicon.js
// Detección de términos en inglés dentro de narración en español.

/**
 * Términos en inglés que aparecen con frecuencia en noticias de ciencia,
 * tecnología y videojuegos.
 *
 * El TTS de Edge NO soporta cambiar el idioma por palabra: <lang>, <phoneme>,
 * <say-as>, <sub> y <express-as> dejan el stream colgado (verificado). La
 * estrategia viable es trocear la narración en tramos español/inglés, sintetizar
 * cada tramo con la voz correcta y unir los audios con ffmpeg.
 *
 * La clave de cada entrada es case-insensitive, sin acentos, y puede tener
 * espacios (frases como "black hole").
 *
 * Se evitan deliberadamente palabras cortas que también existen en español
 * (arm, meta, quien...) porque producirían falsos positivos.
 */
const ENGLISH_TERMS = [
  // Consolas y gaming
  'playstation', 'ps5', 'ps4', 'ps3',
  'nintendo', 'switch 2',
  'xbox', 'series x', 'series s',
  'steam deck', 'steam', 'epic games',
  'game pass', 'playstation plus',
  'genshin', 'fortnite', 'minecraft', 'roblox',
  'league of legends', 'valorant', 'overwatch',
  'call of duty', 'grand theft auto', 'the last of us',
  'god of war', 'spider-man', 'elden ring', 'dark souls',
  'kingdom hearts', 'resident evil', 'silent hill', 'final fantasy',
  'witcher', 'skyrim', 'fallout', 'mass effect', 'half life',
  'clash royale', 'brawl stars', 'free fire',
  'gameplay', 'gaming', 'gamer', 'esports', 'speedrun', 'walkthrough',
  'game award', 'the game awards', 'gamescom', 'retro gaming',
  'indie game', 'gamedev', 'game jam', 'dlc',

  // Tecnología y marcas
  'google', 'microsoft', 'amazon', 'facebook', 'instagram',
  'whatsapp', 'tiktok', 'youtube', 'twitter', 'linkedin', 'netflix', 'spotify',
  'tesla', 'spacex', 'blue origin', 'boeing', 'nokia', 'samsung', 'xiaomi',
  'intel', 'nvidia', 'qualcomm',
  'openai', 'chatgpt', 'anthropic', 'gemini', 'copilot', 'perplexity',
  'deepmind', 'llama', 'midjourney',
  'apple silicon', 'windows', 'linux', 'macos', 'android',
  'iphone', 'ipad', 'macbook', 'airpods', 'apple watch', 'apple tv',
  'smartphone', 'smartwatch', 'laptop', 'gadget', 'software', 'hardware',
  'internet', 'wifi', 'bluetooth', 'blockchain', 'bitcoin', 'ethereum',
  'cryptocurrency', 'startup', 'robotics', 'chatbot',
  'deep learning', 'machine learning', 'self driving', 'neural network',
  'large language model',

  // Ciencia / espacio / salud
  'james webb', 'webb telescope', 'hubble', 'spitzer', 'kepler',
  'starship', 'falcon 9', 'artemis',
  'mrna', 'pfizer', 'moderna', 'fda',
  'alzheimer', 'parkinson', 'covid',
  'gene editing', 'crispr', 'black hole', 'exoplanet',
  'solar system', 'milky way', 'dark matter', 'dark energy',
  'genome', 'protein', 'vitamin', 'antibody', 'antibodies'
];

/** Índice: frase normalizada -> número de palabras que ocupa. */
const ENGLISH_TERM_MAP = new Map();
const normalizeWord = (w) => w.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

for (const term of ENGLISH_TERMS) {
  ENGLISH_TERM_MAP.set(normalizeWord(term), term.split(/\s+/).length);
}
const MAX_TERM_WORDS = Math.max(...ENGLISH_TERM_MAP.values());

/**
 * Trocea el texto en tramos de un solo idioma.
 *
 * Devuelve los tramos con el texto EXACTO que se debe sintetizar, de modo que
 * al unir los audios se reproduzca la narración completa sin perder nada.
 *
 * @param {string} text
 * @returns {Array<{text: string, lang: 'es'|'en'}>}
 */
export function segmentByLanguage(text) {
  if (!text || !String(text).trim()) return [];

  // Trocear en palabras y separadores, conservando el texto original intacto.
  const rawTokens = String(text).match(/\s+|[^\s]+/g) || [];

  // Cada palabra léxica: { word, norm, pre, post }
  // pre/post guardan la puntuación adyacente para poder reconstruir el texto
  // exactamente. Los tokens que empiezan con signo ("¡HOLA", "¿Habrá") SON
  // palabras: su signo va en "pre", no se descarta.
  const lexemes = [];
  let prefix = '';

  const appendSymbol = (chunk) => {
    if (lexemes.length) lexemes[lexemes.length - 1].post += chunk;
    else prefix += chunk;
  };

  for (const tok of rawTokens) {
    if (/^\s+$/.test(tok)) {
      appendSymbol(tok);
      continue;
    }
    // pre = puntuación inicial, word = la palabra, post = el resto
    const m = tok.match(/^([^\p{L}\p{N}]*)([\p{L}\p{N}][\p{L}\p{N}'’-]*)(.*)$/u);
    if (!m) {
      // Token puramente simbólico (emoji suelto, etc.)
      appendSymbol(tok);
      continue;
    }
    lexemes.push({ word: m[2], norm: normalizeWord(m[2]), pre: m[1], post: m[3] });
  }
  if (lexemes.length === 0) return [];

  const segments = [];
  let current = null;

  const start = lang => {
    current = { lang, text: '' };
    segments.push(current);
    return current;
  };
  const append = piece => { if (current) current.text += piece; };

  let i = 0;
  while (i < lexemes.length) {
    // ¿Hay un término en inglés que empiece aquí? (greedy, frase más larga primero)
    let matched = 0;
    for (let len = Math.min(MAX_TERM_WORDS, lexemes.length - i); len >= 1; len--) {
      const phrase = lexemes.slice(i, i + len).map(l => l.norm).join(' ');
      if (ENGLISH_TERM_MAP.has(phrase)) { matched = len; break; }
    }

    if (matched > 0) {
      const seg = current?.lang === 'en' ? current : start('en');
      for (let k = 0; k < matched; k++) {
        const lex = lexemes[i + k];
        append(lex.pre + lex.word + lex.post);
      }
      i += matched;
      current = seg;
    } else {
      const seg = current?.lang === 'es' ? current : start('es');
      const lex = lexemes[i];
      append(lex.pre + lex.word + lex.post);
      i++;
      current = seg;
    }
  }

  // El texto previo a la primera palabra se antepone al primer tramo.
  if (prefix && segments.length > 0) segments[0].text = prefix + segments[0].text;

  return segments.filter(s => s.text.trim().length > 0);
}

/**
 * Marcadores de tono dentro de la narración.
 *
 * Gemini escribe el guion con marcas como [[GRITO]]...[[/GRITO]] para indicar
 * dónde cambia el registro. El TTS las usa para aplicar una prosodia distinta a
 * cada fragmento (y nunca las pronuncia ni las muestra en los subtítulos).
 *
 * Modos:
 *   locucion  - lectura de la noticia, aguda y acelerada (por defecto)
 *   grito     - energía máxima: saludo inicial y exclamaciones
 *   gir       - interrupciones cómicas del personaje, tono muy alto y lento
 */
export const NARRATION_MODES = ['locucion', 'grito', 'gir'];

const MODE_TOKEN = /\[\[\s*\/?\s*(GRITO|GIR)\s*\]\]/gi;

/**
 * Divide el texto en fragmentos con su modo de tono, eliminando los marcadores.
 * Si el texto no trae marcadores, todo queda en modo 'locucion'.
 *
 * @param {string} text
 * @returns {Array<{text: string, mode: string}>}
 */
export function parseNarrationModes(text) {
  if (!text) return [];

  const parts = [];
  let mode = 'locucion';
  let last = 0;
  const re = new RegExp(MODE_TOKEN.source, 'gi');

  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      parts.push({ text: text.slice(last, m.index), mode });
    }
    // Marcador de cierre (contiene '/') vuelve al modo normal.
    mode = m[0].includes('/') ? 'locucion' : m[1].toLowerCase();
    last = re.lastIndex;
  }
  if (last < text.length) {
    parts.push({ text: text.slice(last), mode });
  }

  return parts
    .map(p => ({ ...p, text: p.text.trim() }))
    .filter(p => p.text.length > 0);
}

/**
 * Pipeline completo de segmentación para síntesis: primero por tono
 * (marcadores [[GRITO]] / [[GIR]]), después por idioma (diccionario de términos
 * en inglés).
 *
 * @param {string} text
 * @returns {Array<{text: string, mode: string, lang: 'es'|'en'}>}
 */
export function segmentForSynthesis(text) {
  const out = [];
  for (const part of parseNarrationModes(text)) {
    for (const seg of segmentByLanguage(part.text)) {
      out.push({ text: seg.text, lang: seg.lang, mode: part.mode });
    }
  }
  return out;
}

/** ¿El texto contiene algún término en inglés? */
export function hasEnglishTerms(text) {
  return segmentByLanguage(text).some(s => s.lang === 'en');
}

/** Lista de términos en inglés detectados (para diagnóstico). */
export function findEnglishTerms(text) {
  const found = new Set();
  for (const seg of segmentByLanguage(text)) {
    if (seg.lang === 'en') found.add(seg.text.trim());
  }
  return [...found];
}

// ─── Español de España → español de México (doblaje) ────────────────────────
//
// La voz YA se sintetiza con xml:lang="es-MX", pero una voz neuronal no suena
// mexicana si el TEXTO es de España: al topar con "vuestro" o "ordenador"
// ajusta la pronunciación hacia el castellano, y se nota. El usuario lo detectó
// oyendo "vuestro celular" en medio de una escena.
//
// Se corrige en dos capas: el prompt de Gemini escribe directamente en mexicano
// y aquí se normaliza el texto. Importante que sea aquí y no solo en la voz: si
// se cambiara únicamente lo que se manda a sintetizar, la voz diría "su celular"
// mientras el subtítulo seguiría poniendo "vieuwstro celular".
//
// Las formas de "vosotros" se sustituyen por las de "ustedes", incluyendo la
// conjugación del verbo, porque "vosotros habláis" → "ustedes hablan" y no
// simplemente "ustedes habláis".

// Se ordenan de más largo a más corto para que "vuestros" se sustituya antes
// que "vuestro" y no queden restos.
const PALABRAS_ES_A_MX = [
  // ─── Segunda persona: el caso que más se oía ───────────
  ['vuestros', 'sus'], ['vuestras', 'sus'], ['vuestro', 'su'], ['vuestra', 'su'],
  ['vosotras', 'ustedas'], ['vosotros', 'ustedes'],

  // ─── Presente de vosotros → tercera persona del plural ───────────
  // El pronombre ya se cambió arriba; aquí se arregla la terminación del verbo.
  ['habláis', 'hablan'], ['coméis', 'comen'], ['vivís', 'viven'],
  ['tenéis', 'tienen'], ['queréis', 'quieren'], ['sabéis', 'saben'],
  ['podéis', 'pueden'], ['creéis', 'creen'], ['entendéis', 'entienden'],
  ['venís', 'vienen'], ['decís', 'dicen'], ['oís', 'oyen'], ['hacés', 'hacen'],
  ['vais', 'van'], ['repartís', 'reparten'], ['elegís', 'eligen'],
  ['seguís', 'siguen'], ['conseguís', 'consiguen'], ['cerráis', 'cierran'],
  ['esperáis', 'esperan'], ['lleváis', 'llevan'], ['tendréis', 'tendrán'],
  ['encontraréis', 'encontrarán'], ['entraréis', 'entrarán'],
  ['repartid', 'repartan'], ['elegid', 'elijan'],
  ['seguid', 'sigan'], ['conseguid', 'consigan'],

  // ─── Imperativo de vosotros → de ustedes ────────────────────
  // Solo las formas en -ad, que son inconfundibles. NO se tocan "mira" ni
  // "observa": como interjección ("¡mira qué loco!") se usan igual en México.
  ['hablad', 'hablen'], ['comed', 'coman'], ['vivid', 'vivan'],
  ['tened', 'tengan'], ['sabed', 'sepan'], ['venid', 'vengan'],
  ['decid', 'digan'], ['oid', 'oyan'], ['esperad', 'esperen'],
  ['cerrad', 'cierren'], ['escuchad', 'escuchen'], ['prestad', 'presten'],
  ['tomad', 'tomen'], ['observad', 'observen'], ['mirad', 'miren'],
  ['pensad', 'piensen'], ['acordad', 'acuerden'], ['ayudad', 'ayuden'],
  ['entrad', 'entren'], ['salid', 'salgan'], ['estudiad', 'estudien'],
  ['conversad', 'conversen'], ['necesitad', 'necesitan'], ['practicad', 'practiquen'],

  // ─── Tecnología: el vocabulario que más se oye aquí ────────
  ['ordenadores', 'computadoras'], ['ordenador', 'computadora'],
  ['portátiles', 'laptops'], ['portátil', 'laptop'],
  ['móviles', 'celulares'], ['móvil', 'celular'],

  // ─── Cotidiano ───────────────────────────────────
  // Conjugación completa de "aparcar": es el verbo que más se cuela de España.
  ['aparcamientos', 'estacionamientos'], ['aparcamiento', 'estacionamiento'],
  ['aparcada', 'estacionada'], ['aparcado', 'estacionado'],
  ['aparcaron', 'estacionaron'], ['aparcamos', 'estacionamos'],
  ['aparcaban', 'estacionaban'], ['aparcado', 'estacionado'],
  ['aparcan', 'estacionan'], ['aparcas', 'estacionas'], ['aparco', 'estaciono'],
  ['aparcar', 'estacionar'], ['aparquen', 'estacionen'],
  ['coches', 'carros'], ['coche', 'carro'],
  ['colegios', 'escuelas'], ['colegio', 'escuela'],
  ['chavales', 'compas'], ['chaval', 'compa'],
  ['currar', 'trabajar'], ['curro', 'trabajo'],
  ['papeleo', 'trámites'],
].sort((a, b) => b[0].length - a[0].length);

/**
 * Frases con artículo, para los sustantivos que cambian de género al cambiar de
 * país: "el ordenador" → "la computadora", no "el computadora" (que además de
 * estar mal, no existe en mexicano). Se aplican ANTES que las palabras sueltas.
 *
 * Solo los que cambian de género. "el móvil" → "el celular" y "el coche" → "el
 * carro" ya salen bien con las reglas de palabra.
 */
const FRASES_ES_A_MX = [
  // "el ordenador portátil" → "la laptop": si no se juntan las dos palabras,
  // sale "la computadora laptop", que suena redundante.
  ['los ordenadores portátiles', 'las laptops'],
  ['el ordenador portátil', 'la laptop'],
  ['un ordenador portátil', 'una laptop'],

  // ordenador (m) → computadora (f)
  ['los ordenadores', 'las computadoras'],
  ['las ordenador', 'las computadoras'],
  ['al ordenador', 'a la computadora'],
  ['del ordenador', 'de la computadora'],
  ['el ordenador', 'la computadora'],
  ['un ordenador', 'una computadora'],

  // portátil (m) → laptop (f)
  ['los portátiles', 'las laptops'],
  ['al portátil', 'a la laptop'],
  ['del portátil', 'de la laptop'],
  ['el portátil', 'la laptop'],
  ['un portátil', 'una laptop'],

  // colegio (m) → escuela (f)
  ['los colegios', 'las escuelas'],
  ['al colegio', 'a la escuela'],
  ['del colegio', 'de la escuela'],
  ['el colegio', 'la escuela'],
  ['un colegio', 'una escuela'],
];

/** Construye un patrón que exige que la palabra esté suelta (ni "movilidades"). */
function palabraExacta(palabra) {
  const esc = palabra.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `(?<![\\p{L}])${esc}(?![\\p{L}])`;
}

/** Aplica una sustitución conservando la capitalización de la original. */
function respetandoMayusculas(original, sustitucion) {
  const todasMayus = original === original.toUpperCase() && original !== original.toLowerCase();
  const primeraMayus = original[0] === original[0].toUpperCase()
    && original[0] !== original[0].toLowerCase();
  if (todasMayus) return sustitucion.toUpperCase();
  if (primeraMayus) return sustitucion[0].toUpperCase() + sustitucion.slice(1);
  return sustitucion;
}

/**
 * Convierte español de España en español de México.
 *
 * Orden de aplicación:
 *   1. Frases con artículo (arreglan el género: "el ordenador" → "la computadora")
 *   2. Palabras exactas de la tabla (vosotros, tecnología, cotidiano)
 *   3. Verbos de vosotros genéricos, para los que no están en la tabla
 *
 * Es idempotente: aplicarlo dos veces da el mismo resultado, así que puede
 * usarse como red de seguridad sin riesgo de seguir degradando el texto.
 */
export function aEspanolDeMexico(texto) {
  if (!texto || typeof texto !== 'string') return texto;
  let salida = texto;

  for (const [de, a] of FRASES_ES_A_MX) {
    const re = new RegExp(palabraExacta(de), 'giu');
    salida = salida.replace(re, m => respetandoMayusculas(m, a));
  }

  for (const [de, a] of PALABRAS_ES_A_MX) {
    const re = new RegExp(palabraExacta(de), 'giu');
    salida = salida.replace(re, m => respetandoMayusculas(m, a));
  }

  // Verbos regulares de vosotros que no estén en la tabla. Solo se tocan las
  // terminaciones inequívocas del presente: -áis → -an, -éis → -en, -ís → -en.
  // Los irregulares (tenéis, Queréis, entendéis...) están en la tabla de arriba.
  salida = salida.replace(
    /(?<![\p{L}])([\p{L}]+)(?:áis|éis|ís)(?![\p{L}])/giu,
    (m, raiz) => `${raiz}${m.toLowerCase().endsWith('áis') ? 'an' : 'en'}`
  );

  return salida;
}

/**
 * Quita lo que la voz no sabe expresar.
 *
 * El prompt ya pide guion natural, pero esto lo garantiza siempre:
 *
 *  1. Letras estiradas. "Siiii", "TAQUIIIITO", "Ahiiii", "nooo", "AHHH" son el
 *     recurso tipico de un dibujo animado, pero una voz sintetica las lee como
 *     una secuencia de letras normalitas y el resultado suena plano. Se
 *     colapsan a una sola letra: "TAQUIIIITO" -> "TAQUITO".
 *  2. La palabra "bugs", que el usuario pidio quitar de forma permanente.
 *  3. Signos de grito: el "¡¡" doble, que la voz lee mejor como un solo "¡".
 *     Las MAYÚSCULAS no se tocan: en los subtitulos los acronimos (NASA, RAM,
 *     CIENCIA COOL) deben seguir en mayusculas.
 */
export function pulirParaVoz(texto) {
  if (!texto || typeof texto !== 'string') return texto;
  let salida = texto;

  // 1. Tres o mas letras iguales seguidas -> una sola. En espanol no existen
  //    tres letras iguales seguidas, asi que la regla es segura. Con DOS si se
  //    respetan ("cabelllo", "perro", "llave"), porque esas si son palabras.
  salida = salida.replace(/([\p{L}])\1{2,}/giu, '$1');
  // Vocal repetida al principio de palabra: "Aaaarranca" -> "Arranca".
  // Vocal repetida al principio de palabra: "Aaaarranca" → "Arranca".
  salida = salida.replace(/(?<!\p{L})([aeiouáéíóúü])\1+/giu, '$1');

  // 2. "bugs": el guion no debe decírselo al público nunca.
  salida = salida.replace(/(?<!\p{L})bugs?\s+humanos?(?!\p{L})/giu, 'todos');
  salida = salida.replace(/(?<!\p{L})bugs?(?!\p{L})/giu, 'personas');

  // 3. Signos de grito: se deja un solo "¡", que la voz lee mejor que "¡¡".
  //    NO se tocan las mayúsculas: en los subtítulos los acrónimos (NASA, RAM,
  //    CIENCIA COOL) deben seguir en mayúsculas y no afectan a cómo suena.
  salida = salida.replace(/¡{2,}/g, '¡');
  salida = salida.replace(/!{2,}/g, '!');
  salida = salida.replace(/¿{2,}/g, '¿');

  return salida;
}

/**
 * Normaliza un guion completo: recorre hook, escenas y llamada a la acción.
 * Los [[GRITO]] / [[GIR]] se conservan intactos.
 */
export function normalizarGuionMexicano(script) {
  if (!script || typeof script !== 'object') return script;
  const out = { ...script };

  const limpio = (bloque) => {
    if (!bloque || typeof bloque.narration !== 'string') return bloque;
    return { ...bloque, narration: pulirParaVoz(aEspanolDeMexico(bloque.narration)) };
  };

  if (out.hook) out.hook = limpio(out.hook);
  if (Array.isArray(out.scenes)) out.scenes = out.scenes.map(limpio);
  if (out.callToAction) out.callToAction = limpio(out.callToAction);
  if (typeof out.title === 'string') {
    out.title = pulirParaVoz(aEspanolDeMexico(out.title));
  }
  return out;
}