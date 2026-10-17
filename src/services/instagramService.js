// ─────────────────────────────────────────────────────────────────────────────
// Publicación de Reels en Instagram (Instagram Graph API v26.0).
//
// ── Cómo se publica ─────────────────────────────────────────────────────────
// Instagram NO acepta el MP4 en una sola llamada: son DOS pasos y un tiempo de
// espera en medio.
//
//   1) POST /{ig-user-id}/media   → Instagram se descarga el MP4 del bucket
//      (media_type=REELS + video_url) y devuelve un "contenedor" (container).
//   2) esperar a que el contenedor diga FINISHED. Instagram procesa el video en
//      segundo plano; si se publica antes de tiempo responde "The media is not
//      ready to be published yet".
//   3) POST /{ig-user-id}/media_publish con creation_id=<el contenedor>
//      → ahí sí, el Reel queda publicado.
//
// ── El token ────────────────────────────────────────────────────────────────
// INSTAGRAM_TOKEN es el mismo token DE LA PÁGINA que usa Facebook. Necesita los
// permisos instagram_basic e instagram_content_publish.
//
// ── Requisitos de la cuenta ─────────────────────────────────────────────────
// La cuenta de Instagram tiene que ser PROFESIONAL (Empresa o Creador) y estar
// VINCULADA a la página de Facebook. Ese id es INSTAGRAM_USER_ID.
//
// ── Por qué hay reintentos ──────────────────────────────────────────────────
// Igual que en Facebook: el pipeline no debe morir por un mal minuto de Meta.
// Si algo falla se devuelve ok:false, el video NO se borra del bucket y se
// reintenta en la siguiente pasada (ver limpiarVideosPublicados).
// ─────────────────────────────────────────────────────────────────────────────

import axios from 'axios';

const GRAPH = 'https://graph.facebook.com/v26.0';
const INTENTOS = 3;
const ESPERA_ENTRE_INTENTOS_MS = 5000;

// Instagram tarda en procesar el video. Se pregunta cada 15 s, como máximo 12
// veces: unos 3 minutos. No se estira más porque el pipeline entero corre
// dentro del timeout de Cloud Run (600 s) y quedarse sin tiempo ahí sería peor
// que reintentar el Reel en la siguiente pasada.
const ESPERA_PROCESADO_MS = 15000;
const MAX_CONSULTAS_PROCESADO = 12;

const dormir = (ms) => new Promise((resolver) => setTimeout(resolver, ms));

/** ¿Está configurada la cuenta de Instagram en el entorno? */
export function instagramConfigurado() {
  return Boolean(process.env.INSTAGRAM_USER_ID && process.env.INSTAGRAM_TOKEN);
}

/** Paso 1: crear el contenedor con la URL pública del video. */
async function crearContenedor({ igUserId, token, videoUrl, caption }) {
  let ultimoError = 'error_desconocido';

  for (let intento = 1; intento <= INTENTOS; intento++) {
    try {
      const { data } = await axios.post(
        `${GRAPH}/${igUserId}/media`,
        { media_type: 'REELS', video_url: videoUrl, caption },
        {
          timeout: 120000,
          headers: { 'Content-Type': 'application/json' },
          params: { access_token: token },
        }
      );

      if (data?.id) return { ok: true, id: data.id };
      ultimoError = 'Instagram no devolvió el id del contenedor';
    } catch (error) {
      // El mensaje útil viene en error.response.data.error.message; lo que dice
      // axios ("Request failed with status code 400") no explica nada.
      ultimoError = error.response?.data?.error?.message || error.message;
    }

    console.error(`⚠️ Instagram (crear contenedor) intento ${intento}/${INTENTOS} falló: ${ultimoError}`);
    if (intento < INTENTOS) await dormir(ESPERA_ENTRE_INTENTOS_MS * intento);
  }

  return { ok: false, motivo: ultimoError };
}

/** Paso 2: esperar a que Instagram termine de procesar el video. */
async function esperarProcesado({ token, containerId }) {
  for (let consulta = 1; consulta <= MAX_CONSULTAS_PROCESADO; consulta++) {
    let estado = null;
    let detalle = '';

    try {
      const { data } = await axios.get(`${GRAPH}/${containerId}`, {
        timeout: 30000,
        params: { fields: 'status_code,status', access_token: token },
      });
      estado = data?.status_code;
      detalle = data?.status || '';
    } catch (error) {
      // Un fallo suelto consultando el estado no invalida el contenedor: se
      // vuelve a preguntar en la siguiente vuelta.
      const mensaje = error.response?.data?.error?.message || error.message;
      console.error(`⚠️ Instagram: no se pudo consultar el estado (${consulta}): ${mensaje}`);
      await dormir(ESPERA_PROCESADO_MS);
      continue;
    }

    if (estado === 'FINISHED') return { ok: true };

    if (estado === 'ERROR' || estado === 'EXPIRED') {
      return { ok: false, motivo: `Instagram no pudo procesar el video (${estado}): ${detalle}` };
    }

    console.log(`⏳ Instagram: procesando el video (${estado || 'IN_PROGRESS'}, consulta ${consulta}/${MAX_CONSULTAS_PROCESADO})...`);
    await dormir(ESPERA_PROCESADO_MS);
  }

  return { ok: false, motivo: 'Instagram tardó demasiado en procesar el video' };
}

/** Paso 3: publicar el contenedor ya procesado. */
async function publicarContenedor({ igUserId, token, containerId }) {
  let ultimoError = 'error_desconocido';

  for (let intento = 1; intento <= INTENTOS; intento++) {
    try {
      const { data } = await axios.post(
        `${GRAPH}/${igUserId}/media_publish`,
        { creation_id: containerId },
        {
          timeout: 120000,
          headers: { 'Content-Type': 'application/json' },
          params: { access_token: token },
        }
      );

      if (data?.id) return { ok: true, id: data.id };
      ultimoError = 'Instagram no devolvió el id del Reel';
    } catch (error) {
      ultimoError = error.response?.data?.error?.message || error.message;
    }

    console.error(`⚠️ Instagram (publicar) intento ${intento}/${INTENTOS} falló: ${ultimoError}`);
    if (intento < INTENTOS) await dormir(ESPERA_ENTRE_INTENTOS_MS * intento);
  }

  return { ok: false, motivo: ultimoError };
}

/**
 * Publica un Reel en Instagram con la URL pública del MP4.
 *
 * @returns {Promise<{ok: boolean, id?: string, permalink?: string|null, motivo?: string}>}
 */
export async function publicarEnInstagram({ videoUrl, caption, title }) {
  const igUserId = process.env.INSTAGRAM_USER_ID;
  const token = process.env.INSTAGRAM_TOKEN;

  if (!igUserId || !token) {
    console.log('ℹ️ Instagram sin configurar (falta INSTAGRAM_USER_ID o INSTAGRAM_TOKEN).');
    return { ok: false, motivo: 'sin_configurar' };
  }
  if (!videoUrl) {
    return { ok: false, motivo: 'sin_url_de_video' };
  }

  // Instagram corta los pies de foto en 2 200 caracteres.
  const texto = String(caption || title || 'CIENCIA COOL').slice(0, 2200);

  const contenedor = await crearContenedor({ igUserId, token, videoUrl, caption: texto });
  if (!contenedor.ok) return contenedor;
  console.log(`📦 Instagram: video recibido (contenedor ${contenedor.id}), esperando el procesado...`);

  const procesado = await esperarProcesado({ token, containerId: contenedor.id });
  if (!procesado.ok) return procesado;

  const reel = await publicarContenedor({ igUserId, token, containerId: contenedor.id });
  if (!reel.ok) return reel;

  // El enlace permanente es un extra: si falla, el Reel ya está publicado.
  let permalink = null;
  try {
    const { data } = await axios.get(`${GRAPH}/${reel.id}`, {
      timeout: 30000,
      params: { fields: 'permalink', access_token: token },
    });
    permalink = data?.permalink || null;
  } catch {
    /* sin enlace, pero publicado */
  }

  console.log(`✅ Instagram: Reel publicado (${reel.id})`);
  return { ok: true, id: reel.id, permalink };
}
