import Parser from 'rss-parser';
import { RSS_FEEDS } from '../config/feeds.js';

const parser = new Parser({
  customFields: {
    item: ['description', 'pubDate', 'guid']
  }
});

export async function fetchAllNews() {
  const allArticles = [];
  const now = Date.now();
  const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 días

  for (const feed of RSS_FEEDS) {
    try {
      const parsed = await parser.parseURL(feed.url);
      const items = (parsed.items || []).slice(0, 15).map(item => {
        const rawDate = item.pubDate || item.isoDate || item.date;
        const parsedDate = rawDate ? new Date(rawDate) : new Date();
        const timestamp = isNaN(parsedDate.getTime()) ? now : parsedDate.getTime();
        
        return {
          title: item.title?.replace(/ - .*$/, '').trim() || 'Sin título',
          source: item.title?.split(' - ').pop() || feed.name,
          link: item.link,
          timestamp,
          pubDate: formatRelativeDate(timestamp),
          category: feed.category,
          feedName: feed.name,
          snippet: item.contentSnippet || item.content || ''
        };
      });

      // Filtrar noticias con máximo 30 días de antigüedad
      const recentItems = items.filter(item => (now - item.timestamp) <= MAX_AGE_MS && (item.timestamp <= now + 86400000));
      allArticles.push(...recentItems);
    } catch (error) {
      console.error(`⚠️ Error al leer ${feed.name}: ${error.message}`);
    }
  }

  // Eliminar duplicados por título
  const uniqueArticles = [];
  const titles = new Set();
  for (const art of allArticles) {
    const key = art.title.toLowerCase().trim();
    if (!titles.has(key)) {
      titles.add(key);
      uniqueArticles.push(art);
    }
  }

  // Ordenar estrictamente de la MÁS RECIENTE a la MÁS ANTIGUA
  uniqueArticles.sort((a, b) => b.timestamp - a.timestamp);

  return uniqueArticles;
}

function formatRelativeDate(timestamp) {
  const diffHours = Math.floor((Date.now() - timestamp) / (1000 * 60 * 60));
  const diffDays = Math.floor(diffHours / 24);
  const dateObj = new Date(timestamp);
  const formattedDate = dateObj.toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' });

  if (diffHours < 1) return '⚡ Hace unos momentos';
  if (diffHours < 24) return `🕒 Hace ${diffHours} h (${formattedDate})`;
  if (diffDays === 1) return `📅 Ayer (${formattedDate})`;
  if (diffDays <= 30) return `📅 Hace ${diffDays} días (${formattedDate})`;
  return formattedDate;
}

