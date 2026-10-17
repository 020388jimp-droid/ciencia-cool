// ─────────────────────────────────────────────────────────────────────────────
// Token de Instagram: dónde se guarda y cómo se renueva solo.
//
// El problema: el token de Instagram dura 60 días. Si se deja en una variable
// de entorno, un día deja de publicar y nadie se entera hasta que un video se
// queda atorado en el bucket.
//
// La solución: el token "de verdad" vive en un bucket PRIVADO (el de videos es
// de lectura pública, así que ahí no puede ir una credencial) y se renueva
// antes de que caduque:
//
//   1) La variable INSTAGRAM_TOKEN de Cloud Run es solo la semilla inicial.
//   2) La primera vez se copia al bucket privado con la fecha del día.
//   3) Antes de publicar, si el token guardado tiene más de 30 días, se le pide
//      otro a Meta (grant_type=ig_refresh_token) y se guarda el nuevo.
//   4) Si la renovación falla, se sigue usando el que había: es preferible
//      publicar con el token viejo (aún válido) que no publicar nada.
//
// Como se renueva a los 30 días y cada renovación da 60 días más, el token no
// caduca mientras el pipeline corra (3 veces al día).
//
// IMPORTANTE: obtenerTokenInstagram() NUNCA lanza una excepción. Si algo va
// mal (GCS, red, JSON corrupto) devuelve el token de la variable de entorno,
// porque un fallo aquí no puede tumbar el video del día.
// ─────────────────────────────────────────────────────────────────────────────

import axios from 'axios';
import { Storage } from '@google-cloud/storage';

const GRAPH = (process.env.INSTAGRAM_API_URL || 'https://graph.instagram.com/v23.0').replace(/\/$/, '');

// El bucket privado, creado a propósito para guardar credenciales. Tiene
// acceso uniforme y prevención de acceso público: sin credenciales responde
// 401, así que el token no queda expuesto aunque alguien liste el bucket de
// videos.
const BUCKET_SECRETOS = process.env.GCS_BUCKET_SECRETOS || 'ciencia-cool-secretos-271857970093';
const RUTA_TOKEN = 'instagram-token.json';

// Se renueva a los 30 días (la mitad de los 60 que dura): si una renovación
// falla, quedan otros 30 días para reintentarlo en las siguientes pasadas.
// Se puede forzar con INSTAGRAM_DIAS_PARA_RENOVAR=0 (útil para probar).
const DIAS_PARA_RENOVAR = Number.isFinite(Number(process.env.INSTAGRAM_DIAS_PARA_RENOVAR))
  ? Number(process.env.INSTAGRAM_DIAS_PARA_RENOVAR)
  : 30;

const storage = new Storage();

// Espejo en memoria: en una misma pasada pueden preguntar el token la
// publicación normal y el reintento de pendientes. Así se va a GCS una vez.
let enMemoria = null;

/** Lee el token guardado en el bucket privado. Si no existe, null. */
async function leerGuardado() {
  const [contenido] = await storage.bucket(BUCKET_SECRETOS).file(RUTA_TOKEN).download();
  const datos = JSON.parse(contenido.toString('utf8'));
  if (datos && typeof datos.token === 'string' && datos.token.trim()) {
    return { ...datos, token: datos.token.trim() };
  }
  return null;
}

/** Guarda el token en el bucket privado con la fecha del día. */
async function guardar({ token, expiresIn }) {
  await storage.bucket(BUCKET_SECRETOS).file(RUTA_TOKEN).save(
    JSON.stringify(
      { token, actualizado: new Date().toISOString(), expiresIn: expiresIn || null },
      null,
      2
    ),
    { contentType: 'application/json', resumable: false }
  );
}

/** Cuántos días han pasado desde una fecha ISO. Infinity si no se entiende. */
function diasDesde(fechaISO) {
  const ms = Date.now() - Date.parse(fechaISO);
  return Number.isFinite(ms) ? ms / 86400000 : Infinity;
}

/**
 * Pide a Meta un token nuevo (mismo token, 60 días más de vida).
 * Devuelve null si no se pudo, sin lanzar.
 */
async function renovarEnMeta(token) {
  try {
    const { data } = await axios.get(`${GRAPH}/refresh_access_token`, {
      timeout: 30000,
      params: { grant_type: 'ig_refresh_token', access_token: token },
    });
    if (data?.access_token) {
      return { token: data.access_token, expiresIn: data.expires_in || null };
    }
    console.error('⚠️ Instagram: Meta no devolvió token al renovar.');
    return null;
  } catch (error) {
    const mensaje = error.response?.data?.error?.message || error.message;
    console.error(`⚠️ Instagram: no se pudo renovar el token (${mensaje}). Se sigue con el actual.`);
    return null;
  }
}

/**
 * Token con el que hay que publicar. Renueva y guarda si ya toca.
 *
 * Nunca lanza: en el peor caso devuelve el token de INSTAGRAM_TOKEN.
 */
export async function obtenerTokenInstagram(log = console.log) {
  if (enMemoria?.token) return enMemoria.token;

  const semilla = (process.env.INSTAGRAM_TOKEN || '').trim() || null;

  try {
    const guardado = await leerGuardado().catch((error) => {
      if (error.code !== 404) {
        console.error('No se pudo leer el token de Instagram guardado:', error.message);
      }
      return null;
    });

    let actual = guardado?.token || semilla;
    if (!actual) return null;

    // Primera vez: se guarda la semilla con la fecha de hoy para que el reloj
    // de los 30 días empiece a contar en algún sitio.
    if (!guardado) {
      try {
        await guardar({ token: actual, expiresIn: null });
        log('🔑 Instagram: token inicial guardado en el bucket privado.');
      } catch (error) {
        console.error('No se pudo guardar el token inicial de Instagram:', error.message);
      }
      enMemoria = { token: actual, actualizado: null, expiresIn: null, origen: 'variable de entorno' };
      return actual;
    }

    const dias = diasDesde(guardado.actualizado);
    if (dias < DIAS_PARA_RENOVAR) {
      enMemoria = { token: actual, actualizado: guardado.actualizado, expiresIn: guardado.expiresIn, origen: 'bucket' };
      return actual;
    }

    log(`🔁 Instagram: el token guardado tiene ${Math.round(dias)} días, se renueva...`);
    const nuevo = await renovarEnMeta(actual);
    if (nuevo) {
      actual = nuevo.token;
      try {
        await guardar(nuevo);
        log(`✅ Instagram: token renovado y guardado (${Math.round((nuevo.expiresIn || 0) / 86400)} días más).`);
      } catch (error) {
        // Aunque no se guarde, el token nuevo sirve para esta pasada.
        console.error('El token se renovó pero no se pudo guardar:', error.message);
      }
      enMemoria = { token: actual, actualizado: new Date().toISOString(), expiresIn: nuevo.expiresIn, origen: 'bucket (renovado)' };
      return actual;
    }

    enMemoria = { token: actual, actualizado: guardado.actualizado, expiresIn: guardado.expiresIn, origen: 'bucket' };
    return actual;
  } catch (error) {
    // Red de seguridad: cualquier sorpresa (GCS caído, JSON roto…) no puede
    // impedir que el video del día se publique.
    console.error('Instagram: problema con el token, se usa el de la variable de entorno:', error.message);
    return semilla;
  }
}

/**
 * Informe del token, SIN devolver el token: de dónde sale, cuántos días tiene
 * y cuándo se renovó. Para el endpoint de diagnóstico.
 */
export async function estadoTokenInstagram() {
  const semilla = (process.env.INSTAGRAM_TOKEN || '').trim() || null;
  const informe = {
    hayVariableDeEntorno: Boolean(semilla),
    hayTokenGuardado: false,
    antiguedadDias: null,
    actualizado: null,
    renovacionAutomaticaDias: DIAS_PARA_RENOVAR,
  };

  try {
    const guardado = await leerGuardado();
    if (guardado) {
      informe.hayTokenGuardado = true;
      informe.actualizado = guardado.actualizado || null;
      informe.antiguedadDias = Number.isFinite(diasDesde(guardado.actualizado))
        ? Math.round(diasDesde(guardado.actualizado) * 10) / 10
        : null;
    }
  } catch (error) {
    if (error.code !== 404) informe.error = error.message;
  }

  return informe;
}
