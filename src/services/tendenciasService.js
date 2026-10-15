// src/services/tendenciasService.js
// ─────────────────────────────────────────────────────────────────────────────
// QUÉ CALIENTA HOY EN MÉXICO, sin gastar un peso.
//
// ── La idea ─────────────────────────────────────────────────────────────────
// Elegir la noticia "más reciente" es un mal criterio: la más reciente puede
// ser una nota de relleno, mientras la noticia que todo mundo está buscando
// lleva tres horas publicada. Este servicio reúne las dos señales que se
// pueden tener GRATIS y sin ninguna clave de API:
//
//   1. Google Trends, tendencias de búsqueda de HOY en México.
//      Fuente oficial de Google, pública, sin registro:
//        https://trends.google.com/trending/rss?geo=MX
//      Cada traída viene con el término y el volumen aproximado de búsquedas
//      ("200K+", "2M+"). Eso es exactamente "cuánta gente está preguntando por
//      esto ahora mismo".
//
//   2. Cuántos medios distintos cubren la misma noticia (se calcula sobre la
//      lista de feeds que ya tenemos; ver `contarCobertura`). Si una noticia la
//      traen siete medios a la vez, es que está caliente.
//
// ── Coste ───────────────────────────────────────────────────────────────────
// Una petición HTTP cada 6 horas. Cero pesos, cero claves.
//
// ── Si Google falla ─────────────────────────────────────────────────────────
// Nada se rompe: se devuelve una lista vacía y la elección de noticia sigue
// funcionando igual que antes (recencia + no repetir). Las tendencias son una
// mejora, no una dependencia.
// ─────────────────────────────────────────────────────────────────────────────

import Parser from 'rss-parser';

const parser = new Parser({
  requestOptions: {
    headers: {
      'User-Agent': 'CIENCIA-COOL/1.0 (tendencias)',
      Accept: 'application/rss+xml, application/xml, text/xml, */*',
    },
    timeout: 12000,
  },
  customFields: {
    item: ['ht:approx_traffic', 'ht:picture'],
  },
});

const TRENDS_RSS_MX = 'https://trends.google.com/trending/rss?geo=MX';

// Refresco cada 6 h. Las tendencias de Google cambian a lo largo del día, pero
// consultarlas cada 6 h es más que suficiente y evita martillear el servicio.
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

let cache = { at: 0, terminos: [] };

/** Palabras que no aportan nada al comparar titulares. */
const VACIAS = new Set([
  'de', 'del', 'la', 'las', 'el', 'los', 'un', 'una', 'unos', 'unas', 'y', 'o',
  'a', 'en', 'con', 'por', 'para', 'que', 'se', 'su', 'sus', 'al', 'lo', 'es',
  'son', 'como', 'mas', 'más', 'pero', 'sobre', 'tras', 'hasta', 'desde', 'sin',
  'the', 'of', 'and', 'to', 'in', 'on', 'for', 'with', 'a', 'an', 'is', 'are',
  'noticia', 'noticias', 'video', 'videos', 'asi', 'así', 'esta', 'este',
]);

/** Quita acentos y pasa a minúsculas, para comparar sin tropezar con tildes. */
function normalizar(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/** Convierte "2M+" en 2_000_000 y "200K+" en 200_000. Devuelve 0 si no se puede. */
function traficoANumero(texto) {
  const t = String(texto || '').replace(/[^\d.,kmKMG]/gi, '');
  const n = parseFloat(t.replace(',', '.'));
  if (!Number.isFinite(n)) return 0;
  const sufijo = /m/i.test(String(texto || '')) ? 1_000_000 : /k/i.test(String(texto || '')) ? 1_000 : 1;
  return n * sufijo;
}

/** Palabras con significado de un texto, para comparar. */
export function palabrasClave(texto) {
  return normalizar(texto)
    .split(/[^a-z0-9ñ]+/)
    .filter(p => p.length >= 4 && !VACIAS.has(p));
}

/**
 * ¿Está la palabra COMPLETA en el texto?
 *
 * Sin esto, mirar por subcadena hace que "inter" case con "internacional" y
 * cualquier noticia de una feria internacional se marque como tendencia
 * "Inter de Miami". Palabra completa o nada.
 */
function contienePalabra(textoNormalizado, palabra) {
  return new RegExp(`(^|[^a-z0-9])${palabra}([^a-z0-9]|$)`, 'i').test(textoNormalizado);
}

/**
 * Descarga las tendencias de búsqueda de hoy en México.
 *
 * @returns {Promise<Array<{termino: string, trafico: number}>>}
 */
export async function obtenerTendenciasMX() {
  if (Date.now() - cache.at < CACHE_TTL_MS && cache.terminos.length) {
    return cache.terminos;
  }

  try {
    const feed = await parser.parseURL(TRENDS_RSS_MX);
    const terminos = (feed.items || [])
      .map(item => ({
        termino: String(item.title || '').trim(),
        trafico: traficoANumero(item['ht:approx_traffic'] || item.contentSnippet || ''),
      }))
      .filter(t => t.termino.length > 1)
      .slice(0, 40);

    if (terminos.length) {
      cache = { at: Date.now(), terminos };
      console.log(`🔥 ${terminos.length} tendencias de Google México (la primera: "${terminos[0].termino}")`);
    } else {
      console.warn('⚠️ Google Trends no devolvió términos; se sigue sin tendencias');
    }
    return cache.terminos;
  } catch (error) {
    // Google bloquea a veces estas peticiones. No es grave: la elección de
    // noticia continúa por recencia.
    console.warn(`⚠️ No se pudieron leer las tendencias de Google (${error.message}); se omite ese criterio`);
    return cache.terminos;
  }
}

/**
 * Cuántas noticias distintas de la lista hablan de lo mismo.
 *
 * Dos titulares "hablan de lo mismo" cuando comparten 3 o más palabras con
 * significado. Es una aproximación honesta a "cuántos medios cubren la
 * noticia", usando la lista de feeds que ya tenemos descargada.
 *
 * @param {Array} noticias Lista de noticias candidatas.
 * @returns {Map<object, number>} noticia -> nº de medios que la cubren.
 */
export function contarCobertura(noticias) {
  const claves = noticias.map(n => new Set(palabrasClave(n.title)));
  const cobertura = new Map();

  for (let i = 0; i < noticias.length; i++) {
    let total = 0;
    for (let j = 0; j < noticias.length; j++) {
      if (i === j) continue;
      let comunes = 0;
      for (const p of claves[i]) if (claves[j].has(p)) comunes++;
      if (comunes >= 3) total++;
    }
    cobertura.set(noticias[i], total);
  }

  return cobertura;
}

/**
 * Puntúa una noticia según lo caliente que esté.
 *
 *   cobertura × 1        cuántos medios la cubren (0-10 típico)
 * + tendencia  × 40      si toca una búsqueda en tendencia en México
 * + novedad   × 0-5     más reciente = más puntos
 *
 * Los pesos están puestos para que la tendencia domine (una noticia que la
 * gente está buscando merece publicarse aunque la cubran menos medios), pero
 * que la cobertura siga siendo decisiva entre dos noticias parecidas.
 *
 * @returns {{total: number, motivos: string[]}}
 */
export function puntuarNoticia(noticia, { tendencias = [], cobertura = 0, ahora = Date.now() }) {
  const motivos = [];
  let total = 0;

  // 1. Cobertura entre medios.
  if (cobertura > 0) {
    total += cobertura;
    motivos.push(`${cobertura} medios`);
  }

  // 2. Tendencia de Google México: tienen que estar TODAS las palabras del
  //    término como palabras completas. Esto es lo que evita falsos positivos
  //    como marcar "premio internacional de innovación" como tendencia
  //    "Inter de Miami".
  const titulo = normalizar(noticia.title);
  for (const t of tendencias) {
    const palabras = palabrasClave(t.termino);
    if (!palabras.length) continue;
    const coinciden = palabras.filter(p => contienePalabra(titulo, p)).length;
    if (coinciden === palabras.length) {
      const peso = 40 + Math.min(60, Math.round(t.trafico / 50_000));
      total += peso;
      motivos.push(`tendencia "${t.termino}" (+${peso})`);
      break;
    }
  }

  // 3. Novedad: hasta 5 puntos para lo publicado en las últimas horas.
  const horas = (ahora - Number(noticia.timestamp || 0)) / 3_600_000;
  if (Number.isFinite(horas) && horas >= 0) {
    const novedad = Math.max(0, 5 - horas / 6);
    total += novedad;
    motivos.push(`${horas < 1 ? 'hace <1h' : `hace ${Math.round(horas)}h`}`);
  }

  return { total, motivos };
}

/**
 * Ordena las noticias de más a menos caliente.
 *
 * @param {Array}   noticias
 * @param {Array}   tendencias  Lo que devuelve obtenerTendenciasMX().
 * @returns {Array}  Las mismas noticias, reordenadas.
 */
export function ordenarPorTendencia(noticias, tendencias = []) {
  if (!Array.isArray(noticias) || noticias.length === 0) return [];

  const coberturas = contarCobertura(noticias);
  const ahora = Date.now();

  return noticias
    .map(n => ({
      noticia: n,
      ...puntuarNoticia(n, {
        tendencias,
        cobertura: coberturas.get(n) || 0,
        ahora,
      }),
    }))
    .sort((a, b) => b.total - a.total);
}

/** Vacía la caché. Solo para pruebas. */
export function reiniciarCacheTendencias() {
  cache = { at: 0, terminos: [] };
}
