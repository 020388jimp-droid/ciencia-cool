// Fuentes RSS ampliadas y APIs de ciencia, astronomía, tecnología e historia
export const RSS_FEEDS = [
  // --- ASTRONOMÍA Y ESPACIO ---
  {
    name: 'Google News - Astronomía & Espacio',
    url: 'https://news.google.com/rss/search?q=astronomia+espacio+telescopio+nasa+universo+when:30d&hl=es-419&gl=MX&ceid=MX:es-419',
    category: 'astronomia'
  },
  {
    name: 'ESA (Agencia Espacial Europea en Español)',
    url: 'https://www.esa.int/rssfeed/Spain',
    category: 'astronomia'
  },

  // --- CIENCIA GENERAL Y DESCUBRIMIENTOS ---
  {
    name: 'Google News - Descubrimientos Científicos',
    url: 'https://news.google.com/rss/search?q=descubrimiento+cientifico+fisica+arqueologia+biologia+when:30d&hl=es-419&gl=MX&ceid=MX:es-419',
    category: 'ciencia'
  },
  {
    name: 'Xataka Ciencia',
    url: 'https://www.xatakaciencia.com/index.xml',
    category: 'ciencia'
  },

  // --- INNOVACIÓN Y TECNOLOGÍA ---
  {
    name: 'Google News - Inteligencia Artificial & Robótica',
    url: 'https://news.google.com/rss/search?q=inteligencia+artificial+robotica+innovacion+tecnologia+when:30d&hl=es-419&gl=MX&ceid=MX:es-419',
    category: 'tecnologia'
  },
  {
    name: 'Xataka - Tecnología',
    url: 'https://www.xataka.com/index.xml',
    category: 'tecnologia'
  }
];

export const NASA_ENDPOINTS = {
  apod: 'https://api.nasa.gov/planetary/apod',
  neoWs: 'https://api.nasa.gov/neo/rest/v1/feed',
  mediaSearch: 'https://images-api.nasa.gov/search'
};

export const WIKIPEDIA_ON_THIS_DAY_API = 'https://es.wikipedia.org/api/rest_v1/feed/onthisday';
