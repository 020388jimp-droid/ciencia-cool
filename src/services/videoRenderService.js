// src/services/videoRenderService.js
// Motor de renderizado de video para CIENCIA COOL
// Combina: video de fondo NASA + audio TTS + robot avatar (PiP) + marca de agua

import path from 'path';
import fs from 'fs';
import https from 'https';
import http from 'http';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { searchFreeMedia } from './mediaService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..', '..');

const ASSETS_DIR = path.join(projectRoot, 'public', 'assets');
const VIDEO_OUTPUT_DIR = path.join(projectRoot, 'outputs', 'video');
const TEMP_DIR = path.join(projectRoot, 'outputs', 'temp');

// Crear directorios necesarios
[VIDEO_OUTPUT_DIR, TEMP_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// Detectar ffmpeg: en Alpine Docker usa el del PATH; en Windows usa @ffmpeg-installer
async function getFfmpegPath() {
  // Intentar @ffmpeg-installer (disponible en node_modules)
  try {
    const mod = await import('@ffmpeg-installer/ffmpeg');
    const p = mod.default?.path || mod.path;
    if (p && fs.existsSync(p)) return p;
  } catch (_) {}
  // Fallback: ffmpeg del PATH del sistema (Alpine apk / macOS brew / Windows)
  return 'ffmpeg';
}

let _ffmpegPath = null;
async function ensureFfmpeg() {
  if (!_ffmpegPath) _ffmpegPath = await getFfmpegPath();
  return _ffmpegPath;
}

/**
 * Descarga un archivo desde una URL a una ruta local.
 */
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(destPath);
    proto.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        // Follow redirect
        file.close();
        return downloadFile(response.headers.location, destPath).then(resolve).catch(reject);
      }
      if (response.statusCode !== 200) {
        file.close();
        return reject(new Error(`HTTP ${response.statusCode} descargando ${url}`));
      }
      response.pipe(file);
      file.on('finish', () => { file.close(); resolve(destPath); });
    }).on('error', (err) => {
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

/**
 * Ejecuta un comando ffmpeg y retorna una Promise.
 */
async function runFfmpeg(args) {
  const ffmpegPath = await ensureFfmpeg();
  return new Promise((resolve, reject) => {
    console.log(`🎬 FFmpeg: ${ffmpegPath} ${args.slice(0, 5).join(' ')}...`);
    const proc = spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        console.error('FFmpeg error:', stderr.slice(-800));
        reject(new Error(`FFmpeg terminó con código ${code}. ${stderr.slice(-200)}`));
      }
    });
    proc.on('error', (err) => reject(new Error(`No se pudo iniciar FFmpeg: ${err.message}`)));
  });
}

/**
 * Genera un clip de video de color sólido con duración dada (fallback cuando no hay video).
 */
async function generateSolidColorClip(durationSec, outputPath, color = '0x0a0a1a') {
  await runFfmpeg([
    '-f', 'lavfi',
    '-i', `color=c=${color}:size=1080x1920:rate=30`,
    '-t', String(durationSec),
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-y', outputPath
  ]);
  return outputPath;
}

/**
 * Preprocesa un clip de video: recorta, escala a 1080x1920 (9:16) y aplica subtítulo.
 * Nota: Para subtítulos usamos drawtext de ffmpeg directamente.
 */
async function prepareSceneClip({ inputPath, durationSec, subtitle, index, audioPartPath }) {
  const outputPath = path.join(TEMP_DIR, `scene_${index}_ready.mp4`);

  // Wrap text into multiple lines (max ~28 chars per line for 1080p width at fontsize 42)
  let wrappedSubtitle = '';
  let currentLine = '';
  const words = (subtitle || '').split(' ');
  for (const word of words) {
    if ((currentLine + word).length > 28) {
      wrappedSubtitle += currentLine.trim() + '\n';
      currentLine = word + ' ';
    } else {
      currentLine += word + ' ';
    }
  }
  wrappedSubtitle += currentLine.trim();

  // Texto del subtítulo (escape de caracteres especiales para ffmpeg drawtext)
  const escapedSubtitle = wrappedSubtitle
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/,/g, '\\,')
    .slice(0, 300); // máximo 300 chars en total

  // Fuente para subtítulos (DejaVu es estándar en Alpine)
  const fontPath = '/usr/share/fonts/ttf-dejavu/DejaVuSans-Bold.ttf';
  const fontFallback = 'Arial'; // fallback Windows

  // Filtro de video: escalar + crop a 9:16 + subtítulo centrado abajo
  const videoFilter = [
    // Escalar preservando aspect ratio y rellenando a 1080x1920
    'scale=1080:1920:force_original_aspect_ratio=increase',
    'crop=1080:1920',
    // Subtítulo principal
    `drawtext=text='${escapedSubtitle}':fontsize=52:fontcolor=white:x=(w-text_w)/2:y=h-400:box=1:boxcolor=black@0.65:boxborderw=15`
  ].join(',');

  const args = [
    '-i', inputPath,
    '-t', String(durationSec),
    '-vf', videoFilter,
    '-r', '30',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-crf', '26',
    '-an', // sin audio (lo añadiremos al final)
    '-y', outputPath
  ];

  await runFfmpeg(args);
  return outputPath;
}

/**
 * Genera un clip de "tarjeta de título" como último recurso.
 * Solo se usa si no se encontró ningún video libre.
 */
async function generateTitleCard({ text, durationSec, index }) {
  const outputPath = path.join(TEMP_DIR, `title_${index}.mp4`);
  const escapedText = text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:').slice(0, 80);

  await runFfmpeg([
    '-f', 'lavfi',
    '-i', 'color=c=0x0a0a2e:size=1080x1920:rate=30',
    '-t', String(durationSec),
    '-vf', `drawtext=text='${escapedText}':fontsize=56:fontcolor=0x00e5ff:x=(w-text_w)/2:y=(h-text_h)/2:box=1:boxcolor=black@0.4:boxborderw=20:line_spacing=10`,
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-an',
    '-y', outputPath
  ]);
  return outputPath;
}

/**
 * Busca y descarga un video libre relacionado al tema como fallback.
 * Si no encuentra nada, usa la tarjeta de título.
 */
async function getFallbackVideoClip({ topic, subtitle, durationSec, index, onProgress }) {
  onProgress(`  🔍 Buscando video libre para "${topic.slice(0, 40)}"...`);
  try {
    const mediaResults = await searchFreeMedia(topic, { limit: 3, preferVideo: true });
    const videoResult = mediaResults.find(m => m.isVideo && m.videoUrl);

    if (videoResult) {
      const ext = videoResult.videoUrl.includes('.webm') ? '.webm' : '.mp4';
      const dlPath = path.join(TEMP_DIR, `fallback_dl_${index}${ext}`);
      await downloadFile(videoResult.videoUrl, dlPath);
      onProgress(`  ✅ Video libre encontrado: ${videoResult.source}`);

      return await prepareSceneClip({
        inputPath: dlPath,
        durationSec,
        subtitle,
        index: `${index}_fallback`
      });
    }
  } catch (err) {
    onProgress(`  ⚠️ No se encontró video libre: ${err.message}`);
  }

  // Último recurso: tarjeta de título
  onProgress(`  🃏 Usando tarjeta de título como último recurso`);
  return generateTitleCard({ text: subtitle, durationSec, index: `${index}_card` });
}

/**
 * Renderiza el video final completo.
 *
 * @param {Object} params
 * @param {Array}  params.scenes           - Escenas con { subtitle, videoUrl, durationSec }
 * @param {string} params.fullAudioPath    - Ruta absoluta al audio mp3 completo
 * @param {string} params.robotImagePath  - Ruta al avatar robot PNG (con fondo)
 * @param {string} params.logoPath        - Ruta al logo CIENCIA COOL
 * @param {string} params.brandName       - Nombre de la marca
 * @param {Function} params.onProgress    - Callback de progreso (msg)
 * @returns {Promise<{videoPath, videoUrl}>}
 */
export async function renderFinalVideo({
  scenes,
  fullAudioPath,
  robotImagePath,
  logoPath,
  brandName = 'CIENCIA COOL',
  brandingMode = 'alternate', // 'alternate' | 'watermark_only' | 'robot_only' | 'both' | 'none'
  watermarkPos = 'top-left',  // 'top-left' | 'top-right' | 'bottom-left'
  watermarkOpacity = 0.40,    // 40% opacidad (translúcido sutil)
  onProgress = console.log
}) {
  onProgress('🎬 Iniciando renderizado de video...');

  const timestamp = Date.now();
  const outputFilename = `ciencia_cool_${timestamp}.mp4`;
  const finalOutputPath = path.join(VIDEO_OUTPUT_DIR, outputFilename);

  // ─── FASE A: Preparar cada clip de escena ───────────────────────────────
  // Para cada escena:
  //   1. Descarga el video asignado (Pexels/Pixabay/NASA)
  //   2. Si falla → busca automáticamente un video libre del mismo tema
  //   3. Si no encuentra nada → genera tarjeta de título (último recurso)
  //   4. Aplica: escala a 9:16, recorta al tiempo de la escena, subtítulo
  const sceneClipPaths = [];
  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const clipDuration = scene.durationSec || 6;
    const sceneTopic = scene.topic || scene.subtitle?.slice(0, 60) || 'science';
    onProgress(`📥 Procesando escena ${i + 1}/${scenes.length}: "${sceneTopic.slice(0, 40)}"`);

    let inputVideoPath = null;

    // Paso 1: Intentar descargar el video pre-asignado de la escena
    if (scene.videoUrl) {
      try {
        const ext = scene.videoUrl.endsWith('.webm') ? '.webm' : '.mp4';
        const dlPath = path.join(TEMP_DIR, `dl_scene_${timestamp}_${i}${ext}`);
        await downloadFile(scene.videoUrl, dlPath);
        inputVideoPath = dlPath;
        onProgress(`  ✅ Video principal descargado (escena ${i + 1})`);
      } catch (dlErr) {
        onProgress(`  ⚠️ Error descargando video principal: ${dlErr.message}`);
      }
    }

    let clipPath;

    if (inputVideoPath && fs.existsSync(inputVideoPath)) {
      // Paso 2a: Video descargado → preparar (escalar, subtítulo)
      try {
        clipPath = await prepareSceneClip({
          inputPath: inputVideoPath,
          durationSec: clipDuration,
          subtitle: scene.subtitle || '',
          index: `${timestamp}_${i}`
        });
      } catch (prepErr) {
        onProgress(`  ⚠️ Error procesando clip: ${prepErr.message} → buscando alternativa`);
        // Fallo en procesamiento → buscar video libre
        clipPath = await getFallbackVideoClip({
          topic: sceneTopic,
          subtitle: scene.subtitle || '',
          durationSec: clipDuration,
          index: `${timestamp}_${i}`,
          onProgress
        });
      }
    } else {
      // Paso 2b: Sin video pre-asignado → buscar automáticamente video libre del tema
      clipPath = await getFallbackVideoClip({
        topic: sceneTopic,
        subtitle: scene.subtitle || '',
        durationSec: clipDuration,
        index: `${timestamp}_${i}`,
        onProgress
      });
    }

    sceneClipPaths.push(clipPath);
  }

  onProgress(`✅ ${sceneClipPaths.length} clips preparados. Concatenando...`);

  // ─── FASE B: Concatenar todos los clips ─────────────────────────────────
  const concatListPath = path.join(TEMP_DIR, `concat_${timestamp}.txt`);
  const concatContent = sceneClipPaths.map(p => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n');
  fs.writeFileSync(concatListPath, concatContent, 'utf8');

  const concatenatedPath = path.join(TEMP_DIR, `concat_${timestamp}.mp4`);
  await runFfmpeg([
    '-f', 'concat',
    '-safe', '0',
    '-i', concatListPath,
    '-c', 'copy',
    '-y', concatenatedPath
  ]);

  onProgress('🎵 Añadiendo locución de voz...');

  // ─── FASE C: Añadir audio TTS + overlay robot + logo translúcido ────────
  // Modos de branding admitidos:
  //   - 'alternate': Robot en Gancho (intro) y CTA (cierre); Marca de agua translúcida en la esquina durante todo el video.
  //   - 'watermark_only': Solo logo en esquina translúcido (40%), sin robot (deja libre la pantalla).
  //   - 'robot_only': Solo robot presentador en esquina inferior.
  //   - 'both': Robot y marca de agua translúcida simultáneos.
  //   - 'none': Video 100% limpio sin overlays.

  const allowRobot = (brandingMode === 'both' || brandingMode === 'robot_only' || brandingMode === 'alternate');
  const allowLogo  = (brandingMode === 'both' || brandingMode === 'watermark_only' || brandingMode === 'alternate');

  const hasRobot = allowRobot && Boolean(robotImagePath && fs.existsSync(robotImagePath));
  const hasLogo  = allowLogo && Boolean(logoPath && fs.existsSync(logoPath));

  // Tiempos para alternar (Hook inicial y CTA final)
  const hookDuration = scenes[0]?.durationSec || 4;
  const ctaDuration = scenes[scenes.length - 1]?.durationSec || 4;
  const totalDuration = scenes.reduce((acc, s) => acc + (s.durationSec || 6), 0);
  const ctaStart = Math.max(hookDuration, totalDuration - ctaDuration);

  // Construir argumentos de ffmpeg para compositing
  const ffmpegArgs = [
    '-i', concatenatedPath, // [0:v]
    '-i', fullAudioPath,    // [1:a]
  ];

  if (hasRobot) ffmpegArgs.push('-i', robotImagePath);  // [2:v]
  if (hasLogo)  ffmpegArgs.push('-i', logoPath);         // [3:v o 2:v]

  // Construir filtro complejo de forma segura (sin punto y coma final)
  const filterParts = [];
  let videoStreamLabel = '[0:v]';
  let inputIdx = 2;

  // 1. Robot Presentador (Overlay esquina inferior derecha)
  if (hasRobot) {
    const robotInputIdx = inputIdx++;
    filterParts.push(`[${robotInputIdx}:v]scale=220:220[robot]`);

    if (brandingMode === 'alternate') {
      filterParts.push(`${videoStreamLabel}[robot]overlay=W-250:H-260:enable='between(t,0,${hookDuration})+gte(t,${ctaStart})'[v_robot]`);
    } else {
      filterParts.push(`${videoStreamLabel}[robot]overlay=W-250:H-260[v_robot]`);
    }
    videoStreamLabel = '[v_robot]';
  }

  // 2. Marca de Agua (Logo en esquina en formato translúcido para no estorbar)
  if (hasLogo) {
    const logoInputIdx = inputIdx++;
    filterParts.push(`[${logoInputIdx}:v]scale=150:-1,format=rgba,colorchannelmixer=aa=${watermarkOpacity}[logo]`);

    let logoPos = '40:60'; // top-left (óptima para TikTok, Reels y Shorts)
    if (watermarkPos === 'top-right') {
      logoPos = 'W-w-40:60';
    } else if (watermarkPos === 'bottom-left') {
      logoPos = '40:H-h-120';
    }

    filterParts.push(`${videoStreamLabel}[logo]overlay=${logoPos}[v_final]`);
    videoStreamLabel = '[v_final]';
  } else if (allowLogo && !hasLogo) {
    const escapedBrand = brandName.replace(/'/g, "\\'").replace(/:/g, '\\:');
    let textPos = 'x=40:y=60';
    if (watermarkPos === 'top-right') textPos = 'x=w-text_w-40:y=60';
    else if (watermarkPos === 'bottom-left') textPos = 'x=40:y=h-text_h-120';

    filterParts.push(`${videoStreamLabel}drawtext=text='${escapedBrand}':fontsize=32:fontcolor=0x00e5ff@${watermarkOpacity}:${textPos}[v_final]`);
    videoStreamLabel = '[v_final]';
  }

  const filterComplex = filterParts.join('; ');
  const mapVideoStream = filterParts.length > 0 ? videoStreamLabel.replace(/^\[|\]$/g, '') : '0:v';

  const finalArgs = [
    ...ffmpegArgs,
    ...(filterComplex ? ['-filter_complex', filterComplex] : []),
    ...(filterComplex ? ['-map', `[${mapVideoStream}]`] : ['-map', '0:v']),
    '-map', '1:a',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-shortest', // cortar al más corto (audio o video)
    '-movflags', '+faststart',
    '-pix_fmt', 'yuv420p',
    '-y', finalOutputPath
  ];

  onProgress('🎨 Aplicando composición final (robot overlay + logo + audio)...');
  await runFfmpeg(finalArgs);

  // ─── FASE D: Limpieza de temporales ────────────────────────────────────
  const tempFiles = [...sceneClipPaths, concatListPath, concatenatedPath];
  tempFiles.forEach(f => { try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch (_) {} });

  onProgress(`🎉 Video renderizado: ${outputFilename}`);

  return {
    videoPath: finalOutputPath,
    videoUrl: `/video/${outputFilename}`,
    filename: outputFilename
  };
}

/**
 * Calcula la duración estimada por escena basándose en la cantidad de palabras.
 */
export function estimateSceneDuration(narrationText, wpm = 140) {
  const wordCount = (narrationText || '').split(/\s+/).filter(Boolean).length;
  const minDuration = 4;
  const estimated = Math.round((wordCount / wpm) * 60);
  return Math.max(minDuration, estimated);
}

/**
 * Construye el array de escenas para renderizar a partir del guion y los resultados de media.
 */
export function buildRenderScenes(script, mediaMatches = [], audioResult = null) {
  const scenes = [];
  const getMediaUrl = (type, idx) => {
    const match = mediaMatches.find(m =>
      (type === 'hook' && m.sceneType === 'hook') ||
      (type === 'cta'  && m.sceneType === 'cta')  ||
      (type === 'scene' && m.sceneType === 'scene' && m.sceneIndex === idx)
    );
    return match?.selectedMedia?.videoUrl || null;
  };

  // Hook
  if (script.hook?.narration) {
    const hookTopic = (script.hook?.visualKeywords || []).join(' ') || script.hook?.visualDescription || script.title || 'ciencia';
    scenes.push({
      topic: hookTopic,
      subtitle: script.hook.narration,
      videoUrl: getMediaUrl('hook'),
      durationSec: estimateSceneDuration(script.hook.narration)
    });
  }

  // Escenas principales
  (script.scenes || []).forEach((s, idx) => {
    if (s.narration) {
      const sceneTopic = (s.visualKeywords || []).join(' ') || s.visualDescription || s.badge || script.title || 'ciencia';
      scenes.push({
        topic: sceneTopic,
        subtitle: s.narration,
        videoUrl: getMediaUrl('scene', idx + 1),
        durationSec: estimateSceneDuration(s.narration)
      });
    }
  });

  // CTA
  if (script.callToAction?.narration) {
    const ctaTopic = script.title ? `${script.title} science discovery` : 'science cosmos universe';
    scenes.push({
      topic: ctaTopic,
      subtitle: script.callToAction.narration,
      videoUrl: getMediaUrl('cta'),
      durationSec: estimateSceneDuration(script.callToAction.narration)
    });
  }

  return scenes;
}
