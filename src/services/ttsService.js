import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as googleTTS from 'google-tts-api';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..', '..');
const audioOutputDir = path.join(projectRoot, 'outputs', 'audio');

if (!fs.existsSync(audioOutputDir)) {
  fs.mkdirSync(audioOutputDir, { recursive: true });
}

// ─── Catálogo de voces disponibles ─────────────────────────────────────────
// Voces ROBOT: modulación de pitch/rate con SSML para efecto sintético
// Voces HUMANAS: voces neuronales naturales (Microsoft Edge TTS)
export const AVAILABLE_VOICES = [
  // ── Voces Robot ──────────────────────────────────────────────────────────
  { id: 'robot-alpha5', name: '🤖 Alpha-5 Retro (Agudo · Energético)', voiceKey: 'es-MX-JorgeNeural', pitch: '+45Hz', rate: '+18%' },
  { id: 'robot-cyborg', name: '🤖 Cibernético (Tono Sintético Espacial)', voiceKey: 'es-US-AlonsoNeural', pitch: '+30Hz', rate: '+15%' },
  { id: 'robot-female', name: '🤖 IA Femenina (Asistente Espacial)', voiceKey: 'es-MX-DaliaNeural', pitch: '+35Hz', rate: '+15%' },
  { id: 'robot-deep', name: '🤖 Robot Profundo (Grave · Dramático)', voiceKey: 'es-ES-AlvaroNeural', pitch: '-20Hz', rate: '-10%' },
  // ── Voces Humanas ─────────────────────────────────────────────────────────
  { id: 'es-MX-JorgeNeural', name: '🇲🇽 Jorge (Humana Dinámica / YouTube)', voiceKey: 'es-MX-JorgeNeural', pitch: 'default', rate: 'default' },
  { id: 'es-MX-DaliaNeural', name: '🇲🇽 Dalia (Humana Femenina / TikTok)', voiceKey: 'es-MX-DaliaNeural', pitch: 'default', rate: 'default' },
  { id: 'es-ES-AlvaroNeural', name: '🇪🇸 Álvaro (Documental / Ciencia)', voiceKey: 'es-ES-AlvaroNeural', pitch: 'default', rate: 'default' }
];

export async function textToSpeech(text, filename, voiceId = 'robot-alpha5') {
  const filePath = path.join(audioOutputDir, filename);
  const voiceConfig = AVAILABLE_VOICES.find(v => v.id === voiceId) || AVAILABLE_VOICES[0];
  const targetVoice = voiceConfig.voiceKey || 'es-MX-JorgeNeural';

  // Intentar primero con Microsoft Neural Voices (Edge TTS) con SSML
  try {
    const { MsEdgeTTS, OUTPUT_FORMAT } = await import('msedge-tts');
    const tts = new MsEdgeTTS();
    await tts.setMetadata(targetVoice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    
    // Si la voz tiene modulación de pitch/rate estilo robot, usar SSML
    let streamResult;
    if (voiceConfig.pitch && voiceConfig.pitch !== 'default') {
      const escapedText = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="es-MX">
        <voice name="${targetVoice}">
          <prosody pitch="${voiceConfig.pitch}" rate="${voiceConfig.rate || '+0%'}">
            ${escapedText}
          </prosody>
        </voice>
      </speak>`;
      streamResult = tts.rawToStream(ssml);
    } else {
      streamResult = tts.toStream(text);
    }

    await new Promise((resolve, reject) => {
      const writable = fs.createWriteStream(filePath);
      streamResult.audioStream.pipe(writable);
      writable.on('finish', resolve);
      writable.on('error', reject);
    });

    return {
      success: true,
      filePath,
      filename,
      url: '/audio/' + filename,
      engine: 'msedge-tts',
      voice: voiceConfig.name
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
        voice: voiceConfig.name
      };
    } catch (googleError) {
      throw new Error('Error en generación de voz TTS: ' + googleError.message);
    }
  }
}

export async function generateAudioForScript(script, voiceId = 'robot-alpha5') {
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
      sceneAudios.push({ ...block, audioUrl: res.url, filename: res.filename });
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
