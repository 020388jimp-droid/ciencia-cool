// ─────────────────────────────────────────────────────────────────────────────
// Qué gesto hace GIR en cada escena.
//
// ── Por qué existe ──────────────────────────────────────────────────────────
// GIR es un robot que cuenta la noticia. Si se queda siempre en la misma pose
// parece un sticker; si gesticula en todas las frases parece un payaso. El
// punto medio: los gestos aparecen CUANDO APORTAN, una o dos veces por video.
//
// ── La regla: primero el guion, luego las palabras ──────────────────────────
// Decisión tomada: el guion manda, y solo si no dice nada se decide por el
// texto. Así una imagen nunca contradice lo que se está diciendo, que es
// justo lo que pasó con los scripts antiguos.
//
//   1. Si la escena trae `gesto`, se usa ese (el modelo lo pidió).
//   2. Si no, se busca una palabra clave en el texto (ver REGLA_GESTOS).
//   3. Si tampoco, la escena se queda sin gesto.
//
// Un gesto no se repite: si "senalar" ya salió en la escena 1, no vuelve a
// salir en la 2 aunque matchee, porque dos veces lo mismo es menos efecto que
// una.
//
// ── Presencia: una por escena ───────────────────────────────────────────────
// Medido en un video real: con tope de 2 gestos salía UNO solo en todo el
// video, y el robot parecía un sticker que aparece y desaparece. Se subió el
// tope a 7 (hay 7 gestos distintos) y se añadió un relleno: si una escena no
// matchea ninguna regla, se le pone el gesto neutro. El efecto es que GIR
// está gesticulando durante TODO el video, como un presentador, y no como una
// decoración que asoma.
//
// ── Los gestos disponibles ───────────────────────────────────────────────────
//   senalar        dedo arriba       "ojo", "importante", "clave"
//   manos_abiertas hombros arriba    "no se sabe", "quizá"
//   manos_juntas   esfera verde      un concepto que se explica
//   decepcional    cara triste       "fatal", "fracaso", "murió"
//   pensativa      mano al mentón    "lo interesante", "mira que"
//   brazos_relajado brazos abajo     frase de enlace, transición
//   pizarra        sosteniendo datos cifras, comparaciones
// ─────────────────────────────────────────────────────────────────────────────

/** Los gestos, con la palabra que mejor encaja para cada uno. */
export const GESTOS = {
  senalar: { archivo: 'senalar.png', para: 'señalar' },
  manos_abiertas: { archivo: 'manos_abiertas.png', para: 'duda' },
  manos_juntas: { archivo: 'manos_juntas.png', para: 'explicar' },
  decepcionado: { archivo: 'decepcionado.png', para: 'decepcion' },
  pensativa: { archivo: 'pensativa.png', para: 'reflexionar' },
  brazos_relajado: { archivo: 'brazos_relajado.png', para: 'enlace' },
  pizarra: { archivo: 'pizarra.png', para: 'datos' },
};

/** Gesto por defecto si hubiera que poner alguno pero ninguno encaja. */
const GESTO_NEUTRO = 'brazos_relajado';

/**
 * Cuántos gestos puede tener un video.
 *
 * Hay 7 gestos distintos y un video tiene entre 4 y 7 escenas, así que con 7
 * se puede cubrir TODO el video sin repetir ninguno. Es el objetivo: que GIR
 * esté presente de principio a fin, no que asombre dos veces.
 */
export const MAX_GESTOS_POR_VIDEO = 7;

// ── Reglas por palabra clave ─────────────────────────────────────────────────
//
// El orden importa: la primera regla que matchea gana. Por eso lo más
// específico ("fracaso", "perdio") va antes que lo genérico ("no se sabe").
//
// Las expresiones están en minúsculas y acentos, porque el guion los lleva.
const REGLA_GESTOS = [
  // Emoción fuerte primero: si dice "fracaso" y luego "dato", quiero el gesto de
  // emoción, no el de dato.
  { gesto: 'decepcionado', re: /\b(fracaso|fracas[oó]|fall[oó]|murió|murio|desapareci[oó]|perdi[oó]|ruina|abandon[oó]|p[ée]rdida)\b/ },
  { gesto: 'decepcionado', re: /\b(perecer[oó]|imposible|demasiado tarde|se acab[oó]|no lleg[oó])\b/ },

  // Datos y cifras: la pizarra es para esto.
  { gesto: 'pizarra', re: /\b(\d[\d.,]*\s*(?:mil|mill[oó]n|%|km|metros|[a-z]{2,3})\b)/ },
  { gesto: 'pizarra', re: /\b\d{1,3}(?:,\d{3})+\b/ },
  { gesto: 'pizarra', re: /\b(estudio|estudios|dato|datos|cifra|cifras|medici[oó]n|mediciones|comparaci[oó]n|tasa|porcentaje|resultado|resultados|hallazgo|hallazgos)\b/ },
  { gesto: 'pizarra', re: /\b(\d+\s*(?:°|grados|a[oñ]os|meses|d[ií]as|horas|minutos|segundos))\b/ },

  // Llamar la atención.
  { gesto: 'senalar', re: /\b(ojo|importante|clave|cuidado|fijate|prest[ae] atenci[oó]n|recuerda|demasiado|el mayor|nunca|siempre|todo el mundo)\b/ },

  // Duda e incertidumbre.
  { gesto: 'manos_abiertas', re: /\b(no se sabe|desconocido|quiz[aá]|tal vez|puede ser|probablemente|aunque|nadie|sin confirmaci[oó]n)\b/ },

  // Explicar un concepto: la esfera verde entre las manos.
  { gesto: 'manos_juntas', re: /\b(por qu[eé]|porque|significa|consiste|se define|cuando hablamos de|se trata de|explicado|explicar)\b/ },

  // Reflexión.
  { gesto: 'pensativa', re: /\b(lo interesante|curioso|extra[ñn]o|lo raro|piensa|nadie lo sab[ií]a|sorprende)\b/ },
];

/**
 * Decide el gesto de una escena.
 *
 * @param {object} escena      La escena del guion (con .texto y opcional .gesto).
 * @param {Set<string>} usados Gestos ya usados en este video.
 * @returns {string|null} Clave del gesto, o null si esta escena va sin gesto.
 */
export function elegirGesto(escena, usados = new Set()) {
  // 1. El guion manda. Si dice un gesto, ese es, aunque ya se haya usado: es
  //    una decisión consciente del modelo y no conviene desmontarla.
  const pedido = String(escena?.gesto || '').trim().toLowerCase();
  if (pedido && GESTOS[pedido]) return pedido;

  // 2. Regla por palabras.
  const texto = String(escena?.texto || escena?.narracion || '').toLowerCase();
  for (const regla of REGLA_GESTOS) {
    if (regla.re.test(texto)) {
      // Si ya se usó, se busca la SIGUIENTE regla que dé algo nuevo: mejor un
      // segundo gesto adecuado que repetir el mismo.
      if (!usados.has(regla.gesto)) return regla.gesto;
      for (const otra of REGLA_GESTOS) {
        if (otra !== regla && !usados.has(otra.gesto) && otra.re.test(texto)) return otra.gesto;
      }
      return null;
    }
  }

  return null;
}

/**
 * Reparte los gestos entre las escenas, con tope.
 *
 * Se procesan las escenas EN ORDEN porque el guion se cuenta de principio a
 * fin: si un gesto entra en la escena 3, es porque en ese momento el texto lo
 * pidió, no porque se sorteara al principio.
 *
 * Tres pasadas:
 *   1. Lo que el guion pide explícitamente (manda sobre todo).
 *   2. Lo que deducen las palabras clave, sin repetir gesto.
 *   3. Relleno con el gesto neutro para que ninguna escena se quede sin robot.
 *      Nunca repite el gesto de la escena anterior: dos escenas seguidas con la
 *      misma pose se lee como una imagen congelada, no como un movimiento.
 *
 * @param {Array} escenas    Escenas del guion.
 * @param {number} maximo    Cuántos gestos se permiten en todo el video.
 * @returns {Map<number,string>} Escena (índice) -> gesto.
 */
export function repartirGestos(escenas, maximo = MAX_GESTOS_POR_VIDEO) {
  const asignados = new Map();
  const usados = new Set();
  if (!Array.isArray(escenas) || !escenas.length) return asignados;

  // Primer pase: el guion manda siempre, y cuenta para el tope.
  for (let i = 0; i < escenas.length; i++) {
    const pedido = String(escenas[i]?.gesto || '').trim().toLowerCase();
    if (pedido && GESTOS[pedido] && asignados.size < maximo) {
      asignados.set(i, pedido);
      usados.add(pedido);
    }
  }

  // Segundo pase: si sobra hueco, lo llenan las reglas por palabras.
  for (let i = 0; i < escenas.length && asignados.size < maximo; i++) {
    if (asignados.has(i)) continue;
    const g = elegirGesto(escenas[i], usados);
    if (g && !usados.has(g)) {
      asignados.set(i, g);
      usados.add(g);
    }
  }

  // Tercer pase: relleno. Ninguna escena se queda sin GIR. Se evita repetir el
  // gesto de la escena anterior para que el conjunto se lea como movimiento, y
  // se prefiere el gesto neutro (brazos relajados): es el que vale para
  // cualquier frase, incluido el "síguenos" del final, donde una pose triste
  // desentona.
  for (let i = 0; i < escenas.length && asignados.size < maximo; i++) {
    if (asignados.has(i)) continue;
    const anterior = asignados.get(i - 1);
    const candidato = [GESTO_NEUTRO, ...Object.keys(GESTOS)].find(
      (k) => k !== anterior && !usados.has(k)
    ) || GESTO_NEUTRO;
    asignados.set(i, candidato);
    usados.add(candidato);
  }

  return asignados;
}

/**
 * Devuelve la ruta del archivo de un gesto.
 *
 * @param {string} nombre  Clave del gesto.
 * @param {string} baseDir Carpeta donde están los PNG.
 */
export function rutaGesto(nombre, baseDir) {
  const g = GESTOS[nombre];
  if (!g) return null;
  return `${baseDir}/${g.archivo}`;
}

export { GESTO_NEUTRO };