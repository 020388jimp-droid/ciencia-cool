// src/services/mediaProbe.js
// Utilidades de sondeo de medios, compartidas entre TTS y renderizado.

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..', '..');

let _ffmpegPath = null;

/**
 * Resuelve la ruta de ffmpeg.
 * En Docker usa el binario del sistema; en local usa @ffmpeg-installer.
 */
export async function getFfmpegPath() {
  if (_ffmpegPath) return _ffmpegPath;
  try {
    const mod = await import('@ffmpeg-installer/ffmpeg');
    const p = mod.default?.path || mod.path;
    if (p && fs.existsSync(p)) {
      _ffmpegPath = p;
      return _ffmpegPath;
    }
  } catch (_) {}
  _ffmpegPath = 'ffmpeg';
  return _ffmpegPath;
}

function getFfprobePath(ffmpegPath) {
  return ffmpegPath.replace(/ffmpeg(\.exe)?$/, 'ffprobe');
}

/**
 * Duración real de un archivo de audio/video, en segundos.
 * Usa ffprobe y, si no está disponible, parsea la línea "Duration:" que
 * ffmpeg imprime en stderr. Devuelve null si no se puede medir.
 */
export async function getMediaDuration(filePath) {
  const ffmpegPath = await getFfmpegPath();
  const ffprobePath = getFfprobePath(ffmpegPath);

  const fromFfprobe = () => new Promise((resolve) => {
    const proc = spawn(ffprobePath, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.on('close', () => {
      const dur = parseFloat(out.trim());
      resolve(isNaN(dur) ? null : dur);
    });
    proc.on('error', () => resolve(null));
  });

  const fromFfmpeg = () => new Promise((resolve) => {
    const proc = spawn(ffmpegPath, ['-i', filePath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', () => {
      const m = stderr.match(/Duration:\s*(\d+):(\d{2}):(\d{2})\.(\d{1,2})/);
      if (!m) return resolve(null);
      const dur = parseInt(m[1], 10) * 3600
                + parseInt(m[2], 10) * 60
                + parseInt(m[3], 10)
                + parseInt(m[4].padEnd(2, '0'), 10) / 100;
      resolve(dur > 0 ? dur : null);
    });
    proc.on('error', () => resolve(null));
  });

  const available = fs.existsSync(ffprobePath);
  let dur = available ? await fromFfprobe() : null;
  if (dur === null) dur = await fromFfmpeg();

  if (dur === null) {
    console.error(`No se pudo medir la duración de ${path.basename(filePath)}`);
  }
  return dur;
}

/**
 * Ejecuta ffmpeg y devuelve una Promise. Lanza si ffmpeg devuelve código != 0.
 */
export async function runFfmpeg(args) {
  const ffmpegPath = await getFfmpegPath();
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg terminó con código ${code}. ${stderr.slice(-300)}`));
    });
    proc.on('error', (err) => reject(new Error(`No se pudo iniciar ffmpeg: ${err.message}`)));
  });
}

/**
 * Une varios archivos de audio en uno solo, re-encodificando.
 *
 * El códec depende de la extensión de salida: escribir AAC dentro de un .mp3 es
 * inválido ("Invalid audio stream") y rompe la concatenación. Para .mp3 se usa
 * libmp3lame; para el resto (.m4a/.mp4/.aac) se usa AAC.
 *
 * @param {string[]} files   - Archivos de entrada, en orden
 * @param {string} outputPath
 * @param {string} listDir   - Directorio donde escribir la lista temporal
 * @returns {Promise<string>} ruta del archivo resultante
 */
export async function concatAudioFiles(files, outputPath, listDir) {
  if (!files || files.length === 0) {
    throw new Error('concatAudioFiles: no hay archivos de entrada');
  }
  if (files.length === 1) {
    fs.copyFileSync(files[0], outputPath);
    return outputPath;
  }

  const listPath = path.join(listDir, `aconcat_${path.basename(outputPath)}.txt`);
  fs.writeFileSync(
    listPath,
    files.map(f => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'),
    'utf8'
  );

  const isMp3 = /\.mp3$/i.test(outputPath);
  const codecArgs = isMp3
    ? ['-c:a', 'libmp3lame', '-b:a', '128k']
    : ['-c:a', 'aac', '-b:a', '128k'];

  try {
    await runFfmpeg([
      '-f', 'concat', '-safe', '0', '-i', listPath,
      ...codecArgs,
      '-y', outputPath
    ]);
  } finally {
    try { if (fs.existsSync(listPath)) fs.unlinkSync(listPath); } catch (_) {}
  }

  const dur = await getMediaDuration(outputPath);
  if (dur == null || dur <= 0) {
    throw new Error(`El archivo unido ${path.basename(outputPath)} no contiene audio válido`);
  }
  return outputPath;
}

export { projectRoot };