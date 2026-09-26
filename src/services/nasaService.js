import axios from 'axios';
import dotenv from 'dotenv';
import { NASA_ENDPOINTS } from '../config/feeds.js';

dotenv.config();

const API_KEY = process.env.NASA_API_KEY || 'DEMO_KEY';

export async function fetchNasaAPOD() {
  try {
    const response = await axios.get(NASA_ENDPOINTS.apod, {
      params: { api_key: API_KEY }
    });
    return {
      title: response.data.title,
      explanation: response.data.explanation,
      date: response.data.date,
      url: response.data.url,
      hdurl: response.data.hdurl,
      mediaType: response.data.media_type
    };
  } catch (error) {
    console.error(`⚠️ Error al obtener NASA APOD: ${error.message}`);
    return null;
  }
}

export async function searchNasaMedia(query) {
  try {
    const response = await axios.get(NASA_ENDPOINTS.mediaSearch, {
      params: { q: query, media_type: 'image,video' }
    });
    const items = response.data.collection.items.slice(0, 5);
    return items.map(item => ({
      title: item.data[0]?.title,
      description: item.data[0]?.description,
      nasaId: item.data[0]?.nasa_id,
      preview: item.links?.[0]?.href
    }));
  } catch (error) {
    console.error(`⚠️ Error buscando en NASA Media Library: ${error.message}`);
    return [];
  }
}
