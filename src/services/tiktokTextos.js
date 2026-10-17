// ─────────────────────────────────────────────────────────────────────────────
// Textos para TikTok: lo que se copia y pega a mano en la app.
//
// TikTok es la única red que no se puede publicar de forma 100% automática. Su
// API obliga a que una persona dé el último toque antes de publicar (revisión
// de TikTok: nada de publicación automática por temporizador), así que el plan
// es que el video llegue solo a la bandeja de entrada de la app de TikTok y que
// el título y la descripción se copien y peguen desde la pestaña "TikTok" de
// esta web.
//
// Aquí vive esa memoria: la ficha de cada video con sus textos.
//
// LA REGLA (acordada con el canal): el texto se muestra ÚNICAMENTE mientras es
// el del video más reciente, y hasta UNA HORA ANTES de que se genere el
// siguiente. Pasada esa hora la pestaña queda vacía a propósito: así nunca se
// copia por error el texto de un video que ya pasó. Como los videos se generan
// a las 8, 14 y 20 (hora de México), el texto de las 8 desaparece a las 13, el
// de las 14 a las 19 y el de las 20 a las 7.
//
// El archivo vive en el mismo bucket que los videos (estado/tiktok.json), igual
// que el resto de la memoria del pipeline: Cloud Run es efímero y cualquier
// cosa guardada en memoria del proceso se pierde con cada despliegue.
// ─────────────────────────────────────────────────────────────────────────────

import { Storage } from '@google-cloud/storage';

const BUCKET = process.env.GCS_BUCKET_VIDEOS || 'ciencia-cool-videos-271857970093';
const RUTA_TEXTOS = 'estado/tiktok.json';

// Horas a las que n8n genera el video del día, en hora de México. Son las
// mismas de la programación de n8n (8, 14 y 20). Si algún día cambian, se
// pueden ajustar sin tocar código con HORAS_GENERACION="8,14,20,23".
const HORAS_GENERACION = (() => {
  const crudo = String(process.env.HORAS_GENERACION || '').trim();
  if (!crudo) return [8, 14, 20];
  const horas = crudo
    .split(',')
    .map((h) => Number(h.trim()))
    .filter((h) => Number.isInteger(h) && h >= 0 && h <= 23);
  return horas.length ? [...new Set(horas)].sort((a, b) => a - b) : [8, 14, 20];
})();

// Cuántos minutos antes del siguiente video se vacía la pestaña.
const ANTICIPACION_MINUTOS = Number.isFinite(Number(process.env.TIKTOK_ANTICIPACION_MINUTOS))
  ? Number(process.env.TIKTOK_ANTICIPACION_MINUTOS)
  : 60;

const ZONA = process.env.TIKTOK_ZONA || 'America/Mexico_City';

// Cuántas fichas se recuerdan. Veinte son casi una semana de videos: de sobra
// para saber qué se publicó, y el archivo sigue siendo diminuto.
const MAX_ENTRADAS = 20;

const storage = new Storage();

// ─── Fechas y horarios ───────────────────────────────────────────────────────
//
// Se trabaja con la hora de México aunque el servidor corra en UTC (Cloud Run
// está en UTC). Se calcula con Intl y no restando 6 horas a mano porque así el
// día que un huso cambie de horario de verano el cálculo se corrige solo.

const formateadorMX = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONA,
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** Partes de un instante, en hora de México (no en UTC). */
function partesMX(ts) {
  const p = Object.fromEntries(
    formateadorMX.formatToParts(new Date(ts)).map((x) => [x.type, x.value])
  );
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    // En algunos navegadores/motores la medianoche sale como "24": se corrige.
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
  };
}

/** Minutos que hay que sumarle a UTC para obtener la hora de México (≈ -360). */
function desfaseMinutos(ts) {
  const p = partesMX(ts);
  const comoSiFueraUTC = Date.UTC(
    p.year, p.month - 1, p.day, p.hour, p.minute,
    new Date(ts).getUTCSeconds()
  );
  return Math.round((comoSiFueraUTC - ts) / 60000);
}

/** Instante UTC en el que en México son las `hora`:00 del día indicado. */
function instanteDeHoraMX(year, month, day, hora) {
  // Date.UTC ya normaliza los días fuera de rango (32 de octubre = 1 de
  // noviembre), así que no hay que calcular los fines de mes a mano.
  const objetivo = Date.UTC(year, month - 1, day, hora, 0, 0);
  let ts = objetivo;
  // El desfase depende del instante: se recalcula un par de veces y converge.
  for (let i = 0; i < 3; i++) ts = objetivo - desfaseMinutos(ts) * 60000;
  return ts;
}

/** El siguiente hueco de generación después de `desde`. Null si no se pudo. */
function proximaGeneracion(desde) {
  const { year, month, day } = partesMX(desde);
  for (let salto = 0; salto <= 3; salto++) {
    for (const hora of HORAS_GENERACION) {
      const ts = instanteDeHoraMX(year, month, day + salto, hora);
      // El margen de 1 segundo evita que el hueco de esta misma hora cuente
      // como "el siguiente" cuando el video se generó en ese mismo minuto.
      if (ts > desde + 1000) return ts;
    }
  }
  return null;
}

/**
 * Cuándo deja de mostrarse el texto de un video generado en `generadoEn`.
 *
 * Es una hora antes de la siguiente generación. Si el video se generó tan
 * cerca del hueco siguiente que no quedaría ni una hora (por ejemplo, un
 * arreglo manual a las 19:55), se usa el hueco de después: un texto que dura
 * tres minutos no sirve para nada.
 */
function caducidadDe(generadoEn) {
  let prox = proximaGeneracion(generadoEn);
  if (prox && prox - generadoEn < ANTICIPACION_MINUTOS * 60000) prox = proximaGeneracion(prox);
  return prox ? prox - ANTICIPACION_MINUTOS * 60000 : null;
}

const soloHora = new Intl.DateTimeFormat('es-MX', {
  timeZone: ZONA, hour: '2-digit', minute: '2-digit', hour12: false,
});

/** "14:00" en hora de México. */
function horaMX(ts) {
  return soloHora.format(new Date(ts));
}

/** "17/10" en hora de México. */
function fechaMX(ts) {
  const p = partesMX(ts);
  return `${String(p.day).padStart(2, '0')}/${String(p.month).padStart(2, '0')}`;
}

// ─── Memoria en el bucket ────────────────────────────────────────────────────

/** Lee las fichas guardadas. Nunca lanza: en el peor caso devuelve lista vacía. */
async function leer() {
  try {
    const [contenido] = await storage.bucket(BUCKET).file(RUTA_TEXTOS).download();
    const datos = JSON.parse(contenido.toString('utf8'));
    return { entradas: Array.isArray(datos?.entradas) ? datos.entradas : [] };
  } catch (error) {
    // El 404 es lo normal la primera vez: el archivo todavía no existe.
    if (error.code !== 404) {
      console.error('No se pudo leer los textos de TikTok:', error.message);
    }
    return { entradas: [] };
  }
}

async function guardar(estado) {
  await storage.bucket(BUCKET).file(RUTA_TEXTOS).save(
    JSON.stringify(estado, null, 2),
    { contentType: 'application/json', resumable: false }
  );
}

/** Deja los hashtags siempre como lista con "#", vengan como vengan. */
function normalizarHashtags(crudo) {
  const lista = Array.isArray(crudo) ? crudo : String(crudo || '').split(/[,\s]+/);
  return [...new Set(
    lista
      .map((h) => String(h).trim())
      .filter(Boolean)
      .map((h) => (h.startsWith('#') ? h : `#${h}`))
  )];
}

// ─── Para el pipeline: apuntar los textos de un video ────────────────────────

/**
 * Apunta el título y la descripción de un video recién generado para que
 * aparezcan en la pestaña de TikTok.
 *
 * NUNCA lanza: si el bucket falla, el video del día se publica igual en las
 * demás redes. Como mucho, ese día la pestaña se queda sin textos.
 *
 * Si se llama dos veces con el mismo archivo (un reintento del pipeline, por
 * ejemplo) se reemplaza la ficha en vez de duplicarla.
 */
export async function registrarTextosTikTok(datos = {}) {
  try {
    const archivo = String(datos.archivo || '').trim();
    if (!archivo) return null;

    const entrada = {
      archivo,
      titulo: String(datos.titulo || '').trim(),
      descripcion: String(datos.descripcion || '').trim(),
      caption: String(datos.caption || '').trim(),
      hashtags: normalizarHashtags(datos.hashtags),
      videoUrl: String(datos.videoUrl || '').trim() || null,
      categoria: String(datos.categoria || '').trim() || null,
      fuente: String(datos.fuente || '').trim() || null,
      noticia: String(datos.noticia || '').trim() || null,
      generadoEn: new Date().toISOString(),
    };

    const estado = await leer();
    const entradas = [entrada, ...estado.entradas.filter((e) => e?.archivo !== archivo)]
      .slice(0, MAX_ENTRADAS);
    await guardar({ entradas });

    console.log(`📝 Textos para TikTok apuntados: ${archivo}`);
    return entrada;
  } catch (error) {
    console.error('No se pudieron apuntar los textos de TikTok:', error.message);
    return null;
  }
}

// ─── Para la web: qué hay que copiar AHORA ───────────────────────────────────

/**
 * Devuelve el texto vigente para TikTok, si es que hay alguno.
 *
 * Solo se considera vigente el video MÁS RECIENTE, y solo hasta una hora antes
 * de que se genere el siguiente. Si ya caducó, se devuelve `vigente: null` con
 * el motivo: la pestaña se vacía a propósito para que nadie copie el texto de
 * un video que ya pasó.
 *
 * Nunca lanza: la pestaña tiene que abrir siempre, aunque el bucket esté de
 * mal humor.
 */
export async function pendientesTikTok() {
  const ahora = Date.now();
  const prox = proximaGeneracion(ahora);
  const { entradas } = await leer();

  const ordenadas = entradas
    .filter((e) => e && e.archivo && Number.isFinite(Date.parse(e.generadoEn)))
    // Se descartan las fichas con fecha futura (más de una hora por delante):
    // solo pueden venir de un reloj descompuesto, y si se colaran se quedarían
    // pegadas arriba para siempre tapando los videos de verdad.
    .filter((e) => Date.parse(e.generadoEn) <= ahora + 60 * 60 * 1000)
    .sort((a, b) => Date.parse(b.generadoEn) - Date.parse(a.generadoEn));

  const base = {
    zona: ZONA,
    horasGeneracion: HORAS_GENERACION,
    anticipacionMinutos: ANTICIPACION_MINUTOS,
    ahora: new Date(ahora).toISOString(),
    ahoraHora: horaMX(ahora),
    proximaGeneracion: prox ? new Date(prox).toISOString() : null,
    proximaGeneracionHora: prox ? horaMX(prox) : null,
    proximaGeneracionFecha: prox ? fechaMX(prox) : null,
    registrados: ordenadas.length,
  };

  const ultima = ordenadas[0] || null;
  if (!ultima) return { ...base, vigente: null, motivo: 'sin-videos' };

  const generadoEn = Date.parse(ultima.generadoEn);
  const caducaEn = caducidadDe(generadoEn);

  if (caducaEn === null || ahora >= caducaEn) {
    return {
      ...base,
      vigente: null,
      motivo: 'caducado',
      // Para que la web pueda explicar por qué está vacía, sin mostrar el
      // texto viejo (que es justo lo que se quiere evitar).
      ultimo: {
        titulo: ultima.titulo,
        generadoEn: new Date(generadoEn).toISOString(),
        generadoHora: horaMX(generadoEn),
        caducoHora: caducaEn ? horaMX(caducaEn) : null,
      },
    };
  }

  // ¿Sigue el video en el bucket? Cuando ya se publicó en todas las redes se
  // borra, y ofrecer la descarga de un archivo que ya no existe confunde más
  // que ayudar.
  let videoDisponible = false;
  if (ultima.videoUrl) {
    try {
      const nombre = ultima.videoUrl.split('/').pop();
      const [existe] = await storage.bucket(BUCKET).file(nombre).exists();
      videoDisponible = existe === true;
    } catch (error) {
      console.error('No se pudo comprobar el video de TikTok en el bucket:', error.message);
    }
  }

  return {
    ...base,
    motivo: 'vigente',
    vigente: {
      ...ultima,
      generadoHora: horaMX(generadoEn),
      generadoFecha: fechaMX(generadoEn),
      caducaEn: new Date(caducaEn).toISOString(),
      caducaHora: horaMX(caducaEn),
      caducaFecha: fechaMX(caducaEn),
      videoDisponible,
    },
  };
}

/** Solo para pruebas y diagnóstico: qué horarios está usando el servidor. */
export function horariosTikTok() {
  return { horasGeneracion: HORAS_GENERACION, anticipacionMinutos: ANTICIPACION_MINUTOS, zona: ZONA };
}
