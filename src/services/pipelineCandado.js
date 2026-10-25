// ─────────────────────────────────────────────────────────────────────────────
// Candado anti-duplicados del pipeline.
//
// EL PROBLEMA QUE RESUELVE
// El 20-oct n8n disparó la pasada de las 8:00 dos veces (08:01:01 y 08:04:28).
// Como la cola de trabajo vive en la MEMORIA de cada instancia y Cloud Run puede
// tener hasta 20 instancias, la segunda petición no vio a la primera: generó y
// publicó OTRO video del mismo tema.
//
// LA SOLUCIÓN
// Un archivo en el bucket (estado/pipeline-candado.json) que dice qué pasada se
// está haciendo o cuál fue la última que terminó bien. Antes de generar, el
// pipeline pregunta:
//
//   · ¿Hay una pasada EN CURSO (empezada hace menos de 30 min)?  → se rechaza.
//   · ¿La última pasada terminó BIEN hace menos de 120 min?      → se rechaza.
//
// Las pasadas de verdad van cada 6 horas (8:00, 14:00, 20:00), así que 120 min
// nunca estorban a la siguiente; solo frenan un disparo repetido.
//
// Si una pasada FALLA, el candado se marca como "fallo" y se puede reintentar de
// inmediato: el candado es contra duplicados, no contra reintentos.
//
// El archivo se escribe con condición de generación (ifGenerationMatch): si dos
// instancias intentan reservar la pasada al mismo tiempo, solo una gana y la otra
// recibe 412 y se rechaza como duplicada. Sin esa condición las dos podrían
// escribir y las dos seguirían adelante.
// ─────────────────────────────────────────────────────────────────────────────

import { Storage } from '@google-cloud/storage';

const BUCKET = 'ciencia-cool-videos-271857970093';
const RUTA = 'estado/pipeline-candado.json';

const storage = new Storage();

// Una pasada "en curso" más vieja que esto se da por muerta (la instancia se
// reinició a media generación). El pipeline tarda ~3-4 min; 30 es holgado.
const MINUTOS_EN_CURSO = 30;

// Cuánto tiempo después de una pasada exitosa se rechaza otra.
// Configurable por si algún día se quiere generar más seguido.
const MINUTOS_ESPERA = (() => {
  const n = Number(process.env.PIPELINE_COOLDOWN_MIN);
  return Number.isFinite(n) && n > 0 ? n : 120;
})();

export class PipelineDuplicadoError extends Error {
  constructor(mensaje, detalle = {}) {
    super(mensaje);
    this.name = 'PipelineDuplicadoError';
    this.codigo = 'PIPELINE_DUPLICADO';
    this.detalle = detalle;
  }
}

/**
 * Decide si el registro del candado bloquea una pasada nueva.
 * Se exporta aparte para poder probar la regla sin tocar el bucket.
 *
 * @param {object|null} previo registro guardado (o null si no hay)
 * @param {number} ahora     milisegundos
 * @returns {{motivo: string, mensaje: string, detalle: object}|null}
 */
export function evaluarCandado(previo, ahora = Date.now()) {
  if (!previo || typeof previo !== 'object') return null;

  if (previo.estado === 'en-curso') {
    const inicio = Date.parse(previo.inicio || '');
    if (Number.isFinite(inicio)) {
      const minutos = Math.floor((ahora - inicio) / 60000);
      if (minutos < MINUTOS_EN_CURSO) {
        return {
          motivo: 'en-curso',
          mensaje: `Ya hay una generación en marcha (job ${previo.jobId || 'sin id'}, `
            + `empezó hace ${Math.max(0, minutos)} min). Se rechaza para no duplicar el video.`,
          detalle: { jobId: previo.jobId || null, inicio: previo.inicio, minutos },
        };
      }
    }
    // Pasada abandonada (instancia reiniciada): se puede tomar el turno.
    return null;
  }

  if (previo.estado === 'ok') {
    const fin = Date.parse(previo.fin || previo.inicio || '');
    if (Number.isFinite(fin)) {
      const minutos = Math.floor((ahora - fin) / 60000);
      if (minutos < MINUTOS_ESPERA) {
        return {
          motivo: 'reciente',
          mensaje: `Ya se generó un video hace ${Math.max(0, minutos)} min `
            + `(${previo.video || 'sin archivo'}). Se rechaza para no duplicarlo. `
            + `Para forzar otra pasada, envía "forzar": true.`,
          detalle: { video: previo.video || null, fin: previo.fin || null, minutos },
        };
      }
    }
    return null;
  }

  // 'fallo' o cualquier estado desconocido: se permite reintentar.
  return null;
}

/** Lee el candado. Devuelve el registro y su generación en GCS. */
async function leer() {
  const archivo = storage.bucket(BUCKET).file(RUTA);
  try {
    const [contenido] = await archivo.download();
    const [meta] = await archivo.getMetadata();
    let datos = null;
    try {
      // Se quita el BOM por si el archivo se escribió desde Windows/PowerShell:
      // un BOM hace que JSON.parse falle y el candado se ignoraría.
      datos = JSON.parse(contenido.toString('utf8').replace(/^\uFEFF/, ''));
    } catch {
      datos = null;
    }
    return { datos: datos && typeof datos === 'object' ? datos : null, generacion: meta.generation };
  } catch (error) {
    if (error.code === 404) return { datos: null, generacion: 0 };
    throw error;
  }
}

/** Escribe el candado solo si nadie lo cambió desde que lo leímos. */
async function escribir(datos, generacion) {
  await storage.bucket(BUCKET).file(RUTA).save(
    JSON.stringify(datos, null, 2),
    {
      contentType: 'application/json',
      resumable: false,
      preconditionOpts: { ifGenerationMatch: Number(generacion) || 0 },
    }
  );
}

function esConflicto(error) {
  return Number(error?.code) === 412 || Number(error?.code) === 409;
}

/**
 * Reserva la pasada. Si otra instancia ya la reservó (o acaba de terminar una),
 * lanza PipelineDuplicadoError.
 *
 * @param {{jobId?: string|null, forzar?: boolean}} opts
 * @returns {Promise<{reservado: boolean, inicio: string|null, motivo?: string}>}
 */
export async function reservarPasada({ jobId = null, forzar = false } = {}) {
  for (let intento = 0; intento < 3; intento++) {
    let leido;
    try {
      leido = await leer();
    } catch (error) {
      // Sin bucket no hay candado, pero tampoco habría video: se deja pasar y
      // el pipeline fallará más adelante por la misma razón.
      console.error('Candado: no se pudo leer, se deja pasar:', error.message);
      return { reservado: false, inicio: null, motivo: 'sin-lectura' };
    }

    if (!forzar) {
      const bloqueo = evaluarCandado(leido.datos);
      if (bloqueo) throw new PipelineDuplicadoError(bloqueo.mensaje, bloqueo.detalle);
    }

    const inicio = new Date().toISOString();
    const registro = {
      estado: 'en-curso',
      jobId: jobId || null,
      inicio,
      fin: null,
      video: null,
      forzado: forzar === true,
    };

    try {
      await escribir(registro, leido.generacion);
      return { reservado: true, inicio, motivo: null };
    } catch (error) {
      // 412: otra instancia escribió entre nuestra lectura y nuestra escritura.
      // Se vuelve a leer: en la siguiente vuelta el candado dirá quién ganó.
      if (esConflicto(error)) continue;
      console.error('Candado: no se pudo escribir, se deja pasar:', error.message);
      return { reservado: false, inicio: null, motivo: 'sin-escritura' };
    }
  }

  throw new PipelineDuplicadoError(
    'No se pudo reservar la pasada: otra instancia la tomó al mismo tiempo.',
    { motivo: 'carrera' }
  );
}

/** Anota que la pasada terminó bien. */
export async function marcarPasadaOk(reserva, video = null) {
  if (!reserva?.reservado) return;
  try {
    const { datos, generacion } = await leer();
    // Si otra pasada tomó el turno (la nuestra se dio por abandonada), no se toca.
    if (!datos || datos.inicio !== reserva.inicio) return;
    await escribir({
      ...datos,
      estado: 'ok',
      fin: new Date().toISOString(),
      video: video || null,
    }, generacion);
  } catch (error) {
    console.error('Candado: no se pudo marcar el final:', error.message);
  }
}

/** Anota que la pasada falló, para permitir un reintento inmediato. */
export async function marcarPasadaFallo(reserva, motivo = null) {
  if (!reserva?.reservado) return;
  try {
    const { datos, generacion } = await leer();
    if (!datos || datos.inicio !== reserva.inicio) return;
    await escribir({
      ...datos,
      estado: 'fallo',
      fin: new Date().toISOString(),
      motivo: motivo ? String(motivo).slice(0, 300) : null,
    }, generacion);
  } catch (error) {
    console.error('Candado: no se pudo marcar el fallo:', error.message);
  }
}

/** Para el endpoint de estado: qué dice el candado ahora mismo. */
export async function leerCandado() {
  try {
    const { datos } = await leer();
    if (!datos) return { existe: false, ...reglaActual() };
    return { existe: true, ...datos, ...reglaActual() };
  } catch (error) {
    return { existe: false, error: error.message, ...reglaActual() };
  }
}

function reglaActual() {
  return { minutosEnCurso: MINUTOS_EN_CURSO, minutosEspera: MINUTOS_ESPERA };
}
