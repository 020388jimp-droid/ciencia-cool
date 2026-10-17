// ─────────────────────────────────────────────────────────────────────────────
// Estado de los modelos de OpenCode: cuáles están disponibles y cuáles no.
//
// Quién escribe esto: el probador local (scripts/probar-modelos.ps1), porque
// es lo único que puede hablar con el servicio de OpenCode, que vive en el PC.
// La app corre en Cloud Run y no llega a la máquina, así que el resultado se
// guarda en el bucket (igual que el resto de la memoria del proyecto) y aquí
// solo se lee.
//
// La app lo muestra en el modal del botón "Modelos" de la barra de arriba.
// ─────────────────────────────────────────────────────────────────────────────

import { Storage } from '@google-cloud/storage';

const BUCKET = process.env.GCS_BUCKET_VIDEOS || 'ciencia-cool-videos-271857970093';
const RUTA_ESTADO = 'estado/modelos.json';

const storage = new Storage();

/**
 * Lee el estado guardado por el probador. Devuelve null si todavía no se ha
 * corrido (el archivo no existe) o si el bucket no se pudo leer.
 *
 * Se le quita el BOM de UTF-8 si lo tiene: el probador lo escribe con
 * PowerShell (Set-Content -Encoding UTF8), que lo pone, y JSON.parse de Node
 * lo rechaza ("Unexpected token"). Sin este recorte el modal siempre vería
 * "todavía no se ha comprobado ningún modelo".
 */
export async function leerEstadoModelos() {
  try {
    const [contenido] = await storage.bucket(BUCKET).file(RUTA_ESTADO).download();
    const texto = contenido.toString('utf8').replace(/^\uFEFF/, '');
    const datos = JSON.parse(texto);
    return datos && typeof datos === 'object' ? datos : null;
  } catch (error) {
    // El 404 es lo normal la primera vez: todavía no se ha corrido el probador.
    if (error.code !== 404) {
      console.error('No se pudo leer el estado de modelos:', error.message);
    }
    return null;
  }
}

/**
 * Guarda el estado en el bucket. Nunca lanza: si el bucket falla, el probador
 * sigue funcionando con la copia local y la web simplemente no lo verá.
 */
export async function guardarEstadoModelos(estado) {
  try {
    await storage.bucket(BUCKET).file(RUTA_ESTADO).save(
      JSON.stringify(estado, null, 2),
      { contentType: 'application/json', resumable: false }
    );
    console.log('🤖 Estado de modelos guardado en el bucket.');
  } catch (error) {
    console.error('No se pudo guardar el estado de modelos en el bucket:', error.message);
  }
}
