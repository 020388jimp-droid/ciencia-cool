// src/services/videoRenderService.js
// Motor de renderizado de video para CIENCIA COOL
// Combina: video de fondo (Pexels/Pixabay/NASA) + audio TTS + marca de agua + etiquetas

import path from 'path';
import fs from 'fs';
import https from 'https';
import http from 'http';
import { fileURLToPath } from 'url';
import { searchFreeMedia } from './mediaService.js';
import {
  buildCuesFromWordBoundaries,
  writeCuesAsSRT,
  buildApproximateCues
} from './subtitleService.js';
import { getMediaDuration, runFfmpeg as runFfmpegRaw } from './mediaProbe.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..', '..');

const VIDEO_OUTPUT_DIR = path.join(projectRoot, 'outputs', 'video');
const TEMP_DIR = path.join(projectRoot, 'outputs', 'temp');

// Presupuesto máximo del MP4 final.
//
// Cloud Run tiene un LÍMITE DE 32 MB POR RESPUESTA HTTP: si el archivo pesa más,
// el servidor cierra la respuesta y el <video> del navegador falla con
// "Error al cargar el video" aunque el render haya sido perfecto. Es lo que pasó
// con un video de 70 s que salió en 35,7 MB.
//
// 20 MB deja margen de sobra para vídeo vertical y, además, sigue siendo
// comfortably rápido de descargar y de subir a las redes.
const MAX_FINAL_BYTES = 20 * 1024 * 1024;

// Crear directorios necesarios
[VIDEO_OUTPUT_DIR, TEMP_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

/** Ejecuta ffmpeg con una línea de log para el progreso. */
async function runFfmpeg(args) {
  console.log(`🎬 FFmpeg: ${args.slice(0, 6).join(' ')}...`);
  return runFfmpegRaw(args);
}

/**
 * Descarga un archivo desde una URL a una ruta local.
 */
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(destPath);
    proto.get(url, response => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        file.close();
        return downloadFile(response.headers.location, destPath).then(resolve).catch(reject);
      }
      if (response.statusCode !== 200) {
        file.close();
        return reject(new Error(`HTTP ${response.statusCode} descargando ${url}`));
      }
      response.pipe(file);
      file.on('finish', () => { file.close(); resolve(destPath); });
    }).on('error', err => {
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

/**
 * Preprocesa un clip de video: recorta y escala a 1080x1920 (9:16).
 *
 * NO se aplican aquí los subtítulos: cada clip tiene su propia línea de tiempo
 * que arranca en 0, así que un SRT con tiempos globales (p.ej. 9.83s) nunca
 * se vería dentro de un clip de 5s. Los subtítulos se queman una sola vez en
 * la Fase C, sobre el video ya concatenado y con la misma línea de tiempo que
 * el audio maestro.
 */
async function prepareSceneClip({ inputPath, durationSec, index }) {
  const outputPath = path.join(TEMP_DIR, `scene_${index}_ready.mp4`);

  // durationSec es la AUTORIDAD: ya fue medido con ffprobe en renderFinalVideo
  // y es el mismo valor que se acumula en accumulatedTime, que a su vez fija el
  // offset de los subtítulos de esta escena.
  const realDuration = durationSec || 6;

  const videoFilter = [
    // Escalar preservando aspect ratio y rellenando a 1080x1920
    'scale=1080:1920:force_original_aspect_ratio=increase',
    'crop=1080:1920'
  ].join(',');

  await runFfmpeg([
    '-stream_loop', '-1',  // Loop el video si es más corto que durationSec
    '-i', inputPath,
    '-t', String(realDuration),
    '-vf', videoFilter,
    '-r', '30',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-crf', '26',
    '-an',  // sin audio (lo añadimos al final)
    '-y', outputPath
  ]);

  return outputPath;
}

/**
 * Construye el SRT maestro: une los tiempos de palabra de todas las escenas
 * desplazados por el tiempo acumulado de cada clip. Se quema una sola vez sobre
 * el video concatenado, donde los tiempos globales sí tienen sentido.
 *
 * @returns {{srtPath: string|null, cueCount: number, preciseCount: number, approxCount: number}}
 */
function buildMasterSRT({ scenes, sceneDurations, outputPath }) {
  const allCues = [];
  let offset = 0;
  let preciseCount = 0;
  let approxCount = 0;

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const dur = sceneDurations[i] || scene.durationSec || 6;
    const wb = scene.wordBoundaries || [];

    let cues;
    if (wb.length > 0) {
      cues = buildCuesFromWordBoundaries(wb, { timeOffset: offset });
      preciseCount++;
    } else {
      cues = buildApproximateCues(scene.subtitle || '', dur).map(c => ({
        ...c,
        start: c.start + offset,
        end: c.end + offset
      }));
      approxCount++;
    }
    allCues.push(...cues);
    offset += dur;
  }

  if (allCues.length === 0) {
    console.warn('⚠️ No se pudieron generar subtítulos para el video');
    return { srtPath: null, cueCount: 0, preciseCount, approxCount };
  }

  // Garantizar orden y no solapamiento global.
  allCues.sort((a, b) => a.start - b.start);
  let cursor = -Infinity;
  const clean = allCues.map(c => {
    const start = Math.max(c.start, cursor);
    const end = Math.max(c.end, start + 0.25);
    cursor = end;
    return { ...c, start, end };
  });

  writeCuesAsSRT(clean, outputPath);
  return { srtPath: outputPath, cueCount: clean.length, preciseCount, approxCount };
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
        index: `${index}_fallback`
      });
    }
  } catch (err) {
    onProgress(`  ⚠️ No se encontró video libre: ${err.message}`);
  }

  // Último recurso: tarjeta de título
  onProgress(`  📃 Usando tarjeta de título como último recurso`);
  return generateTitleCard({ text: subtitle, durationSec, index: `${index}_card` });
}

/**
 * Renderiza el video final completo.
 *
 * @param {Object} params
 * @param {Array}  params.scenes           - Escenas con { subtitle, videoUrl, durationSec, wordBoundaries }
 * @param {string} params.fullAudioPath    - Ruta absoluta al audio mp3 completo
 * @param {string} params.robotImagePath   - Ruta al avatar robot
 * @param {string} params.logoPath         - Ruta al logo CIENCIA COOL
 * @param {string} params.brandName        - Nombre de la marca
 * @param {string} params.source           - Fuente de la noticia (ej: "NASA")
 * @param {string} params.category         - Categoría de la noticia
 * @param {Function} params.onProgress     - Callback de progreso (msg)
 * @returns {Promise<{videoPath, videoUrl, filename}>}
 */
export async function renderFinalVideo({
  scenes,
  fullAudioPath,
  robotImagePath,
  logoPath,
  brandName = 'CIENCIA COOL',
  source = '',
  category = '',
  brandingMode = 'watermark_only', // 'watermark_only' | 'none'
  watermarkPos = 'top-left',
  watermarkOpacity = 0.40,
  onProgress = console.log
}) {
  onProgress('🎬 Iniciando renderizado de video...');

  const timestamp = Date.now();
  const outputFilename = `ciencia_cool_${timestamp}.mp4`;
  const finalOutputPath = path.join(VIDEO_OUTPUT_DIR, outputFilename);

  // ─── FASE A: Preparar cada clip de escena ─────────────────────────────────
  // Para cada escena:
  //   1. Descarga el video asignado (Pexels/Pixabay/NASA)
  //   2. Si falla → busca automáticamente un video libre del mismo tema
  //   3. Si no encuentra nada → genera tarjeta de título (último recurso)
  //   4. Escala a 9:16 y recorta al tiempo REAL del audio de la escena
  const sceneClipPaths = [];
  const sceneAudioParts = [];
  const measuredDurations = [];
  const audioDir = path.join(projectRoot, 'outputs', 'audio');
  let accumulatedTime = 0;

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];

    // La duración del clip DEBE ser exactamente la del audio de la escena:
    // es el valor que se acumula en accumulatedTime para los offsets del SRT.
    // Cualquier redondeo distinto aquí y allí descuadra los subtítulos.
    let clipDuration = scene.durationSec || 6;
    let audioPartPath = null;

    if (scene.audioPartFilename) {
      const candidate = path.join(audioDir, scene.audioPartFilename);
      if (fs.existsSync(candidate)) {
        const realDur = await getMediaDuration(candidate);
        if (realDur && realDur > 0) {
          clipDuration = realDur;
          audioPartPath = candidate;
          sceneAudioParts.push(candidate);
          onProgress(`  ⏱️ Audio escena ${i + 1}: ${realDur.toFixed(3)}s`);
        }
      }
    }
    measuredDurations.push(clipDuration);

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
      // Paso 2a: Video descargado → preparar (escalar a 9:16)
      try {
        clipPath = await prepareSceneClip({
          inputPath: inputVideoPath,
          durationSec: clipDuration,
          index: `${timestamp}_${i}`
        });
      } catch (prepErr) {
        onProgress(`  ⚠️ Error procesando clip: ${prepErr.message} → buscando alternativa`);
        clipPath = await getFallbackVideoClip({
          topic: sceneTopic,
          subtitle: scene.subtitle || '',
          durationSec: clipDuration,
          index: `${timestamp}_${i}`,
          onProgress
        });
      }
    } else {
      // Paso 2b: Sin video pre-asignado → buscar automáticamente video libre
      clipPath = await getFallbackVideoClip({
        topic: sceneTopic,
        subtitle: scene.subtitle || '',
        durationSec: clipDuration,
        index: `${timestamp}_${i}`,
        onProgress
      });
    }

    sceneClipPaths.push(clipPath);
    // El offset se acumula con la MISMA duración que se le dio al clip.
    accumulatedTime += clipDuration;
  }

  const totalVideoDuration = accumulatedTime;
  onProgress(`✅ ${sceneClipPaths.length} clips preparados (total ${totalVideoDuration.toFixed(2)}s). Concatenando...`);

  // ─── FASE B: Concatenar clips de video + audio de escenas ────────────────
  const concatListPath = path.join(TEMP_DIR, `concat_${timestamp}.txt`);
  fs.writeFileSync(
    concatListPath,
    sceneClipPaths.map(p => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'),
    'utf8'
  );

  const concatenatedPath = path.join(TEMP_DIR, `concat_${timestamp}.mp4`);
  await runFfmpeg([
    '-f', 'concat',
    '-safe', '0',
    '-i', concatListPath,
    '-c', 'copy',
    '-y', concatenatedPath
  ]);

  // El audio maestro se construye concatenando los MISMOS _part_N.mp3 que
  // generaron los tiempos de los subtítulos. Antes se usaba full.mp3 (una única
  // síntesis TTS del texto unido) cuyas pausas entre bloques NO coinciden con
  // los límites de escena, por lo que los subtítulos se desincronizaban.
  let masterAudioPath = fullAudioPath;
  if (sceneAudioParts.length === scenes.length && sceneAudioParts.length > 0) {
    try {
      onProgress('🎵 Concatenando audio por escenas (misma fuente que los subtítulos)...');
      const audioListPath = path.join(TEMP_DIR, `aconcat_${timestamp}.txt`);
      fs.writeFileSync(
        audioListPath,
        sceneAudioParts.map(p => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'),
        'utf8'
      );
      const joinedAudioPath = path.join(TEMP_DIR, `master_${timestamp}.m4a`);
      await runFfmpeg([
        '-f', 'concat', '-safe', '0', '-i', audioListPath,
        '-c:a', 'aac', '-b:a', '128k',
        '-y', joinedAudioPath
      ]);
      const joinedDur = await getMediaDuration(joinedAudioPath);
      if (joinedDur && joinedDur > 0) {
        masterAudioPath = joinedAudioPath;
        onProgress(`   ✅ Audio por escenas: ${joinedDur.toFixed(3)}s (video: ${totalVideoDuration.toFixed(3)}s)`);
      } else {
        onProgress('   ⚠️ Duración de audio inválida, usando full.mp3');
      }
    } catch (audioErr) {
      onProgress(`   ⚠️ No se pudo concatenar el audio (${audioErr.message}), usando full.mp3`);
    }
  } else {
    onProgress(`   ⚠️ Audio por escenas incompleto (${sceneAudioParts.length}/${scenes.length}), usando full.mp3`);
  }

  onProgress('🎵 Añadiendo locución de voz...');

  // ─── SRT MAESTRO ──────────────────────────────────────────────────────────
  // Se construye con tiempos globales y se quema UNA vez sobre el video
  // concatenado, que comparte línea de tiempo con el audio maestro.
  const masterSrtPath = path.join(TEMP_DIR, `subtitles_master_${timestamp}.srt`);
  const srtInfo = buildMasterSRT({
    scenes,
    sceneDurations: measuredDurations,
    outputPath: masterSrtPath
  });
  if (srtInfo.srtPath) {
    onProgress(
      `📝 SRT maestro: ${srtInfo.cueCount} subtítulos ` +
      `(${srtInfo.preciseCount} escenas con tiempos exactos` +
      `${srtInfo.approxCount ? `, ${srtInfo.approxCount} estimadas` : ''})`
    );
  }

  // ─── FASE C: Audio TTS + marca de agua + etiquetas ───────────────────────
  const allowRobot = brandingMode === 'robot_only' || brandingMode === 'both' || brandingMode === 'alternate';
  const allowLogo = brandingMode === 'watermark_only' || brandingMode === 'both' || brandingMode === 'alternate';

  const hasRobot = allowRobot && Boolean(robotImagePath && fs.existsSync(robotImagePath));
  const hasLogo = allowLogo && Boolean(logoPath && fs.existsSync(logoPath));

  // Tiempos para el modo 'alternate' (hook inicial y CTA final)
  const hookDuration = scenes[0]?.durationSec || 4;
  const ctaDuration = scenes[scenes.length - 1]?.durationSec || 4;
  const narrationDuration = scenes.reduce((acc, s) => acc + (s.durationSec || 6), 0);
  const ctaStart = Math.max(hookDuration, narrationDuration - ctaDuration);

  const ffmpegArgs = [
    '-i', concatenatedPath,  // [0:v]
    '-i', masterAudioPath     // [1:a] audio por escenas, alineado con los SRT
  ];

  if (hasRobot) ffmpegArgs.push('-i', robotImagePath);
  if (hasLogo) ffmpegArgs.push('-i', logoPath);

  const filterParts = [];
  let videoStreamLabel = '[0:v]';
  let inputIdx = 2;

  // 0. Subtítulos (primero, sobre el video ya alineado con el audio maestro).
  //    Estilo相同的 al que el usuario aprobó: no cambiar la fuente.
  if (srtInfo.srtPath) {
    const escapedSrt = srtInfo.srtPath
      .replace(/\\/g, '/')
      .replace(/:/g, '\\:')
      .replace(/'/g, "\\'");
    filterParts.push(
      `${videoStreamLabel}subtitles='${escapedSrt}':force_style='FontName=DejaVu Sans Bold,FontSize=18,` +
      `PrimaryColour=&HFFFFFF,OutlineColour=&H000000,BorderStyle=1,Outline=2,Shadow=1,` +
      `Alignment=2,MarginV=40'[v_subs]`
    );
    videoStreamLabel = '[v_subs]';
  }

  // 1. Robot presentador (overlay esquina inferior derecha)
  if (hasRobot) {
    const robotInputIdx = inputIdx++;
    filterParts.push(`[${robotInputIdx}:v]scale=220:220[robot]`);
    if (brandingMode === 'alternate') {
      filterParts.push(
        `${videoStreamLabel}[robot]overlay=W-250:H-260:` +
        `enable='between(t,0,${hookDuration})+gte(t,${ctaStart})'[v_robot]`
      );
    } else {
      filterParts.push(`${videoStreamLabel}[robot]overlay=W-250:H-260[v_robot]`);
    }
    videoStreamLabel = '[v_robot]';
  }

  // 2. Marca de agua (logo translúcido en esquina)
  if (hasLogo) {
    const logoInputIdx = inputIdx++;
    filterParts.push(
      `[${logoInputIdx}:v]scale=150:-1,format=rgba,colorchannelmixer=aa=${watermarkOpacity}[logo]`
    );

    let logoPos = '40:60';
    if (watermarkPos === 'top-right') logoPos = 'W-w-40:60';
    else if (watermarkPos === 'bottom-left') logoPos = '40:H-h-120';

    filterParts.push(`${videoStreamLabel}[logo]overlay=${logoPos}[v_logo]`);
    videoStreamLabel = '[v_logo]';
  } else if (allowLogo && !hasLogo) {
    const escapedBrand = brandName.replace(/'/g, "\\'").replace(/:/g, '\\:');
    let textPos = 'x=40:y=60';
    if (watermarkPos === 'top-right') textPos = 'x=w-text_w-40:y=60';
    else if (watermarkPos === 'bottom-left') textPos = 'x=40:y=h-text_h-120';

    filterParts.push(
      `${videoStreamLabel}drawtext=text='${escapedBrand}':fontsize=32:` +
      `fontcolor=0x00e5ff@${watermarkOpacity}:${textPos}[v_logo]`
    );
    videoStreamLabel = '[v_logo]';
  }

  // 3. Etiqueta de fuente (ej: "Fuente: NASA")
  if (source) {
    // Tope de longitud: drawtext no ajusta el texto al ancho, así que un valor
    // largo se sale del encuadre. Antes aquí llegaba el titular entero de la
    // noticia y se escribía atravessando el video de lado a lado.
    let textoFuente = String(source).replace(/\s+/g, ' ').trim();
    if (textoFuente.length > 40) textoFuente = textoFuente.slice(0, 39).trim() + '…';
    const escapedSource = textoFuente.replace(/'/g, "\\'").replace(/:/g, '\\:');
    filterParts.push(
      `${videoStreamLabel}drawtext=text='Fuente: ${escapedSource}':fontsize=36:fontcolor=white:` +
      `box=1:boxcolor=black@0.9:boxborderw=15:borderw=3:bordercolor=white@0.5:` +
      `shadowcolor=black@0.8:shadowx=2:shadowy=2:x=40:y=h-50[v_source]`
    );
    videoStreamLabel = '[v_source]';
  } else {
    console.warn('⚠️ No se proporcionó fuente para la etiqueta de fuente');
  }

  // 4. Etiqueta de categoría.
  // Sin emojis: drawtext usa la fuente del sistema (DejaVu Sans) y no tiene
  // glifos de emoji, por lo que salían como cuadros vacíos en el video.
  if (category) {
    const categoryLabels = {
      tecnologia: 'Tecnología',
      medicina: 'Medicina',
      astronomia: 'Astronomía',
      ciencia: 'Ciencia',
      videojuegos: 'Videojuegos',
      medio_ambiente: 'Medio Ambiente'
    };
    const categoryText = categoryLabels[category] || category;
    const escapedCategory = categoryText.replace(/'/g, "\\'").replace(/:/g, '\\:');
    filterParts.push(
      `${videoStreamLabel}drawtext=text='${escapedCategory}':fontsize=32:fontcolor=white:` +
      `box=1:boxcolor=black@0.8:boxborderw=15:borderw=3:bordercolor=0x00e5ff:` +
      `shadowcolor=black@0.8:shadowx=2:shadowy=2:x=w-text_w-40:y=60[v_category]`
    );
    videoStreamLabel = '[v_category]';
  }

  // 5. Stream final si no se agregó ninguna etiqueta
  if (videoStreamLabel === '[v_logo]' || videoStreamLabel === '[0:v]') {
    filterParts.push(`${videoStreamLabel}copy[v_final]`);
    videoStreamLabel = '[v_final]';
  }

  const filterComplex = filterParts.join('; ');
  const mapVideoStream = filterParts.length > 0
    ? videoStreamLabel.replace(/^\[|\]$/g, '')
    : '0:v';

  // Presupuesto de bits para que el MP4 quepa siempre en el límite de 32 MB por
  // respuesta de Cloud Run. Se reparte el presupuesto entre vídeo y audio y se
  // reparte a partes iguales entre los segundos que dura el video, de modo que
  // un guion de 3 minutos no acabe en 60 MB por muy bueno que sea el material.
  const audioBitrate = 96_000;
  const bitsForVideo = Math.max(
    0,
    (MAX_FINAL_BYTES * 8) - audioBitrate * totalVideoDuration
  );
  const maxVideoBitrate = Math.round(
    Math.max(700_000, Math.min(4_000_000, bitsForVideo / Math.max(1, totalVideoDuration)))
  );
  const estimatedMB = ((maxVideoBitrate + audioBitrate) * totalVideoDuration) / 8 / 1024 / 1024;
  onProgress(
    `🎨 Aplicando composición final (marca de agua + etiquetas + audio)... ` +
    `[~${estimatedMB.toFixed(1)} MB de ${(MAX_FINAL_BYTES / 1024 / 1024).toFixed(0)} MB máx.]`
  );
  await runFfmpeg([
    ...ffmpegArgs,
    ...(filterComplex ? ['-filter_complex', filterComplex] : []),
    ...(filterComplex ? ['-map', `[${mapVideoStream}]`] : ['-map', '0:v']),
    // El audio se rellena con silencio para que no termine antes que el video
    '-af', 'apad',
    '-map', '1:a',
    '-c:v', 'libx264',
    '-preset', 'faster',
    // Tope duro de tamaño. Cloud Run CORTA cualquier respuesta HTTP de más de
    // 32 MB: el render terminaba bien, pero al descargarlo el servidor devolvía
    // 500 y el navegador no reproducía nada. Medido: un video de 70 s salía en
    // 35,7 MB con CRF 23 sin tope y era imposible de servir.
    //
    // Con CRF 26 + VBV (maxrate/bufsize) la calidad sigue siendo CRF —se
    // adapta al contenido— pero el resultado nunca pasa del presupuesto. Un
    // guion largo baja de calidad en vez de pasarse de tamaño.
    '-crf', '26',
    '-maxrate', `${maxVideoBitrate}`,
    '-bufsize', `${maxVideoBitrate * 2}`,
    '-c:a', 'aac',
    '-b:a', '96k',
    // Duración determinista: la suma exacta de los clips de escena.
    // Antes se usaba -shortest, que truncaba el video de golpe cuando el
    // audio era más corto y desplazaba los límites de escena.
    '-t', totalVideoDuration.toFixed(3),
    '-movflags', '+faststart',
    '-pix_fmt', 'yuv420p',
    '-y', finalOutputPath
  ]);

  // ─── FASE D: Limpieza de temporales ───────────────────────────────────────
  const tempFiles = [
    ...sceneClipPaths,
    concatListPath,
    concatenatedPath,
    path.join(TEMP_DIR, `aconcat_${timestamp}.txt`)
  ];
  if (masterSrtPath) tempFiles.push(masterSrtPath);
  if (masterAudioPath !== fullAudioPath) tempFiles.push(masterAudioPath);
  tempFiles.forEach(f => { try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch (_) {} });

  const finalDur = await getMediaDuration(finalOutputPath);
  onProgress(
    `🎉 Video renderizado: ${outputFilename} ` +
    `(${finalDur ? finalDur.toFixed(2) + 's' : 'duración desconocida'})`
  );

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
 * Construye el array de escenas para renderizar a partir del guion y los
 * resultados de media. Cada escena se lleva los tiempos de palabra exactos que
 * devolvió Edge TTS al sintetizar su audio.
 */
export function buildRenderScenes(script, mediaMatches = [], audioResult = null) {
  const scenes = [];
  const audioScenes = audioResult?.scenes || [];
  let audioIdx = 0;

  const withAudio = (scene, audioScene) => ({
    ...scene,
    audioPartFilename: audioScene?.filename || null,
    wordBoundaries: audioScene?.wordBoundaries || []
  });

  const getMediaUrl = (type, idx) => {
    const match = mediaMatches.find(m =>
      (type === 'hook' && m.sceneType === 'hook') ||
      (type === 'cta' && m.sceneType === 'cta') ||
      (type === 'scene' && m.sceneType === 'scene' && m.sceneIndex === idx)
    );
    return match?.selectedMedia?.videoUrl || null;
  };

  // Hook
  if (script.hook?.narration) {
    const hookTopic =
      (script.hook?.visualKeywords || []).join(' ') ||
      script.hook?.visualDescription ||
      script.title || 'ciencia';
    const audioScene = audioScenes[audioIdx++] || null;
    scenes.push(withAudio({
      topic: hookTopic,
      subtitle: script.hook.narration,
      videoUrl: getMediaUrl('hook'),
      durationSec: estimateSceneDuration(script.hook.narration)
    }, audioScene));
  }

  // Escenas principales
  (script.scenes || []).forEach((s, idx) => {
    if (s.narration) {
      const sceneTopic =
        (s.visualKeywords || []).join(' ') ||
        s.visualDescription || s.badge || script.title || 'ciencia';
      const audioScene = audioScenes[audioIdx++] || null;
      scenes.push(withAudio({
        topic: sceneTopic,
        subtitle: s.narration,
        videoUrl: getMediaUrl('scene', idx + 1),
        durationSec: estimateSceneDuration(s.narration)
      }, audioScene));
    }
  });

  // CTA
  if (script.callToAction?.narration) {
    const ctaTopic = script.title ? `${script.title} science discovery` : 'science cosmos universe';
    const audioScene = audioScenes[audioIdx++] || null;
    scenes.push(withAudio({
      topic: ctaTopic,
      subtitle: script.callToAction.narration,
      videoUrl: getMediaUrl('cta'),
      durationSec: estimateSceneDuration(script.callToAction.narration)
    }, audioScene));
  }

  return scenes;
}