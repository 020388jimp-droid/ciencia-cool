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

import { fetchAllNews } from './newsService.js';
import { generateScriptWithGemini } from './geminiService.js';
import { normalizarGuionMexicano } from './lexicon.js';
import { generateAudioForScript } from './ttsService.js';
import { findMediaForScenes } from './mediaService.js';
import { renderFinalVideo, buildRenderScenes } from './videoRenderService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..', '..');

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
    onProgress = () => {},
  } = opts;

  const log = (m) => onProgress(`[pipeline] ${m}`);

  // Cronómetro por paso. El desglose se devuelve junto al resultado para poder
  // ver de un vistazo dónde se va el tiempo (lo normal es que el audio domine).
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

  return {
    videoUrl: resultado.videoUrl,
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
}