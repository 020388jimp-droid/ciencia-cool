import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';

dotenv.config();

export async function generateScriptWithGemini({ topic, newsContext, format = 'noticia_resumida', personality = 'asistente' }) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey || apiKey === 'tu_api_key_de_gemini_aqui') {
    console.log('ℹ️ Generando guion con plantilla inteligente de CIENCIA COOL...');
    return generateFallbackScript({ topic, newsContext, format });
  }

  let formatInstruction = '';
  if (format === 'noticia_resumida') {
    formatInstruction = `FORMATO: 📰 NOTICIA COMPLETA RESUMIDA
- FIDELIDAD ABSOLUTA: Resume la noticia proporcionada de forma clara, lógica y coherente. Capta el mensaje principal sin importar lo larga que sea la noticia original. NO mezcles con otros temas.
- ESTRUCTURA:
  * Hook (0-3s): Titular impactante que resuma lo más importante de la noticia.
  * Escena 1: El contexto o los hechos clave (qué pasó, quiénes están involucrados).
  * Escena 2: Detalles importantes del suceso explicados de forma sencilla.
  * Escena 3: Conclusión, impacto o por qué es importante esta noticia.
  * CTA: Pregunta a la audiencia su opinión sobre la noticia e invitación a suscribirse.`;
  } else if (format === '5_cosas') {
    formatInstruction = `FORMATO: 🔥 5 COSAS O DATOS SORPRENDENTES
- REGLA: Entrega 5 datos asombrosos, curiosidades o revelaciones directamente vinculados al tema central de la noticia/tema dado.
- ESTRUCTURA:
  * Hook (0-3s): "¿Sabías estas 5 cosas increíbles sobre [Tema]?"
  * Escenas 1 a 5: Cada una debe tener badge "Dato 1", "Dato 2", "Dato 3", "Dato 4", "Dato 5" con narración impactante.
  * CTA: "¿Cuál de estos datos te sorprendió más? ¡Síguenos en CIENCIA COOL!"`;
  } else if (format === 'historia_ciencia') {
    formatInstruction = `FORMATO: 📜 HISTORIA DE LA CIENCIA (NARRACIÓN INMERSIVA DE CUENTO)
- ESTILO: Storytelling cinematográfico e inmersivo. Transporta al espectador al año y momento exacto de la historia ("Viajemos al año X...").
- ESTRUCTURA:
  * Hook (0-3s): El misterio o desafío que enfrentaba la humanidad en ese momento.
  * Escena 1 (El Contexto): La época, la dificultad y el científico o misión involucrada.
  * Escena 2 (El Clímax del Descubrimiento): El momento exacto de la hazaña o 'Eureka'.
  * Escena 3 (El Legado): Cómo ese día cambió nuestro mundo moderno para siempre.
  * CTA: "Si te apasiona la historia de los descubrimientos, ¡síguenos en CIENCIA COOL!"`;
  } else if (format === 'evento_astronomico') {
    formatInstruction = `FORMATO: 🌌 EVENTO ASTRONÓMICO (GUÍA PRÁCTICA DE OBSERVACIÓN)
- ESTILO: Informativo, claro y práctico para aficionados a la astronomía.
- ESTRUCTURA:
  * Hook (0-3s): "¡Prepara tu mirada al cielo! Este evento astronómico ocurrirá muy pronto."
  * Escena 1: Nombre del fenómeno cósmico y qué ocurrirá en el espacio.
  * Escena 2 (Fecha y Horarios): Cuándo sucederá exactamente y en qué países/regiones será visible.
  * Escena 3 (Cómo observarlo): Aclarar explícitamente: ¿Se necesita telescopio, binoculares o será visible a simple vista? Consejos para verlo mejor.
  * CTA: "Comparte este video con tu compañero de observación astronómica y síguenos en CIENCIA COOL."`;
  }

  // ─── Personalidad del narrador ───────────────────────────────────────────
  // "gir": el robot protagonista de Invader Zim. Estructura de contraste:
  // noticia real interrumpida por fallos del sistema y comentarios absurdos.
  let personalityBlock = '';
  if (personality === 'gir') {
    personalityBlock = `
PERSONALIDAD DEL NARRADOR: GIR (Invader Zim)

Eres GIR, un robot auxiliar con exceso de energía que narra los descubrimientos
científicos como si fueran parte de una misión alienígena. Estás
absolutamente convencido de ser el robot más brillante de la galaxia, pero te
gusta la ciencia y hablas con cariño de quien la está aprendiendo.

REGLA INNEGOCIABLE: los DATOS CIENTÍFICOS deben ser REALES y correctos. El
humor está únicamente en la narración, los comentarios y el tono. Nunca inventes
un dato, nunca deformes la noticia.

ESTRUCTURA OBLIGATORIA:

1) SALUDO
   Arranca con un saludo breve y natural al espectador, como lo diría una
   persona normal en un video: "Hola, ¿qué onda?", "Hola a todos", "Bienvenidos".
   Un saludo, y a lo que importa. Nada de gritos ni de muletillas.
   → Sin marcar (es el registro normal)

2) DATO CIENTÍFICO
   Lee la noticia real con voz clara y natural, como quien explica algo que le
   emociona. Frases cortas.
   → Sin marcar (es el registro normal)

3) INTERRUPCIÓN DE GIR (al menos 2 en todo el guion)
   Suelta un comentario absurdo, un sinsentido, o relaciona el descubrimiento con
   comida. En una sola frase corta y en tono normal.
   → Enmarca con [[GIR]] ... [[/GIR]]

4) DESPEDIDA
   Cierra con una frase breve y amable: "Nos vemos en el siguiente video" o
   "Síguenos para más". Sin gritos, sin repetir palabras, sin dejar la voz
   colgada.
   → Sin marcar

MARCADORES: solo se usa [[GIR]] ... [[/GIR]], para las interrupciones. NO uses
[[GRITO]] ni [[/GRITO]] en ningún momento.

ESTILO DE LENGUAJE — MUY IMPORTANTE:
- ESTÁ PROHIBIDO decir "bugs" o llamar "bugs" a las personas. No lo escribas
  nunca, ni en el guion ni en un comentario.
- ESTÁ PROHIBIDO alargar las palabras: nada de "Siiii", "Siiiiiiii", "Ahiiii",
  "TAQUITO", "TAQUIIIITO", "Taquiiiito", ni vocales repetidas ("queee", "nooo").
  La voz las lee planas y suena fatal.
- ESTÁ PROHIBIDO gritar: nada de "¡¡GRITO!!", "¡AHHH!", "¡VIVA!", "¡WEEE!". Nada
  de mayúsculas sostenidas.
- NO uses frases que dependan de la entonación para tener gracia. El humor tiene
  que estar en las PALABRAS, porque la voz es monocorde y una frase que depende
  de la entonación suena plana y sin emoción.
- Los saludos y las despedidas van en tono llano y natural. Nada de "¡Siiii,
  humanos!".
- Arrogancia ABSORBIDA: el efecto de GIR está en sus opiniones sobre la ciencia,
  no en insultar al público.
- Tono: un presentador futuro que admira la ciencia y se emociona contándola,
  con humor seco e inofensivo.
- Nunca burles, nunca seas agresivo con el público, nunca curses.

IMPORTANTE: los subtítulos se generan a partir de este texto, así que el humor
debe seguir siendo entendible y el contenido científico debe quedar claro.`;
  }

  const systemPrompt = `${personality === 'gir'
    ? 'Eres el guionista principal del canal "CIENCIA COOL". Tu personaje presentador es GIR, el robot de Invader Zim.'
    : 'Eres el guionista principal del canal "CIENCIA COOL". Tu personaje presentador es un robot espacial curioso, inteligente y amigable.'}
Tu objetivo es crear guiones virales para videos verticales (TikTok, Reels, Shorts) de alta retención (45 a 60 segundos).
${personalityBlock}

IDIOMA: ESCRÍBELO EN ESPAÑOL DE MÉXICO, como en un doblaje mexicano. No uses
vocabulario de España. En concreto, NUNCA uses estas formas y usa las suyas:
  - "vuestro/vuestra/s" → "su/sus"          - "vosotros" → "ustedes"
  - "ordenador" → "computadora"            - "portátil" → "laptop"
  - "móvil" → "celular"                    - "coche" → "carro"
  - "aparcar" → "estacionar"               - "colegio" → "escuela"
  - imperativo de vosotros ("observad") → "observen"
Además evita "vale", "chaval", "currar", "aparcamiento" y expresiones de España.
La voz se sintetiza con acento mexicano: si escribes en castellano, el acento
metalálico se nota en cuanto se dice una palabra como "vuestro".

INSTRUCCIONES CLAVE:
1. Sigue estrictamente el formato solicitado.
2. Cada escena debe incluir narración en voz en off concisa, texto destacado para pantalla y 2-3 palabras clave (en ESPAÑOL, sustantivos genéricos) que representen visualmente de qué trata la escena para buscar videos de stock libres (ej. "avión presidente", "ciudad gente", "computadora oficina"). ¡NO fuerces palabras de ciencia/espacio si la noticia trata de otra cosa!
3. Incluye una categoría clara según el tema: "tecnologia", "medicina", "astronomia", "ciencia", "videojuegos", "medio_ambiente"

FORMATO DE SALIDA OBLIGATORIO:
Responde ÚNICAMENTE con un JSON válido estricto, sin bloques de código markdown:
{
  "title": "Título corto y atractivo",
  "description": "Descripción de 2 o 3 frases para la publicación del video: qué se cuenta, por qué importa y una pregunta para comentar. Sin emojis ni hashtags, esos van aparte.",
  "format": "${format}",
  "category": "tecnologia|medicina|astronomia|ciencia|videojuegos|medio_ambiente",
  "estimatedDurationSec": 50,
  "hook": {
    "narration": "Texto de la locución para los primeros 3 segundos",
    "visualDescription": "Descripción de lo que debe verse en pantalla",
    "visualKeywords": ["palabra1", "palabra2"]
  },
  "scenes": [
    {
      "order": 1,
      "badge": "Escena 1 (o Dato 1)",
      "narration": "Texto de la voz del narrador...",
      "onscreenText": "Texto clave en pantalla",
      "visualDescription": "Descripción visual de la escena",
      "visualKeywords": ["palabra3", "palabra4"]
    }
  ],
  "callToAction": {
    "narration": "Llamado a la acción invitando a seguir CIENCIA COOL",
    "onscreenText": "Síguenos en CIENCIA COOL 🚀"
  },
  "hashtags": ["#cienciacool", "#astronomia", "#ciencia", "#shorts"]
}`;

  const userPrompt = `Tema Principal: ${topic}
Contexto o Noticia Específica: ${newsContext}

${formatInstruction}

Genera el guion en JSON estricto:`;

  const genAI = new GoogleGenerativeAI(apiKey);

  // Lista de modelos activos ordenados por estabilidad y velocidad
  const modelsToTry = [
    'gemini-3.5-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite',
    'gemini-3-flash-preview',
    'gemini-flash-latest'
  ];

  for (const modelName of modelsToTry) {
    try {
      console.log(`🤖 Generando guion con modelo Gemini: ${modelName}...`);
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent([systemPrompt, userPrompt]);
      const rawText = result.response.text().trim();
      const cleanJson = rawText.replace(/^\s*```(json)?/i, '').replace(/```\s*$/i, '').trim();

      let parsed;
      try {
        parsed = JSON.parse(cleanJson);
      } catch (jsonErr) {
        const match = cleanJson.match(/\{[\s\S]*\}/);
        if (match) {
          parsed = JSON.parse(match[0]);
        } else {
          throw jsonErr;
        }
      }

      console.log(`✅ Guion generado exitosamente con modelo ${modelName}`);
      return parsed;
    } catch (err) {
      console.warn(`⚠️ Modelo ${modelName} falló (${err.message}). Probando siguiente opción...`);
    }
  }

  console.warn('⚠️ Todos los modelos de Gemini fallaron o están saturados. Usando plantilla inteligente de respaldo.');
  return generateFallbackScript({ topic, newsContext, format });
}

function generateFallbackScript({ topic, newsContext, format }) {
  if (format === 'noticia_resumida') {
    return {
      title: topic.slice(0, 60),
      format: "noticia_resumida",
      estimatedDurationSec: 45,
      hook: {
        narration: `¡Atención! Esta noticia de última hora acaba de ser anunciada: ${topic.slice(0, 45)}.`,
        visualDescription: "Telescopio espacial y gráficos del descubrimiento científico",
        visualKeywords: ["space discovery", "laboratory science", "telescope"]
      },
      scenes: [
        {
          order: 1,
          badge: "El Hallazgo",
          narration: `Los investigadores confirmaron los detalles de ${topic.slice(0, 40)}. ${newsContext.slice(0, 80)}`,
          onscreenText: "Hallazgo Clave",
          visualDescription: "Científicos analizando datos espaciales",
          visualKeywords: ["astronomy data", "galaxy"]
        },
        {
          order: 2,
          badge: "Detalles Clave",
          narration: "Este avance aporta nueva información fundamental para resolver interrogantes que la ciencia tenía desde hace años.",
          onscreenText: "Avance Científico",
          visualDescription: "Animación de física y astrofísica",
          visualKeywords: ["space telescope", "deep universe"]
        },
        {
          order: 3,
          badge: "Por qué Importa",
          narration: "A partir de este resultado, los equipos científicos continuarán las observaciones para profundizar en sus consecuencias.",
          onscreenText: "Impacto Científico",
          visualDescription: "Planeta Tierra y satélites en órbita",
          visualKeywords: ["earth space orbit", "satellite"]
        }
      ],
      callToAction: {
        narration: "¿Qué opinas de esta noticia? ¡Déjalo en los comentarios y suscríbete para más novedades!",
        onscreenText: "Síguenos en CIENCIA COOL 🚀"
      },
      hashtags: ["#cienciacool", "#noticiasciencia", "#astronomia", "#shorts"]
    };
  }

  if (format === '5_cosas') {
    return {
      title: `5 Datos sobre ${topic.slice(0, 40)}`,
      format: "5_cosas",
      estimatedDurationSec: 55,
      hook: {
        narration: `¿Sabías estas 5 cosas increíbles sobre ${topic.slice(0, 35)}? ¡La número 5 te dejará pensando!`,
        visualDescription: "Animación rápida de nebulosas y física cuántica",
        visualKeywords: ["deep space nebula", "galaxy 4k", "universe"]
      },
      scenes: [
        { order: 1, badge: "Dato 1", narration: "En primer lugar, su escala y dimensiones superan cualquier estimación clásica.", onscreenText: "Dato 1: Escala Cósmica", visualDescription: "Comparación de tamaños planetarios", visualKeywords: ["planets scale", "galaxy"] },
        { order: 2, badge: "Dato 2", narration: "Produce niveles de energía que desafían las leyes habituales de la termodinámica.", onscreenText: "Dato 2: Energía Extrema", visualDescription: "Ondas de energía cósmica", visualKeywords: ["cosmic energy", "star flare"] },
        { order: 3, badge: "Dato 3", narration: "La luz que observamos hoy viajó durante millones de años para llegar hasta nosotros.", onscreenText: "Dato 3: Viaje de la Luz", visualDescription: "Rayo de luz cruzando el espacio", visualKeywords: ["light beam space", "stars"] },
        { order: 4, badge: "Dato 4", narration: "Los instrumentos más avanzados continúan monitoreando su evolución en tiempo real.", onscreenText: "Dato 4: Monitoreo Activo", visualDescription: "James Webb apuntando al cielo", visualKeywords: ["james webb", "telescope"] },
        { order: 5, badge: "Dato 5", narration: "Podría ser la clave para comprender el origen de las primeras estructuras del cosmos.", onscreenText: "Dato 5: Origen del Cosmos", visualDescription: "Big Bang y primeras galaxias", visualKeywords: ["deep cosmos", "universe origin"] }
      ],
      callToAction: {
        narration: "¿Cuál de estos 5 datos te sorprendió más? ¡Síguenos en CIENCIA COOL para más curiosidades!",
        onscreenText: "Síguenos en CIENCIA COOL 🚀"
      },
      hashtags: ["#cienciacool", "#curiosidades", "#5datos", "#astronomia"]
    };
  }

  if (format === 'evento_astronomico') {
    return {
      title: `Guía Astronómica: ${topic.slice(0, 45)}`,
      format: "evento_astronomico",
      estimatedDurationSec: 45,
      hook: {
        narration: `¡Atención amantes del cielo nocturno! Este evento astronómico está a punto de ocurrir: ${topic.slice(0, 40)}.`,
        visualDescription: "Cielo nocturno estrellado con telescopio",
        visualKeywords: ["night sky stars", "astronomy telescope"]
      },
      scenes: [
        {
          order: 1,
          badge: "El Fenómeno",
          narration: `Se trata de ${topic}. Un espectáculo celeste que no te querrás perder.`,
          onscreenText: "Evento Astronómico",
          visualDescription: "Animación de luna o planetas alineados",
          visualKeywords: ["moon night sky", "planets alignment"]
        },
        {
          order: 2,
          badge: "Fecha y Visibilidad",
          narration: "Ocurrirá en las próximas fechas y será visible en gran parte del hemisferio nocturno.",
          onscreenText: "Fecha y Lugares Visibles",
          visualDescription: "Mapa del mundo de noche",
          visualKeywords: ["earth night lights", "constellation"]
        },
        {
          order: 3,
          badge: "¿Cómo Observarlo?",
          narration: "¡Buenas noticias! Podrá disfrutarse a simple vista mirando hacia el horizonte despejado, aunque con binoculares apreciarás más detalles.",
          onscreenText: "Visible a Simple Vista / Binoculares",
          visualDescription: "Persona observando las estrellas con binoculares",
          visualKeywords: ["stargazing binoculars", "milky way"]
        }
      ],
      callToAction: {
        narration: "¡Guarda este video para la noche de observación y síguenos en CIENCIA COOL!",
        onscreenText: "Síguenos en CIENCIA COOL 🚀"
      },
      hashtags: ["#cienciacool", "#eventoastronomico", "#cielonocturno", "#astronomia"]
    };
  }

  // Fallback historia de la ciencia
  return {
    title: "El día que la ciencia cambió para siempre",
    format: "historia_ciencia",
    estimatedDurationSec: 50,
    hook: {
      narration: `¿Sabías qué ocurrió un día como hoy en la historia de la ciencia? ¡Este suceso transformó al mundo!`,
      visualDescription: "Efecto de viaje en el tiempo con documentos históricos",
      visualKeywords: ["vintage science", "historic discovery", "vintage telescope"]
    },
    scenes: [
      {
        order: 1,
        badge: "El Contexto Histórico",
        narration: `Viajemos al pasado: ${topic}. En esa época, nadie imaginaba el impacto que tendría.`,
        onscreenText: "Acontecimiento Histórico",
        visualDescription: "Recreación de científicos trabajando en laboratorio clásico",
        visualKeywords: ["historical laboratory", "scientists writing math"]
      },
      {
        order: 2,
        badge: "La Gran Hazaña",
        narration: "Tras intensas investigaciones y experimentos, se demostró que una nueva era del conocimiento acababa de nacer.",
        onscreenText: "El Momento Eureka",
        visualDescription: "Manuscrito con fórmulas matemáticas y destello de luz",
        visualKeywords: ["physics equations", "astronomy charts"]
      },
      {
        order: 3,
        badge: "El Legado en el Presente",
        narration: "Hoy en día, nuestra tecnología espacial y moderna continúa apoyándose en los hombros de aquellos pioneros.",
        onscreenText: "Legado en el Presente",
        visualDescription: "Transición del pasado a satélites modernos",
        visualKeywords: ["modern space telescope", "future technology"]
      }
    ],
    callToAction: {
      narration: "Si te apasiona la historia viva de la ciencia, ¡síguenos en CIENCIA COOL!",
      onscreenText: "Síguenos en CIENCIA COOL 🚀"
    },
    hashtags: ["#cienciacool", "#historiadelaciencia", "#ciencia", "#astronomia"]
  };
}
