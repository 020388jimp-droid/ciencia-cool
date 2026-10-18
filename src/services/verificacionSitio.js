// ─────────────────────────────────────────────────────────────────────────────
// Archivos de verificación del sitio (los pide TikTok, y sirven para cualquier
// red que lo pida).
//
// TikTok genera un archivo tipo tiktokAbCd123.txt con un contenido exacto y
// comprueba que esté publicado en la raíz del sitio. En vez de meterlo en el
// código (habría que reconstruir la imagen cada vez), se guarda en la carpeta
// `verificacion/` del bucket de videos (que ya es de lectura pública) y la app
// lo devuelve tal cual.
//
// El contenido se compara literalmente, así que se sirve byte por byte: sin
// recortes, sin reordenar y sin añadir texto.
// ─────────────────────────────────────────────────────────────────────────────

import { Storage } from '@google-cloud/storage';

const BUCKET = process.env.GCS_BUCKET_VIDEOS || 'ciencia-cool-videos-271857970093';

const storage = new Storage();

/** ¿El nombre parece un archivo de verificación de TikTok? */
export function esFirmaDeSitio(nombre) {
  // Solo este formato: así esta ruta no puede servir cualquier archivo del
  // bucket, aunque alguien adivine el camino.
  return /^tiktok[A-Za-z0-9]+\.txt$/.test(String(nombre || ''));
}

/** Devuelve el contenido del archivo, o null si no existe. Nunca lanza. */
export async function leerFirmaDeSitio(nombre) {
  if (!esFirmaDeSitio(nombre)) return null;

  try {
    const [contenido] = await storage.bucket(BUCKET).file(`verificacion/${nombre}`).download();
    return contenido.toString('utf8');
  } catch (error) {
    if (error.code !== 404) {
      console.error('No se pudo leer la firma del sitio:', error.message);
    }
    return null;
  }
}
