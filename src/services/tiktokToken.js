// ─────────────────────────────────────────────────────────────────────────────
// Conexión con TikTok: autorización (OAuth) y guardado del token.
//
// TikTok no da tokens eternos como Facebook. Da dos:
//
//   • token de acceso  → dura 24 horas (es el que se usa para subir videos)
//   • token de renovación → dura 1 año, y CADA renovación devuelve un par
//     nuevo: el anterior deja de servir (van rotando).
//
// Por eso el token "de verdad" no puede vivir en una variable de entorno: hay
// que irlo guardando. Se guarda en el bucket PRIVADO (el de videos es de
// lectura pública, ahí no puede ir una credencial) junto con la fecha:
//
//   1) El usuario autoriza una sola vez desde el navegador:
//      POST /api/tiktok/autorizar → TikTok → GET /api/tiktok/callback.
//   2) El callback intercambia el código por el par de tokens y lo guarda.
//   3) Antes de cada envío, si el token de acceso tiene más de 12 horas, se
//      renueva y se guarda el par nuevo.
//
// Como se renueva cada 12 h y el de acceso dura 24 h, el pipeline (3 veces al
// día) nunca se queda sin token.
//
// obtenerTokenTikTok() NUNCA lanza: si algo falla devuelve null y el pipeline
// sigue con las demás redes. TikTok es la única red semi-manual (el video cae
// en la bandeja de la cuenta y el último toque lo da una persona).
// ─────────────────────────────────────────────────────────────────────────────

import axios from 'axios';
import { Storage } from '@google-cloud/storage';

const API = (process.env.TIKTOK_API_URL || 'https://open.tiktokapis.com/v2').replace(/\/$/, '');
const AUTORIZACION = 'https://www.tiktok.com/v2/auth/authorize/';

const BUCKET_SECRETOS = process.env.GCS_BUCKET_SECRETOS || 'ciencia-cool-secretos-271857970093';
const RUTA_TOKEN = 'tiktok-token.json';
const RUTA_ESTADO = 'tiktok-oauth-state.json';

// El token de acceso dura 24 h; se renueva a las 12 (la mitad) para tener
// margen si una renovación falla. TIKTOK_HORAS_PARA_RENOVAR=0 fuerza renovar
// siempre (útil para probar).
const HORAS_PARA_RENOVAR = Number.isFinite(Number(process.env.TIKTOK_HORAS_PARA_RENOVAR))
  ? Number(process.env.TIKTOK_HORAS_PARA_RENOVAR)
  : 12;

// El "state" del OAuth es un vale de un solo uso que se guarda al empezar la
// autorización y se gasta al volver de TikTok. Si tarda más de esto, se pide
// empezar de nuevo.
const MINUTOS_VALIDEZ_ESTADO = 15;

const storage = new Storage();

let enMemoria = null;

/** ¿Ya están puestas las llaves de la app de TikTok en Cloud Run? */
export function configuradoTikTok() {
  return Boolean((process.env.TIKTOK_CLIENT_KEY || '').trim() && (process.env.TIKTOK_CLIENT_SECRET || '').trim());
}

/** La dirección a la que TikTok devuelve al usuario. Debe estar EXACTAMENTE
 *  igual en el portal de desarrolladores. */
export function redirectUriTikTok() {
  return (
    process.env.TIKTOK_REDIRECT_URI ||
    'https://ciencia-cool-studio-271857970093.us-central1.run.app/api/tiktok/callback'
  );
}

/** Enlace de autorización: aquí es donde el usuario entra con @cienciacoolmx
 *  y acepta que la app suba videos a su bandeja. */
export function urlAutorizacionTikTok(state) {
  const params = new URLSearchParams({
    client_key: (process.env.TIKTOK_CLIENT_KEY || '').trim(),
    // Solo el permiso de subida. El de leer el perfil (user.info.basic) es
    // opcional y TikTok lo muestra como un interruptor aparte que se queda
    // apagado: pedirlo solo confundía la pantalla de autorización y hacía
    // fallar la comprobación de la cuenta. No lo necesitamos para nada.
    scope: 'video.upload',
    response_type: 'code',
    redirect_uri: redirectUriTikTok(),
    state,
  });
  return `${AUTORIZACION}?${params.toString()}`;
}

function credenciales() {
  return {
    client_key: (process.env.TIKTOK_CLIENT_KEY || '').trim(),
    client_secret: (process.env.TIKTOK_CLIENT_SECRET || '').trim(),
  };
}

/** Lee el par de tokens guardado. null si todavía no se ha autorizado. */
async function leerGuardado() {
  const [contenido] = await storage.bucket(BUCKET_SECRETOS).file(RUTA_TOKEN).download();
  const datos = JSON.parse(contenido.toString('utf8').replace(/^\uFEFF/, ''));
  if (datos && typeof datos.token === 'string' && datos.token.trim()) {
    return { ...datos, token: datos.token.trim() };
  }
  return null;
}

/** Guarda el par de tokens con la fecha del día. */
async function guardar({ token, refreshToken, expiresIn, refreshExpiresIn, openId, scope }) {
  await storage.bucket(BUCKET_SECRETOS).file(RUTA_TOKEN).save(
    JSON.stringify(
      {
        token,
        refreshToken: refreshToken || null,
        openId: openId || null,
        scope: scope || null,
        actualizado: new Date().toISOString(),
        expiresIn: expiresIn || null,
        refreshExpiresIn: refreshExpiresIn || null,
      },
      null,
      2
    ),
    { contentType: 'application/json', resumable: false }
  );
}

/** Horas desde una fecha ISO. Infinity si no se entiende. */
function horasDesde(fechaISO) {
  const ms = Date.now() - Date.parse(fechaISO);
  return Number.isFinite(ms) ? ms / 3600000 : Infinity;
}

/** Pide el par de tokens a cambio del código que devuelve TikTok. */
export async function intercambiarCodigoTikTok(code) {
  const { data } = await axios.post(
    `${API}/oauth/token/`,
    new URLSearchParams({
      ...credenciales(),
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUriTikTok(),
    }).toString(),
    {
      timeout: 30000,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }
  );

  if (!data?.access_token) {
    const detalle = data?.error_description || data?.error || 'TikTok no devolvió token';
    throw new Error(detalle);
  }

  await guardar({
    token: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
    refreshExpiresIn: data.refresh_expires_in,
    openId: data.open_id,
    scope: data.scope,
  });

  return {
    token: data.access_token,
    openId: data.open_id || null,
    scope: data.scope || null,
    expiresIn: data.expires_in || null,
  };
}

/** Pide un par nuevo usando el token de renovación. Devuelve null si no pudo
 *  (sin lanzar: el que había todavía puede servir un rato más). */
async function renovarEnTikTok(refreshToken) {
  try {
    const { data } = await axios.post(
      `${API}/oauth/token/`,
      new URLSearchParams({
        ...credenciales(),
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }).toString(),
      {
        timeout: 30000,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }
    );

    if (data?.access_token && data?.refresh_token) {
      return {
        token: data.access_token,
        refreshToken: data.refresh_token,
        expiresIn: data.expires_in || null,
        refreshExpiresIn: data.refresh_expires_in || null,
        openId: data.open_id || null,
        scope: data.scope || null,
      };
    }

    console.error('⚠️ TikTok: no devolvió un par nuevo al renovar:', data?.error_description || data?.error || 'respuesta vacía');
    return null;
  } catch (error) {
    const mensaje = error.response?.data?.error_description || error.response?.data?.error || error.message;
    console.error(`⚠️ TikTok: no se pudo renovar el token (${mensaje}). Se sigue con el actual.`);
    return null;
  }
}

/**
 * Token con el que hay que subir el video. Renueva y guarda si ya toca.
 * Devuelve null si la cuenta no está conectada. Nunca lanza.
 */
export async function obtenerTokenTikTok(log = console.log) {
  if (enMemoria?.token) return enMemoria.token;

  try {
    const guardado = await leerGuardado().catch((error) => {
      if (error.code !== 404) {
        console.error('No se pudo leer el token de TikTok guardado:', error.message);
      }
      return null;
    });

    if (!guardado?.token) {
      console.warn('⚠️ TikTok: la cuenta todavía no está conectada (falta autorizar).');
      return null;
    }

    const horas = horasDesde(guardado.actualizado);
    if (horas < HORAS_PARA_RENOVAR) {
      enMemoria = { token: guardado.token, actualizado: guardado.actualizado };
      return guardado.token;
    }

    if (!guardado.refreshToken) {
      // Sin token de renovación no hay forma de pedir uno nuevo: se usa el que
      // hay y, si ya caducó, el envío fallará y se reintentará tras reconectar.
      enMemoria = { token: guardado.token, actualizado: guardado.actualizado };
      return guardado.token;
    }

    log(`🔁 TikTok: el token tiene ${Math.round(horas)} h, se renueva...`);
    const nuevo = await renovarEnTikTok(guardado.refreshToken);

    if (!nuevo) {
      enMemoria = { token: guardado.token, actualizado: guardado.actualizado };
      return guardado.token;
    }

    try {
      await guardar(nuevo);
      log('✅ TikTok: token renovado y guardado.');
    } catch (error) {
      // Aunque no se guarde, el token nuevo sirve para esta pasada.
      console.error('El token de TikTok se renovó pero no se pudo guardar:', error.message);
    }

    enMemoria = { token: nuevo.token, actualizado: new Date().toISOString() };
    return nuevo.token;
  } catch (error) {
    console.error('TikTok: problema con el token:', error.message);
    return null;
  }
}

/** Informe del token, SIN devolverlo. Para el endpoint de diagnóstico. */
export async function estadoTokenTikTok() {
  const informe = {
    hayToken: false,
    antiguedadHoras: null,
    actualizado: null,
    ultimaRenovacionDias: null,
    openId: null,
    scope: null,
    renovacionAutomaticaHoras: HORAS_PARA_RENOVAR,
    caducaEnHoras: null,
  };

  try {
    const guardado = await leerGuardado();
    if (guardado) {
      const horas = horasDesde(guardado.actualizado);
      informe.hayToken = true;
      informe.actualizado = guardado.actualizado || null;
      informe.antiguedadHoras = Number.isFinite(horas) ? Math.round(horas * 10) / 10 : null;
      informe.openId = guardado.openId || null;
      informe.scope = guardado.scope || null;
      if (guardado.expiresIn) informe.caducaEnHoras = Math.max(0, Math.round((guardado.expiresIn / 3600) - horas));
      if (guardado.refreshExpiresIn) {
        informe.ultimaRenovacionDias = Math.round(guardado.refreshExpiresIn / 86400);
      }
    }
  } catch (error) {
    if (error.code !== 404) informe.error = error.message;
  }

  return informe;
}

// ── Vale de un solo uso para el OAuth ───────────────────────────────────────

/** Guarda el "state" antes de mandar al usuario a TikTok. */
export async function guardarEstadoOauth(state) {
  await storage.bucket(BUCKET_SECRETOS).file(RUTA_ESTADO).save(
    JSON.stringify({ state, creado: new Date().toISOString() }, null, 2),
    { contentType: 'application/json', resumable: false }
  );
}

/**
 * Comprueba el "state" que vuelve de TikTok.
 *
 * Devuelve:
 *   'nuevo'    → es el vale que acaba de emitir la app: hay que canjear el código.
 *   'repetido' → es el mismo vale, pero ya se usó: la conexión ya se hizo. Pasa
 *                cuando el navegador manda la dirección dos veces (o el usuario
 *                vuelve atrás y reenvía). En vez de un "el enlace caducó"
 *                desconcertante, se le dice que ya quedó conectado.
 *   'invalido' → no es nuestro vale, o ya pasaron más de 15 minutos.
 */
export async function revisarEstadoOauth(state) {
  const archivo = storage.bucket(BUCKET_SECRETOS).file(RUTA_ESTADO);

  try {
    const [contenido] = await archivo.download();
    const datos = JSON.parse(contenido.toString('utf8').replace(/^\uFEFF/, ''));

    const minutos = (Date.now() - Date.parse(datos.creado)) / 60000;
    const vigente = Number.isFinite(minutos) && minutos >= 0 && minutos <= MINUTOS_VALIDEZ_ESTADO;

    if (!datos?.state || datos.state !== state || !vigente) return 'invalido';
    if (datos.usado) return 'repetido';

    // Se marca como usado (no se borra): así un segundo envío del mismo enlace
    // encuentra el vale gastado y puede decir "ya quedó" en vez de "caducó".
    await archivo.save(
      JSON.stringify({ ...datos, usado: new Date().toISOString() }, null, 2),
      { contentType: 'application/json', resumable: false }
    );

    return 'nuevo';
  } catch (error) {
    if (error.code !== 404) {
      console.error('No se pudo comprobar el state de TikTok:', error.message);
    }
    return 'invalido';
  }
}
