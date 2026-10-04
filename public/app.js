// Estado global
let currentNews = [];
let currentHistory = [];

document.addEventListener('DOMContentLoaded', () => {
  setupTabs();
  loadNews();
  loadHistory();
  loadNasaAPOD();
  setupEventListeners();
});

// Navegación de pestañas
function setupTabs() {
  const navBtns = document.querySelectorAll('.nav-btn');
  const panes = document.querySelectorAll('.tab-pane');

  navBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      navBtns.forEach(b => b.classList.remove('active'));
      panes.forEach(p => p.classList.remove('active'));

      btn.classList.add('active');
      const targetId = btn.getAttribute('data-tab');
      const targetPane = document.getElementById(targetId);
      if (targetPane) targetPane.classList.add('active');

      if (targetId === 'library-tab') loadLibrary();
      if (targetId === 'videos-tab') loadVideosLibrary();
    });
  });
}

function showToast(msg, isError = false) {
  const toast = document.getElementById('toast');
  toast.innerText = msg;
  toast.style.borderColor = isError ? '#ef4444' : '#00e5ff';
  toast.style.display = 'block';
  setTimeout(() => { toast.style.display = 'none'; }, 3500);
}

// 1. Cargar Noticias
let currentCategory = 'todas';

async function loadNews(category = currentCategory, { force = false } = {}) {
  currentCategory = category;
  const grid = document.getElementById('news-grid');
  const btn = document.getElementById('btn-refresh-news');

  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ Actualizando...';
  }
  grid.innerHTML = '<div class="loading-spinner">📡 Consultando fuentes científicas en tiempo real...</div>';

  try {
    // force=1 hace que el servidor descargue los feeds de nuevo en vez de
    // responder desde caché. Evita saturar a Google News si se spamea el botón.
    const url = `/api/news?category=${category}${force ? '&refresh=1' : ''}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    currentNews = data.data;
    renderNews(currentNews);
  } catch (error) {
    grid.innerHTML = `<div class="loading-spinner" style="color: var(--danger)">Error al cargar noticias: ${error.message}</div>`;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '🔄 Actualizar Noticias';
    }
  }
}

function renderNews(items) {
  const grid = document.getElementById('news-grid');
  if (items.length === 0) {
    grid.innerHTML = '<div class="loading-spinner">No hay noticias en esta categoría.</div>';
    return;
  }

  grid.innerHTML = items.map((item, idx) => `
    <div class="card">
      <div>
        <div class="card-badge-row">
          <span class="badge badge-${item.category}">${item.category}</span>
          <span class="card-date">${item.pubDate}</span>
        </div>
        <h3 class="card-title">${item.title}</h3>
        <p class="card-snippet">${item.snippet || 'Noticia científica de actualidad.'}</p>
      </div>
      <div class="card-actions">
        <button class="btn btn-primary" onclick="prepareScriptFromNews(${idx})">✨ Crear Guion</button>
        <a href="${item.link}" target="_blank" class="btn btn-secondary" style="text-decoration:none">🔗 Leer</a>
      </div>
    </div>
  `).join('');
}

// 2. Cargar Efemérides Históricas
let selectedHistoryDate = new Date();

async function loadHistory(targetDate = selectedHistoryDate) {
  selectedHistoryDate = new Date(targetDate);
  const month = selectedHistoryDate.getMonth() + 1;
  const day = selectedHistoryDate.getDate();

  const picker = document.getElementById('history-date-picker');
  const label = document.getElementById('history-current-label');
  if (picker) {
    const yyyy = selectedHistoryDate.getFullYear();
    const mm = String(month).padStart(2, '0');
    const dd = String(day).padStart(2, '0');
    picker.value = `${yyyy}-${mm}-${dd}`;
  }
  if (label) {
    const formatted = selectedHistoryDate.toLocaleDateString('es-ES', { day: 'numeric', month: 'long' });
    label.innerText = `Efemérides del ${formatted}`;
  }

  const grid = document.getElementById('history-grid');
  grid.innerHTML = `<div class="loading-spinner">📜 Consultando acontecimientos históricos del ${day}/${month}...</div>`;

  try {
    const res = await fetch(`/api/history?month=${month}&day=${day}`);
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    currentHistory = data.data;
    renderHistory(currentHistory);
  } catch (error) {
    grid.innerHTML = `<div class="loading-spinner" style="color: var(--danger)">Error: ${error.message}</div>`;
  }
}

function renderHistory(items) {
  const grid = document.getElementById('history-grid');
  if (!items || items.length === 0) {
    grid.innerHTML = '<div class="loading-spinner">No se encontraron efemérides para esta fecha.</div>';
    return;
  }

  grid.innerHTML = items.map((item, idx) => `
    <div class="timeline-item">
      <div class="timeline-year">${item.year}</div>
      <div class="timeline-body">
        <div style="display:flex; gap:0.5rem; align-items:center; margin-bottom:0.3rem">
          <span class="badge badge-historia">${item.type}</span>
          <span style="font-size:0.8rem; color:var(--primary); font-weight:600">📅 ${item.dateFormatted || ''}</span>
        </div>
        <h4 class="timeline-title">${item.title}</h4>
        <p class="timeline-desc">${item.description}</p>
      </div>
      <button class="btn btn-primary" onclick="prepareScriptFromHistory(${idx})">✨ Crear Guion</button>
    </div>
  `).join('');
}


// 3. Cargar NASA APOD
async function loadNasaAPOD() {
  const container = document.getElementById('apod-container');
  try {
    const res = await fetch('/api/nasa');
    const data = await res.json();
    if (!data.success || !data.data) throw new Error('No se pudo cargar NASA APOD');

    const apod = data.data;
    const isVideo = apod.mediaType === 'video';

    container.innerHTML = `
      <div class="apod-media" style="background-image: url('${apod.hdurl || apod.url}'); display: ${isVideo ? 'none' : 'block'}"></div>
      <div class="apod-content" style="grid-column: ${isVideo ? 'span 2' : 'span 1'}">
        <span class="badge badge-astronomia">NASA APOD - ${apod.date}</span>
        <h3>${apod.title}</h3>
        <p>${apod.explanation.slice(0, 400)}...</p>
        <div class="card-actions">
          <button class="btn btn-primary" onclick="prepareScriptFromNasa('${apod.title.replace(/'/g, "\\'")}', '${apod.explanation.slice(0, 300).replace(/'/g, "\\'")}')">✨ Crear Guion APOD</button>
          <a href="${apod.hdurl || apod.url}" target="_blank" class="btn btn-secondary">🖼️ Ver Alta Resolución</a>
        </div>
      </div>
    `;
  } catch (error) {
    container.innerHTML = `<div class="loading-spinner" style="color: var(--danger)">${error.message}</div>`;
  }
}

window.prepareScriptFromNews = function(index) {
  const item = currentNews[index];
  if (!item) return;

  document.getElementById('script-topic').value = item.title;
  document.getElementById('script-context').value = `Fuente: ${item.source}. ${item.snippet || ''}`;
  document.getElementById('script-format').value = 'noticia_resumida';
  
  // Guardar la fuente para el renderizado
  window._currentNewsSource = item.source || '';
  window._currentNewsCategory = item.category || '';

  // Cambiar a pestaña de estudio
  document.querySelector('[data-tab="studio-tab"]').click();
  showToast('Noticia cargada en el Estudio. ¡Haz clic en Generar Guion!');
};

window.prepareScriptFromHistory = function(index) {
  const item = currentHistory[index];
  if (!item) return;

  document.getElementById('script-topic').value = item.title;
  document.getElementById('script-context').value = item.description;
  document.getElementById('script-format').value = 'historia_ciencia';

  document.querySelector('[data-tab="studio-tab"]').click();
  showToast('Acontecimiento histórico cargado. ¡Haz clic en Generar Guion!');
};

window.prepareScriptFromNasa = function(title, context) {
  document.getElementById('script-topic').value = title;
  document.getElementById('script-context').value = context;
  document.getElementById('script-format').value = 'evento_astronomico';

  document.querySelector('[data-tab="studio-tab"]').click();
  showToast('Datos de la NASA cargados. ¡Haz clic en Generar Guion!');
};

let currentScript = null;
let currentScriptAudio = null;
let currentScriptMedia = null;
let currentRenderedVideo = null;

// 5. Generar Guion
async function generateScript() {
  const topic = document.getElementById('script-topic').value.trim();
  const context = document.getElementById('script-context').value.trim();
  const format = document.getElementById('script-format').value;
  const viewer = document.getElementById('script-viewer');
  const btn = document.getElementById('btn-generate-script');

  if (!topic) {
    showToast('Por favor escribe o selecciona un tema.', true);
    return;
  }

  btn.disabled = true;
  btn.innerText = '⏳ Redactando con IA...';
  viewer.innerHTML = '<div class="loading-spinner">✨ Google Gemini está estructurando el guion viral y los ganchos para CIENCIA COOL...</div>';

  try {
    // Se envía la voz seleccionada para que el guion adopte la personalidad
    // correspondiente (GIR escribe con sus marcas de tono).
    const selectedVoice = document.getElementById('script-voice')?.value || '';
    const res = await fetch('/api/generate-script', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, newsContext: context, format, voiceId: selectedVoice })
    });

    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    currentScript = data.data;
    currentScriptAudio = null;
    currentScriptMedia = null;
    renderStoryboard(currentScript);
    showToast('✅ ¡Guion generado y guardado con éxito!');
  } catch (error) {
    viewer.innerHTML = `<div class="loading-spinner" style="color: var(--danger)">Error: ${error.message}</div>`;
    showToast(`Error: ${error.message}`, true);
  } finally {
    btn.disabled = false;
    btn.innerText = '✨ Generar Guion con IA';
  }
}

function renderStoryboard(script) {
  currentScript = script;
  const viewer = document.getElementById('script-viewer');

  viewer.innerHTML = `
    <div class="storyboard">
      <div class="storyboard-header" style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:1rem;">
        <div>
          <h2>${script.title}</h2>
          <p style="color: var(--text-dim); margin-top:0.2rem;">⏱️ Duración estimada: ~${script.estimatedDurationSec}s | Formato: ${script.format}</p>
        </div>
        <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
          <button id="btn-generate-audio" class="btn btn-primary" onclick="generateVoiceAudio()">🎙️ Generar Audio (Voz)</button>
          <button id="btn-find-media" class="btn btn-secondary" onclick="findSceneVideos()">🎬 Buscar Videos para Escenas</button>
          <button id="btn-render-video" class="btn btn-render" onclick="renderFinalVideoUI()" style="background: linear-gradient(135deg,#7c3aed,#a855f7); color:#fff; border:none;">🚀 Renderizar Video Final</button>
          <button class="btn btn-secondary" onclick="copyScriptText()">📋 Copiar Texto</button>
        </div>
      </div>

      <!-- Opciones de Marca de Agua y Robot Presentador -->
      <div class="render-overlay-bar" style="background: rgba(0,229,255,0.05); border: 1px solid var(--border-glow); border-radius: 10px; padding: 0.75rem 1rem; margin-bottom: 1rem; display: flex; flex-wrap: wrap; gap: 1rem; align-items: center; justify-content: space-between;">
        <div style="display:flex; align-items:center; gap:0.6rem; flex-wrap:wrap;">
          <span style="font-weight:700; color:var(--primary); font-size:0.85rem;">🎨 Estilo de Marca & Overlays:</span>
          <select id="render-branding-mode" style="background: rgba(10,14,39,0.9); border: 1px solid var(--border-color); color: #fff; padding: 0.4rem 0.75rem; border-radius: 7px; font-family: inherit; font-size: 0.85rem; cursor: pointer;">
            <option value="watermark_only" selected>💧 Solo Marca de Agua (Logo translúcido en esquina, sin robot)</option>
            <option value="none">🚫 Video Limpio (Sin overlays)</option>
          </select>
        </div>
        <div style="display:flex; align-items:center; gap:0.6rem; flex-wrap:wrap;">
          <span style="font-size:0.82rem; color:var(--text-dim);">📍 Esquina Logo:</span>
          <select id="render-watermark-pos" style="background: rgba(10,14,39,0.9); border: 1px solid var(--border-color); color: #fff; padding: 0.4rem 0.75rem; border-radius: 7px; font-family: inherit; font-size: 0.85rem; cursor: pointer;">
            <option value="top-left" selected>Superior Izquierda (Zona Segura TikTok/Reels)</option>
            <option value="top-right">Superior Derecha</option>
            <option value="bottom-left">Inferior Izquierda</option>
          </select>
        </div>
      </div>

      <!-- Reproductor de Audio Principal (si ya se generó) -->
      <div id="master-audio-container" style="${currentScriptAudio ? 'display:block' : 'display:none'}; background: rgba(0,229,255,0.08); border: 1px solid var(--border-glow); padding: 1rem; border-radius: 12px; margin-bottom: 0.5rem;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.5rem;">
          <span style="font-weight:700; color:var(--primary); font-size:0.9rem;">🎧 Locución Neuronal Completa</span>
          <span id="audio-voice-badge" class="badge badge-ciencia">${currentScriptAudio?.voice || 'Voz Neuronal'}</span>
        </div>
        <audio id="master-audio-player" controls style="width: 100%; border-radius: 8px;" src="${currentScriptAudio?.fullAudioUrl || ''}"></audio>
      </div>

      <!-- Hook -->
      <div class="scene-block hook-block">
        <div class="scene-header">
          <span>🎣 GANCHO INICIAL (0 - 3s)</span>
          <span style="color: #f59e0b">ALTA RETENCIÓN</span>
        </div>
        <div class="scene-narration">🎙️ "${script.hook.narration}"</div>
        <div style="font-size:0.85rem; color: var(--text-dim)">🎬 <b>Visual:</b> ${script.hook.visualDescription}</div>
        <div class="scene-keywords">
          ${(script.hook.visualKeywords || []).map(k => `<span class="keyword-tag">🏷️ ${k}</span>`).join('')}
        </div>
        <div id="media-hook" class="scene-media-box" style="margin-top:0.6rem;"></div>
      </div>

      <!-- Escenas -->
      ${(script.scenes || []).map((s, idx) => `
        <div class="scene-block">
          <div class="scene-header">
            <span>🔹 ${s.badge || `Escena ${idx + 1}`}</span>
          </div>
          <div class="scene-narration">🎙️ ${s.narration}</div>
          <div><span class="scene-onscreen">${s.onscreenText}</span></div>
          <div style="font-size:0.85rem; color: var(--text-dim)">🎬 <b>Visual:</b> ${s.visualDescription}</div>
          <div class="scene-keywords">
            ${(s.visualKeywords || []).map(k => `<span class="keyword-tag">🏷️ ${k}</span>`).join('')}
          </div>
          <div id="media-scene-${idx + 1}" class="scene-media-box" style="margin-top:0.6rem;"></div>
        </div>
      `).join('')}

      <!-- CTA -->
      <div class="scene-block cta-block">
        <div class="scene-header">
          <span>📢 LLAMADO A LA ACCIÓN (CTA)</span>
          <span style="color: #10b981">CIENCIA COOL</span>
        </div>
        <div class="scene-narration">🎙️ "${script.callToAction.narration}"</div>
        <div><span class="scene-onscreen">${script.callToAction.onscreenText}</span></div>
        <div style="margin-top: 0.5rem; color: var(--primary)">${(script.hashtags || []).join(' ')}</div>
        <div id="media-cta" class="scene-media-box" style="margin-top:0.6rem;"></div>
      </div>

      <!-- Panel de renderizado de video -->
      <div id="render-panel" style="display:none; margin-top:1rem; background: rgba(124,58,237,0.12); border: 1px solid rgba(168,85,247,0.4); border-radius:14px; padding:1.2rem;">
        <div style="font-weight:700; color:#a855f7; margin-bottom:0.6rem; font-size:1rem;">🚀 Renderizando Video</div>
        <div id="render-progress-log" style="font-size:0.82rem; color: var(--text-dim); font-family: monospace; max-height:180px; overflow-y:auto; background: rgba(0,0,0,0.3); border-radius:8px; padding:0.7rem; line-height:1.8;"></div>
        <div id="render-result" style="margin-top:0.8rem; display:none;">
          <div style="font-weight:700; color:#10b981; margin-bottom:0.5rem;">✅ ¡Video listo para descargar y publicar!</div>
          <video id="rendered-video-player" controls playsinline style="width:100%; max-height:480px; border-radius:10px; border:2px solid #a855f7; background:#000;"></video>
          <div style="display:flex; gap:0.8rem; margin-top:0.8rem; flex-wrap:wrap;">
            <a id="render-download-link" href="#" download class="btn btn-primary" style="background: linear-gradient(135deg,#10b981,#059669);">⬇️ Descargar MP4</a>
            <button class="btn btn-secondary" onclick="shareVideoToLibrary()">📚 Guardar en Biblioteca</button>
          </div>
        </div>
      </div>
    </div>
  `;

  if (currentScriptMedia) renderSceneMediaMatches(currentScriptMedia);
}

// Generador de voz TTS
window.generateVoiceAudio = async function() {
  if (!currentScript) {
    showToast('Primero genera o selecciona un guion.', true);
    return;
  }

  const voiceSelect = document.getElementById('script-voice');
  const voiceId = voiceSelect ? voiceSelect.value : 'es-MX-JorgeNeural';
  const btn = document.getElementById('btn-generate-audio');

  if (btn) {
    btn.disabled = true;
    btn.innerText = '⏳ Generando locución...';
  }

  showToast('🎙️ Sintetizando voz neuronal en español...');

  try {
    const res = await fetch('/api/generate-audio', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script: currentScript, voiceId })
    });

    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    currentScriptAudio = data.data;

    // Mostrar y reproducir el audio
    const container = document.getElementById('master-audio-container');
    const player = document.getElementById('master-audio-player');
    const badge = document.getElementById('audio-voice-badge');

    if (container && player) {
      container.style.display = 'block';
      player.src = currentScriptAudio.fullAudioUrl;
      if (badge) badge.innerText = currentScriptAudio.voice || 'Voz Neuronal';
      player.play().catch(() => {});
    }

    showToast('✅ ¡Locución generada con éxito! Reproduciendo audio.');
  } catch (error) {
    showToast(`Error al generar audio: ${error.message}`, true);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerText = '🎙️ Regenerar Audio';
    }
  }
};

// Buscador de videos de stock para escenas
window.findSceneVideos = async function() {
  if (!currentScript) {
    showToast('Primero genera o selecciona un guion.', true);
    return;
  }

  const btn = document.getElementById('btn-find-media');
  if (btn) {
    btn.disabled = true;
    btn.innerText = '⏳ Buscando videos...';
  }

  showToast('🎬 Buscando clips y videos en biblioteca espacial...');

  try {
    const res = await fetch('/api/find-media', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script: currentScript })
    });

    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    currentScriptMedia = data.data;
    renderSceneMediaMatches(currentScriptMedia);
    showToast('✅ ¡Videos y clips encontrados para cada escena!');
  } catch (error) {
    showToast(`Error buscando medios: ${error.message}`, true);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerText = '🎬 Buscar Videos para Escenas';
    }
  }
};

// ─── FASE 3: Renderizador de Video Final ────────────────────────────────────
window.renderFinalVideoUI = async function() {
  if (!currentScript) {
    showToast('Primero genera un guion.', true);
    return;
  }
  if (!currentScriptAudio || !currentScriptAudio.fullAudioFilename) {
    showToast('Primero genera la locución de voz (🎙️).', true);
    return;
  }

  const panel = document.getElementById('render-panel');
  const log   = document.getElementById('render-progress-log');
  const result = document.getElementById('render-result');
  const btn   = document.getElementById('btn-render-video');

  panel.style.display = 'block';
  result.style.display = 'none';
  log.innerHTML = '';
  panel.scrollIntoView({ behavior: 'smooth' });

  if (btn) { btn.disabled = true; btn.innerText = '⏳ Renderizando...'; }

  const appendLog = (msg) => {
    const line = document.createElement('div');
    line.textContent = msg;
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
  };

  appendLog('🎬 Iniciando render de video vertical 9:16 para redes sociales...');

  try {
    const brandingMode = document.getElementById('render-branding-mode')?.value || 'watermark_only';
    const watermarkPos = document.getElementById('render-watermark-pos')?.value || 'top-left';

    const res = await fetch('/api/render-video', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        script: currentScript,
        audioResult: currentScriptAudio,
        mediaMatches: currentScriptMedia || [],
        brandingMode,
        watermarkPos,
        source: window._currentNewsSource || currentScript.source || '',
        category: window._currentNewsCategory || currentScript.category || ''
      })
    });

    // Leer SSE manualmente como stream de texto
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalVideoUrl = null;
    // Handler de error del <video> del render anterior, para poder quitarlo
    // antes de poner el nuevo (si no, se acumulan uno por render).
    let mostrarErrorAnterior = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const evt = JSON.parse(line.slice(6));
            if (evt.type === 'progress') {
              appendLog(evt.message);
            } else if (evt.type === 'error') {
              appendLog('❌ Error: ' + evt.message);
              showToast('Error en renderizado: ' + evt.message, true);
            } else if (evt.type === 'done') {
              finalVideoUrl = evt.videoUrl;
              currentRenderedVideo = evt;
              appendLog('🎉 ¡Renderizado completado exitosamente!');
            }
          } catch (_) {}
        }
      }
    }

    if (finalVideoUrl) {
      const player = document.getElementById('rendered-video-player');
      const dlLink = document.getElementById('render-download-link');

      // Agregar timestamp para evitar caché del navegador
      const videoUrlWithCacheBust = `${finalVideoUrl}?t=${Date.now()}`;

      // Los listeners se registran ANTES de asignar src. Con el orden
      // inverso, un fallo rápido (404 o respuesta cortada) podía dispararse
      // antes de que existiera el listener y el error se perdía en silencio,
      // dejando el recuadro en negro sin explicación. También se limpian los
      // listeners del render anterior: si no, se acumulan uno por render y el
      // toast de error salía repetidas veces.
      const mostrarError = (e) => {
        console.error('Error cargando video:', player.error || e);
        // El código 4 es MEDIA_ERR_SRC_NOT_SUPPORTED: el archivo llegó pero el
        // navegador no puede decodificarlo. 2 es error de red (el caso de que
        // Cloud Run cortara la respuesta por superar los 32 MB).
        const detalle = player.error && player.error.code === 4
          ? ' El archivo se descargó pero el navegador no pudo reproducirlo.'
          : ' No se pudo descargar el archivo del servidor.';
        showToast('Error al cargar el video.' + detalle + ' Intenta renderizar de nuevo.', true);
      };
      player.removeEventListener('error', mostrarErrorAnterior);
      mostrarErrorAnterior = mostrarError;
      player.addEventListener('error', mostrarError);

      player.addEventListener('loadedmetadata', function alCargar() {
        player.removeEventListener('loadedmetadata', alCargar);
        console.log('✅ Video cargado correctamente:', player.duration, 'segundos');
        showToast('🎉 ¡Video listo! Puedes descargarlo y subirlo a TikTok/Instagram/YouTube Shorts.');
      });

      player.src = videoUrlWithCacheBust;
      dlLink.href = videoUrlWithCacheBust;
      dlLink.download = finalVideoUrl.split('/').pop();
      result.style.display = 'block';
      // Fuerza a que el <video> pida los datos con la nueva URL.
      player.load();
    }
  } catch (error) {
    appendLog('❌ Error de conexión: ' + error.message);
    showToast('Error de conexión: ' + error.message, true);
  } finally {
    if (btn) { btn.disabled = false; btn.innerText = '🚀 Renderizar Video Final'; }
  }
};

window.shareVideoToLibrary = function() {
  showToast('📚 Video guardado en Biblioteca. Ve a la pestaña Videos.');
  document.querySelector('[data-tab="videos-tab"]')?.click();
};

// Cargar biblioteca de videos renderizados
async function loadVideosLibrary() {
  const grid = document.getElementById('videos-grid');
  if (!grid) return;
  grid.innerHTML = '<div class="loading-spinner">Cargando videos renderizados...</div>';

  try {
    const res = await fetch('/api/videos');
    const data = await res.json();
    if (!data.success || data.data.length === 0) {
      grid.innerHTML = '<div class="loading-spinner">Aún no hay videos renderizados. ¡Genera el primero desde el Estudio!</div>';
      return;
    }

    grid.innerHTML = data.data.map((v, idx) => {
      const sizeMB = (v.size / 1024 / 1024).toFixed(1);
      const date = new Date(v.createdAt).toLocaleString('es-ES');
      const playerId = `vlib-player-${idx}`;
      const thumbId  = `vlib-thumb-${idx}`;
      return `
        <div class="card" style="position:relative;">
          <!-- Thumbnail / video container 9:16 -->
          <div id="${thumbId}" style="background:#000; border-radius:10px; overflow:hidden; margin-bottom:0.8rem; position:relative; aspect-ratio:9/16; max-height:360px; cursor:pointer;" onclick="toggleVideoLibPlayer('${playerId}','${thumbId}','${v.url}')">
            <!-- Poster negro con ícono play hasta que el usuario haga clic -->
            <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;z-index:2;background:rgba(0,0,0,0.55);">
              <div style="width:60px;height:60px;border-radius:50%;background:var(--primary);display:flex;align-items:center;justify-content:center;box-shadow:0 0 20px var(--primary);">
                <span style="font-size:1.6rem;margin-left:4px;">▶</span>
              </div>
            </div>
            <video id="${playerId}" preload="metadata" playsinline style="width:100%;height:100%;object-fit:cover;display:block;"></video>
          </div>
          <div class="card-badge-row">
            <span class="badge badge-ciencia">MP4 Vertical 9:16</span>
            <span class="card-date">${date}</span>
          </div>
          <p class="card-snippet" style="color:var(--text-dim);font-size:0.8rem;">📁 ${v.filename} · ${sizeMB} MB</p>
          <div class="card-actions">
            <a href="${v.url}" download="${v.filename}" class="btn btn-primary" style="text-decoration:none;background:linear-gradient(135deg,#10b981,#059669);">⬇️ Descargar</a>
            <button class="btn btn-secondary" onclick="toggleVideoLibPlayer('${playerId}','${thumbId}','${v.url}')">▶ Reproducir</button>
          </div>
        </div>
      `;
    }).join('');
  } catch (e) {
    grid.innerHTML = `<div class="loading-spinner" style="color: var(--danger)">Error: ${e.message}</div>`;
  }
}

// Controla el reproductor en la galería de videos (lazy load: asigna src solo al hacer clic)
window.toggleVideoLibPlayer = function(playerId, thumbId, videoUrl) {
  const videoEl = document.getElementById(playerId);
  const thumbEl = document.getElementById(thumbId);
  if (!videoEl) return;

  // Ocultar overlay de play
  const overlay = thumbEl?.querySelector('div[style*="z-index:2"]');

  if (!videoEl.src) {
    // Primera reproducción: asignar src y reproducir
    videoEl.src = videoUrl;
    videoEl.load();
    videoEl.play().catch(() => {});
    if (overlay) overlay.style.display = 'none';
  } else if (videoEl.paused) {
    videoEl.play().catch(() => {});
    if (overlay) overlay.style.display = 'none';
  } else {
    videoEl.pause();
    if (overlay) overlay.style.display = 'flex';
  }
};


function renderSceneMediaMatches(matches) {
  if (!matches || !Array.isArray(matches)) return;

  matches.forEach(match => {
    let targetElId = '';
    if (match.sceneType === 'hook') targetElId = 'media-hook';
    else if (match.sceneType === 'cta') targetElId = 'media-cta';
    else if (match.sceneType === 'scene') targetElId = `media-scene-${match.sceneIndex}`;

    const el = document.getElementById(targetElId);
    if (!el) return;

    if (match.selectedMedia) {
      const media = match.selectedMedia;
      const isVideo = media.isVideo;

      el.innerHTML = `
        <div style="background: rgba(0,0,0,0.55); border: 1px solid var(--border-glow); border-radius: 10px; padding: 0.8rem; margin-top: 0.5rem; display: flex; flex-direction: column; gap: 0.6rem;">
          <div style="display: flex; gap: 0.8rem; align-items: center;">
            <div style="position: relative; width: 80px; height: 55px; flex-shrink: 0;">
              <img src="${media.preview}" style="width: 100%; height: 100%; object-fit: cover; border-radius: 6px; border: 1px solid var(--border-color);" alt="clip">
              ${isVideo ? '<span style="position: absolute; bottom: 2px; right: 2px; background: rgba(0,0,0,0.8); color: var(--primary); font-size: 0.65rem; padding: 1px 4px; border-radius: 3px; font-weight: 700;">MP4</span>' : ''}
            </div>
            <div style="flex: 1; min-width: 0;">
              <div style="font-size: 0.85rem; font-weight: 700; color: var(--primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${isVideo ? '🎥 Video' : '🖼️ Imagen'}: ${media.title}</div>
              <div style="font-size: 0.75rem; color: var(--text-dim); margin-top: 0.1rem;">Fuente: ${media.source}</div>
            </div>
            ${isVideo ? `
              <button class="btn btn-primary" style="font-size: 0.75rem; padding: 0.35rem 0.7rem;" onclick="toggleSceneVideoPlayer('${targetElId}-player', '${media.videoUrl}')">▶️ Reproducir Video</button>
            ` : `
              <a href="${media.preview}" target="_blank" class="btn btn-secondary" style="font-size: 0.75rem; padding: 0.35rem 0.7rem; text-decoration: none;">👁️ Ver Imagen</a>
            `}
          </div>
          ${isVideo ? `
            <div id="${targetElId}-player" style="display: none; width: 100%; margin-top: 0.4rem;">
              <video controls playsinline loop style="width: 100%; max-height: 280px; border-radius: 8px; background: #000; border: 1px solid var(--primary);" src="${media.videoUrl}"></video>
            </div>
          ` : ''}
        </div>
      `;
    }
  });
}

window.toggleSceneVideoPlayer = function(playerId, videoUrl) {
  const container = document.getElementById(playerId);
  if (!container) return;
  const isHidden = container.style.display === 'none';
  container.style.display = isHidden ? 'block' : 'none';
  const videoEl = container.querySelector('video');
  if (videoEl) {
    if (isHidden) {
      if (!videoEl.src) videoEl.src = videoUrl;
      videoEl.play().catch(() => {});
    } else {
      videoEl.pause();
    }
  }
};


window.copyScriptText = function() {
  const blocks = document.querySelectorAll('.scene-narration');
  const text = Array.from(blocks).map(b => b.innerText.replace('🎙️ ', '')).join('\n\n');
  navigator.clipboard.writeText(text);
  showToast('📋 Texto de la locución copiado al portapapeles.');
};

// 6. Cargar Biblioteca de Guiones Guardados
async function loadLibrary() {
  const grid = document.getElementById('library-grid');
  grid.innerHTML = '<div class="loading-spinner">Cargando biblioteca de guiones...</div>';

  try {
    const res = await fetch('/api/scripts');
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    if (data.data.length === 0) {
      grid.innerHTML = '<div class="loading-spinner">Aún no hay guiones generados. ¡Genera el primero!</div>';
      return;
    }

    grid.innerHTML = data.data.map(item => `
      <div class="card">
        <div>
          <div class="card-badge-row">
            <span class="badge badge-ciencia">${item.format}</span>
            <span class="card-date">${new Date(item.createdAt).toLocaleDateString('es-ES')}</span>
          </div>
          <h3 class="card-title">${item.title}</h3>
          <p class="card-snippet">🎣 "${item.content?.hook?.narration || ''}"</p>
        </div>
        <div class="card-actions">
          <button class="btn btn-primary" onclick='loadExistingScript(${JSON.stringify(item.content).replace(/'/g, "&apos;")})'>👁️ Ver en Estudio</button>
        </div>
      </div>
    `).join('');
  } catch (error) {
    grid.innerHTML = `<div class="loading-spinner" style="color: var(--danger)">Error: ${error.message}</div>`;
  }
}

window.loadExistingScript = function(script) {
  document.querySelector('[data-tab="studio-tab"]').click();
  renderStoryboard(script);
  showToast(`Guion cargado: ${script.title}`);
};


// Listeners
function setupEventListeners() {
  document.getElementById('btn-refresh-news')?.addEventListener('click', () => loadNews(currentCategory, { force: true }));
  document.getElementById('btn-refresh-history')?.addEventListener('click', loadHistory);
  document.getElementById('btn-refresh-library')?.addEventListener('click', loadLibrary);
  document.getElementById('btn-generate-script')?.addEventListener('click', generateScript);

  // Navegación de efemérides por fecha
  const datePicker = document.getElementById('history-date-picker');
  datePicker?.addEventListener('change', (e) => {
    if (e.target.value) {
      const parts = e.target.value.split('-');
      const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
      loadHistory(d);
    }
  });

  document.getElementById('btn-today-history')?.addEventListener('click', () => {
    loadHistory(new Date());
  });

  document.getElementById('btn-prev-day')?.addEventListener('click', () => {
    const prev = new Date(selectedHistoryDate);
    prev.setDate(prev.getDate() - 1);
    loadHistory(prev);
  });

  document.getElementById('btn-next-day')?.addEventListener('click', () => {
    const next = new Date(selectedHistoryDate);
    next.setDate(next.getDate() + 1);
    loadHistory(next);
  });

  // Filtros de categoría de noticias
  document.querySelectorAll('.filter-chip[data-category]').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.filter-chip[data-category]').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      const cat = chip.getAttribute('data-category');
      loadNews(cat);
    });
  });


  // Búsqueda en NASA
  document.getElementById('btn-search-nasa')?.addEventListener('click', async () => {
    const q = document.getElementById('nasa-search-input').value.trim() || 'galaxy';
    const grid = document.getElementById('nasa-results-grid');
    grid.innerHTML = '<div class="loading-spinner">Buscando en la NASA...</div>';

    try {
      const res = await fetch(`/api/nasa/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      if (!data.success || data.data.length === 0) {
        grid.innerHTML = '<div class="loading-spinner">No se encontraron resultados en la NASA.</div>';
        return;
      }

      grid.innerHTML = data.data.map(item => `
        <div class="card">
          <div style="height: 180px; background: url('${item.preview}') center/cover no-repeat; border-radius: 8px; margin-bottom: 0.8rem"></div>
          <h4 class="card-title" style="font-size: 0.95rem">${item.title}</h4>
          <div class="card-actions" style="margin-top: 0.8rem">
            <button class="btn btn-primary" onclick="prepareScriptFromNasa('${item.title.replace(/'/g, "\\'")}', '${(item.description || '').slice(0, 200).replace(/'/g, "\\'")}')">✨ Crear Guion</button>
          </div>
        </div>
      `).join('');
    } catch (e) {
      grid.innerHTML = `<div class="loading-spinner" style="color: var(--danger)">Error: ${e.message}</div>`;
    }
  });
}
