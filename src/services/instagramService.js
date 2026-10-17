// ─────────────────────────────────────────────────────────────────────────────
// Publicación de Reels en Instagram (API de Instagram con inicio de sesión de
// Instagram, graph.instagram.com).
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
// Se usa la API de Instagram con INICIO DE SESIÓN DE INSTAGRAM, que es la que
// Meta mantiene hoy: el caso de uso "Administrar mensajes y contenido en
// Instagram" del panel de la app. Los permisos son instagram_business_basic e
// instagram_business_content_publish, y el token se saca ahí mismo, en
// "2. Generar tokens de acceso → Agregar cuenta".
//
//   INSTAGRAM_USER_ID  → id de la cuenta profesional de Instagram
//   INSTAGRAM_TOKEN    → token de larga duración (60 días)
//
// El token se RENUEVA SOLO: vive en un bucket privado y se pide otro a Meta
// antes de que caduque, sin que nadie tenga que acordarse. La variable de
// entorno solo hace de semilla. Todo eso está en instagramToken.js.
//
// OJO con el dominio: esta API vive en graph.instagram.com, NO en
// graph.facebook.com. Por eso la dirección es configurable: si algún día hay
// que subir de versión (v23.0 → v24.0…), se hace con una variable de entorno,
// sin tocar el código ni volver a construir la imagen.
//
// ── Requisitos de la cuenta ─────────────────────────────────────────────────
// La cuenta de Instagram tiene que ser PROFESIONAL (Empresa o Creador).
//
// ── Por qué hay reintentos ──────────────────────────────────────────────────
// Igual que en Facebook: el pipeline no debe morir por un mal minuto de Meta.
// Si algo falla se devuelve ok:false, el video NO se borra del bucket y se
// reintenta en la siguiente pasada (ver limpiarVideosPublicados).
// ─────────────────────────────────────────────────────────────────────────────

import axios from 'axios';
import { obtenerTokenInstagram } from './instagramToken.js';

const GRAPH = (process.env.INSTAGRAM_API_URL || 'https://graph.instagram.com/v23.0').replace(/\/$/, '');
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

  if (!igUserId) {
    console.log('ℹ️ Instagram sin configurar (falta INSTAGRAM_USER_ID).');
    return { ok: false, motivo: 'sin_configurar' };
  }

  // El token se le pide al módulo que lo renueva: puede venir de la variable de
  // entorno (semilla) o del bucket privado, ya renovado. Ver instagramToken.js.
  const token = await obtenerTokenInstagram();
  if (!token) {
    console.log('ℹ️ Instagram sin token disponible (INSTAGRAM_TOKEN vacío y nada guardado).');
    return { ok: false, motivo: 'sin_token' };
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

/**
 * Comprueba contra Instagram que el token sirve y con qué cuenta se publicará.
 *
 * No devuelve el token, solo el resultado: lo usa el endpoint
 * /api/instagram/estado para saber si Instagram está listo sin publicar nada.
 */
export async function verificarCuentaInstagram() {
  const igUserId = process.env.INSTAGRAM_USER_ID;
  if (!igUserId) return { ok: false, motivo: 'sin_configurar' };

  const token = await obtenerTokenInstagram();
  if (!token) return { ok: false, motivo: 'sin_token' };

  try {
    const { data } = await axios.get(`${GRAPH}/me`, {
      timeout: 30000,
      params: { fields: 'id,username,account_type,media_count', access_token: token },
    });

    return {
      ok: true,
      id: data?.id || null,
      username: data?.username || null,
      accountType: data?.account_type || null,
      mediaCount: data?.media_count ?? null,
      // Si no coinciden, la app está publicando en una cuenta que no es la
      // configurada: mejor enterarse por aquí que por un Reel en el perfil
      // equivocado.
      coincideConLaConfigurada: data?.id === igUserId,
    };
  } catch (error) {
    return { ok: false, motivo: error.response?.data?.error?.message || error.message };
  }
}
