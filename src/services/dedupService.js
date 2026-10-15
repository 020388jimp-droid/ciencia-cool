// src/services/dedupService.js
// ─────────────────────────────────────────────────────────────────────────────
// ¿Es esta noticia la MISMA que ya publicamos, aunque el titular sea otro?
//
// ── El problema real ─────────────────────────────────────────────────────────
// El mismo hecho lo cuentan varios medios con titulares distintos:
//
//   "Científicos votan eliminar el minuto de 61 segundos…"
//   "El mundo decide si rectifica el tiempo universal coordinado…"
//
// Son la misma noticia (el segundo intercalar), pero no comparten palabras
// suficientes como para detectarlo comparando textos. Comparando títulos se
// publicó dos veces el mismo tema en días distintos, que es justo lo que hay
// que evitar.
//
// ── La solución ──────────────────────────────────────────────────────────────
// Preguntárselo a Gemini. Una llamada cortísima (unos cientos de tokens, una
// fracción del coste de generar el guion del video) que responde SÍ o NO.
//
// Si Gemini falla o no hay clave, NO se bloquea nada: se asume que la noticia
// es nueva y el pipeline sigue. Es mejor un video repetido de vez en cuando que
// un día sin video.
// ─────────────────────────────────────────────────────────────────────────────

import { GoogleGenerativeAI } from '@google/generative-ai';
import { MODELOS_GEMINI } from './geminiService.js';

let cliente = null;

/** Conexión perezosa: solo se crea si hay clave. */
function getCliente() {
  if (cliente) return cliente;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'tu_api_key_de_gemini_aqui') return null;
  cliente = new GoogleGenerativeAI(apiKey);
  return cliente;
}

// Cuántos titulares ya usados se enseñan como máximo. Con 8-10 bastan para
// detectar la repetición y el prompt sigue siendo corto (y barato).
const MAX_TITULOS = 10;

/**
 * ¿Habla la candidata de lo mismo que alguna de las ya publicadas?
 *
 * @param {string}      tituloCandidato
 * @param {string[]}    titularesUsados  Titulares reales de noticias ya usadas.
 * @returns {Promise<{duplicado: boolean, motivo: string}>}
 */
export async function esMismaHistoria(tituloCandidato, titularesUsados = []) {
  const candidata = String(tituloCandidato || '').trim();
  const usados = titularesUsados.filter(Boolean).slice(0, MAX_TITULOS);

  // Sin nada que comparar, o sin clave, no hay forma de saber: se sigue.
  if (!candidata || !usados.length) return { duplicado: false, motivo: 'nada que comparar' };

  const ia = getCliente();
  if (!ia) return { duplicado: false, motivo: 'sin clave de Gemini' };

  const prompt = [
    'Eres un filtro anti-repetición para un canal de noticias de ciencia.',
    '',
    'NOTICIA CANDIDATA:',
    candidata,
    '',
    'NOTICIAS YA PUBLICADAS:',
    ...usados.map((t, i) => `${i + 1}. ${t}`),
    '',
    '¿La candidata habla del MISMO acontecimiento, descubrimiento o suceso',
    'concreto que alguna de las ya publicadas? Aunque el titular, el medio o',
    'el enfoque sean distintos, si es el mismo hecho la respuesta es DUPLICADO.',
    'Dos noticias sobre el mismo tema general (por ejemplo dos avances',
    'distintos de robótica) son NUEVO.',
    '',
    'Responde UNA sola palabra, sin explicación: DUPLICADO o NUEVO.',
  ].join('\n');

  try {
    // Se prueban los mismos modelos que usa el generador de guion: con un
    // nombre que no exista para esta clave, la llamada falla y el filtro se
    // queda sin hacer nada (que es lo que pasó la primera vez).
    //
    // El límite de tokens es generoso a propósito: los modelos "piensan" antes
    // de responder y con 60 tokens se quedaban sin texto. Pidiendo una sola
    // palabra la respuesta es además mucho más fácil de interpretar.
    let texto = '';
    for (const modelName of MODELOS_GEMINI) {
      try {
        const modelo = ia.getGenerativeModel({
          model: modelName,
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 400,
          },
        });
        const respuesta = await modelo.generateContent(prompt);
        texto = (respuesta?.response?.text?.() || '').trim();
        if (texto) break;
      } catch (errorModelo) {
        console.warn(`⚠️ Modelo ${modelName} no disponible para el filtro: ${errorModelo.message}`);
      }
    }

    if (!texto) return { duplicado: false, motivo: 'el modelo no devolvió texto' };

    // Una sola palabra: DUPLICADO o NUEVO. Se mira DUPLICADO primero porque
    // "no es duplicado" contendría la palabra "duplicado".
    if (/duplicado/i.test(texto)) {
      return { duplicado: true, motivo: 'misma historia que una ya publicada' };
    }
    if (/nuevo/i.test(texto)) {
      return { duplicado: false, motivo: 'historia nueva' };
    }

    return { duplicado: false, motivo: `respuesta no reconocida ("${texto.slice(0, 30)}")` };
  } catch (error) {
    // Un fallo aquí no puede tumbar la generación del video.
    console.warn(`⚠️ No se pudo comprobar si la noticia está repetida (${error.message}); se acepta`);
    return { duplicado: false, motivo: 'error al comprobar' };
  }
}

/**
 * Elige la primera noticia de la lista que NO sea repetición.
 *
 * La lista viene ya ordenada por "calor" (tendencia + cobertura), así que se
 * recorre de arriba abajo y se para en la primera que no esté publicada.
 *
 * @param {Array<{title: string, timestamp: number}>} ordenadas
 * @param {string[]} titularesUsados
 * @param {number}   maxComprobaciones  Límite de llamadas a Gemini por video.
 * @returns {Promise<{noticia: object|null, motivo: string}>}
 */
export async function elegirNoRepetida(ordenadas, titularesUsados, maxComprobaciones = 4) {
  if (!Array.isArray(ordenadas) || !ordenadas.length) {
    return { noticia: null, motivo: 'sin candidatas' };
  }

  const exactas = new Set(titularesUsados.filter(Boolean));

  for (let i = 0; i < ordenadas.length && i < maxComprobaciones; i++) {
    const candidata = ordenadas[i];

    // Filtro barato primero: si el titular es idéntico, ni se pregunta.
    if (exactas.has(candidata.title)) {
      console.log(`↩️  Descartada por titular idéntico: "${candidata.title.slice(0, 50)}"`);
      continue;
    }

    const { duplicado, motivo } = await esMismaHistoria(candidata.title, titularesUsados);
    if (duplicado) {
      console.log(`↩️  Descartada (${motivo}): "${candidata.title.slice(0, 50)}"`);
      continue;
    }

    return { noticia: candidata, motivo };
  }

  // Si las primeras eran todas repetición, se coge la primera disponible:
  // mejor un video que se parezca a uno anterior que quedarse sin publicar.
  const indisponibles = new Set(ordenadas.slice(0, maxComprobaciones));
  return {
    noticia: ordenadas.find(n => !indisponibles.has(n)) || ordenadas[0],
    motivo: 'sin más candidatas nuevas',
  };
}
