// Fuentes RSS de ciencia, astronomía, tecnología, medicina, videojuegos y medio ambiente.
//
// ESTRATEGIA (corregida tras un bloqueo de Google News en producción):
//
//   · Fuentes PROPIAS en español como base. El 02/10/2026 los 19 feeds de
//     Google News empezaron a devolver 503 todos a la vez desde Cloud Run (su IP
//     de salida es compartida y Google News la bloquea) y la app se quedó sin
//     noticias. Por eso ahora la base son medios españoles directos.
//   · Las consultas de Google News se mantienen al final porque cuando NO están
//     bloqueadas aportan mucho volumen por categoría. Con el circuit breaker, si
//     fallan no ralentizan nada ni rompen la carga.
//
// Todas las fuentes propias fueron verificadas con HTTP 200 y artículos reales.
export const RSS_FEEDS = [
  // ─── BASE: fuentes propias en español, SECCIONES de ciencia/salud/tecno ───
  { name: 'RTVE Ciencia', url: 'https://api2.rtve.es/rss/temas_ciencia.xml', category: 'ciencia' },
  { name: 'RTVE Salud', url: 'https://api2.rtve.es/rss/temas_salud.xml', category: 'medicina' },
  { name: 'La Vanguardia - Ciencia', url: 'https://www.lavanguardia.com/rss/ciencia.xml', category: 'ciencia' },
  { name: 'La Vanguardia - Salud', url: 'https://www.lavanguardia.com/rss/salud.xml', category: 'medicina' },
  { name: 'La Vanguardia - Economía', url: 'https://www.lavanguardia.com/rss/economia.xml', category: 'tecnologia' },
  { name: 'La Vanguardia - Sociedad', url: 'https://www.lavanguardia.com/rss/sociedad.xml', category: 'medio_ambiente' },
  { name: 'elDiario.es - Ciencia', url: 'https://www.eldiario.es/rss/ciencia/', category: 'ciencia' },
  { name: 'ABC - Ciencia', url: 'https://www.abc.es/rss/2.0/ciencia/', category: 'astronomia' },
  { name: '20minutos - Tecnología', url: 'https://www.20minutos.es/rss/tecnologia/', category: 'tecnologia' },
  { name: 'Xataka Ciencia', url: 'https://www.xatakaciencia.com/index.xml', category: 'ciencia' },
  { name: 'Xataka - Tecnología', url: 'https://www.xataka.com/index.xml', category: 'tecnologia' },
  { name: 'ESA (Agencia Espacial Europea)', url: 'https://www.esa.int/rssfeed/Spain', category: 'astronomia' },

  // ─── Google News: volumen por categoría cuando NO está bloqueado ─────────
  { name: 'Google News - Astronomía', url: 'https://news.google.com/rss/search?q=astronomia+telescopio+espacio+nasa&hl=es-419&gl=MX&ceid=MX:es-419', category: 'astronomia' },
  { name: 'Google News - Planetas y Misiones', url: 'https://news.google.com/rss/search?q=exoplaneta+marte+lunar+telescopio+espacial+sonda+when:30d&hl=es-419&gl=MX&ceid=MX:es-419', category: 'astronomia' },
  { name: 'Google News - Lanzamientos Espaciales', url: 'https://news.google.com/rss/search?q=sonda+espacial+lanzamiento+cohete+orbita&hl=es-419&gl=MX&ceid=MX:es-419', category: 'astronomia' },
  { name: 'Google News - Física', url: 'https://news.google.com/rss/search?q=fisica+cuantica+teoria+relatividad&hl=es-419&gl=MX&ceid=MX:es-419', category: 'ciencia' },
  { name: 'Google News - Biología y Genética', url: 'https://news.google.com/rss/search?q=biologia+genetica+evolucion+especie&hl=es-419&gl=MX&ceid=MX:es-419', category: 'ciencia' },
  { name: 'Google News - Descubrimientos', url: 'https://news.google.com/rss/search?q=descubrimiento+cientifico+investigadores+estudio+fisica+biologia+when:30d&hl=es-419&gl=MX&ceid=MX:es-419', category: 'ciencia' },
  { name: 'Google News - Arqueología y Fósiles', url: 'https://news.google.com/rss/search?q=arqueologia+fossil+paleontologia+prehistoria&hl=es-419&gl=MX&ceid=MX:es-419', category: 'ciencia' },
  { name: 'Google News - Inteligencia Artificial', url: 'https://news.google.com/rss/search?q=inteligencia+artificial+robotica+innovacion+tecnologia+when:30d&hl=es-419&gl=MX&ceid=MX:es-419', category: 'tecnologia' },
  { name: 'Google News - Apps y Gadgets', url: 'https://news.google.com/rss/search?q=inteligencia+artificial+chatgpt+robot&hl=es-419&gl=MX&ceid=MX:es-419', category: 'tecnologia' },
  { name: 'Google News - Salud y Medicina', url: 'https://news.google.com/rss/search?q=salud+medicina+tratamiento+cancer&hl=es-419&gl=MX&ceid=MX:es-419', category: 'medicina' },
  { name: 'Google News - Tratamientos', url: 'https://news.google.com/rss/search?q=medicina+salud+descubrimiento+medico+tratamiento+when:30d&hl=es-419&gl=MX&ceid=MX:es-419', category: 'medicina' },
  { name: 'Google News - Corazón y Diabetes', url: 'https://news.google.com/rss/search?q=corazon+diabetes+obesidad+riesgo+salud&hl=es-419&gl=MX&ceid=MX:es-419', category: 'medicina' },
  { name: 'Google News - Videojuegos', url: 'https://news.google.com/rss/search?q=videojuegos+gaming+consola+juego+when:30d&hl=es-419&gl=MX&ceid=MX:es-419', category: 'videojuegos' },
  { name: 'Google News - Consolas', url: 'https://news.google.com/rss/search?q=ps5+xbox+nintendo+switch+consola+when:30d&hl=es-419&gl=MX&ceid=MX:es-419', category: 'videojuegos' },
  { name: 'Google News - Indies y Desarrollo', url: 'https://news.google.com/rss/search?q=videojuego+indie+estudio+desarrollo+gameplay+when:30d&hl=es-419&gl=MX&ceid=MX:es-419', category: 'videojuegos' },
  { name: 'Google News - Medio Ambiente', url: 'https://news.google.com/rss/search?q=medio+ambiente+cambio+climatico+naturaleza+when:30d&hl=es-419&gl=MX&ceid=MX:es-419', category: 'medio_ambiente' },
  { name: 'Google News - Clima y Catástrofes', url: 'https://news.google.com/rss/search?q=clima+sequia+inundacion+contaminacion+emisiones+when:30d&hl=es-419&gl=MX&ceid=MX:es-419', category: 'medio_ambiente' },
  { name: 'Google News - Energía Renovable', url: 'https://news.google.com/rss/search?q=energia+renovable+solar+eolica+electrica&hl=es-419&gl=MX&ceid=MX:es-419', category: 'medio_ambiente' }
];

export const NASA_ENDPOINTS = {
  apod: 'https://api.nasa.gov/planetary/apod',
  neoWs: 'https://api.nasa.gov/neo/rest/v1/feed',
  mediaSearch: 'https://images-api.nasa.gov/search'
};

export const WIKIPEDIA_ON_THIS_DAY_API = 'https://es.wikipedia.org/api/rest_v1/feed/onthisday';

// Categorías disponibles para filtrar
export const NEWS_CATEGORIES = [
  { id: 'todas', name: 'Todas', icon: '📰' },
  { id: 'astronomia', name: 'Astronomía', icon: '🌌' },
  { id: 'ciencia', name: 'Ciencia', icon: '🔬' },
  { id: 'tecnologia', name: 'Tecnología', icon: '💻' },
  { id: 'medicina', name: 'Medicina', icon: '🏥' },
  { id: 'videojuegos', name: 'Videojuegos', icon: '🎮' },
  { id: 'medio_ambiente', name: 'Medio Ambiente', icon: '🌍' }
];