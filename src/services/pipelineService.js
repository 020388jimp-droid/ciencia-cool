// ─────────────────────────────────────────────────────────────────────────────
// Pipeline automático: de una categoría a un MP4 listo para publicar.
//
// Existe para que un orquestador externo (n8n) pueda pedir "un video de
// astronomía" con UNA sola llamada, en lugar de encadenar los cuatro endpoints
// que usa la interfaz (/generate-script, /generate-audio, /find-media,
// /render-video) y tener que interpretar el SSE del render.
//
// No duplica lógica: llama a los mismos servicios que usa la web, que ya están
// probados. Solo los encadena y devuelve un JSON limpio.
//
// Aquí NO se generan imágenes ni se publican videos: eso es trabajo de n8n.
// ─────────────────────────────────────────────────────────────────────────────

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { Storage } from '@google-cloud/storage';

import { fetchAllNews } from './newsService.js';
import { generateScriptWithGemini } from './geminiService.js';
import { normalizarGuionMexicano } from './lexicon.js';
import { generateAudioForScript } from './ttsService.js';
import { findMediaForScenes } from './mediaService.js';
import { renderFinalVideo, buildRenderScenes } from './videoRenderService.js';
import { repartirGestos, rutaGesto, MAX_GESTOS_POR_VIDEO } from './gestosGir.js';
import { getMediaDuration } from './mediaProbe.js';
import { obtenerTendenciasMX, ordenarPorTendencia } from './tendenciasService.js';
import { elegirNoRepetida } from './dedupService.js';
import { publicarEnFacebook, facebookConfigurado } from './facebookService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..', '..');

// ─── Google Cloud Storage ────────────────────────────────────────────────────
//
// Cloud Run tiene un disco EFÍMERO: el MP4 desaparece cuando la instancia se
// reinicia, y la URL que devuelve el render deja de funcionar a los pocos
// minutos. Para que el video sobreviva (y las redes puedan descargarlo cuando
// quieran), se sube a un bucket de GCS, que es permanente.
//
// El bucket es público de lectura a propósito: los videos van a parar a redes
// sociales, así que no tienen por qué ser privados. El nombre del bucket es
// suficientemente largo y aleatorio como para que no lo encuentren por azar.
const BUCKET = 'ciencia-cool-videos-271857970093';
const storage = new Storage();

/**
 * Sube el MP4 al bucket y devuelve su URL pública permanente.
 *
 * El bucket tiene acceso uniforme a nivel de bucket (UBLA) y una política IAM
 * que da lectura pública a allUsers. Con UBLA NO se puede llamar a makePublic()
 * por objeto — Google lo rechaza con "Cannot update access control for an
 * object when uniform bucket-level access is enabled". No hace falta: la
 * política del bucket ya hace públicos a todos los objetos.
 *
 * Si la subida falla, se devuelve null y el pipeline sigue: mejor un video que
 * solo existe en Cloud Run (y dura 5 minutos) que no tener video.
 */
async function subirAGcs(videoPath, nombreArchivo) {
  try {
    const bucket = storage.bucket(BUCKET);
    const archivo = bucket.file(nombreArchivo);

    await new Promise((resolve, reject) => {
      fs.createReadStream(videoPath)
        .pipe(archivo.createWriteStream({
          metadata: { contentType: 'video/mp4' },
          resumable: false,
        }))
        .on('error', reject)
        .on('finish', resolve);
    });

    // No se llama a makePublic(): con UBLA la política IAM del bucket ya hace
    // público el objeto. Llamarlo rompe la subida.
    const url = `https://storage.googleapis.com/${BUCKET}/${nombreArchivo}`;
    return url;
  } catch (error) {
    console.error('No se pudo subir a GCS:', error.message);
    return null;
  }
}

const CATEGORIAS_VALIDAS = new Set([
  'astronomia', 'ciencia', 'tecnologia', 'medicina', 'videojuegos', 'medio_ambiente',
]);

// Rotación de categorías, para que una tanda cubra todas sin repetir la misma.
const ROTACION = ['astronomia', 'ciencia', 'tecnologia', 'medio_ambiente', 'medicina', 'videojuegos'];

// ─── Noticias ya usadas, persistidas en Cloud Storage ───────────────────────
//
// Antes esto vivía en una variable del proceso. Cloud Run es EFÍMERO: cada
// vez que se despliega una versión (y son varias al día mientras se ajusta
// algo) la instancia arranca de cero y el pipeline volvía a elegir la noticia
// más reciente del feed, que es la misma de ayer. Eso es lo que hizo que se
// publicara dos veces "Adiós al segundo extra".
//
// Ahora la lista se guarda en el bucket, en estado/noticias-usadas.json, y
// sobrevive a reinicios, despliegues y escalados.
const RUTA_ESTADO = 'estado/noticias-usadas.json';

// Cuántos titulares se recuerdan por categoría. 40 son ~2-3 semanas de video
// diario: suficiente para no repetir, y el archivo sigue siendo diminuto.
const MAX_RECUERDO = 40;
// ─── Fase 2: elegir la noticia por tendencia ─────────────────────────────────
//
// Poniendo USAR_TENDENCIAS en false se vuelve al comportamiento anterior (la
// mas reciente). Si Google Trends deja de responder el pipeline tampoco se
// entera: el servicio de tendencias devuelve lista vacia y se elige por recencia.
const USAR_TENDENCIAS = process.env.USAR_TENDENCIAS !== 'false';

// Espejo en memoria: evita ir a por el archivo dos veces en el mismo proceso.
let estadoEnMemoria = null;

/** Descarga el estado de noticias usadas. Si no existe, devuelve uno vacío. */
async function descargarEstado() {
  try {
    const [contenido] = await storage.bucket(BUCKET).file(RUTA_ESTADO).download();
    const estado = JSON.parse(contenido.toString('utf8'));
    if (!estado || typeof estado !== 'object' || !estado.porCategoria) return { porCategoria: {} };
    return estado;
  } catch (error) {
    // 404 es lo normal la primera vez: el archivo todavía no existe.
    if (error.code !== 404) {
      console.error('No se pudo leer el estado de noticias usadas:', error.message);
    }
    return { porCategoria: {} };
  }
}

/** Guarda el estado de noticias usadas en el bucket. */
async function subirEstado(estado) {
  await storage.bucket(BUCKET).file(RUTA_ESTADO).save(
    JSON.stringify(estado, null, 2),
    { contentType: 'application/json', resumable: false }
  );
}

// ─── Estado de publicación, red por red ─────────────────────────────────────
//
// Anota en qué redes se publicó cada video. Existe para cumplir la regla de
// oro del proyecto: un video NO se borra del bucket hasta que se publicó en
// TODAS las redes. Si Facebook falla, el video se queda en el bucket y se
// reintenta en la siguiente pasada, en vez de perderse para siempre.
//
// Estructura:
//   { "ciencia_cool_123.mp4": {
//       titulo, descripcion,
//       facebook: { ok, id, permalink, motivo, fecha },
//       youtube:  { ok, fecha } } }
const RUTA_PUBLICACIONES = 'estado/publicaciones.json';

async function descargarPublicaciones() {
  try {
    const [contenido] = await storage.bucket(BUCKET).file(RUTA_PUBLICACIONES).download();
    const publicaciones = JSON.parse(contenido.toString('utf8'));
    return (publicaciones && typeof publicaciones === 'object' && !Array.isArray(publicaciones))
      ? publicaciones
      : {};
  } catch (error) {
    // 404 es lo normal la primera vez: el archivo todavía no existe.
    if (error.code !== 404) {
      console.error('No se pudo leer el estado de publicaciones:', error.message);
    }
    return {};
  }
}

async function guardarPublicaciones(publicaciones) {
  await storage.bucket(BUCKET).file(RUTA_PUBLICACIONES).save(
    JSON.stringify(publicaciones, null, 2),
    { contentType: 'application/json', resumable: false }
  );
}

/**
 * Anota el resultado de publicar (o de intentarlo) en una red.
 *
 * Se vuelve a descargar el archivo antes de escribir para no pisar lo que haya
 * anotado otra instancia mientras tanto.
 */
async function registrarPublicacion(archivo, red, resultado, extras = {}) {
  if (!archivo) return;
  try {
    const publicaciones = await descargarPublicaciones();
    publicaciones[archivo] = {
      ...(publicaciones[archivo] || {}),
      ...extras,
      [red]: {
        ok: resultado.ok === true,
        id: resultado.id || null,
        permalink: resultado.permalink || null,
        motivo: resultado.ok ? null : (resultado.motivo || 'error'),
        fecha: new Date().toISOString(),
      },
    };
    await guardarPublicaciones(publicaciones);
  } catch (error) {
    // No poder anotar el resultado no debe tumbar el video.
    console.error('No se pudo guardar el estado de publicación:', error.message);
  }
}

/**
 * Reintenta publicar en Facebook los videos que quedaron pendientes.
 *
 * Se llama al principio de cada pasada. Si la vez anterior Facebook falló, el
 * video sigue en el bucket (no se borró, ver limpiarVideosPublicados) y aquí se
 * le da otra oportunidad: mejor publicar el video de ayer un rato después que
 * no publicarlo nunca.
 *
 * @returns {Promise<Array<{archivo: string, ok: boolean, motivo?: string}>>}
 */
async function publicarPendientesEnFacebook(log = console.log) {
  if (!facebookConfigurado()) return [];

  try {
    const publicaciones = await descargarPublicaciones();
    const pendientes = Object.entries(publicaciones)
      .filter(([, ficha]) => ficha?.facebook?.ok === false)
      .map(([archivo]) => archivo);

    if (!pendientes.length) return [];

    log(`♻️ ${pendientes.length} video(s) sin publicar en Facebook: se reintenta.`);
    const resultados = [];

    for (const archivo of pendientes) {
      const ficha = publicaciones[archivo] || {};
      const resultado = await publicarEnFacebook({
        videoUrl: `https://storage.googleapis.com/${BUCKET}/${archivo}`,
        title: ficha.titulo,
        description: ficha.descripcion,
      });
      await registrarPublicacion(archivo, 'facebook', resultado);
      resultados.push({ archivo, ...resultado });
      log(resultado.ok
        ? `♻️ Reintento en Facebook OK: ${archivo}`
        : `⚠️ Reintento en Facebook falló (${archivo}): ${resultado.motivo}`);
    }

    return resultados;
  } catch (error) {
    console.error('No se pudieron reintentar las publicaciones pendientes:', error.message);
    return [];
  }
}

/**
 * Marca un titular como usado en su categoría.
 *
 * Se vuelve a descargar el archivo antes de escribir: si hay otra instancia
 * corriendo a la vez (Cloud Run escala sola), así no se pisa lo suyo.
 */
async function registrarNoticiaUsada(categoria, titulo) {
  if (!categoria || !titulo) return;
  try {
    const estado = await descargarEstado();
    const lista = Array.isArray(estado.porCategoria[categoria])
      ? estado.porCategoria[categoria]
      : [];
    // El más reciente primero.
    estado.porCategoria[categoria] = [titulo, ...lista.filter(t => t !== titulo)].slice(0, MAX_RECUERDO);
    estado.actualizado = new Date().toISOString();
    await subirEstado(estado);
    estadoEnMemoria = estado;
  } catch (error) {
    // Un fallo aquí no debe tumbar el video: se sigue con la memoria del proceso.
    console.error('No se pudo guardar la noticia como usada:', error.message);
  }
}

/**
 * Titulares ya usados en una categoría (los más recientes primero).
 */
async function noticiasUsadas(categoria) {
  if (!estadoEnMemoria) estadoEnMemoria = await descargarEstado();
  const lista = estadoEnMemoria?.porCategoria?.[categoria];
  return Array.isArray(lista) ? lista : [];
}

/**
 * Titulares ya usados en CUALQUIER categoria.
 *
 * La misma noticia puede aparecer un dia clasificada como "tecnologia" y al
 * siguiente como "ciencia": el clasificador opera por palabras. Si el filtro
 * de repeticion solo mira la categoria actual, esa noticia se cuela por la otra
 * puerta (paso con la del segundo intercalar).
 */
async function noticiasUsadasGlobales() {
  if (!estadoEnMemoria) estadoEnMemoria = await descargarEstado();
  const porCat = estadoEnMemoria?.porCategoria || {};
  return Object.values(porCat).flat();
}

/**
 * Borra del bucket todos los videos menos el que se indica.
 *
 * ── Por qué ─────────────────────────────────────────────────────────────────
 * Cada render deja un MP4 de 13-21 MB. Con uno al día son 21 vídeos y 333 MB
 * en una semana de pruebas. El coste es ínfimo (0,13 pesos al mes), pero
 * ensucia y obliga a mirar qué es cada archivo. La regla es la acordada: solo
 * vive el último video, que es el que está publicado o a punto de publicarse.
 *
 * @param {string} conservar  Nombre del archivo que se acaba de subir.
 */
async function borrarVideosAntiguos(conservar, { soloMasViejosQueDias = 0 } = {}) {
  try {
    const [archivos] = await storage.bucket(BUCKET).getFiles({ prefix: 'ciencia_cool_' });
    const limite = soloMasViejosQueDias
      ? Date.now() - soloMasViejosQueDias * 24 * 60 * 60 * 1000
      : Infinity;

    const sobran = archivos
      .filter(f => f.name.endsWith('.mp4') && f.name !== conservar)
      .filter(f => {
        if (limite === Infinity) return true;
        const creado = Date.parse(f.metadata?.timeCreated || '') || 0;
        // Sin fecha fiable no se borra: mejor que sobre a que falte.
        return creado > 0 && creado < limite;
      })
      .map(f => f.name);

    if (!sobran.length) return 0;

    // Se borran una a una y sin `await` encadenado: si uno falla (permisos,
    // que otro proceso lo esté borrando), se sigue con los demás.
    await Promise.all(sobran.map(nombre =>
      storage.bucket(BUCKET).file(nombre).delete().catch(err =>
        console.error(`No se pudo borrar ${nombre}:`, err.message)
      )
    ));

    console.log(`🧹 ${sobran.length} video(s) antiguo(s) borrados de Cloud; se conserva ${conservar}`);
    return sobran.length;
  } catch (error) {
    console.error('No se pudo limpiar la lista de videos antiguos:', error.message);
    return 0;
  }
}

/**
 * Borra del bucket todos los videos MENOS el más reciente.
 *
 * Se llama al final del flujo de n8n, cuando el video ya se publicó en todas
 * las redes. Conserva el que se acaba de publicar y borra los de generaciones
 * anteriores, que ya están publicados.
 *
 * Antes el borrado lo hacía el propio pipeline nada más generar. Se cambió
 * porque con varias redes eso es demasiado pronto: si el video se borra y la
 * subida a Instagram falla un minuto después, habría que volver a generar el
 * video entero (3 minutos de ffmpeg y Gemini) para reintentar.
 *
 * @returns {Promise<{borrados: string[], conservado: string|null, error?: string}>}
 */
export async function limpiarVideosPublicados() {
  try {
    const [archivos] = await storage.bucket(BUCKET).getFiles({ prefix: 'ciencia_cool_' });
    const fecha = (f) => Date.parse(f.metadata?.timeCreated || '') || 0;

    const videos = archivos
      .filter(f => f.name.endsWith('.mp4'))
      .sort((a, b) => fecha(a) - fecha(b));

    if (videos.length <= 1) {
      return { borrados: [], conservado: videos[0]?.name || null };
    }

    const conservado = videos[videos.length - 1].name;

    // A este endpoint lo llama n8n DESPUÉS de subir a YouTube, así que el video
    // que se conserva ya está publicado ahí. Se anota para tener la ficha.
    await registrarPublicacion(conservado, 'youtube', { ok: true });

    const publicaciones = await descargarPublicaciones();

    // ── Regla de oro: no borrar lo que no se publicó en todas las redes ──────
    // Si Facebook falló, el video se queda en el bucket y se reintenta en la
    // siguiente pasada (ver publicarPendientesEnFacebook). Los videos viejos,
    // anteriores a esta función, no tienen ficha: se dan por publicados.
    const candidatos = videos.slice(0, -1).map(f => f.name);
    const pendientes = candidatos.filter(nombre => publicaciones[nombre]?.facebook?.ok === false);
    const sobran = candidatos.filter(nombre => !pendientes.includes(nombre));

    if (pendientes.length) {
      console.warn(`⏸️ No se borran ${pendientes.length} video(s): siguen pendientes de Facebook (${pendientes.join(', ')})`);
    }

    await Promise.all(sobran.map(nombre =>
      storage.bucket(BUCKET).file(nombre).delete().catch(err =>
        console.error(`No se pudo borrar ${nombre}:`, err.message)
      )
    ));

    console.log(`🧹 Publicado en todas las redes: ${sobran.length} video(s) borrado(s); se conserva ${conservado}`);
    return { borrados: sobran, conservado, pendientes };
  } catch (error) {
    console.error('No se pudo limpiar los videos publicados:', error.message);
    return { borrados: [], conservado: null, error: error.message };
  }
}

let indiceRotacion = 0;

/**
 * Devuelve la siguiente categoría de la rotación y lo guarda.
 *
 * El contador vive en el mismo archivo de estado que las noticias usadas.
 * Si se quedara en memoria, cada reinicio de la instancia volvería a empezar
 * por "astronomia" y con 3 videos al día se repetiría categoría.
 */
async function siguienteCategoria() {
  try {
    const estado = await descargarEstado();
    const n = Number(estado.rotacion) || 0;
    estado.rotacion = n + 1;
    await subirEstado(estado);
    indiceRotacion = estado.rotacion;
    estadoEnMemoria = estado;
    return ROTACION[n % ROTACION.length];
  } catch (error) {
    // Si el bucket falla, se rota igualmente en memoria: algo es mejor que nada.
    console.error('No se pudo guardar la rotacion; se rota solo en memoria:', error.message);
    return ROTACION[indiceRotacion++ % ROTACION.length];
  }
}

// ─── Control de concurrencia ────────────────────────────────────────────────
//
// Medido en producción: un pipeline en solitario tarda ~165 s, pero TRES a la vez
// tardan 386-437 s (el render se va de 103 s a más de 300 s). No fallan, pero se
// triplican el tiempo y cada respuesta individual queda a un Raquitazo del límite
// de 600 s de Cloud Run y del de 480 s del nodo HTTP de n8n.
//
// El render va con ffmpeg en un contenedor de 2 vCPU, así que correr varios a la
// vez no da más rendimiento: se reparten la CPU y no rinden más. Medido: hacer 3
// en serie tarda lo MISMO en total que hacerlos en paralelo (309 s), pero en
// serie cada petición se responde en ~165 s en vez de ~437 s. Esa es la gracia:
// no gana rendimiento, gana PREDICTIBILIDAD, y es lo que evita que una petición
// se pase de los 600 s y Cloud Run la corte a mitad.
//
// La cola es de 1 solo. Con 2 esperando, el último tardaría 200 s de espera más
// 200 s de render, y sumando el arranque en frío se acercaría al límite. Es mejor
// responder 429 rápido y que el orquestador reintente en un par de minutos.
const MAX_CONCURRENTES = 1;
const MAX_EN_COLA = 1;

let enCurso = 0;
let enCola = 0;

/**
 * Ejecuta `tarea` esperando turno si ya hay otra en marcha.
 * Si la cola está llena lanza PipelineBusyError para que el endpoint responda 429.
 */
async function conTurno(tarea) {
  if (enCurso >= MAX_CONCURRENTES) {
    if (enCola >= MAX_EN_COLA) {
      const err = new Error(
        `El servidor ya tiene ${enCurso} generación en marcha y ${enCola} en cola. ` +
        `Reintenta en unos minutos.`
      );
      err.codigo = 'PIPELINE_BUSY';
      throw err;
    }
    enCola++;
    try {
      while (enCurso >= MAX_CONCURRENTES) {
        await new Promise(r => setTimeout(r, 2000));
      }
    } finally {
      enCola--;
    }
  }
  enCurso++;
  try {
    return await tarea();
  } finally {
    enCurso--;
  }
}

export function estadoPipeline() {
  return { enCurso, enCola, maxConcurrentes: MAX_CONCURRENTES, maxCola: MAX_EN_COLA };
}

// ─── Caché de resultados por jobId ──────────────────────────────────────────
//
// Si n8n reintenta (una caída de red, un timeout) volvería a generar y a
// publicar OTRO video del mismo tema. Con jobId se devuelve el resultado que ya
// se tenía en vez de repetir el trabajo.
//
// Vive en memoria: si la instancia se reinicia se pierde, pero tampoco sobrevive
// el MP4 (el disco es efímero), así que el caché caduca antes que el archivo.
const CACHE_TTL_MS = 2 * 60 * 60 * 1000;
const resultados = new Map();

function guardarResultado(jobId, data) {
  resultados.set(jobId, { data, at: Date.now() });
  // Limpieza perezosa: no hace falta un temporizador para esto.
  if (resultados.size > 50) {
    const ahora = Date.now();
    for (const [k, v] of resultados) {
      if (ahora - v.at > CACHE_TTL_MS) resultados.delete(k);
    }
  }
}

function leerResultado(jobId) {
  if (!jobId) return null;
  const guardado = resultados.get(jobId);
  if (!guardado) return null;
  if (Date.now() - guardado.at > CACHE_TTL_MS) {
    resultados.delete(jobId);
    return null;
  }
  return guardado.data;
}

/**
 * Elige la noticia sobre la que hacer el video.
 *
 * Con `topic` explícito se respeta al pie de la letra (útil para probar o para
 * publicar un tema concreto). Sin él, se toma la más reciente de la categoría
 * evitando repetir la última de esa misma categoría.
 */
async function elegirNoticia({ categoria, topic }) {
  if (topic && topic.trim()) {
    return {
      topic: topic.trim(),
      newsContext: '',
      category: categoria || 'ciencia',
      source: '',
      newsTitle: '',
    };
  }

  const cat = CATEGORIAS_VALIDAS.has(categoria) ? categoria : 'todas';
  let noticias = await fetchAllNews(cat);

  // ── Reintento si la lectura vino floja ────────────────────────────────────
  // Cloud Run a veces no llega a los feeds: medido en los registros, la misma
  // petición ha devuelto 331 artículos con 30 feeds OK y, diez segundos
  // después, 0 artículos con 3 feeds OK. Cuando la lista queda corta, el
  // servicio ya tiene un refresco en segundo plano que suele completarse
  // 10-20 s más tarde, así que se fuerza uno y se compara.
  //
  // Sin esto, con 10 feeds OK la noticia "más reciente" de tecnología podía ser
  // una de hacía 13 días, y de ahí salían dos videos seguidos del mismo tema.
  if (noticias.length < 15) {
    console.log(`📰 Solo ${noticias.length} candidatas: se reintenta la lectura de feeds`);
    const reintento = await fetchAllNews(cat, { force: true });
    if (reintento.length > noticias.length) noticias = reintento;
  }

  // ── Antigüedad máxima ─────────────────────────────────────────────────────
  // Una noticia de hace 13 días no es noticia. El límite alto que traía el
  // servicio (30 días) dejaba pasar cualquier cosa cuando la lista venía
  // parcial. 3 días cubre de sobra un canal de ciencia que publica a diario.
  const ANTIGUEDAD_MAXIMA_MS = 3 * 24 * 60 * 60 * 1000;
  const haceTresDias = Date.now() - ANTIGUEDAD_MAXIMA_MS;
  const recientes = noticias.filter(n => Number(n.timestamp) >= haceTresDias);
  const candidatas = recientes.length ? recientes : noticias;

  // Titulares ya usados en esta categoría, sacados del bucket (no de la RAM:
  // la RAM se pierde en cada despliegue y eso repetía la noticia del día).
  // Se comprueba contra TODO lo usado, no solo contra esta categoria.
  const usadas = await noticiasUsadasGlobales();

  if (!noticias.length) {
    // Sin noticias no hay contexto, pero el pipeline puede seguir con un tema
    // genérico: peor un video flojo que un día sin publicar.
    const genérica = cat === 'todas' ? 'ciencia' : cat;
    return {
      topic: `${genérica} descubrimiento reciente`,
      newsContext: '',
      category: genérica,
      source: '',
      newsTitle: '',
    };
  }

  const ordenadas = [...candidatas].sort((a, b) => b.timestamp - a.timestamp);

  // Se descarta todo lo ya usado. Si por lo que sea todo estuviera usado, se
  // vuelve al más reciente: mejor repetir que quedarse sin video.
  const frescas = ordenadas.filter(a => !usadas.includes(a.title));
  const disponibles = frescas.length ? frescas : ordenadas;

  // Fase 2: de las candidatas disponibles se elige la mas CALIENTE, no la mas
  // reciente. "Caliente" = cuantos medios la cubren + si toca una busqueda en
  // tendencia en Mexico (Google Trends) + lo reciente que sea.
  let elegida = null;
  let razon = 'la mas reciente';
  if (USAR_TENDENCIAS) {
    try {
      const tendencias = await obtenerTendenciasMX();
     const ranking = ordenarPorTendencia(disponibles, tendencias).map(r => r.noticia);

      // Se recorre el ranking de arriba abajo y se descarta lo que ya este
      // publicado, aunque el titular sea distinto (mismo hecho, otro medio).
      const elegidaFinal = await elegirNoRepetida(ranking, usadas);
      if (elegidaFinal?.noticia) {
        elegida = elegidaFinal.noticia;
        razon = 'tendencia (' + elegidaFinal.motivo + ')';
      }
    } catch (error) {
      console.warn('⚠️ No se pudo ordenar por tendencia; se usa la mas reciente:', error.message);
    }
  }
  if (!elegida) elegida = disponibles[0];

  // Traza de por qué se eligió esta noticia. Sin esto, si un día el pipeline
  // elige una noticia vieja (pasó: dos veces la misma, de 13 días atrás) no hay
  // forma de distinguir si falló el filtro de "ya usadas" o si la lista de
  // candidatas venía ya mal desde el servicio de feeds.
  const ts = (t) => (Number.isFinite(t) ? new Date(t).toISOString().slice(0, 16) : 'sin fecha');
  console.log(
    `\u{1F4F0} ${cat}: ${noticias.length} candidatas · ${usadas.length} ya usadas · ` +
    `la más reciente es "${ordenadas[0]?.title?.slice(0, 40)}" (${ts(ordenadas[0]?.timestamp)}) · ` +
    `elegida "${elegida?.title?.slice(0, 40)}" (${ts(elegida?.timestamp)}) [${razon}]`
  );

  await registrarNoticiaUsada(cat, elegida.title);

  return {
    topic: elegida.title,
    newsContext: elegida.snippet
      ? `${elegida.snippet} (Fuente: ${elegida.source || 'desconocida'})`
      : '',
    category: elegida.category || (cat === 'todas' ? 'ciencia' : cat),
    source: elegida.source || '',
    newsTitle: elegida.title,
  };
}

/**
 * Arma el paquete de publicación.
 *
 * YouTube y TikTok/Instagram tienen límites distintos: el texto largo va para
 * YouTube y el corto para los otros dos, que truncan pasado cierto número de
 * caracteres. Se devuelven ambos y que n8n elija.
 */
function construirPublicacion(script, noticia) {
  const titulo = (script?.title || noticia.topic || 'CIENCIA COOL').trim();
  const descripcionGemini = (script?.description || '').trim();

  // Si Gemini no dio descripción, se arma con lo que ya hay: los textos en
  // pantalla de cada escena resumen el video sin inventar nada.
  const resumen = descripcionGemini || (script?.scenes || [])
    .map(s => s.onscreenText || s.badge)
    .filter(Boolean)
    .join(' · ');

  const hashtags = [...new Set([
    ...(Array.isArray(script?.hashtags) ? script.hashtags : []),
    '#cienciacool',
    '#shorts',
  ])].map(h => (String(h).trim().startsWith('#') ? h.trim() : `#${h.trim()}`));

  const descripcion = [
    resumen,
    '',
    noticia.source ? `Fuente: ${noticia.source}` : '',
    'Video generado automáticamente con CIENCIA COOL.',
    '',
    hashtags.join(' '),
  ].filter(Boolean).join('\n');

  const resumenCorto = [resumen, hashtags.join(' ')].filter(Boolean).join(' ');
  const caption = resumenCorto.length > 300 ? `${resumenCorto.slice(0, 297)}...` : resumenCorto;

  return { titulo, descripcion, caption, hashtags };
}

/**
 * Ejecuta el pipeline completo: noticia → guion → audio → medios → MP4.
 *
 * @param {object} opts
 * @param {string} [opts.categoria]        categoría de la noticia
 * @param {string} [opts.topic]           tema explícito (ignora la selección de noticia)
 * @param {string} [opts.voiceId]          voz a usar (por defecto, GIR)
 * @param {string} [opts.format]           formato del guion
 * @param {string} [opts.brandingMode]     'watermark_only' | 'none'
 * @param {string} [opts.watermarkPos]
 * @param {number} [opts.watermarkOpacity]
 * @param {string} [opts.jobId]            si se repite, devuelve el resultado anterior
 * @param {boolean} [opts.dryRun]          valida y devuelve el plan sin generar nada
 * @param {boolean} [opts.borrarAnteriores] borra ya los videos anteriores (por defecto
 *                                          no: se borran al publicar, ver publicado-y-limpiar)
 * @param {(msg: string) => void} [opts.onProgress]
 */
export async function ejecutarPipeline(opts = {}) {
  const {
    categoria,
    topic,
    voiceId = 'robot-gir',
    format = 'noticia_resumida',
    brandingMode = 'watermark_only',
    watermarkPos = 'top-left',
    watermarkOpacity = 0.90,
    jobId = null,
    dryRun = false,
    // Por defecto NO se borran los videos anteriores al generar: el video se
    // queda en el bucket hasta que n8n confirma que se publicó en todas las
    // redes (ahí se llama a /api/publicado-y-limpiar, que sí los borra).
    borrarAnteriores = false,
    onProgress = () => {},
  } = opts;

  const log = (m) => onProgress(`[pipeline] ${m}`);

  // ── Reintento del mismo jobId: no se vuelve a generar ─────────────────────
  if (jobId) {
    const previo = leerResultado(jobId);
    if (previo) {
      const existe = fs.existsSync(path.join(projectRoot, 'outputs', 'video', previo.videoFilename));
      if (existe) {
        log(`Job ${jobId} ya se había generado: se devuelve el resultado anterior.`);
        return { ...previo, jobId, reutilizado: true };
      }
      // El MP4 ya no está (la instancia se reinició): el caché no sirve.
      log(`Job ${jobId}: el video anterior ya no existe, se regenera.`);
      resultados.delete(jobId);
    }
  }

  // ── Ensayo: no genera nada, solo dice qué haría ───────────────────────────
  if (dryRun) {
    const cat = categoria && CATEGORIAS_VALIDAS.has(categoria) ? categoria : 'todas';
    const prevista = topic ? topic.trim() : '(la noticia más reciente de la categoría)';
    log('Modo ensayo: no se genera nada.');
    return {
      dryRun: true,
      jobId,
      categoriaPedida: categoria || '(rotación automática)',
      categoriaValida: CATEGORIAS_VALIDAS.has(categoria),
      categoriasValidas: [...CATEGORIAS_VALIDAS],
      temaPrevisto: prevista,
      voiceId,
      format,
      mensaje: 'Ensayo correcto. Para generar de verdad, quita "dryRun": true.',
    };
  }

  // ── El render va con turno: uno a la vez, con cola corta ──────────────────
  return conTurno(async () => {
    const tiempos = {};
    const marcar = (nombre, desde) => {
      tiempos[nombre] = Math.round((Date.now() - desde) / 1000);
      log(`⏱️ ${nombre}: ${tiempos[nombre]}s`);
    };

    // ── Reintentos pendientes ────────────────────────────────────────────────
    // Si en una pasada anterior Facebook falló, ese video sigue en el bucket.
    // Se reintenta AHORA, antes de generar uno nuevo, para no perderlo.
    await publicarPendientesEnFacebook(log);

    // ── 1. Noticia ────────────────────────────────────────────────────────────
    let paso = Date.now();
    const catElegida = categoria || await siguienteCategoria();
    log(`Categoría: ${catElegida}${topic ? ' (tema explícito)' : ''}`);
    const noticia = await elegirNoticia({ categoria: catElegida, topic });
    log(`Noticia: ${noticia.newsTitle || noticia.topic}`);
    marcar('noticia', paso);

    // ── 2. Guion ──────────────────────────────────────────────────────────────
    paso = Date.now();
    log('Generando guion...');
    const guionCrudo = await generateScriptWithGemini({
      topic: noticia.topic,
      newsContext: noticia.newsContext,
      format,
      // GIR es el narrador del canal; se deduce del prefijo del voiceId.
      personality: String(voiceId).startsWith('robot-gir') ? 'gir' : 'asistente',
  });
    const script = normalizarGuionMexicano(guionCrudo);
    log(`Guion listo: ${(script.scenes || []).length} escenas`);
    marcar('guion', paso);

    // ── 3. Audio ──────────────────────────────────────────────────────────────
    paso = Date.now();
    log('Generando audio (es el paso que más tarda)...');
    const audioResult = await generateAudioForScript(script, voiceId);
    log(`Audio listo: ${audioResult.fullAudioFilename}`);
    marcar('audio', paso);

    // ── 4. Medios ─────────────────────────────────────────────────────────────
    paso = Date.now();
    log('Buscando video de stock...');
    const mediaMatches = await findMediaForScenes(script);
    log(`Medios listos: ${(mediaMatches || []).length} escenas`);
    marcar('medios', paso);

    // ── 5. Render ─────────────────────────────────────────────────────────────
    const fullAudioPath = path.join(projectRoot, 'outputs', 'audio', audioResult.fullAudioFilename);
    if (!fs.existsSync(fullAudioPath)) {
      throw new Error(`Audio no encontrado: ${audioResult.fullAudioFilename}`);
    }

    const scenes = buildRenderScenes(script, mediaMatches || [], audioResult);
    if (!scenes || scenes.length === 0) {
      throw new Error('No se encontraron escenas en el guion.');
    }

    const robotImagePath = path.join(projectRoot, 'public', 'assets', 'robot_host.jpg');
    // Logo con fondo TRANSPARENTE (logo.png): es logo.jpg con el turquesa del
    // fondo recortado, así que en el video se ve solo el disco azul con
    // "CIENCIA COOL" y el robot, que es como se veía en los videos anteriores.
    // El disco lo mantiene `public/assets/_logoalpha.cjs` (script de recorte).
    const logoPath = path.join(projectRoot, 'public', 'assets', 'logo.png');

    // ─── Gestos de GIR ───────────────────────────────────────────────────────
    // Se eligen sobre las escenas del GUION (donde está el texto y el campo
    // `gesto` que puede haber pedido Gemini) y luego se traduce a los tiempos
    // reales del audio, que es donde sabemos cuándo dice cada cosa.
    //
    // El desplazamiento se lleva porque cada escena tiene su audio: el
    // wordBoundaries de la escena 1 empiezan en 0, los de la escena 2 en
    // (duración de la 1), y así sucesivamente. Sin sumar, todos los gestos
    // aparecerían al principio del video.
    const gestosBase = path.join(projectRoot, 'assets', 'gir_gestos');

    // El CTA se llama `callToAction` en el guion normalizado y `cta` en algunos
    // scripts viejos. Si aquí solo se miraba `cta`, el array se quedaba con una
    // escena MENOS que el render: la última (el "síguenos") se quedaba sin gesto
    // y había un desplazamiento de índice. Se miran los dos, en ese orden.
    const cta = script.callToAction || script.cta || null;

    // MAX_GESTOS_POR_VIDEO (7 = todos los distintos), no 2: con 2 salía un solo
    // gesto en todo el video y GIR parecía ausente. Ahora hay uno por escena.
    const eleccion = repartirGestos(
      [
        script.hook ? { texto: script.hook.narration, gesto: script.hook.gesto } : null,
        ...(script.scenes || []).map(s => ({ texto: s.narration, gesto: s.gesto })),
        cta ? { texto: cta.narration, gesto: cta.gesto } : null,
      ].filter(Boolean),
      MAX_GESTOS_POR_VIDEO
    );

    // Duración REAL de cada escena, medida con ffprobe sobre el mp3 que generó
    // sus tiempos de palabra.
    //
    // Antes se acumulaba `esc.durationSec`, que es una ESTIMACIÓN por número de
    // palabras. La estimación se desvía de la realidad (medido: 3 segundos de
    // error al final de un video de 54 s), así que los gestos se iban
    // desplazando escena a escena y el último caía fuera de tiempo. ffprobe da
    // el mismo valor que usa el render para cortar cada clip, así que ahora
    // coinciden al milímetro.
    const audioDir = path.join(projectRoot, 'outputs', 'audio');
    const durReales = [];
    for (const esc of scenes) {
      let d = esc.durationSec || 0;
      const part = esc.audioPartFilename
        ? path.join(audioDir, esc.audioPartFilename)
        : null;
      if (part && fs.existsSync(part)) {
        const real = await getMediaDuration(part);
        if (real && real > 0) d = real;
      }
      durReales.push(d);
    }

    const gestosConTiempo = [];
    let tEscena = 0;
    for (let i = 0; i < scenes.length; i++) {
      const esc = scenes[i];
      const nombre = eleccion.get(i);
      if (nombre) {
        const ruta = rutaGesto(nombre, gestosBase);
        if (ruta && fs.existsSync(ruta)) {
          const bordes = esc.wordBoundaries || [];
          if (bordes.length) {
            // El gesto se muestra mientras GIR dice ESA frase, no durante toda
            // la escena: si dura 10 s y el gesto 4, se nota que no encaja.
            gestosConTiempo.push({
              nombre,
              ruta,
              ini: tEscena + bordes[0].start,
              fin: tEscena + bordes.at(-1).end,
            });
          }
        }
      }
      tEscena += durReales[i] || 0;
    }

    if (gestosConTiempo.length) {
      log(`🙋 ${gestosConTiempo.length} gesto(s) de GIR: ${gestosConTiempo.map(g => g.nombre).join(', ')}`);
    }

    log(`Renderizando ${scenes.length} escenas...`);
    const resultado = await renderFinalVideo({
      scenes,
      fullAudioPath,
      robotImagePath: fs.existsSync(robotImagePath) ? robotImagePath : null,
      logoPath: fs.existsSync(logoPath) ? logoPath : null,
      brandName: process.env.BRAND_NAME || 'CIENCIA COOL',
      source: noticia.source,
      category: script.category || noticia.category || '',
      brandingMode,
      watermarkPos,
      watermarkOpacity,
      gestos: gestosConTiempo,
      onProgress: log,
  });

    const stat = fs.existsSync(resultado.videoPath) ? fs.statSync(resultado.videoPath) : { size: 0 };
    marcar('render', paso);
    const pub = construirPublicacion(script, noticia);

    // Subir a GCS para que el video sobreviva al disco efímero de Cloud Run.
    // Sin esto, la URL del render deja de funcionar a los minutos de generarse.
    paso = Date.now();
    log('Subiendo el video a Google Cloud Storage...');
    let facebook = null;
    const urlGcs = stat.size > 0
      ? await subirAGcs(resultado.videoPath, resultado.filename)
      : null;
    if (urlGcs) {
      log(`Video disponible en GCS: ${urlGcs}`);

      // Limpieza. Antes se borraba AQUÍ, nada más generar. Ahora el video se
      // queda en el bucket hasta que n8n confirma que se publicó en TODAS las
      // redes: si se borrase aquí y la subida a Instagram fallara un minuto
      // después, habría que volver a generar el video entero para reintentar.
      //
      //   borrarAnteriores: true -> solo queda este video (como antes)
      //   sin la opción (normal)  -> solo se barren los videos de más de 3
      //                             días, por si el flujo se queda a medias y
      //                             se van acumulando
      paso = Date.now();
      const borrados = borrarAnteriores
        ? await borrarVideosAntiguos(resultado.filename)
        : await borrarVideosAntiguos(resultado.filename, { soloMasViejosQueDias: 3 });
      if (borrados) marcar('limpieza de Cloud', paso);

      // ── Facebook ──────────────────────────────────────────────────────────
      // Se publica aquí, dentro del pipeline, y no como un nodo más de n8n,
      // por una razón: así la regla "no borrar hasta publicar en todas las
      // redes" vive en un solo sitio y no depende de que el orquestador se
      // acuerde de hacerlo en el orden correcto.
      //
      // Facebook se descarga el MP4 él solo desde la URL pública del bucket.
      if (facebookConfigurado()) {
        paso = Date.now();
        log('Publicando en Facebook...');
        facebook = await publicarEnFacebook({
          videoUrl: urlGcs,
          title: pub.titulo,
          description: pub.descripcion,
        });
        await registrarPublicacion(resultado.filename, 'facebook', facebook, {
          titulo: pub.titulo,
          descripcion: pub.descripcion,
        });
        if (facebook.ok) {
          log(`✅ Facebook: ${facebook.permalink || facebook.id}`);
        } else {
          log(`⚠️ Facebook falló (${facebook.motivo}). El video NO se borrará del bucket: se reintentará en la siguiente pasada.`);
        }
        marcar('publicación en Facebook', paso);
      } else {
        log('ℹ️ Facebook sin configurar: se omite (revisa FACEBOOK_PAGE_ID y FACEBOOK_PAGE_TOKEN).');
      }
    } else {
      log('No se pudo subir a GCS; se devuelve la URL de Cloud Run (temporal).');
    }
    marcar('subida a GCS', paso);

    const salida = {
      videoUrl: resultado.videoUrl,
      videoUrlAbsoluta: urlGcs || resultado.videoUrl,
      videoUrlGcs: urlGcs,
      videoFilename: resultado.filename,
      sizeBytes: stat.size,
      title: pub.titulo,
      description: pub.descripcion,
      caption: pub.caption,
      hashtags: pub.hashtags,
      category: script.category || noticia.category || '',
      source: noticia.source,
      newsTitle: noticia.newsTitle,
      voiceId,
      sceneCount: (script.scenes || []).length,
      facebook,
      tiempos,
    };

    if (jobId) {
      guardarResultado(jobId, salida);
      log(`Job ${jobId} guardado para reintentos.`);
    }

    return { ...salida, jobId, reutilizado: false };
  });
}