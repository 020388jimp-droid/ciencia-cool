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
import { Storage } from '@google-cloud/storage';
import { obtenerTokenTikTok } from './tiktokToken.js';

const API = (process.env.TIKTOK_API_URL || 'https://open.tiktokapis.com/v2').replace(/\/$/, '');
const BUCKET = process.env.GCS_BUCKET_VIDEOS || 'ciencia-cool-videos-271857970093';

const storage = new Storage();

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

/** El video más reciente que sigue en el bucket (nombre de archivo), o null. */
export async function ultimoVideoEnBucket() {
  try {
    const [archivos] = await storage.bucket(BUCKET).getFiles({ prefix: 'ciencia_cool_' });
    const videos = archivos
      .filter((a) => a.name.endsWith('.mp4'))
      .map((a) => a.name)
      .sort();
    return videos.length ? videos[videos.length - 1] : null;
  } catch (error) {
    console.error('No se pudo listar los videos del bucket:', error.message);
    return null;
  }
}

/**
 * Manda un video del bucket a la BANDEJA de la cuenta de TikTok.
 *
 * Es el camino semi-automático de este proyecto: TikTok no aprueba apps que
 * publiquen solas con un temporizador, así que el video llega como BORRADOR a
 * la bandeja de la cuenta y la persona le da "Publicar" desde la app del
 * teléfono (ahí sí sale al público).
 *
 * Se sube el archivo en sí (FILE_UPLOAD) y no una URL (PULL_FROM_URL) porque
 * la segunda forma obliga a verificar el dominio desde el que TikTok
 * descargaría el video.
 *
 * Los videos del canal pesan menos de 20 MB, así que van en un solo trozo:
 * chunk_size = el tamaño completo y total_chunk_count = 1.
 *
 * Nunca lanza: devuelve { ok:false, motivo } para que el pipeline pueda
 * anotarlo y reintentarlo en la siguiente pasada.
 */
export async function subirVideoABandeja(nombreArchivo, { log = console.log } = {}) {
  const token = await obtenerTokenTikTok(log);
  if (!token) {
    return { ok: false, motivo: 'sin_token', detalle: 'La cuenta de TikTok no está conectada.' };
  }

  try {
    const archivo = storage.bucket(BUCKET).file(nombreArchivo);

    const [existe] = await archivo.exists();
    if (!existe) {
      return { ok: false, motivo: 'no_esta_en_bucket', detalle: nombreArchivo };
    }

    const [metadata] = await archivo.getMetadata();
    const tamano = Number(metadata?.size || 0);
    if (!tamano) {
      return { ok: false, motivo: 'sin_tamano', detalle: 'El archivo no reporta tamaño.' };
    }

    // 1) Permiso de subida: TikTok responde con una URL temporal y un id.
    const init = await axios.post(
      `${API}/post/publish/inbox/video/init/`,
      {
        source_info: {
          source: 'FILE_UPLOAD',
          video_size: tamano,
          chunk_size: tamano,
          total_chunk_count: 1,
        },
      },
      {
        timeout: 30000,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=UTF-8',
        },
      }
    );

    const codigo = init.data?.error?.code;
    if (codigo && codigo !== 'ok') {
      return {
        ok: false,
        motivo: `init_${codigo}`,
        detalle: init.data?.error?.message || null,
        logId: init.data?.error?.log_id || null,
      };
    }

    const uploadUrl = init.data?.data?.upload_url;
    const publishId = init.data?.data?.publish_id || null;
    if (!uploadUrl) {
      return { ok: false, motivo: 'init_sin_url', detalle: JSON.stringify(init.data || {}).slice(0, 300) };
    }

    // 2) Los bytes del video, directo del bucket a TikTok.
    const [bytes] = await archivo.download();

    const subida = await axios.put(uploadUrl, bytes, {
      timeout: 300000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Range': `bytes 0-${tamano - 1}/${tamano}`,
      },
    });

    const codigoSubida = subida.data?.error?.code;
    if (codigoSubida && codigoSubida !== 'ok') {
      return {
        ok: false,
        motivo: `subida_${codigoSubida}`,
        publishId,
        detalle: subida.data?.error?.message || null,
        logId: subida.data?.error?.log_id || null,
      };
    }

    log(`🎵 TikTok: video enviado a la bandeja (${Math.round(tamano / 1024 / 1024 * 10) / 10} MB, id ${publishId || 's/n'}).`);
    return { ok: true, publishId, tamano, modo: 'bandeja' };
  } catch (error) {
    return {
      ok: false,
      motivo: 'excepcion',
      detalle: mensajeDeError(error),
      status: error.response?.status || null,
    };
  }
}
