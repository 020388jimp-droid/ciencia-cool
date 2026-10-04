import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..', '..');
const TEMP_DIR = path.join(projectRoot, 'outputs', 'temp');


/**
 * Genera un archivo SRT a partir de los tiempos de palabra que entrega Edge TTS.
 *
 * Estos tiempos vienen de la MISMA sintesis que produjo el MP3, asi que el
 * subtitulo queda pegado a la palabra real: no hay Estimacion ni drifted.
 * Los offsets de Edge estan en unidades de 100 nanosegundos.
 *
 * @param {Array<{word: string, start: number, end: number}>} boundaries
 * @param {Object} options
 * @param {number} options.timeOffset  - Offset de la escena dentro del video
 * @param {number} options.maxChars    - Maximo de caracteres por linea
 * @param {number} options.maxWords    - Maximo de palabras por subtitulo
 * @returns {Array<{start:number,end:number,text:string}>}
 */
export function buildCuesFromWordBoundaries(boundaries, {
  timeOffset = 0,
  maxChars = 48,
  maxWords = 8
} = {}) {
  const words = (boundaries || [])
    .filter(b => b && typeof b.word === 'string' && b.word.trim().length > 0 && isFinite(b.start))
    .map(b => ({
      word: b.word.trim(),
      start: b.start,
      end: Math.max(b.end, b.start + 0.05),
      mode: b.mode || 'locucion'
    }))
    .sort((a, b) => a.start - b.start);

  if (words.length === 0) return [];

  const isSentenceEnd = w => /[.!?…]["'»)\]]?$/.test(w.word);
  const isClauseEnd  = w => /[,;:—]["'»)\]]?$/.test(w.word);

  const cues = [];
  let group = [];

  const flush = () => {
    if (group.length === 0) return;
    cues.push({
      start: group[0].start,
      end: group[group.length - 1].end,
      text: group.map(w => w.word).join(' ')
    });
    group = [];
  };

  for (let i = 0; i < words.length; i++) {
    // Nunca agrupar palabras de registros distintos: el narrador cambia de
    // tono en ese punto y el subtítulo debe acompañar ese cambio.
    if (group.length > 0 && words[i].mode !== group[0].mode) {
      flush();
    }

    group.push(words[i]);
    const last = words[i];
    const projected = group.map(w => w.word).join(' ');

    const isLast = i === words.length - 1;
    const tooLong = projected.length > maxChars || group.length >= maxWords;

    // Corte: fin de oracion, o el grupo se paso de largo, o ya no queda mas texto.
    if (isLast || (tooLong && (isSentenceEnd(last) || group.length >= maxWords)) || (tooLong && projected.length > maxChars * 1.6)) {
      flush();
    } else if (isClauseEnd(last) && projected.length >= maxChars * 0.6) {
      // Corte suave en coma cuando el subtitulo ya tiene tamano razonable.
      flush();
    }
  }
  flush();

  // Aplicar offset de escena y evitar solapamientos.
  let cursor = -Infinity;
  return cues
    .map(c => {
      let start = c.start + timeOffset;
      let end = c.end + timeOffset;
      if (start < cursor) start = cursor;
      if (end <= start) end = start + 0.3;
      cursor = end + 0.001;
      return { ...c, start, end };
    })
    .filter(c => c.text.length > 0);
}

/**
 * Genera cues aproximados a partir del texto y la duración, para cuando una
 * escena no tiene tiempos de palabra del TTS. Reparte el tiempo en proporción
 * al número de palabras de cada frase.
 *
 * @param {string} text
 * @param {number} durationSec
 * @returns {Array<{start:number,end:number,text:string}>}
 */
export function buildApproximateCues(text, durationSec) {
  if (!text || !durationSec || durationSec <= 0) return [];

  const phrases = text
    .split(/(?<=[.!?])\s+/)
    .map(p => p.trim())
    .filter(Boolean);

  const parts = [];
  for (const p of phrases) {
    if (p.length > 100) parts.push(...p.split(/,\s+/).map(s => s.trim()).filter(Boolean));
    else parts.push(p);
  }
  if (parts.length === 0) return [];

  const weights = parts.map(p => p.split(/\s+/).filter(Boolean).length);
  const total = weights.reduce((a, b) => a + b, 0);
  if (total === 0) return [];

  const cues = [];
  let t = 0;
  for (let i = 0; i < parts.length; i++) {
    const d = (weights[i] / total) * durationSec;
    cues.push({ start: t, end: t + d, text: parts[i] });
    t += d;
  }
  return cues;
}

/**
 * Escribe cues en disco como archivo SRT.
 *
 * @param {Array<{start:number,end:number,text:string}>} cues
 * @param {string} outputPath
 * @param {number} maxChars - Ancho de linea al envolver
 * @returns {string} outputPath
 */
export function writeCuesAsSRT(cues, outputPath, maxChars = 34) {
  if (!cues || cues.length === 0) {
    fs.writeFileSync(outputPath, '', 'utf8');
    return outputPath;
  }

  const toSRTTime = (seconds) => {
    const s = Math.max(0, seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    const ms = Math.round((s - Math.floor(s)) * 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
  };

  const wrap = (text) => {
    const words = text.split(/\s+/);
    const lines = [];
    let line = '';
    for (const w of words) {
      if (line && (line.length + 1 + w.length) > maxChars) {
        lines.push(line);
        line = w;
      } else {
        line = line ? `${line} ${w}` : w;
      }
    }
    if (line) lines.push(line);
    return lines.join('\n');
  };

  const body = cues
    .map((c, i) => `${i + 1}\n${toSRTTime(c.start)} --> ${toSRTTime(c.end)}\n${wrap(c.text)}\n`)
    .join('\n');

  fs.writeFileSync(outputPath, body, 'utf8');
  return outputPath;
}

/**
 * Genera un archivo SRT básico como fallback cuando no hay tiempos de palabra.
 * Divide el texto en frases y asigna tiempos proporcionales.
 * 
 * @param {string} text - Texto de la narración
 * @param {number} durationSec - Duración total del audio en segundos
 * @param {string} outputPath - Ruta de salida del archivo SRT
 * @returns {string} - Ruta al archivo SRT generado
 */
export function generateFallbackSRT(text, durationSec, outputPath) {
  if (!text || !durationSec || durationSec <= 0) {
    const srt = `1\n00:00:00,000 --> 00:00:05,000\n${text || ''}\n`;
    fs.writeFileSync(outputPath, srt, 'utf8');
    return outputPath;
  }

  // Dividir en frases por oraciones
  let phrases = text
    .split(/(?<=[.!?])\s+/)
    .map(p => p.trim())
    .filter(p => p.length > 0);

  // Si hay frases muy largas, dividirlas por comas
  const finalPhrases = [];
  for (const phrase of phrases) {
    if (phrase.length > 100) {
      const subPhrases = phrase
        .split(/,\s+/)
        .map(p => p.trim())
        .filter(p => p.length > 0);
      finalPhrases.push(...subPhrases);
    } else {
      finalPhrases.push(phrase);
    }
  }

  if (finalPhrases.length <= 1) {
    const srt = `1\n00:00:00,000 --> 00:00:${String(Math.floor(durationSec)).padStart(2, '0')},000\n${text}\n`;
    fs.writeFileSync(outputPath, srt, 'utf8');
    return outputPath;
  }

  // Calcular duración proporcional basada en palabras
  const wordCounts = finalPhrases.map(p => p.split(/\s+/).filter(Boolean).length);
  const totalWords = wordCounts.reduce((sum, w) => sum + w, 0);
  
  // Velocidad de habla: ~2.5 palabras por segundo (español)
  const wordsPerSecond = 2.5;
  
  let currentTime = 0;
  const srtLines = finalPhrases.map((phrase, idx) => {
    const wordCount = wordCounts[idx];
    const duration = Math.max(1.5, (wordCount / wordsPerSecond));
    const start = currentTime;
    const end = currentTime + duration;
    currentTime = end;
    
    // Formato SRT: HH:MM:SS,mmm
    const formatTime = (seconds) => {
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      const s = Math.floor(seconds % 60);
      const ms = Math.floor((seconds % 1) * 1000);
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
    };
    
    return `${idx + 1}\n${formatTime(start)} --> ${formatTime(end)}\n${phrase}\n`;
  });

  fs.writeFileSync(outputPath, srtLines.join('\n'), 'utf8');
  return outputPath;
}
