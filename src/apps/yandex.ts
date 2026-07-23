import axios from 'axios';
import * as cheerio from 'cheerio';

export interface YandexTrackResult {
  title: string;
  artists: string;
  album?: string;
  thumbnail?: string;
}

/**
 * Scrapes metadata (title, artist, album, cover image) from Yandex Music track page.
 */
export async function scrapeYandexMetadata(url: string): Promise<YandexTrackResult> {
  // Replace music.yandex.com with music.yandex.ru for consistent crawling
  const targetUrl = url.replace('music.yandex.com', 'music.yandex.ru');

  const response = await axios.get(targetUrl, {
    headers: {
      'User-Agent': 'TelegramBot (like TwitterBot)',
      'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7'
    },
    timeout: 10000
  });

  const $ = cheerio.load(response.data);
  const jsonLdScript = $('script[type="application/ld+json"]').html();

  if (jsonLdScript) {
    try {
      const data = JSON.parse(jsonLdScript);
      const title = data.name || data.tracks?.[0]?.name || 'Unknown Title';
      const artists = data.byArtist?.name || data.author?.name || 'Unknown Artist';
      const album = data.inAlbum?.name || undefined;
      let thumbnail = data.thumbnailUrl || data.image;

      if (thumbnail && thumbnail.startsWith('//')) {
        thumbnail = `https:${thumbnail}`;
      }

      return { title, artists, album, thumbnail };
    } catch (e) {
      console.warn('Failed to parse Yandex JSON-LD:', e);
    }
  }

  // Fallback to meta tags
  const title = $('meta[property="og:title"]').attr('content') || $('title').text() || 'Yandex Track';
  const desc = $('meta[property="og:description"]').attr('content') || '';
  const thumbnail = $('meta[property="og:image"]').attr('content');

  return {
    title,
    artists: desc || 'Yandex Music',
    thumbnail
  };
}

export default {
  name: 'yandex',
  domains: ['music.yandex.ru', 'music.yandex.com', 'music.yandex.by', 'music.yandex.kz'],
  download: scrapeYandexMetadata
};

