// ─────────────────────────────────────────────────────────────────────────────
// Publicación en la Página de Facebook (Graph API v26.0).
//
// ── Cómo se publica ─────────────────────────────────────────────────────────
// No se sube el archivo a mano: se le pasa a Facebook la URL pública del MP4
// (la del bucket de GCS) en el campo `file_url` y Facebook se lo descarga solo.
// Es la única forma razonable desde Cloud Run: son 20 MB y subirlos por
// multipart desde Node obliga a partir el archivo en trozos y a llevar la
// cuenta de los offsets.
//
// ── El token ────────────────────────────────────────────────────────────────
// FACEBOOK_PAGE_TOKEN es el token DE LA PÁGINA (no el del usuario). Se saca de
// un token de usuario de larga duración, así que NO caduca. Viene de la variable
// de entorno, nunca del repositorio: ver outputs/facebook.txt en local, que está
// excluido por .gitignore.
//
// ── Por qué hay reintentos ──────────────────────────────────────────────────
// El pipeline no debe morir porque Facebook tenga un mal minuto. Se intenta tres
// veces con esperas crecientes; si aun así falla, se devuelve ok:false y el
// video NO se borra del bucket (ver limpiarVideosPublicados), así que se puede
// reintentar en la siguiente pasada.
// ─────────────────────────────────────────────────────────────────────────────

import axios from 'axios';

const GRAPH = 'https://graph.facebook.com/v26.0';
const INTENTOS = 3;

/** ¿Está configurada la Página en el entorno? */
export function facebookConfigurado() {
  return Boolean(process.env.FACEBOOK_PAGE_ID && process.env.FACEBOOK_PAGE_TOKEN);
}

/**
 * Publica un video en la Página con la URL pública del MP4.
 *
 * @returns {Promise<{ok: boolean, id?: string, permalink?: string, motivo?: string}>}
 */
export async function publicarEnFacebook({ videoUrl, title, description }) {
  const pageId = process.env.FACEBOOK_PAGE_ID;
  const token = process.env.FACEBOOK_PAGE_TOKEN;

  if (!pageId || !token) {
    console.log('ℹ️ Facebook sin configurar (falta FACEBOOK_PAGE_ID o FACEBOOK_PAGE_TOKEN).');
    return { ok: false, motivo: 'sin_configurar' };
  }
  if (!videoUrl) {
    return { ok: false, motivo: 'sin_url_de_video' };
  }

  let ultimoError = 'error_desconocido';

  for (let intento = 1; intento <= INTENTOS; intento++) {
    try {
      const { data } = await axios.post(
        `${GRAPH}/${pageId}/videos`,
        {
          file_url: videoUrl,
          title: (title || 'Ciencia COOL').slice(0, 200),
          description: description || '',
          published: true,
        },
        {
          timeout: 120000,
          headers: { 'Content-Type': 'application/json' },
        }
      );

      const id = data?.id;
      console.log(`✅ Facebook: video publicado (${id})`);
      return {
        ok: true,
        id,
        permalink: id ? `https://www.facebook.com/reel/${id}/` : null,
      };
    } catch (error) {
      // La Graph API explica el fallo en error.response.data.error.message; el
      // mensaje de axios ("Request failed with status code 400") no dice nada.
      ultimoError = error.response?.data?.error?.message || error.message;
      console.error(`⚠️ Facebook intento ${intento}/${INTENTOS} falló: ${ultimoError}`);
      if (intento < INTENTOS) {
        await new Promise(r => setTimeout(r, 5000 * intento));
      }
    }
  }

  return { ok: false, motivo: ultimoError };
}
