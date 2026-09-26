import axios from 'axios';
import { WIKIPEDIA_ON_THIS_DAY_API } from '../config/feeds.js';

const PRIMARY_SCIENCE_KEYWORDS = [
  'voyager', 'viking', 'apollo', 'hubble', 'sonda espacial', 'satélite', 'telescopio',
  'luna', 'marte', 'espacio', 'nasa', 'astronomía', 'astrónomo', 'premio nobel',
  'descubrimiento científico', 'teoría de la relatividad', 'mecánica cuántica',
  'einstein', 'newton', 'galileo', 'curie', 'darwin', 'tesla', 'hawking', 'turing'
];

const SECONDARY_SCIENCE_KEYWORDS = [
  'física', 'físico', 'química', 'químico', 'biología', 'biólogo', 'matemática', 'matemático',
  'inventa', 'invento', 'vacuna', 'computadora', 'planeta', 'estrella', 'átomo', 'electricidad'
];

const EXCLUDE_WORDS = [
  'bombardeo', 'bombardea', 'guerra', 'atentado', 'asesinato', 'militar', 'fútbol', 'copa', 'estadio',
  'partido político', 'opositor', 'disturbios', 'deportista', 'presentadora'
];

const MONTH_NAMES_ES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
];

export async function fetchTodayScienceHistory(customMonth, customDay) {
  const now = new Date();
  const targetMonth = customMonth ? Number(customMonth) : (now.getMonth() + 1);
  const targetDay = customDay ? Number(customDay) : now.getDate();

  const monthStr = String(targetMonth).padStart(2, '0');
  const dayStr = String(targetDay).padStart(2, '0');
  const dateFormatted = `${targetDay} de ${MONTH_NAMES_ES[targetMonth - 1]}`;

  try {
    const url = `${WIKIPEDIA_ON_THIS_DAY_API}/all/${monthStr}/${dayStr}`;
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'CienciaCoolBot/1.0 (contacto@cienciacool.com)'
      },
      timeout: 8000
    });

    const events = response.data.events || [];
    const births = response.data.births || [];

    const scoredItems = [];

    // Evaluar acontecimientos
    for (const ev of events) {
      const text = (ev.text + ' ' + (ev.pages?.map(p => p.description || '').join(' '))).toLowerCase();
      if (EXCLUDE_WORDS.some(w => text.includes(w))) continue;

      let score = 0;
      if (PRIMARY_SCIENCE_KEYWORDS.some(kw => text.includes(kw))) score += 10;
      if (SECONDARY_SCIENCE_KEYWORDS.some(kw => text.includes(kw))) score += 5;

      if (score > 0) {
        scoredItems.push({
          score,
          year: ev.year,
          day: targetDay,
          month: targetMonth,
          dateFormatted,
          type: 'Acontecimiento Histórico',
          title: `En ${ev.year}: ${ev.text}`,
          description: ev.text
        });
      }
    }

    // Evaluar nacimientos de científicos
    for (const b of births) {
      const text = (b.text + ' ' + (b.pages?.map(p => p.description || '').join(' '))).toLowerCase();
      if (EXCLUDE_WORDS.some(w => text.includes(w))) continue;

      let score = 0;
      if (PRIMARY_SCIENCE_KEYWORDS.some(kw => text.includes(kw))) score += 8;
      if (SECONDARY_SCIENCE_KEYWORDS.some(kw => text.includes(kw))) score += 4;

      if (score > 0) {
        scoredItems.push({
          score,
          year: b.year,
          day: targetDay,
          month: targetMonth,
          dateFormatted,
          type: 'Nacimiento de Científico Ilustre',
          title: `En ${b.year} nace ${b.text}`,
          description: b.text
        });
      }
    }

    // Ordenar cronológicamente por AÑO (de más antiguo a más reciente) para un recorrido histórico ordenado
    scoredItems.sort((a, b) => a.year - b.year);

    if (scoredItems.length === 0) {
      return getLegendaryScienceMilestones(dateFormatted);
    }

    return scoredItems.slice(0, 15);
  } catch (error) {
    console.error('⚠️ Error al consultar efemérides históricas de Wikipedia:', error.message);
    return getLegendaryScienceMilestones(dateFormatted);
  }
}

export function getLegendaryScienceMilestones(dateFormatted = 'Hoy') {
  return [
    {
      year: 1609,
      dateFormatted,
      type: 'Revolución Astronómica',
      title: 'Galileo Galilei apunta por primera vez un telescopio al cielo',
      description: 'Descubre las lunas de Júpiter y las fases de Venus, destruyendo para siempre el modelo geocéntrico.'
    },
    {
      year: 1905,
      dateFormatted,
      type: 'El Año Milagroso de la Física',
      title: 'Albert Einstein publica la Teoría de la Relatividad Especial',
      description: 'Introduce la ecuación E=mc² y cambia para siempre nuestra concepción del espacio, el tiempo y la energía.'
    },
    {
      year: 1969,
      dateFormatted,
      type: 'Hito de la Humanidad',
      title: 'El Apolo 11 llega a la Luna: El primer paso en otro mundo',
      description: 'Neil Armstrong y Buzz Aldrin pisan la superficie lunar, un hito que redefinió la tecnología y la ciencia espacial.'
    },
    {
      year: 1977,
      dateFormatted,
      type: 'Hito Espacial',
      title: 'Lanzamiento de la sonda espacial Voyager 2',
      description: 'La histórica sonda de la NASA que visitó Júpiter, Saturno, Urano y Neptuno, y hoy viaja por el espacio interestelar.'
    }
  ];
}

