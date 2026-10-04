import Parser from 'rss-parser';
import { RSS_FEEDS } from '../config/feeds.js';

const parser = new Parser({
  // Un User-Agent identificable reduce los 503/429 de Google News.
  requestOptions: {
    headers: {
      'User-Agent': 'CIENCIA-COOL/1.0 (RSS reader)',
      'Accept': 'application/rss+xml, application/xml, text/xml, */*'
    },
    timeout: 15000
  },
  customFields: {
    item: ['description', 'pubDate', 'guid']
  }
});

/**
 * Palabras clave por categoría.
 *
 * Reglas para no repeatir el error de la version anterior:
 *  - NINGUNA palabra clave de 3 letras o menos. Con busqueda por subcadena,
 *    "de" matchea practicamente cualquier titular en espanol.
 *  - Solo terminos inequivocos. Se evitan siglas ambiguas (AI/AR/CP/ME...).
 *  - Se permiten frases de varias palabras, que son las mas precisas.
 *  - Los pesos reflejan especificidad: un termino largo o una frase vale mas.
 */
const CATEGORY_KEYWORDS = {
  medicina: {
    label: 'Medicina',
    terms: [
      //weighted: 3
      'salud', 'medicina', 'medico', 'médico', 'hospital', 'paciente', 'pacientes',
      'enfermeria', 'enfermero', 'cirugia', 'diagnostico', 'diagnóstico',
      'tratamiento', 'terapia', 'farmaco', 'fármaco', 'medicamento', 'vacuna',
      'epidemia', 'pandemia', 'epidemiologia', 'virulencia', 'bacterias',
      'cancer', 'cáncer', 'oncologia', 'tumor', 'diabetes', 'obesidad',
      'alzheimer', 'parkinson', 'esclerosis', 'artritis', 'osteoporosis',
      'cardiovascular', 'corazon', 'corazón', 'pulmones', 'pulmon', 'hígado',
      'riñones', 'sintomas', 'síntomas', 'enfermedad', 'infeccion', 'infección',
      'virus', 'bacteria', 'antibiotico', 'antibiótico', 'cirrosis',
      'trasplante', 'donacion de organos', 'esterilizacion', 'esterilización',
      'cognicion', 'cognición', 'demencia', 'autismo', 'depresion', 'depresión',
      'ansiedad', 'esquizofrenia', 'psiquiatria', 'psiquiatría', 'psicologia', 'psicología',
      'nutricion', 'nutrición', 'vitaminas', 'obra social', 'seguro medico',
      'ensayo clinico', 'ensayo clínico', 'estudio clinico', 'estudio clínico',
      'muerte cerebral', 'vida sintetica', 'vida sintética',
      'health', 'medical', 'medicine', 'clinical', 'cancer', 'disease', 'patients',
      'doctors', 'nurses', 'therapy', 'treatment', 'diagnosis', 'surgery', 'drugs'
    ]
  },
  videojuegos: {
    label: 'Videojuegos',
    terms: [
      'videojuego', 'videojuegos', 'videogames', 'gaming', 'gamer', 'gamers',
      'playstation', 'playstation 5', 'ps5', 'xbox', 'xbox series', 'nintendo',
      'switch 2', 'nintendo switch', 'steam deck', 'consola', 'consolas',
      'gameplay', 'esports', 'eSports', 'speedrun', 'walkthrough', 'gameplay',
      'game pass', 'playstation plus', 'xbox game pass', 'nintendo online',
      'minecraft', 'fortnite', 'roblox', 'free fire', 'genshin', 'honkai',
      'league of legends', 'counter-strike', 'valorant', 'overwatch', 'dota',
      'apex legends', 'call of duty', 'battlefield', 'grand theft auto',
      'the last of us', 'god of war', 'spider-man', 'elden ring', 'dark souls',
      'sekiro', 'bloodborne', 'zelda', 'pokemon', 'mario', 'sonic', 'kirby',
      'metroid', 'hollow knight', 'celeste', 'undertale', 'terraria', 'stardew valley',
      'factorio', 'satisfactory', 'rimworld', 'simcity', 'civilization',
      'cyberpunk', 'witcher', 'skyrim', 'fallout', 'mass effect', 'dragon age',
      'final fantasy', 'kingdom hearts', 'persona 5', 'resident evil',
      'silent hill', 'dead space', 'outlast', 'cuphead', 'halo', 'doom',
      'half-life', 'portal 2', 'minecraft better', 'clash royale', 'brawl stars',
      'league', 'gacha', 'speedrun', 'frame perfect', 'eFootball', 'fc 25',
      'nintendo switch 2', 'game award', 'the game awards', 'indie game',
      'gamedev', 'game jam', 'speedrun.com',
      'nintendo ds', 'game boy', 'sega', 'atari', 'playstation portal',
      'xbox one', 'nintendo 64', 'super nintendo', 'megadrive', 'dreamcast',
      'gamer culture', 'gaming industry', 'video game', 'gamescom', 'steam',
      'epic games', 'ubisoft', 'bandai namco', 'square enix', 'capcom',
      'konami', 'activision', 'blizzard', 'valve', 'retro gaming', 'emulador'
    ]
  },
  tecnologia: {
    label: 'Tecnología',
    terms: [
      'inteligencia artificial', 'aprendizaje automatico', 'aprendizaje automático',
      'redes neuronales', 'modelo de lenguaje', 'modelos de lenguaje', 'chatbot',
      'criptomoneda', 'criptomonedas', 'blockchain', 'bitcoin', 'ethereum',
      'smartphone', 'telefono inteligente', 'portatil', 'portátil', 'computadora',
      'procesador', 'tarjeta grafica', 'tarjeta gráfica', 'memoria ram',
      'robot', 'robotica', 'robótica', 'dron', 'drones', 'internet de las cosas',
      'realidad aumentada', 'realidad virtual', 'realidad mixta', 'metaverso',
      'ciberseguridad', 'ciberataque', 'hackeo', 'malware', 'ransomware',
      'sistema operativo', 'nube', 'computacion', 'computación', 'algoritmo',
      'machine learning', 'deep learning', 'artificial intelligence',
      'openai', 'chatgpt', 'google deepmind', 'anthropic', 'nvidia', 'open source',
      'software', 'aplicacion movil', 'aplicación móvil', 'app movil', 'startup',
      'startups', 'tecnologia', 'tecnología', 'innovacion tecnologica',
      '5g', 'internet de las cosas', 'semiconductor', 'chips', 'wearable',
      'reales aumentados', 'autopiloto', 'vehiculo autonomo', 'vehículo autónomo',
      'smartwatch', 'laptop', 'tablet', 'smart tv', 'television inteligente'
    ]
  },
  astronomia: {
    label: 'Astronomía',
    terms: [
      'astronomia', 'astronomía', 'astofisica', 'astrofísica', 'astrobiologia',
      'espacio', 'sistema solar', 'planeta', 'planetas', 'lunar', 'marte',
      'jupiter', 'júpiter', 'saturno', 'urano', 'neptuno', 'pluton', 'plutón',
      'estrella', 'estrellas', 'galaxia', 'galaxias', 'constelacion', 'constelación',
      'universo', 'cosmologia', 'cosmología', 'telescopio', 'telescopios',
      'observatorio', 'satelite', 'satélite', 'satelites', 'cohete', 'cohetes',
      'nasa', 'esa', 'spacex', 'blue origin', 'starlink', 'astronauta',
      'exoplaneta', 'exoplanetas', 'agujero negro', 'materia oscura',
      'energia oscura', 'enana blanca', 'supernova', 'nebulosa', 'supernovas',
      'eclipse', 'meteoro', 'meteorito', 'asteroide', 'cometa', 'estacion espacial',
      'jwst', 'james webb', 'hubble', 'webb telescope', 'constelacion',
      'space launch', 'rocket launch', 'lanzamiento espacial', 'mission espacial',
      'planeta exoplanetario', 'orbit', 'orbita', 'órbita', 'satelites artificiales',
      'starship', 'falcon 9', 'new shepherd', 'vehiculo espacial', 'nave espacial'
    ]
  },
  ciencia: {
    label: 'Ciencia',
    terms: [
      'ciencia', 'cientifico', 'científico', 'cientifica', 'científica',
      'investigacion', 'investigación', 'investigadores', 'descubrimiento',
      'descubrimientos', 'experimento', 'experimentos', 'laboratorio',
      'hipotesis', 'hipótesis', 'teoria', 'teoría', 'estudio cientifico',
      'paper', 'revista cientifica', 'publicacion cientifica', ' Nature ',
      ' Science ', ' Science Advances', 'investigacion basica',
      'genetica', 'genética', 'genoma', 'sequencing', 'crispr', 'edicion genetica',
      'darwin', 'evolucion', 'evolución', 'arqueologia', 'arqueología',
      'fossil', 'fósil', 'fósiles', 'paleontologia', 'paleontología',
      'antropologia', 'antropología', 'biologia', 'biología', 'quimica', 'química',
      'fisica', 'física', 'matematicas', 'matemáticas', 'ecologia', 'ecología',
      'botanica', 'botánica', 'zoologia', 'zoología', 'geologia', 'geología',
      'neurociencia', 'neurosciencia', 'fisiologia', 'fisiología',
      'cambio climatico', 'cambio climático', 'innovacion cientifica',
      'avance cientifico', 'avances cientificos', 'ensayo', 'muestra',
      'revolucion cientifica', 'hallazgo', 'hallazgos', 'physics', 'biology',
      'chemistry', 'genetics', 'research', 'scientist', 'scientists',
      'discovery', 'laboratory', 'experiment', 'evolution', 'fossil'
    ]
  },
  medio_ambiente: {
    label: 'Medio Ambiente',
    terms: [
      'medio ambiente', 'medioambiente', 'contaminacion', 'contaminación',
      'cambio climatico', 'cambio climático', 'calentamiento global',
      'efecto invernadero', 'emisiones de carbono', 'huella de carbono',
      'reciclaje', 'reciclar', 'sostenibilidad', 'sostenible',
      'medioambiente', 'ecossistema', 'ecosistema', 'ecosistemas',
      'biodiversidad', 'extincion', 'extinción', 'especie protegida',
      'especies en peligro', 'deforestacion', 'deforestación', 'reforestacion',
      'selva', 'bosque', 'amazonia', 'amazonía', 'arctic', 'artico', 'ártico',
      'antartida', 'antártida', 'glaciar', 'glaciares', 'capa de hielo',
      'oceano', 'océano', 'mares', 'arrecife', 'arrecifes', 'coral',
      'energia renovable', 'energía renovable', 'energia solar', 'paneles solares',
      'energia eolica', 'energía eólica', 'clima', 'climatico', 'climático',
      'sequia', 'sequía', 'inundacion', 'inundación', 'volcan', 'volcán',
      'clima extremo', 'evento climatico', 'evento climático',
      'environment', 'environmental', 'climate', 'climate change', 'global warming',
      'pollution', 'recycling', 'sustainability', 'sustainable', 'biodiversity',
      'deforestation', 'renewable energy', 'solar panel', 'ecosystem',
      'greenhouse', 'emissions', 'glacier', 'ocean', 'coral reef', 'wildfire'
    ]
  }
};

/**
 * Normaliza texto para busquedas por palabra completa:
 * minusculas, sin acentos, y solo [a-z0-9 ].
 */
function normalizeForMatch(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Devuelve un Set de formas normalizadas para buscar como palabra completa. */
const MATCH_INDEX = {};
for (const [category, cfg] of Object.entries(CATEGORY_KEYWORDS)) {
  MATCH_INDEX[category] = new Set(cfg.terms.map(t => normalizeForMatch(t)));
}

/** Peso de un término:pecifico (largo o frase) pesa más que una palabra genérica. */
function termWeight(term) {
  const n = normalizeForMatch(term);
  if (n.includes(' ')) return 3;          // frases exactas: muy precisas
  if (n.length >= 12) return 3;
  if (n.length >= 8) return 2;
  return 1;
}
const TERM_WEIGHTS = {};
for (const [category, cfg] of Object.entries(CATEGORY_KEYWORDS)) {
  TERM_WEIGHTS[category] = new Map(cfg.terms.map(t => [normalizeForMatch(t), termWeight(t)]));
}

/**
 * Puntúa una noticia contra todas las categorías.
 * La coincidencia es por palabra completa, nunca por subcadena.
 */
function scoreCategories(text) {
  const scores = {};
  for (const category of Object.keys(CATEGORY_KEYWORDS)) {
    let score = 0;
    const hits = [];
    for (const term of MATCH_INDEX[category]) {
      if (!term) continue;
      // " palabra " para asegurar que el término es una palabra/unigram completo.
      if ((' ' + text + ' ').includes(' ' + term + ' ')) {
        score += TERM_WEIGHTS[category].get(term) || 1;
        hits.push(term);
      }
    }
    scores[category] = { score, hits };
  }
  return scores;
}

/**
 * Clasifica una noticia combinando dos señales:
 *  1. El contenido (título + resumen).
 *  2. La categoría del feed de origen (IGN y 3DJuegos solo traen videojuegos,
 *     NASA solo astronomía), que aporta un prior fiable.
 */
function classifyNewsByContent(title, snippet = '', feedCategory = '') {
  const text = normalizeForMatch(`${title} ${snippet}`);

  if (!text) return feedCategory || 'ciencia';

  const scores = scoreCategories(text);

  // Prior del feed: aporta un empujón fijo, nunca decide solo.
  const PRIOR = 4;
  if (feedCategory && scores[feedCategory]) {
    scores[feedCategory].score += PRIOR;
  }

  let best = feedCategory || 'ciencia';
  let bestScore = 0;

  for (const [category, { score }] of Object.entries(scores)) {
    if (score > bestScore) {
      bestScore = score;
      best = category;
    }
  }

  // Si el contenido no dio ninguna señal fuerte, nos quedamos con el feed.
  if (bestScore <= PRIOR && feedCategory) return feedCategory;

  return bestScore > 0 ? best : (feedCategory || 'ciencia');
}

/**
 * Filtro de idioma: descarta artículos claramente en inglés.
 *
 * Google News en español también se cuela con notas publicadas por medios
 *ELDx.uk. Este filtro es una red de seguridad: solo descarta cuando hay
 * evidencia clara de inglés, y nunca descarta titulares cortos (donde no hay
 * suficientes palabras para decidir con seguridad).
 */

// Palabras que solo existen en español (sin ambigüedad con el inglés).
const STOP_ES = new Set([
  'de', 'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'y', 'que', 'con',
  'para', 'por', 'del', 'se', 'su', 'sus', 'como', 'más', 'pero', 'este', 'esta',
  'estos', 'estas', 'según', 'entre', 'sobre', 'desde', 'puede', 'podría', 'han',
  'será', 'serán', 'dos', 'tres', 'años', 'día', 'días', 'mes', 'meses', 'nuevo',
  'nueva', 'nuevos', 'nuevas', 'ciencia', 'científico', 'científica', 'también',
  'cada', 'otro', 'otra', 'sin', 'sobre', 'hacia', 'ante', 'durante', 'mientras',
  'descubre', 'hallazgo', 'investigadores', 'estudio', 'mundo', 'país', 'gobierno'
]);

// Palabras que solo existen en inglés.
const STOP_EN = new Set([
  'the', 'of', 'and', 'to', 'in', 'is', 'are', 'was', 'were', 'for', 'on', 'with',
  'that', 'this', 'from', 'has', 'have', 'will', 'its', 'says', 'said', 'after',
  'over', 'how', 'why', 'their', 'they', 'them', 'you', 'your', 'our', 'not',
  'but', 'new', 'more', 'can', 'could', 'would', 'about', 'into', 'than', 'what',
  'who', 'when', 'where', 'which', 'been', 'were', 'his', 'her', 'she', 'here'
]);

/**
 * Devuelve true si el texto parece estar en español (o no hay evidencia clara
 * de que esté en inglés).
 */
export function isProbablySpanish(text) {
  const words = normalizeForMatch(text).split(' ').filter(Boolean);
  // Titulares muy cortos: no hay suficiente señal, no arriesgamos.
  if (words.length < 6) return true;

  let es = 0;
  let en = 0;
  for (const w of words) {
    if (STOP_ES.has(w)) es++;
    else if (STOP_EN.has(w)) en++;
  }

  if (en === 0) return true;
  // Inglés si hay 2+ marcadores y superan claramente a los españoles.
  // Con 1 solo marcador no se descarta: un titular español puede traer
  // una palabra-functional en inglés sin dejar de ser español.
  return !(en >= 2 && en > es + 1);
}

// ─── Caché en memoria ────────────────────────────────────────────────────────
//
// Problemas medidos en producción y cómo se corrigen aquí:
//
//  1. DESCARGA SECUENCIAL: con 30 feeds y ~16 s por feed caído, la primera
//     carga tardaba más de 5 minutos. Ahora se descargan EN PARALELO con un
//     límite de concurrencia: el tiempo pasa a ser el del feed más lento, no la
//     suma de todos.
//
//  2. REINTENTOS QUE EMPEORAN EL RATE LIMIT: cuando Google News empezó a
//     devolver 503 a los 19 de sus feeds, reintentar uno por uno solo alargaba
//     la espera. Ahora se falla rápido ante 503 y, si un host falla varias
//     veces seguidas, queda BLOQUEADO un rato (circuit breaker) y no se vuelve a
//     intentar hasta que expire.
//
//  3. FUSIÓN SIN PÉRDIDA: lo que ya teníamos se conserva aunque su feed falle.
//
//  4. CACHÉ: el endpoint responde al instante desde memoria y refresca aparte.
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const FEED_TIMEOUT_MS = 8000;
const CONCURRENCY = 10;
const BREAKER_FAILS = 3;        // fallos seguidos para bloquear un host
const BREAKER_MS = 15 * 60 * 1000;

let cache = { at: 0, articles: [], feedsOk: 0, feedsFail: 0, discardedEN: 0 };
let inflight = null;

/** Hosts bloqueados temporalmente: host -> { fails, until } */
const breaker = new Map();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function hostOf(url) {
  try { return new URL(url).host; } catch { return url; }
}

/**
 * ¿Este fragmento de texto parece el nombre de un medio?
 *
 * Un medio es corto, sin comas ni puntos suspensivos, y puede llevar punto si es
 * un dominio ("tribunanoticias.mx", "elDiario.es"). Los RSS de Google News
 * siempre acaban el titular con " - Medio", así que lo que hay que descartar es
 * sobre todo una cola de frase.
 */
function pareceMedio(texto) {
  const cand = String(texto || '').trim();
  if (!cand) return false;
  if (cand.length > 45) return false;
  if (cand.split(/\s+/).length > 6) return false;

  // Se permite el punto de los dominios y se descarta el resto de la puntuación,
  // que en un titular indica que lo que hay es una frase.
  const sinDominio = cand.replace(/\.(?:com|mx|net|org|es|ar|co|uk|eu|io)\b/gi, '');
  if (/[.!?;:,]/.test(sinDominio)) return false;

  return true;
}

/**
 * Devuelve el MEDIO de publicación, o null si no se puede averiguar.
 *
 * Muchos RSS ponen el formato "Titular - Medio", y de ahí se tomaba el medio con
 * split(' - ').pop(). El problema es que si el titular NO lleva ese sufijo —como
 * pasa en La Vanguardia, RTVE, elDiario.es o las secciones de ABC— el split no
 * parte en nada y devuelve el TITULAR ENTERO. En el video quedaba escrito
 * "Fuente: Mientras anuncia márgenes récord y más fábricas, el CEO de Micron
 * avisa de la crisis de RAM", que es el titular entero.
 *
 * Se resuelve en tres pasos, de más fiable a menos:
 *   1. El elemento <source> del propio RSS, que es el medio real.
 *   2. El sufijo "Titular - Medio", validado con pareceMedio().
 *   3. El nombre del feed sin la sección ("ABC - Ciencia" → "ABC").
 *
 * Devuelve null cuando nada de eso identifica a una publicación real: las
 * consultas de Google News no son medios, y poner "Fuente: Google News"
 * sería mentir. En ese caso el video simplemente no lleva etiqueta de fuente.
 */
function medioDePublicacion(feedTitle, rssSource, feedName) {
  const fuente = typeof rssSource === 'string' ? rssSource : rssSource?.name || rssSource?.title;
  if (typeof fuente === 'string') {
    const limpio = fuente.replace(/<[^>]*>/g, '').trim();
    if (pareceMedio(limpio)) return limpio;
  }

  const limpio = String(feedTitle || '').trim();
  for (const sep of [' - ', ' | ', ' — ', ' – ']) {
    const corte = limpio.lastIndexOf(sep);
    if (corte === -1) continue;
    const candidato = limpio.slice(corte + sep.length).trim();
    if (pareceMedio(candidato)) return candidato;
  }

  // Nombre del feed sin la sección. Solo si el propio feed es un medio: las
  // consultas de Google News ("Google News - Astronomía") no lo son.
  const nombre = String(feedName || '').split(' - ')[0].trim();
  if (nombre && !/^google news$/i.test(nombre)) return nombre;
  return null;
}

function hostBlocked(host) {
  const st = breaker.get(host);
  if (!st) return false;
  if (Date.now() < st.until) return true;
  breaker.delete(host);
  return false;
}

function noteHostResult(host, ok) {
  if (ok) { breaker.delete(host); return; }
  const st = breaker.get(host) || { fails: 0, until: 0 };
  st.fails++;
  if (st.fails >= BREAKER_FAILS) {
    st.until = Date.now() + BREAKER_MS;
    console.warn(`⚡ Circuit breaker: ${host} bloqueado ${BREAKER_MS / 60000} min tras ${st.fails} fallos`);
  }
  breaker.set(host, st);
}

/**
 * Un intento de lectura con timeout propio.
 *
 * No se pasa `timeout` a rss-parser: en la versión instalada su manejador de
 * tiempo agota con "callback is not a function" y tumba el proceso. Usamos
 * Promise.race, que además permite distinguir timeout de error real.
 *
 * Solo se reintenta ante 429 (límite de tasa leve). Un 503 es bloqueo duro
 * (p. ej. Google News con la IP compartida de Cloud Run): reintentar solo
 * alarga la espera, así que se falla rápido.
 */
async function readFeed(feed) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), FEED_TIMEOUT_MS);
    });
    try {
      return await Promise.race([parser.parseURL(feed.url), timeout]);
    } catch (error) {
      if (/\b429\b/.test(error.message || '') && attempt === 1) {
        await sleep(700);
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('sin reintentos');
}

/**
 * Descarga todos los feeds EN PARALELO con concurrencia limitada.
 * Los hosts bajo circuit breaker se saltan sin gastar tiempo.
 */
async function fetchFeedsFresh() {
  const now = Date.now();
  const collected = [];
  let ok = 0;
  let fail = 0;
  let discardedEN = 0;
  let skipped = 0;

  const cola = RSS_FEEDS.filter(f => {
    const host = hostOf(f.url);
    if (hostBlocked(host)) { skipped++; return false; }
    return true;
  });

  let cursor = 0;
  async function worker() {
    while (cursor < cola.length) {
      const feed = cola[cursor++];
      const host = hostOf(feed.url);
      try {
        const parsed = await readFeed(feed);
        noteHostResult(host, true);
        ok++;
        for (const item of (parsed.items || []).slice(0, 25)) {
          const rawDate = item.pubDate || item.isoDate || item.date;
          const parsedDate = rawDate ? new Date(rawDate) : new Date();
          const timestamp = isNaN(parsedDate.getTime()) ? now : parsedDate.getTime();
          if ((now - timestamp) > MAX_AGE_MS || timestamp > now + 86400000) continue;

          const title = item.title?.replace(/ - .*$/, '').trim() || 'Sin título';
          const snippet = item.contentSnippet || item.content || '';

          // Descartar artículos claramente en inglés.
          if (!isProbablySpanish(`${title} ${snippet}`)) {
            discardedEN++;
            continue;
          }

          collected.push({
            title,
            source: medioDePublicacion(item.title, item.source, feed.name),
            link: item.link,
            timestamp,
            pubDate: formatRelativeDate(timestamp),
            category: classifyNewsByContent(title, snippet, feed.category),
            feedCategory: feed.category,
            feedName: feed.name,
            snippet: String(snippet).slice(0, 200)
          });
        }
      } catch (error) {
        noteHostResult(host, false);
        fail++;
        console.error(`Error al leer ${feed.name}: ${error.message}`);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, cola.length) }, () => worker())
  );

  // Fusión sin pérdida: lo nuevo manda, pero lo que ya teníamos y no volvió
  // (porque su feed falló) se conserva.
  const merged = new Map();
  for (const art of collected) merged.set(art.title.toLowerCase().trim(), art);
  let preserved = 0;
  for (const art of cache.articles) {
    const key = art.title.toLowerCase().trim();
    if (!merged.has(key) && (now - art.timestamp) <= MAX_AGE_MS) {
      merged.set(key, art);
      preserved++;
    }
  }

  if (skipped) console.log(`⏭️ ${skipped} feeds omitidos por circuit breaker`);
  return { articles: [...merged.values()], ok, fail, preserved, discardedEN };
}

/** Refresca la caché una sola vez a la vez. */
async function refreshCache() {
  try {
    const { articles, ok, fail, preserved, discardedEN } = await fetchFeedsFresh();
    cache = { at: Date.now(), articles, feedsOk: ok, feedsFail: fail, discardedEN };
    console.log(`📰 Noticias actualizadas: ${articles.length} articulos (feeds ok=${ok} fail=${fail}, preservados=${preserved}, descartados_EN=${discardedEN})`);
  } catch (error) {
    console.error('Fallo refrescando noticias:', error.message);
  } finally {
    inflight = null;
  }
}

/**
 * Devuelve las noticias filtradas por categoría.
 *
 * @param {string} category
 * @param {Object} options
 * @param {boolean} options.force  Fuerza refresco (botón "Actualizar noticias").
 */
export async function fetchAllNews(category = 'todas', { force = false } = {}) {
  const stale = Date.now() - cache.at > CACHE_TTL_MS;
  const firstLoad = cache.articles.length === 0;

  if (force || stale || firstLoad) {
    if (!inflight) inflight = refreshCache();

    if (firstLoad) {
      await inflight;                       // sin caché: hay que esperar
    } else if (force) {
      await inflight;                       // el usuario pidió actualizar
    } else {
      // Refresco stale: respondemos ya con lo cacheado y actualizamos aparte.
      inflight.catch(() => {});
    }
  }

  let result = cache.articles;
  if (category && category !== 'todas') {
    result = result.filter(art => art.category === category);
  }

  return [...result].sort((a, b) => b.timestamp - a.timestamp);
}

/** Estado de la caché, para diagnóstico. */
export function getNewsCacheStats() {
  return {
    articulos: cache.articles.length,
    antiguedadSeg: Math.round((Date.now() - cache.at) / 1000),
    feedsOk: cache.feedsOk,
    feedsFallidos: cache.feedsFail,
    descartadosEnIngles: cache.discardedEN
  };
}

function formatRelativeDate(timestamp) {
  const diffHours = Math.floor((Date.now() - timestamp) / (1000 * 60 * 60));
  const diffDays = Math.floor(diffHours / 24);
  const dateObj = new Date(timestamp);
  const formattedDate = dateObj.toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' });

  if (diffHours < 1) return '⚡ Hace unos momentos';
  if (diffHours < 24) return `🕒 Hace ${diffHours} h (${formattedDate})`;
  if (diffDays === 1) return `📅 Ayer (${formattedDate})`;
  if (diffDays <= 30) return `📅 Hace ${diffDays} días (${formattedDate})`;
  return formattedDate;
}
export { classifyNewsByContent };
