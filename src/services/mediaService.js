import axios from 'axios';

// ─────────────────────────────────────────────────────────────────────────────
// FUENTES DE VIDEO LIBRE
// Priority: Pexels → Pixabay → NASA (solo temas espaciales) → Wikimedia Commons
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Busca videos en Pexels (videos de stock libres, cualquier tema).
 * Requiere PEXELS_API_KEY en .env (gratis en pexels.com/api)
 */
async function searchPexelsVideos(query, orientation = 'portrait') {
  const apiKey = process.env.PEXELS_API_KEY;
  if (!apiKey || apiKey === 'tu_pexels_key_aqui') return [];

  try {
    const url = `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=8&orientation=${orientation}&size=medium&locale=es-ES`;
    const res = await axios.get(url, {
      headers: { Authorization: apiKey },
      timeout: 8000
    });

    return (res.data?.videos || []).map(v => {
      const files = v.video_files || [];
      const preferred = files.find(f => f.height >= 720 && f.height <= 1920)
        || files.find(f => f.quality === 'hd')
        || files[0];

      return {
        id: `pexels_${v.id}`,
        title: v.url?.split('/').filter(Boolean).pop() || `Video ${v.id}`,
        description: `Video de stock libre - Pexels #${v.id}`,
        mediaType: 'video',
        preview: v.image,
        videoUrl: preferred?.link || null,
        isVideo: Boolean(preferred?.link),
        source: 'Pexels (Libre de Derechos)',
        duration: v.duration,
        width: preferred?.width,
        height: preferred?.height
      };
    }).filter(v => v.videoUrl);
  } catch (err) {
    console.warn('⚠️ Pexels no disponible:', err.message);
    return [];
  }
}

/**
 * Busca videos en Pixabay (videos libres CC0, cualquier tema).
 * Requiere PIXABAY_API_KEY en .env (gratis en pixabay.com/api/)
 */
async function searchPixabayVideos(query) {
  const apiKey = process.env.PIXABAY_API_KEY;
  if (!apiKey || apiKey === 'tu_pixabay_key_aqui') return [];

  try {
    const url = `https://pixabay.com/api/videos/?key=${apiKey}&q=${encodeURIComponent(query)}&per_page=8&video_type=film&lang=es`;
    const res = await axios.get(url, { timeout: 8000 });

    return (res.data?.hits || []).map(v => {
      const videos = v.videos || {};
      const best = videos.medium?.url || videos.small?.url || videos.large?.url;
      return {
        id: `pixabay_${v.id}`,
        title: v.tags || `Video ${v.id}`,
        description: `Video libre CC0 - Pixabay #${v.id}`,
        mediaType: 'video',
        preview: `https://i.vimeocdn.com/video/${v.picture_id}_640x360.jpg`,
        videoUrl: best || null,
        isVideo: Boolean(best),
        source: 'Pixabay (CC0 Libre)',
        duration: v.duration
      };
    }).filter(v => v.videoUrl);
  } catch (err) {
    console.warn('⚠️ Pixabay no disponible:', err.message);
    return [];
  }
}

/**
 * Busca videos en la NASA.
 * Solo se llama cuando el tema es claramente espacial/científico.
 */
async function searchNasaVideos(query = 'space galaxy') {
  try {
    const spanishToEnglish = {
      'espacio': 'space', 'galaxia': 'galaxy', 'estrella': 'star', 'planeta': 'planet',
      'luna': 'moon', 'sol': 'sun', 'tierra': 'earth', 'agua': 'water', 'fuego': 'fire',
      'tecnología': 'technology', 'ciencia': 'science', 'laboratorio': 'laboratory',
      'naturaleza': 'nature', 'universo': 'universe', 'cohete': 'rocket', 'marte': 'mars'
    };
    let englishQuery = query.split(' ').map(w => spanishToEnglish[w.toLowerCase()] || w).join(' ');
    const cleanQuery = englishQuery.replace(/[^\w\s]/gi, '').trim() || 'galaxy';
    const url = `https://images-api.nasa.gov/search?q=${encodeURIComponent(cleanQuery)}&media_type=video,image`;
    const response = await axios.get(url, { timeout: 8000 });
    const items = response.data?.collection?.items || [];

    const results = [];
    for (const item of items.slice(0, 6)) {
      const data = item.data?.[0];
      const preview = item.links?.find(l => l.rel === 'preview')?.href;
      if (data && preview) {
        let videoUrl = null;
        if (data.media_type === 'video' && item.href) {
          try {
            const assetRes = await axios.get(item.href, { timeout: 4000 });
            const files = Array.isArray(assetRes.data) ? assetRes.data : [];
            const mp4 = files.find(f =>
              f.endsWith('~preview.mp4') ||
              f.endsWith('~mobile.mp4') ||
              f.endsWith('~medium.mp4') ||
              f.endsWith('.mp4')
            );
            if (mp4) videoUrl = mp4.replace(/^http:\/\//i, 'https://');
          } catch (_) {}
        }
        results.push({
          id: data.nasa_id,
          title: data.title,
          description: data.description,
          mediaType: data.media_type,
          preview,
          videoUrl: videoUrl || null,
          isVideo: Boolean(videoUrl),
          source: 'NASA Cosmos Archive'
        });
      }
    }
    return results;
  } catch (error) {
    console.error('Error buscando en NASA:', error.message);
    return [];
  }
}

/**
 * Busca en Wikimedia Commons videos libres de derechos.
 */
async function searchWikimediaVideos(query) {
  try {
    const url = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6&gsrsearch=${encodeURIComponent(query + ' filetype:video')}&gsrlimit=5&prop=videoinfo&viprop=url|mime|size&format=json&origin=*`;
    const res = await axios.get(url, { timeout: 6000 });
    const pages = Object.values(res.data?.query?.pages || {});
    return pages
      .filter(p => p.videoinfo?.[0]?.url)
      .map(p => ({
        id: `wiki_${p.pageid}`,
        title: p.title?.replace('File:', ''),
        description: 'Video de Wikimedia Commons (dominio público)',
        mediaType: 'video',
        preview: p.videoinfo[0].url,
        videoUrl: p.videoinfo[0].url,
        isVideo: true,
        source: 'Wikimedia Commons (Dominio Público)'
      }))
      .filter(v => v.videoUrl?.endsWith('.webm') || v.videoUrl?.endsWith('.mp4') || v.videoUrl?.endsWith('.ogv'));
  } catch (err) {
    console.warn('⚠️ Wikimedia no disponible:', err.message);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DETECCIÓN DE TEMA — evita cruzar contenidos
// ─────────────────────────────────────────────────────────────────────────────

/** Palabras clave de tema espacial/astronómico */
const SPACE_KEYWORDS = [
  'space', 'galaxy', 'nasa', 'star', 'planet', 'cosmos', 'orbit', 'rocket',
  'astronaut', 'moon', 'sun', 'nebula', 'asteroid', 'comet', 'universe',
  'espacio', 'galaxia', 'estrella', 'planeta', 'cohete', 'astronauta', 'luna',
  'sol', 'nebulosa', 'asteroide', 'universo', 'órbita', 'satélite', 'telescopio',
  'hubble', 'webb', 'marte', 'jupiter', 'saturn', 'venus', 'mars', 'solar'
];

/** Palabras clave NO espaciales — cuando aparecen, NASA NO es relevante */
const NON_SPACE_OVERRIDES = [
  'videojuego', 'gaming', 'game', 'jugador', 'gamer', 'playstation', 'xbox',
  'política', 'president', 'gobierno', 'elección', 'election', 'candidato',
  'fútbol', 'soccer', 'deporte', 'sport', 'atleta', 'athlete',
  'economía', 'economy', 'dinero', 'money', 'banco', 'bank', 'bolsa', 'stock market',
  'música', 'music', 'canción', 'song', 'artista', 'artist', 'concierto', 'concert',
  'película', 'movie', 'film', 'cine', 'cinema', 'actor', 'actriz',
  'comida', 'food', 'receta', 'recipe', 'restaurante', 'restaurant',
  'moda', 'fashion', 'ropa', 'clothes', 'diseñador'
];

/**
 * Detecta si el tema es relacionado a espacio/astronomía para priorizar NASA.
 * Solo devuelve true si hay palabras clave espaciales Y no hay sobreescrituras
 * de otros temas (evita poner videos de galaxias en noticias de videojuegos).
 */
function isSpaceTopic(query) {
  const q = query.toLowerCase();
  const hasSpaceWord = SPACE_KEYWORDS.some(kw => q.includes(kw));
  const hasNonSpaceWord = NON_SPACE_OVERRIDES.some(kw => q.includes(kw));
  return hasSpaceWord && !hasNonSpaceWord;
}

// ─────────────────────────────────────────────────────────────────────────────
// TRADUCCIÓN ES → EN — para mejores resultados en Pexels y Pixabay
// ─────────────────────────────────────────────────────────────────────────────

/** Diccionario ES→EN expandido para búsquedas en stock genérico */
const ES_TO_EN = {
  // Ciencia y espacio
  'espacio': 'space', 'galaxia': 'galaxy', 'estrella': 'star', 'planeta': 'planet',
  'luna': 'moon', 'sol': 'sun', 'tierra': 'earth', 'universo': 'universe',
  'cohete': 'rocket', 'astronauta': 'astronaut', 'satélite': 'satellite',
  'telescopio': 'telescope', 'nebulosa': 'nebula', 'cometa': 'comet',
  'laboratorio': 'laboratory', 'ciencia': 'science', 'científico': 'scientist',
  'experimento': 'experiment', 'tecnología': 'technology', 'robot': 'robot',
  'microscopio': 'microscope', 'adn': 'dna', 'célula': 'cell',
  // Naturaleza
  'naturaleza': 'nature', 'agua': 'water', 'fuego': 'fire', 'tierra': 'earth',
  'océano': 'ocean', 'mar': 'sea', 'montaña': 'mountain', 'bosque': 'forest',
  'árbol': 'tree', 'flor': 'flower', 'animal': 'animal', 'pájaro': 'bird',
  // Sociedad y economía
  'ciudad': 'city', 'gente': 'people', 'persona': 'person', 'hombre': 'man',
  'mujer': 'woman', 'niño': 'child', 'oficina': 'office', 'trabajo': 'work',
  'computadora': 'computer', 'teléfono': 'phone', 'dinero': 'money',
  'banco': 'bank', 'mercado': 'market', 'presidente': 'president',
  'gobierno': 'government', 'policía': 'police', 'hospital': 'hospital',
  // Cultura y entretenimiento
  'música': 'music', 'deporte': 'sport', 'fútbol': 'soccer', 'juego': 'game',
  'película': 'movie', 'comida': 'food', 'viaje': 'travel', 'avión': 'airplane',
  'auto': 'car', 'coche': 'car', 'libro': 'book', 'escuela': 'school',
};

/**
 * Traduce una frase de español a inglés usando el diccionario.
 * Deja intactas las palabras sin traducción conocida.
 */
function translateToEnglish(phrase) {
  return phrase
    .toLowerCase()
    .split(/\s+/)
    .map(word => {
      const clean = word.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
      return ES_TO_EN[clean] || ES_TO_EN[word] || word;
    })
    .join(' ');
}

// ─────────────────────────────────────────────────────────────────────────────
// CONSTRUCCIÓN DE QUERY DE BÚSQUEDA
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Construye una query de búsqueda inteligente a partir de las metadatas de escena.
 * - Prioriza `visualKeywords` (generadas por la IA para representar la escena)
 * - Aplica traducción ES→EN automática
 * - Nunca devuelve un query vacío
 *
 * @param {string[]} keywords       - visualKeywords del guion
 * @param {string}   description    - visualDescription del guion
 * @param {string}   narration      - narración (último recurso para extraer términos)
 * @param {string}   [scriptTitle]  - título del guion (contexto general)
 * @returns {string} Query lista para enviar a Pexels/Pixabay
 */
export function buildSearchQuery(keywords, description, narration, scriptTitle = '') {
  let terms = [];

  // 1. Prioridad máxima: visualKeywords de la IA (ya deberían ser sustantivos concretos)
  if (Array.isArray(keywords) && keywords.length > 0) {
    terms = [...keywords];
  }

  // 2. Respaldo: palabras del description visual (> 4 letras, evitar artículos)
  if (terms.length < 4 && description) {
    const stopWords = new Set(['para', 'como', 'desde', 'hacia', 'sobre', 'entre', 'with', 'from', 'that', 'this', 'una', 'unos', 'unas', 'cada', 'donde', 'cuando', 'mientras', 'porque', 'aunque', 'además', 'también', 'incluso', 'primer', 'primera', 'segundo', 'segunda']);
    const descWords = description.toLowerCase().split(/\s+/)
      .filter(w => w.length > 4 && !stopWords.has(w));
    terms.push(...descWords);
  }

  // 3. Último recurso: palabras clave de la narración
  if (terms.length < 4 && narration) {
    const narWords = narration.toLowerCase().split(/\s+/).filter(w => w.length > 5);
    terms.push(...narWords);
  }

  if (terms.length === 0 && scriptTitle) {
    terms = scriptTitle.split(/\s+/).filter(w => w.length > 4).slice(0, 5);
  }

  // Limpiar, normalizar y traducir al inglés (máximo 4 términos para mejor relevancia)
  const cleanTerms = terms
    .slice(0, 5)
    .map(t => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\s]/gi, '').trim())
    .filter(Boolean);

  const query = cleanTerms.slice(0, 4).join(' ') || 'science';
  return translateToEnglish(query);
}

// ─────────────────────────────────────────────────────────────────────────────
// BUSCADOR UNIVERSAL — combina todas las fuentes en cascada
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Busca videos de uso libre desde múltiples fuentes y retorna los mejores resultados.
 * Prioridad: Pexels → Pixabay → NASA (solo si tema espacial) → Wikimedia Commons
 *
 * @param {string} query         - Término de búsqueda (preferiblemente en inglés)
 * @param {Object} options
 * @param {number} options.limit - Máximo de resultados (default 4)
 * @param {boolean} options.preferVideo - Preferir videos sobre imágenes (default true)
 * @returns {Promise<Array>}     - Array de media objects ordenados por relevancia
 */
export async function searchFreeMedia(query, { limit = 4, preferVideo = true } = {}) {
  const results = [];

  // Buscar en paralelo en todas las fuentes disponibles
  const searches = await Promise.allSettled([
    searchPexelsVideos(query),
    searchPixabayVideos(query),
    isSpaceTopic(query) ? searchNasaVideos(query) : Promise.resolve([]),
    searchWikimediaVideos(query)
  ]);

  const [pexels, pixabay, nasa, wiki] = searches.map(s =>
    s.status === 'fulfilled' ? s.value : []
  );

  // Mezclar resultados: primero los que tienen video real
  const allResults = [...pexels, ...pixabay, ...nasa, ...wiki];
  const withVideo = allResults.filter(r => r.isVideo && r.videoUrl);
  const withImage = allResults.filter(r => !r.isVideo || !r.videoUrl);

  if (preferVideo) {
    results.push(...withVideo, ...withImage);
  } else {
    results.push(...allResults);
  }

  // Si no se encontró nada, hacer un fallback contextual (evitar siempre "space")
  if (results.length === 0) {
    const fallbackQuery = isSpaceTopic(query) ? 'galaxy nebula cosmos' : 'people technology city';
    if (query !== fallbackQuery) {
      console.log(`⚠️ Sin resultados para "${query}", buscando término alternativo: "${fallbackQuery}"`);
      return searchFreeMedia(fallbackQuery, { limit, preferVideo });
    }
  }

  return results.slice(0, limit);
}

// ─────────────────────────────────────────────────────────────────────────────
// INTEGRACIÓN CON GUIONES — asigna media a cada escena
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Busca automáticamente recursos de video libres para las escenas de un guion.
 * Usa múltiples fuentes: Pexels, Pixabay, NASA (solo para temas espaciales), Wikimedia Commons.
 *
 * Mejoras clave:
 * - Pasa el `scriptTitle` como contexto para refinar búsquedas vagas.
 * - El CTA reutiliza el query principal del hook (misma temática visual).
 * - Aplica `buildSearchQuery` con traducción ES→EN en todas las escenas.
 */
export async function findMediaForScenes(script) {
  const sceneMediaMatches = [];
  const scriptTitle = script.title || '';

  // 1. Gancho inicial
  const hookQuery = buildSearchQuery(
    script.hook?.visualKeywords,
    script.hook?.visualDescription,
    script.hook?.narration,
    scriptTitle
  );
  const hookMedia = await searchFreeMedia(hookQuery);
  sceneMediaMatches.push({
    sceneType: 'hook',
    label: 'Gancho Inicial',
    query: hookQuery,
    selectedMedia: hookMedia[0] || null,
    alternatives: hookMedia.slice(1, 4)
  });

  // 2. Escenas principales
  if (Array.isArray(script.scenes)) {
    for (let i = 0; i < script.scenes.length; i++) {
      const scene = script.scenes[i];
      const query = buildSearchQuery(
        scene.visualKeywords,
        scene.visualDescription,
        scene.narration,
        scriptTitle
      );
      const media = await searchFreeMedia(query);
      sceneMediaMatches.push({
        sceneType: 'scene',
        sceneIndex: i + 1,
        label: scene.badge || `Escena ${i + 1}`,
        query,
        selectedMedia: media[0] || null,
        alternatives: media.slice(1, 4)
      });
    }
  }

  // 3. CTA — mismo tema visual que el hook (coherencia visual al cierre)
  const ctaMedia = await searchFreeMedia(hookQuery);
  sceneMediaMatches.push({
    sceneType: 'cta',
    label: 'Llamado a la Acción',
    query: hookQuery,
    selectedMedia: ctaMedia[0] || null,
    alternatives: ctaMedia.slice(1, 4)
  });

  return sceneMediaMatches;
}

// Re-export searchNasaVideos for backwards compatibility (NASA tab search)
export { searchNasaVideos };
