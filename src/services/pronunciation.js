// ─────────────────────────────────────────────────────────────────────────────
// Cómo se PRONUNCIA cada cosa cuando el motor es Google Cloud TTS.
//
// ── Por qué existe ──────────────────────────────────────────────────────────
// El guion trae números y siglas tal cual los escribió Gemini ("2,000", "IA",
// "NASA"). Edge TTS los resolvía solo. Cloud TTS es más literal y no siempre
// acierta:
//
//   "2,000"  -> "dos coma cero cero cero"   (debería ser "dos mil")
//   "IA"     -> "i-ai"                       (peor: se oye raro)
//
// ── Dónde se aplica ─────────────────────────────────────────────────────────
// Solo sobre el texto que va al motor de voz. El texto del subtítulo NO se
// toca: el espectador tiene que LEER "2,000", mientras lo que suena tiene que
// ser "dos mil". Son dos cosas distintas, y por eso el arreglo va únicamente
// en la síntesis.
//
// En Edge no se aplica: si Microsoft levanta el bloqueo, la voz buena vuelve
// sin tocar una línea, y este módulo no debe alterar su comportamiento.
// ─────────────────────────────────────────────────────────────────────────────

// Siglas cuya lectura letra a letra suena mal en español. Se pasan por
// <say-as interpret-as="characters">, que es como las trata bien el motor.
const SIGLAS_ESPECIALES = {
  IA: 'I de A',
  CC: 'C de C',
  PP: 'P de P',
  MM: 'M de M',
  RR: 'R de R',
  AA: 'A de A',
  EE: 'E de E',
  UU: 'U de U',
};

// Siglas que en español ya se pronuncian como una palabra normal. Escribirlas
// en minúsculas evita que el motor las deletree.
const SIGLAS_PALABRA = {
  NASA: 'nasa',
  IA: 'ia',
  ONU: 'onu',
  OMS: 'oms',
  UIT: 'uit',
  ADN: 'a de ene', // "a de ene" se oye mejor que "a d n"
  ARN: 'a de ene',
};

const VOCALES = ['a', 'e', 'i', 'o', 'u'];

/** Escapa texto para poder meterlo dentro de SSML. */
function esc(t) {
  return String(t)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const UNIDADES = ['', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete',
  'ocho', 'nueve', 'diez', 'once', 'doce', 'trece', 'catorce', 'quince',
  'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve', 'veinte'];
const DECENAS = ['', '', 'veinte', 'treinta', 'cuarenta', 'cincuenta', 'sesenta',
  'setenta', 'ochenta', 'noventa'];

/** 0-999 -> "doscientos treinta y cuatro". */
function hasta999(n) {
  if (n === 0) return 'cero';
  if (n < 30) return UNIDADES[n];

  // n ya es >= 30, así que n/100 da la centena y (n%100)/10 la decena. Con
  // n/10 directamente se saltaba el nivel de las centenas y "250" salía como
  // "undefined mil".
  const centenas = Math.floor(n / 100);
  const resto = n % 100;

  // "dos cientos" está mal: en español la centena se junta ("doscientos",
  // "trescientos"), y solo "ciento" se separa ("ciento veinte").
  const CENTENAS = ['', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos',
    'quinientos', 'seiscientos', 'setecientos', 'ochocientos', 'novecientos'];

  let out = '';
  if (centenas === 1) out = 'ciento';
  else if (centenas > 1) out = CENTENAS[centenas];

  if (resto > 0) {
    if (resto < 30) {
      out += (out ? ' ' : '') + UNIDADES[resto];
    } else {
      const d = Math.floor(resto / 10);
      const u = resto % 10;
      // 21-29 se juntan: "veintiuno", no "veinte y uno". Así lo dice la gente.
      if (d === 2) out += (out ? ' ' : '') + 'veinti' + UNIDADES[u];
      else if (u === 0) out += (out ? ' ' : '') + DECENAS[d];
      else out += (out ? ' ' : '') + DECENAS[d] + ' y ' + UNIDADES[u];
    }
  }

  return out;
}

/**
 * Entero -> palabras en español, hasta 999999.
 *
 * Por encima de un millón se devuelve null: es un número que no aparece en
 * estos guiones, y es preferible que el motor lo lea a como venga antes que
 * inventar una lectura rare.
 */
function enteroAPalabras(n) {
  if (!Number.isFinite(n) || n < 0 || n > 999999) return null;
  if (n === 0) return 'cero';

  const miles = Math.floor(n / 1000);
  const resto = n % 1000;

  let partes = [];
  if (miles === 1) partes.push('mil');
  else if (miles > 1) partes.push(hasta999(miles) + ' mil');
  if (resto > 0) partes.push(hasta999(resto));

  return partes.join(' ');
}

/**
 * Convierte un número con comas de millar en palabras: "2,000" -> "dos mil".
 *
 * Solo aplica a enteros con separador de miles. Los años van sin coma ("2024"),
 * así que nunca entran por aquí, que es justo lo que se quiere: "en 2024" no
 * debe sonar "en dos mil veinticuatro".
 *
 * Devuelve null si no se puede convertir, para que quien llama decida.
 */
function milesAPalabras(textoNum) {
  const limpio = textoNum.replace(/,/g, '');
  if (!/^\d+$/.test(limpio)) return null;

  const n = parseInt(limpio, 10);
  if (n < 1000) return null;
  return enteroAPalabras(n);
}

/**
 * Devuelve el SSML del texto ya corregido para que Cloud TTS lo lea bien.
 *
 * Solo se toca lo que de verdad sale mal:
 *
 *   - Números con coma de millar -> palabras ("2,000" -> "dos mil")
 *   - Siglas que suenan raro      -> <say-as interpret-as="characters">
 *   - Siglas que son una palabra  -> en minúsculas ("NASA" -> "nasa")
 *
 * Se deja todo lo demás intacto a propósito:
 *
 *   - Decimales ("0.75"): el motor ya los lee bien.
 *   - Años sin coma ("2024"): ya los lee bien.
 *   - Siglas normales (CERN, MIT, JPL): letra a letra es lo esperado.
 *   - Texto en inglés: en inglés el motor sí lee "2,000" como "two thousand".
 */
export function textoAPronunciableSsml(texto, lang) {
  // En inglés no hay nada que corregir: la numeración y las siglas inglesas se
  // leen correctamente con el nombre de la voz.
  if (String(lang || '').toLowerCase().startsWith('en')) {
    return `<speak>${esc(texto)}</speak>`;
  }

  // Se recorre una sola vez buscando el siguiente patrón a partir de la
  // posición actual. Con tres patrones independientes se iría en bucle
  // infinito: los tests globales no avanzan, así que hay que buscar la
  // siguiente coincidencia por delante a mano.
  const patrones = [
    { re: /\d{1,3}(?:,\d{3})+\b/g, tipo: 'miles' },
    { re: /\b[A-ZÁÉÍÓÚÑ]{2,5}\b/g, tipo: 'sigla' },
  ];

  let salida = '';
  let i = 0;

  while (i < texto.length) {
    // Siguiente coincidencia de cada patrón por delante de i.
    let mejor = null;
    for (const p of patrones) {
      p.re.lastIndex = i;
      const m = p.re.exec(texto);
      if (m && (!mejor || m.index < mejor.index)) {
        mejor = { index: m.index, texto: m[0], tipo: p.tipo };
      }
    }

    if (!mejor) {
      salida += esc(texto.slice(i));
      break;
    }

    salida += esc(texto.slice(i, mejor.index));
    const original = mejor.texto;

    if (mejor.tipo === 'miles') {
      const palabras = milesAPalabras(original);
      // Si no se puede convertir (número enorme, formato raro), se deja tal
      // cual. Suena raro, pero al menos es legible y no inventamos lectura.
      salida += palabras ? esc(palabras) : esc(original);
    } else {
      const sigla = original.toUpperCase();
      if (SIGLAS_ESPECIALES[sigla]) {
        // "IA" -> "I de A": se oye "i de a", que es como se dice en español y
        // no "i-ai".
        salida += `<say-as interpret-as="characters">${esc(SIGLAS_ESPECIALES[sigla])}</say-as>`;
      } else if (SIGLAS_PALABRA[sigla]) {
        salida += esc(SIGLAS_PALABRA[sigla]);
      } else {
        // Cualquier otra sigla (CERN, MIT, JPL, ESA): letra a letra, que es lo
        // que espera el espectador y lo que ya hace bien el motor.
        salida += esc(original);
      }
    }

    i = mejor.index + original.length;
  }

  return `<speak>${salida}</speak>`;
}