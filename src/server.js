import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

import { fetchAllNews } from './services/newsService.js';
import { fetchNasaAPOD, searchNasaMedia } from './services/nasaService.js';
import { fetchTodayScienceHistory } from './services/historyService.js';
import { generateScriptWithGemini } from './services/geminiService.js';
import { saveScript } from './services/storageService.js';
import { generateAudioForScript, AVAILABLE_VOICES } from './services/ttsService.js';
import { findMediaForScenes } from './services/mediaService.js';
import { renderFinalVideo, buildRenderScenes } from './services/videoRenderService.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(projectRoot, 'public')));
app.use('/audio', express.static(path.join(projectRoot, 'outputs', 'audio')));
app.use('/media', express.static(path.join(projectRoot, 'outputs', 'media')));

// Servir videos con soporte para HTTP Range Requests (indispensable para
// previsualizar <video> en el navegador — permite scrubbing / seek)
app.use('/video', (req, res, next) => {
  const videoDir = path.join(projectRoot, 'outputs', 'video');
  const filename = req.path.replace(/^\//, '');
  const filePath = path.join(videoDir, filename);

  if (!fs.existsSync(filePath) || !filePath.endsWith('.mp4')) return next();

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = end - start + 1;
    const file = fs.createReadStream(filePath, { start, end });
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': 'video/mp4',
    });
    file.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

// API: Obtener noticias
app.get('/api/news', async (req, res) => {
  try {
    const news = await fetchAllNews();
    res.json({ success: true, count: news.length, data: news });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Obtener efemérides históricas de ciencia (soporta ?month=8&day=26)
app.get('/api/history', async (req, res) => {
  try {
    const { month, day } = req.query;
    const history = await fetchTodayScienceHistory(month, day);
    res.json({ success: true, count: history.length, data: history });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Obtener NASA APOD
app.get('/api/nasa', async (req, res) => {
  try {
    const apod = await fetchNasaAPOD();
    res.json({ success: true, data: apod });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Buscar en biblioteca de la NASA
app.get('/api/nasa/search', async (req, res) => {
  try {
    const query = req.query.q || 'galaxy';
    const items = await searchNasaMedia(query);
    res.json({ success: true, data: items });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Generar guion con IA
app.post('/api/generate-script', async (req, res) => {
  try {
    const { topic, newsContext, format } = req.body;
    if (!topic) {
      return res.status(400).json({ success: false, error: 'Se requiere un tema para generar el guion.' });
    }

    const script = await generateScriptWithGemini({
      topic,
      newsContext: newsContext || '',
      format: format || '5_cosas'
    });

    const saved = saveScript(script);
    res.json({ success: true, data: script, saved });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Listar guiones generados previamente
app.get('/api/scripts', (req, res) => {
  try {
    const scriptsDir = path.join(projectRoot, 'outputs', 'scripts');
    if (!fs.existsSync(scriptsDir)) {
      return res.json({ success: true, data: [] });
    }

    const files = fs.readdirSync(scriptsDir)
      .filter(f => f.endsWith('.json'))
      .map(file => {
        const fullPath = path.join(scriptsDir, file);
        const content = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
        const stats = fs.statSync(fullPath);
        return {
          filename: file,
          title: content.title,
          format: content.format,
          createdAt: stats.birthtime,
          content
        };
      })
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.json({ success: true, data: files });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Listar voces neuronales disponibles
app.get('/api/voices', (req, res) => {
  res.json({ success: true, data: AVAILABLE_VOICES });
});

// API: Generar locución de voz para un guion
app.post('/api/generate-audio', async (req, res) => {
  try {
    const { script, voiceId } = req.body;
    if (!script) {
      return res.status(400).json({ success: false, error: 'Se requiere un guion para generar el audio.' });
    }

    const audioResult = await generateAudioForScript(script, voiceId || 'robot-alpha5');
    res.json({ success: true, data: audioResult });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Buscar recursos de video y medios para las escenas
app.post('/api/find-media', async (req, res) => {
  try {
    const { script } = req.body;
    if (!script) {
      return res.status(400).json({ success: false, error: 'Se requiere un guion para buscar medios.' });
    }

    const mediaResult = await findMediaForScenes(script);
    res.json({ success: true, data: mediaResult });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Obtener estado de configuración
app.get('/api/settings', (req, res) => {
  res.json({
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'tu_api_key_de_gemini_aqui'),
    nasaApiKey: process.env.NASA_API_KEY || 'DEMO_KEY',
    pexelsConfigured: Boolean(process.env.PEXELS_API_KEY && process.env.PEXELS_API_KEY !== 'tu_pexels_key_aqui'),
    pixabayConfigured: Boolean(process.env.PIXABAY_API_KEY && process.env.PIXABAY_API_KEY !== 'tu_pixabay_key_aqui'),
    brandName: process.env.BRAND_NAME || 'CIENCIA COOL'
  });
});

// API: Guardar configuración en .env
app.post('/api/settings', (req, res) => {
  try {
    const { geminiApiKey, nasaApiKey, pexelsApiKey, pixabayApiKey, brandName } = req.body;
    const envPath = path.join(projectRoot, '.env');
    
    let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';

    if (geminiApiKey) {
      process.env.GEMINI_API_KEY = geminiApiKey;
      envContent = envContent.replace(/GEMINI_API_KEY=.*/g, `GEMINI_API_KEY=${geminiApiKey}`);
      if (!envContent.includes('GEMINI_API_KEY=')) envContent += `\nGEMINI_API_KEY=${geminiApiKey}`;
    }

    if (nasaApiKey) {
      process.env.NASA_API_KEY = nasaApiKey;
      envContent = envContent.replace(/NASA_API_KEY=.*/g, `NASA_API_KEY=${nasaApiKey}`);
    }

    if (pexelsApiKey) {
      process.env.PEXELS_API_KEY = pexelsApiKey;
      envContent = envContent.replace(/PEXELS_API_KEY=.*/g, `PEXELS_API_KEY=${pexelsApiKey}`);
      if (!envContent.includes('PEXELS_API_KEY=')) envContent += `\nPEXELS_API_KEY=${pexelsApiKey}`;
    }

    if (pixabayApiKey) {
      process.env.PIXABAY_API_KEY = pixabayApiKey;
      envContent = envContent.replace(/PIXABAY_API_KEY=.*/g, `PIXABAY_API_KEY=${pixabayApiKey}`);
      if (!envContent.includes('PIXABAY_API_KEY=')) envContent += `\nPIXABAY_API_KEY=${pixabayApiKey}`;
    }

    if (brandName) {
      process.env.BRAND_NAME = brandName;
      envContent = envContent.replace(/BRAND_NAME=.*/g, `BRAND_NAME=${brandName}`);
    }

    fs.writeFileSync(envPath, envContent.trim() + '\n', 'utf8');
    res.json({ success: true, message: 'Configuración guardada exitosamente.' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Renderizar video final (con SSE para progreso en tiempo real)
app.post('/api/render-video', async (req, res) => {
  // Configurar SSE para enviar progreso en tiempo real
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendSSE = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const { script, audioResult, mediaMatches, brandingMode, watermarkPos, watermarkOpacity } = req.body;

    if (!script) {
      sendSSE({ type: 'error', message: 'Se requiere un guion para renderizar.' });
      return res.end();
    }

    if (!audioResult || !audioResult.fullAudioFilename) {
      sendSSE({ type: 'error', message: 'Primero genera el audio de locución antes de renderizar.' });
      return res.end();
    }

    const fullAudioPath = path.join(projectRoot, 'outputs', 'audio', audioResult.fullAudioFilename);
    if (!fs.existsSync(fullAudioPath)) {
      sendSSE({ type: 'error', message: `Audio no encontrado: ${audioResult.fullAudioFilename}` });
      return res.end();
    }

    const scenes = buildRenderScenes(script, mediaMatches || [], audioResult);
    if (!scenes || scenes.length === 0) {
      sendSSE({ type: 'error', message: 'No se encontraron escenas en el guion.' });
      return res.end();
    }

    sendSSE({ type: 'progress', message: `📋 ${scenes.length} escenas detectadas. Iniciando renderizado...` });

    const robotImagePath = path.join(projectRoot, 'public', 'assets', 'robot_host.jpg');
    const logoPath = path.join(projectRoot, 'public', 'assets', 'logo.jpg');
    const brandName = process.env.BRAND_NAME || 'CIENCIA COOL';

    const result = await renderFinalVideo({
      scenes,
      fullAudioPath,
      robotImagePath: fs.existsSync(robotImagePath) ? robotImagePath : null,
      logoPath: fs.existsSync(logoPath) ? logoPath : null,
      brandName,
      brandingMode: brandingMode || 'alternate',
      watermarkPos: watermarkPos || 'top-left',
      watermarkOpacity: typeof watermarkOpacity === 'number' ? watermarkOpacity : 0.40,
      onProgress: (msg) => sendSSE({ type: 'progress', message: msg })
    });

    sendSSE({ type: 'done', videoUrl: result.videoUrl, filename: result.filename });
    res.end();
  } catch (error) {
    console.error('Error en renderizado:', error);
    sendSSE({ type: 'error', message: error.message });
    res.end();
  }
});

// API: Metadatos de un video renderizado
app.get('/api/video-info/:filename', (req, res) => {
  try {
    const videoDir = path.join(projectRoot, 'outputs', 'video');
    const filename = req.params.filename;
    // Sanitize: solo nombres de archivo simples (sin rutas relativas)
    if (!filename || filename.includes('..') || !filename.endsWith('.mp4')) {
      return res.status(400).json({ success: false, error: 'Nombre de archivo inválido.' });
    }
    const filePath = path.join(videoDir, filename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, error: 'Video no encontrado.' });
    }
    const stats = fs.statSync(filePath);
    res.json({
      success: true,
      data: {
        filename,
        url: '/video/' + filename,
        sizeMB: (stats.size / 1024 / 1024).toFixed(2),
        createdAt: stats.birthtime,
        modifiedAt: stats.mtime
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Listar videos renderizados
app.get('/api/videos', (req, res) => {
  try {
    const videoDir = path.join(projectRoot, 'outputs', 'video');
    if (!fs.existsSync(videoDir)) return res.json({ success: true, data: [] });
    const files = fs.readdirSync(videoDir)
      .filter(f => f.endsWith('.mp4'))
      .map(f => {
        const stats = fs.statSync(path.join(videoDir, f));
        return { filename: f, url: '/video/' + f, size: stats.size, createdAt: stats.birthtime };
      })
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ success: true, data: files });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n🚀 CIENCIA COOL Studio iniciado en http://localhost:${PORT}`);
});
