// ─────────────────────────────────────────────────────────────────────────────
// Hablar con la API de TikTok.
//
// Por ahora solo lo necesario para comprobar la conexión: con qué cuenta se
// publicaría. La subida a la bandeja (Content Posting API, método "inbox") se
// añade aquí cuando la cuenta esté conectada.
//
// Recordatorio del plan: TikTok no aprueba bots que publican solos con un
// temporizador, así que este camino sube el video a la BANDEJA de la cuenta y
// el último toque ("Publicar") lo da una persona desde la app del teléfono.
// ─────────────────────────────────────────────────────────────────────────────

import axios from 'axios';
import { obtenerTokenTikTok } from './tiktokToken.js';

const API = (process.env.TIKTOK_API_URL || 'https://open.tiktokapis.com/v2').replace(/\/$/, '');

/** El mensaje de error de TikTok, venga donde venga. */
function mensajeDeError(error, datos) {
  return (
    datos?.error?.message ||
    datos?.error_description ||
    datos?.error ||
    error.response?.data?.error?.message ||
    error.response?.data?.error_description ||
    error.message
  );
}

/**
 * ¿Con qué cuenta de TikTok se publicaría? Pregunta a la API y devuelve los
 * datos públicos de la cuenta. Nunca lanza: devuelve { ok: false, error }.
 *
 * @param {string|null} tokenExplicito Token recién obtenido (al conectar); si
 *        no se pasa, se usa el guardado.
 */
export async function verificarCuentaTikTok(tokenExplicito = null) {
  const token = tokenExplicito || (await obtenerTokenTikTok());

  if (!token) {
    return {
      ok: false,
      error: 'La cuenta de TikTok todavía no está conectada (falta autorizarla).',
    };
  }

  try {
    const { data } = await axios.get(`${API}/user/info/`, {
      timeout: 20000,
      params: { fields: 'open_id,display_name,username,avatar_url' },
      headers: { Authorization: `Bearer ${token}` },
    });

    const usuario = data?.data?.user;
    if (!usuario) {
      return { ok: false, error: 'TikTok no devolvió los datos de la cuenta.' };
    }

    return {
      ok: true,
      username: usuario.username || null,
      nombre: usuario.display_name || null,
      avatar: usuario.avatar_url || null,
      openId: usuario.open_id || null,
    };
  } catch (error) {
    return {
      ok: false,
      error: mensajeDeError(error),
      status: error.response?.status || null,
      logId: error.response?.data?.error?.log_id || null,
    };
  }
}
