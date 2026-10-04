import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

import { fetchAllNews, getNewsCacheStats } from './services/newsService.js';
import { fetchNasaAPOD, searchNasaMedia } from './services/nasaService.js';
import { fetchTodayScienceHistory } from './services/historyService.js';
import { generateScriptWithGemini } from './services/geminiService.js';
import { normalizarGuionMexicano } from './services/lexicon.js';
import { saveScript } from './services/storageService.js';
import { generateAudioForScript, AVAILABLE_VOICES, DEFAULT_VOICE_ID } from './services/ttsService.js';
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

  // Sanitizar nombre de archivo para prevenir path traversal
  const sanitizedFilename = path.basename(filename);
  const safeFilePath = path.join(videoDir, sanitizedFilename);

  if (!fs.existsSync(safeFilePath) || !safeFilePath.endsWith('.mp4')) {
    console.warn(`⚠️ Video no encontrado: ${filename}`);
    return next();
  }

  const stat = fs.statSync(safeFilePath);
  const fileSize = stat.size;

  // Cloud Run CORTA cualquier respuesta HTTP de más de 32 MB: el render
  // terminaba bien, pero al descargarlo el servidor cerraba la respuesta y el
  // <video> del navegador fallaba con "Error al cargar el video".
  //
  // Los videos se codifican con un presupuesto de 20 MB (ver MAX_FINAL_BYTES en
  // videoRenderService), así que lo normal es servirlos enteros en una sola
  // respuesta. Este troceado es solo la red de seguridad para el caso de que
  // un archivo se pase: se trocea en respuestas de 30 MB —por debajo del límite
  // de Cloud Run— y el navegador encadena las peticiones Range con normalidad.
  //
  // El tope va en 30 MB y NO en 16: ponerlo en 16 obligaba a trocear videos de
  // 17 MB que cabían de sobra, y una descarga simple se quedaba a medias.
  const MAX_CHUNK_BYTES = 30 * 1024 * 1024;

  const range = req.headers.range;

  console.log(`🎬 Sirviendo video: ${sanitizedFilename} (${(fileSize / 1024 / 1024).toFixed(2)} MB)`);

  // Normaliza el rango pedido. Un "bytes=0-" (abierto, que es lo que manda el
  // <video> del navegador) llega hasta el final del archivo.
  let start = 0;
  let end = fileSize - 1;
  if (range) {
    const parts = String(range).replace(/bytes=/, '').split('-');
    if (parts[0]) start = parseInt(parts[0], 10);
    if (parts[1]) end = parseInt(parts[1], 10);
  }
  if (!Number.isFinite(start) || start < 0) start = 0;
  if (!Number.isFinite(end) || end > fileSize - 1) end = fileSize - 1;

  // Solo se recorta el final si el trozo superaría el máximo por respuesta.
  if (end - start + 1 > MAX_CHUNK_BYTES) {
    end = start + MAX_CHUNK_BYTES - 1;
    console.warn(
      `⚠️ ${sanitizedFilename}: trozo recortado a ${MAX_CHUNK_BYTES / 1024 / 1024} MB ` +
      `de ${(fileSize / 1024 / 1024).toFixed(2)} MB`
    );
  }

  const chunkSize = end - start + 1;
  // Si el cliente no pidió rango y el archivo entero cabe en una respuesta, se
  // sirve como respuesta normal (200). Si no cabe, se sirve el primer trozo con
  // 206 + Content-Range, que es una respuesta válida y el cliente la encadena.
  if (!range && chunkSize >= fileSize) {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(safeFilePath).pipe(res);
  } else {
    const file = fs.createReadStream(safeFilePath, { start, end });
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': 'video/mp4',
    });
    file.pipe(res);
  }
});

// API: Obtener noticias (con filtro por categoría)
app.get('/api/news', async (req, res) => {
  try {
    const { category } = req.query;
    // ?refresh=1 fuerza la descarga (botón "Actualizar noticias").
    const force = req.query.refresh === '1' || req.query.refresh === 'true';
    const news = await fetchAllNews(category || 'todas', { force });
    res.json({
      success: true,
      count: news.length,
      data: news,
      category: category || 'todas',
      cache: getNewsCacheStats()
    });
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
    const { topic, newsContext, format, voiceId } = req.body;
    if (!topic) {
      return res.status(400).json({ success: false, error: 'Se requiere un tema para generar el guion.' });
    }

    // Las voces de personaje (GIR) llevan un guion con personalidad y marcadores
    // de tono; las demás usan el tono neutro de siempre.
    const personality = voiceId && voiceId.startsWith('robot-gir') ? 'gir' : 'asistente';

    const guionGemini = await generateScriptWithGemini({
      topic,
      newsContext: newsContext || '',
      format: format || '5_cosas',
      personality
    });

    // Normaliza a español de México antes de devolverlo. Se hace AQUÍ, y no
    // solo en la voz, para que el guion, el audio y los subtítulos digan
    // exactamente lo mismo: si se corrigiera únicamente lo que se manda a
    // sintetizar, se oiría "su celular" mientras el subtítulo pondría
    // "vuestro celular".
    const script = normalizarGuionMexicano(guionGemini);

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

    const audioResult = await generateAudioForScript(script, voiceId || DEFAULT_VOICE_ID);
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
    const { script, audioResult, mediaMatches, brandingMode, watermarkPos, watermarkOpacity, source, category } = req.body;

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
      source: source || script.source || '',
      category: category || script.category || '',
      brandingMode: brandingMode || 'watermark_only',
      watermarkPos: watermarkPos || 'top-left',
      watermarkOpacity: typeof watermarkOpacity === 'number' ? watermarkOpacity : 0.40,
      onProgress: (msg) => sendSSE({ type: 'progress', message: msg })
    });
    
    // Log para depuración
    console.log(`📋 Renderizado completado - Source: "${source || script.source || 'N/A'}", Category: "${category || script.category || 'N/A'}"`);

    // Verificar que el video existe antes de enviar la respuesta
    if (fs.existsSync(result.videoPath)) {
      const stats = fs.statSync(result.videoPath);
      const mb = stats.size / 1024 / 1024;
      console.log(`✅ Video generado: ${result.filename} (${mb.toFixed(2)} MB)`);
      // Cloud Run corta respuestas de más de 32 MB. El render ya limita el
      // tamaño por codificación, pero si aun así se pasa se avisa en el log
      // porque el symptoms sería un "Error al cargar el video" en el navegador.
      if (stats.size > 32 * 1024 * 1024) {
        console.warn(
          `⚠️ ${result.filename} (${mb.toFixed(2)} MB) supera el límite de 32 MB de ` +
          `Cloud Run: se servirá troceado por Range Requests.`
        );
      }
      sendSSE({ type: 'done', videoUrl: result.videoUrl, filename: result.filename, size: stats.size });
    } else {
      console.error(`❌ Video no encontrado en: ${result.videoPath}`);
      sendSSE({ type: 'error', message: 'El video no se generó correctamente. Intenta de nuevo.' });
    }
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

  // Calentamiento de la caché de noticias al arrancar el contenedor.
  // Con min-instances=0 cada visita paga un arranque en frío; si además tiene
  // que esperar a que se descarguen los feeds, la primera carga se va a varios
  // minutos. Arrancando la descarga aquí, la petición del usuario se engancha al
  // refresco en curso (misma promesa) en vez de esperarlo desde cero.
  fetchAllNews('todas')
    .then(n => console.log(`🔄 Caché de noticias lista: ${n.length} artículos`))
    .catch(e => console.error('No se pudo calentar la caché de noticias:', e.message));
});
