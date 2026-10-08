// ─────────────────────────────────────────────────────────────────────────────
// Pipeline automático: de una categoría a un MP4 listo para publicar.
//
// Existe para que un orquestador externo (n8n) pueda pedir "un video de
// astronomía" con UNA sola llamada, en lugar de encadenar los cuatro endpoints
// que usa la interfaz (/generate-script, /generate-audio, /find-media,
// /render-video) y tener que interpretar el SSE del render.
//
// No duplica lógica: llama a los mismos servicios que usa la web, que ya están
// probados. Solo los encadena y devuelve un JSON limpio.
//
// Aquí NO se generan imágenes ni se publican videos: eso es trabajo de n8n.
// ─────────────────────────────────────────────────────────────────────────────

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { Storage } from '@google-cloud/storage';

import { fetchAllNews } from './newsService.js';
import { generateScriptWithGemini } from './geminiService.js';
import { normalizarGuionMexicano } from './lexicon.js';
import { generateAudioForScript } from './ttsService.js';
import { findMediaForScenes } from './mediaService.js';
import { renderFinalVideo, buildRenderScenes } from './videoRenderService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..', '..');

// ─── Google Cloud Storage ────────────────────────────────────────────────────
//
// Cloud Run tiene un disco EFÍMERO: el MP4 desaparece cuando la instancia se
// reinicia, y la URL que devuelve el render deja de funcionar a los pocos
// minutos. Para que el video sobreviva (y las redes puedan descargarlo cuando
// quieran), se sube a un bucket de GCS, que es permanente.
//
// El bucket es público de lectura a propósito: los videos van a parar a redes
// sociales, así que no tienen por qué ser privados. El nombre del bucket es
// suficientemente largo y aleatorio como para que no lo encuentren por azar.
const BUCKET = 'ciencia-cool-videos-271857970093';
const storage = new Storage();

/**
 * Sube el MP4 al bucket y devuelve su URL pública permanente.
 *
 * El bucket tiene acceso uniforme a nivel de bucket (UBLA) y una política IAM
 * que da lectura pública a allUsers. Con UBLA NO se puede llamar a makePublic()
 * por objeto — Google lo rechaza con "Cannot update access control for an
 * object when uniform bucket-level access is enabled". No hace falta: la
 * política del bucket ya hace públicos a todos los objetos.
 *
 * Si la subida falla, se devuelve null y el pipeline sigue: mejor un video que
 * solo existe en Cloud Run (y dura 5 minutos) que no tener video.
 */
async function subirAGcs(videoPath, nombreArchivo) {
  try {
    const bucket = storage.bucket(BUCKET);
    const archivo = bucket.file(nombreArchivo);

    await new Promise((resolve, reject) => {
      fs.createReadStream(videoPath)
        .pipe(archivo.createWriteStream({
          metadata: { contentType: 'video/mp4' },
          resumable: false,
        }))
        .on('error', reject)
        .on('finish', resolve);
    });

    // No se llama a makePublic(): con UBLA la política IAM del bucket ya hace
    // público el objeto. Llamarlo rompe la subida.
    const url = `https://storage.googleapis.com/${BUCKET}/${nombreArchivo}`;
    return url;
  } catch (error) {
    console.error('No se pudo subir a GCS:', error.message);
    return null;
  }
}

const CATEGORIAS_VALIDAS = new Set([
  'astronomia', 'ciencia', 'tecnologia', 'medicina', 'videojuegos', 'medio_ambiente',
]);

// Rotación de categorías, para que una tanda cubra todas sin repetir la misma.
const ROTACION = ['astronomia', 'ciencia', 'tecnologia', 'medio_ambiente', 'medicina', 'videojuegos'];

// Recuerda la última noticia usada en cada categoría para no repetirla mañana.
// Vive en memoria porque el disco de Cloud Run es efímero: si la instancia se
// reinicia se empieza de cero, que es un fallo aceptable.
const ultimaNoticia = {};
let indiceRotacion = 0;

// ─── Control de concurrencia ────────────────────────────────────────────────
//
// Medido en producción: un pipeline en solitario tarda ~165 s, pero TRES a la vez
// tardan 386-437 s (el render se va de 103 s a más de 300 s). No fallan, pero se
// triplican el tiempo y cada respuesta individual queda a un Raquitazo del límite
// de 600 s de Cloud Run y del de 480 s del nodo HTTP de n8n.
//
// El render va con ffmpeg en un contenedor de 2 vCPU, así que correr varios a la
// vez no da más rendimiento: se reparten la CPU y no rinden más. Medido: hacer 3
// en serie tarda lo MISMO en total que hacerlos en paralelo (309 s), pero en
// serie cada petición se responde en ~165 s en vez de ~437 s. Esa es la gracia:
// no gana rendimiento, gana PREDICTIBILIDAD, y es lo que evita que una petición
// se pase de los 600 s y Cloud Run la corte a mitad.
//
// La cola es de 1 solo. Con 2 esperando, el último tardaría 200 s de espera más
// 200 s de render, y sumando el arranque en frío se acercaría al límite. Es mejor
// responder 429 rápido y que el orquestador reintente en un par de minutos.
const MAX_CONCURRENTES = 1;
const MAX_EN_COLA = 1;

let enCurso = 0;
let enCola = 0;

/**
 * Ejecuta `tarea` esperando turno si ya hay otra en marcha.
 * Si la cola está llena lanza PipelineBusyError para que el endpoint responda 429.
 */
async function conTurno(tarea) {
  if (enCurso >= MAX_CONCURRENTES) {
    if (enCola >= MAX_EN_COLA) {
      const err = new Error(
        `El servidor ya tiene ${enCurso} generación en marcha y ${enCola} en cola. ` +
        `Reintenta en unos minutos.`
      );
      err.codigo = 'PIPELINE_BUSY';
      throw err;
    }
    enCola++;
    try {
      while (enCurso >= MAX_CONCURRENTES) {
        await new Promise(r => setTimeout(r, 2000));
      }
    } finally {
      enCola--;
    }
  }
  enCurso++;
  try {
    return await tarea();
  } finally {
    enCurso--;
  }
}

export function estadoPipeline() {
  return { enCurso, enCola, maxConcurrentes: MAX_CONCURRENTES, maxCola: MAX_EN_COLA };
}

// ─── Caché de resultados por jobId ──────────────────────────────────────────
//
// Si n8n reintenta (una caída de red, un timeout) volvería a generar y a
// publicar OTRO video del mismo tema. Con jobId se devuelve el resultado que ya
// se tenía en vez de repetir el trabajo.
//
// Vive en memoria: si la instancia se reinicia se pierde, pero tampoco sobrevive
// el MP4 (el disco es efímero), así que el caché caduca antes que el archivo.
const CACHE_TTL_MS = 2 * 60 * 60 * 1000;
const resultados = new Map();

function guardarResultado(jobId, data) {
  resultados.set(jobId, { data, at: Date.now() });
  // Limpieza perezosa: no hace falta un temporizador para esto.
  if (resultados.size > 50) {
    const ahora = Date.now();
    for (const [k, v] of resultados) {
      if (ahora - v.at > CACHE_TTL_MS) resultados.delete(k);
    }
  }
}

function leerResultado(jobId) {
  if (!jobId) return null;
  const guardado = resultados.get(jobId);
  if (!guardado) return null;
  if (Date.now() - guardado.at > CACHE_TTL_MS) {
    resultados.delete(jobId);
    return null;
  }
  return guardado.data;
}

/**
 * Elige la noticia sobre la que hacer el video.
 *
 * Con `topic` explícito se respeta al pie de la letra (útil para probar o para
 * publicar un tema concreto). Sin él, se toma la más reciente de la categoría
 * evitando repetir la última de esa misma categoría.
 */
async function elegirNoticia({ categoria, topic }) {
  if (topic && topic.trim()) {
    return {
      topic: topic.trim(),
      newsContext: '',
      category: categoria || 'ciencia',
      source: '',
      newsTitle: '',
    };
  }

  const cat = CATEGORIAS_VALIDAS.has(categoria) ? categoria : 'todas';
  const noticias = await fetchAllNews(cat);

  if (!noticias.length) {
    // Sin noticias no hay contexto, pero el pipeline puede seguir con un tema
    // genérico: peor un video flojo que un día sin publicar.
    const genérica = cat === 'todas' ? 'ciencia' : cat;
    return {
      topic: `${genérica} descubrimiento reciente`,
      newsContext: '',
      category: genérica,
      source: '',
      newsTitle: '',
    };
  }

  const ordenadas = [...noticias].sort((a, b) => b.timestamp - a.timestamp);
  const anterior = ultimaNoticia[cat];
  const elegida = (anterior && ordenadas.length > 1)
    ? (ordenadas.find(a => a.title !== anterior) || ordenadas[0])
    : ordenadas[0];
  ultimaNoticia[cat] = elegida.title;

  return {
    topic: elegida.title,
    newsContext: elegida.snippet
      ? `${elegida.snippet} (Fuente: ${elegida.source || 'desconocida'})`
      : '',
    category: elegida.category || (cat === 'todas' ? 'ciencia' : cat),
    source: elegida.source || '',
    newsTitle: elegida.title,
  };
}

/**
 * Arma el paquete de publicación.
 *
 * YouTube y TikTok/Instagram tienen límites distintos: el texto largo va para
 * YouTube y el corto para los otros dos, que truncan pasado cierto número de
 * caracteres. Se devuelven ambos y que n8n elija.
 */
function construirPublicacion(script, noticia) {
  const titulo = (script?.title || noticia.topic || 'CIENCIA COOL').trim();
  const descripcionGemini = (script?.description || '').trim();

  // Si Gemini no dio descripción, se arma con lo que ya hay: los textos en
  // pantalla de cada escena resumen el video sin inventar nada.
  const resumen = descripcionGemini || (script?.scenes || [])
    .map(s => s.onscreenText || s.badge)
    .filter(Boolean)
    .join(' · ');

  const hashtags = [...new Set([
    ...(Array.isArray(script?.hashtags) ? script.hashtags : []),
    '#cienciacool',
    '#shorts',
  ])].map(h => (String(h).trim().startsWith('#') ? h.trim() : `#${h.trim()}`));

  const descripcion = [
    resumen,
    '',
    noticia.source ? `Fuente: ${noticia.source}` : '',
    'Video generado automáticamente con CIENCIA COOL.',
    '',
    hashtags.join(' '),
  ].filter(Boolean).join('\n');

  const resumenCorto = [resumen, hashtags.join(' ')].filter(Boolean).join(' ');
  const caption = resumenCorto.length > 300 ? `${resumenCorto.slice(0, 297)}...` : resumenCorto;

  return { titulo, descripcion, caption, hashtags };
}

/**
 * Ejecuta el pipeline completo: noticia → guion → audio → medios → MP4.
 *
 * @param {object} opts
 * @param {string} [opts.categoria]        categoría de la noticia
 * @param {string} [opts.topic]           tema explícito (ignora la selección de noticia)
 * @param {string} [opts.voiceId]          voz a usar (por defecto, GIR)
 * @param {string} [opts.format]           formato del guion
 * @param {string} [opts.brandingMode]     'watermark_only' | 'none'
 * @param {string} [opts.watermarkPos]
 * @param {number} [opts.watermarkOpacity]
 * @param {string} [opts.jobId]            si se repite, devuelve el resultado anterior
 * @param {boolean} [opts.dryRun]          valida y devuelve el plan sin generar nada
 * @param {(msg: string) => void} [opts.onProgress]
 */
export async function ejecutarPipeline(opts = {}) {
  const {
    categoria,
    topic,
    voiceId = 'robot-gir',
    format = 'noticia_resumida',
    brandingMode = 'watermark_only',
    watermarkPos = 'top-left',
    watermarkOpacity = 0.40,
    jobId = null,
    dryRun = false,
    onProgress = () => {},
  } = opts;

  const log = (m) => onProgress(`[pipeline] ${m}`);

  // ── Reintento del mismo jobId: no se vuelve a generar ─────────────────────
  if (jobId) {
    const previo = leerResultado(jobId);
    if (previo) {
      const existe = fs.existsSync(path.join(projectRoot, 'outputs', 'video', previo.videoFilename));
      if (existe) {
        log(`Job ${jobId} ya se había generado: se devuelve el resultado anterior.`);
        return { ...previo, jobId, reutilizado: true };
      }
      // El MP4 ya no está (la instancia se reinició): el caché no sirve.
      log(`Job ${jobId}: el video anterior ya no existe, se regenera.`);
      resultados.delete(jobId);
    }
  }

  // ── Ensayo: no genera nada, solo dice qué haría ───────────────────────────
  if (dryRun) {
    const cat = categoria && CATEGORIAS_VALIDAS.has(categoria) ? categoria : 'todas';
    const prevista = topic ? topic.trim() : '(la noticia más reciente de la categoría)';
    log('Modo ensayo: no se genera nada.');
    return {
      dryRun: true,
      jobId,
      categoriaPedida: categoria || '(rotación automática)',
      categoriaValida: CATEGORIAS_VALIDAS.has(categoria),
      categoriasValidas: [...CATEGORIAS_VALIDAS],
      temaPrevisto: prevista,
      voiceId,
      format,
      mensaje: 'Ensayo correcto. Para generar de verdad, quita "dryRun": true.',
    };
  }

  // ── El render va con turno: uno a la vez, con cola corta ──────────────────
  return conTurno(async () => {
    const tiempos = {};
    const marcar = (nombre, desde) => {
      tiempos[nombre] = Math.round((Date.now() - desde) / 1000);
      log(`⏱️ ${nombre}: ${tiempos[nombre]}s`);
    };

    // ── 1. Noticia ────────────────────────────────────────────────────────────
    let paso = Date.now();
    const catElegida = categoria || ROTACION[indiceRotacion++ % ROTACION.length];
    log(`Categoría: ${catElegida}${topic ? ' (tema explícito)' : ''}`);
    const noticia = await elegirNoticia({ categoria: catElegida, topic });
    log(`Noticia: ${noticia.newsTitle || noticia.topic}`);
    marcar('noticia', paso);

    // ── 2. Guion ──────────────────────────────────────────────────────────────
    paso = Date.now();
    log('Generando guion...');
    const guionCrudo = await generateScriptWithGemini({
      topic: noticia.topic,
      newsContext: noticia.newsContext,
      format,
      // GIR es el narrador del canal; se deduce del prefijo del voiceId.
      personality: String(voiceId).startsWith('robot-gir') ? 'gir' : 'asistente',
  });
    const script = normalizarGuionMexicano(guionCrudo);
    log(`Guion listo: ${(script.scenes || []).length} escenas`);
    marcar('guion', paso);

    // ── 3. Audio ──────────────────────────────────────────────────────────────
    paso = Date.now();
    log('Generando audio (es el paso que más tarda)...');
    const audioResult = await generateAudioForScript(script, voiceId);
    log(`Audio listo: ${audioResult.fullAudioFilename}`);
    marcar('audio', paso);

    // ── 4. Medios ─────────────────────────────────────────────────────────────
    paso = Date.now();
    log('Buscando video de stock...');
    const mediaMatches = await findMediaForScenes(script);
    log(`Medios listos: ${(mediaMatches || []).length} escenas`);
    marcar('medios', paso);

    // ── 5. Render ─────────────────────────────────────────────────────────────
    const fullAudioPath = path.join(projectRoot, 'outputs', 'audio', audioResult.fullAudioFilename);
    if (!fs.existsSync(fullAudioPath)) {
      throw new Error(`Audio no encontrado: ${audioResult.fullAudioFilename}`);
    }

    const scenes = buildRenderScenes(script, mediaMatches || [], audioResult);
    if (!scenes || scenes.length === 0) {
      throw new Error('No se encontraron escenas en el guion.');
    }

    const robotImagePath = path.join(projectRoot, 'public', 'assets', 'robot_host.jpg');
    const logoPath = path.join(projectRoot, 'public', 'assets', 'logo.jpg');

    log(`Renderizando ${scenes.length} escenas...`);
    const resultado = await renderFinalVideo({
      scenes,
      fullAudioPath,
      robotImagePath: fs.existsSync(robotImagePath) ? robotImagePath : null,
      logoPath: fs.existsSync(logoPath) ? logoPath : null,
      brandName: process.env.BRAND_NAME || 'CIENCIA COOL',
      source: noticia.source,
      category: script.category || noticia.category || '',
      brandingMode,
      watermarkPos,
      watermarkOpacity,
      onProgress: log,
  });

    const stat = fs.existsSync(resultado.videoPath) ? fs.statSync(resultado.videoPath) : { size: 0 };
    marcar('render', paso);
    const pub = construirPublicacion(script, noticia);

    // Subir a GCS para que el video sobreviva al disco efímero de Cloud Run.
    // Sin esto, la URL del render deja de funcionar a los minutos de generarse.
    paso = Date.now();
    log('Subiendo el video a Google Cloud Storage...');
    const urlGcs = stat.size > 0
      ? await subirAGcs(resultado.videoPath, resultado.filename)
      : null;
    if (urlGcs) {
      log(`Video disponible en GCS: ${urlGcs}`);
    } else {
      log('No se pudo subir a GCS; se devuelve la URL de Cloud Run (temporal).');
    }
    marcar('subida a GCS', paso);

    const salida = {
      videoUrl: resultado.videoUrl,
      videoUrlAbsoluta: urlGcs || resultado.videoUrl,
      videoUrlGcs: urlGcs,
      videoFilename: resultado.filename,
      sizeBytes: stat.size,
      title: pub.titulo,
      description: pub.descripcion,
      caption: pub.caption,
      hashtags: pub.hashtags,
      category: script.category || noticia.category || '',
      source: noticia.source,
      newsTitle: noticia.newsTitle,
      voiceId,
      sceneCount: (script.scenes || []).length,
      tiempos,
    };

    if (jobId) {
      guardarResultado(jobId, salida);
      log(`Job ${jobId} guardado para reintentos.`);
    }

    return { ...salida, jobId, reutilizado: false };
  });
}