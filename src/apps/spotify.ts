import axios from 'axios';
import { load } from 'cheerio';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { AppDownloadResult } from './index';
import { downloadMedia, resizeThumbnailTo320, embedCoverToMp3, FFMPEG_PATH } from '../engine';

export interface SpotifyTrackResult {
  title: string;
  artists: string[];
  album?: string;
  thumbnail?: string;
  mediaUrl?: string;
}

const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function parseMetadata(downloadData: any, metaData: any) {
  const downloadLinks: any[] = [];
  if (downloadData.type === 'track') {
    downloadData.album = metaData.album?.name || metaData.name;
    downloadData.thumbnail = metaData.album?.images?.[0]?.url || metaData.image || metaData.cover;
    downloadLinks.push({
      mediaUrl: metaData.external_urls?.spotify || metaData.id || metaData.url
    });
  }
  return downloadLinks;
}

const mobileUserAgent = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

function normalizePodcastStr(str: string): string {
  return (str || '').replace(/[\u00a0\s]+/g, ' ').replace(/[^\w\sа-яА-ЯёЁ]/g, '').toLowerCase().trim();
}

async function resolvePodcastRssMp3(podcastName: string, episodeTitle: string): Promise<string | null> {
  try {
    const searchUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(podcastName)}&entity=podcast&limit=5`;
    const { data } = await axios.get(searchUrl, { timeout: 7000 });
    const results = data?.results || [];

    for (const res of results) {
      const feedUrl = res?.feedUrl;
      if (!feedUrl) continue;

      try {
        const { data: xml } = await axios.get(feedUrl, { timeout: 10000 });
        const $ = load(xml, { xmlMode: true });
        let matchedEnclosure: string | null = null;

        const normTarget = normalizePodcastStr(episodeTitle);
        const searchPrefix = normTarget.slice(0, 25);

        $('item').each((_, elem) => {
          const itemTitle = $(elem).find('title').text();
          const normItem = normalizePodcastStr(itemTitle);
          if (searchPrefix && (normItem.includes(searchPrefix) || normTarget.includes(normItem.slice(0, 25)))) {
            const enclosure = $(elem).find('enclosure').attr('url');
            if (enclosure) {
              matchedEnclosure = enclosure;
              return false;
            }
          }
        });

        if (matchedEnclosure) {
          console.log(`[resolvePodcastRssMp3] Found direct podcast MP3 from RSS: ${matchedEnclosure}`);
          return matchedEnclosure;
        }
      } catch (feedErr) {
        console.warn(`[resolvePodcastRssMp3] Error parsing feed ${feedUrl}:`, feedErr);
      }
    }
  } catch (err) {
    console.warn('[resolvePodcastRssMp3] Error searching iTunes podcast API:', err);
  }

  return null;
}

async function fetchSpotifyEpisodeEmbed(spotifyUrl: string): Promise<SpotifyTrackResult> {
  const episodeIdMatch = spotifyUrl.match(/episode\/([A-Za-z0-9]+)/);
  if (!episodeIdMatch) throw new Error('Not an episode URL');
  const episodeId = episodeIdMatch[1];
  const embedUrl = `https://open.spotify.com/embed/episode/${episodeId}`;

  const { data: html } = await axios.get(embedUrl, {
    headers: { 'User-Agent': mobileUserAgent },
    timeout: 10000
  });

  let title = 'Spotify Episode';
  let artists: string[] = ['Podcast'];
  let thumbnail: string | undefined;

  try {
    const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([^<]+)<\/script>/);
    if (nextDataMatch) {
      const jsonData = JSON.parse(nextDataMatch[1]);
      const entity = jsonData?.props?.pageProps?.state?.data?.entity;
      if (entity) {
        if (entity.title || entity.name) title = entity.title || entity.name;
        if (entity.subtitle) artists = [entity.subtitle];
        if (Array.isArray(entity.relatedEntityCoverArt) && entity.relatedEntityCoverArt.length > 0) {
          thumbnail = entity.relatedEntityCoverArt[0].url;
        }
      }
    }
  } catch (e) {
    console.warn('[downloadSpotify] Failed to parse NEXT_DATA for episode:', e);
  }

  const podcastName = artists[0] || '';
  const rssMp3Url = await resolvePodcastRssMp3(podcastName, title);

  return {
    title,
    artists,
    album: podcastName || 'Podcast',
    thumbnail,
    mediaUrl: rssMp3Url || undefined
  };
}

const SpotifyServers = {
  // 0. Spotify Embed scraper (for episodes/podcasts)
  spotifyEmbedEpisode: async (spotifyUrl: string): Promise<SpotifyTrackResult> => {
    return await fetchSpotifyEpisodeEmbed(spotifyUrl);
  },

  // 1. spotmate server (spotmate.online)
  spotmate: async (spotifyUrl: string): Promise<SpotifyTrackResult> => {
    const baseUrl = 'https://spotmate.online';
    const { headers, data: html } = await axios.get(baseUrl, { timeout: 7000, headers: { 'User-Agent': userAgent } });
    const $ = load(html);
    const token = $('[name="csrf-token"]').attr('content');
    const newHeaders = {
      'X-CSRF-TOKEN': token,
      Cookie: headers['set-cookie']?.join(';'),
      'Content-Type': 'application/json',
      'User-Agent': userAgent
    };
    const { data: metaData } = await axios({
      method: 'post',
      url: `${baseUrl}/getTrackData`,
      data: { spotify_url: spotifyUrl },
      headers: newHeaders,
      timeout: 7000
    });
    const result: any = {
      title: metaData.name,
      type: metaData.type,
      artists: metaData.artists?.map((v: any) => v.name) || ['Unknown']
    };
    const downloadLinks = parseMetadata(result, metaData);
    if (downloadLinks.length > 0) {
      const track = downloadLinks[0];
      const { data } = await axios({
        method: 'post',
        url: `${baseUrl}/convert`,
        data: { urls: track.mediaUrl },
        headers: newHeaders,
        timeout: 10000
      });
      const mediaUrl = data.error ? data.data : (data.url || data.file_url);
      if (mediaUrl && typeof mediaUrl === 'string' && mediaUrl.startsWith('http')) {
        return {
          title: result.title,
          artists: result.artists,
          album: result.album,
          thumbnail: result.thumbnail,
          mediaUrl
        };
      }
    }
    throw new Error('spotmate failed');
  },

  // 2. spotisongdownloader server (spotisongdownloader.com)
  spotisongdownloader: async (spotifyUrl: string): Promise<SpotifyTrackResult> => {
    const baseUrl = 'https://spotisongdownloader.com';
    const { data: json } = await axios({
      method: 'POST',
      url: `${baseUrl}/api/composer/spotify/details`,
      data: { url: spotifyUrl },
      headers: { 'User-Agent': userAgent },
      timeout: 7000
    });
    if (json?.apiResponse?.data?.[0]) {
      const item = json.apiResponse.data[0];
      const { data } = await axios({
        method: 'POST',
        url: `${baseUrl}/api/download-track`,
        data: { url: item.url },
        headers: { 'User-Agent': userAgent },
        timeout: 10000
      });
      if (data?.file_url) {
        return {
          title: item.name,
          album: item.album,
          artists: item.artist ? item.artist.split(', ') : ['Unknown'],
          thumbnail: item.cover_url,
          mediaUrl: data.file_url
        };
      }
    }
    throw new Error('spotisongdownloader failed');
  },

  // 3. fabdl server (api.fabdl.com)
  fabdl: async (spotifyUrl: string): Promise<SpotifyTrackResult> => {
    const baseUrl = 'https://api.fabdl.com';
    const { data } = await axios({
      url: `${baseUrl}/spotify/get`,
      params: { url: spotifyUrl },
      headers: { 'User-Agent': userAgent },
      timeout: 7000
    });
    if (data.error) throw new Error(data.error.message);
    const { result: metaData } = data;
    const result: any = {
      title: metaData.name,
      type: metaData.type,
      artists: [metaData.artists]
    };
    const downloadLinks = parseMetadata(result, metaData);
    if (downloadLinks.length > 0) {
      const track = downloadLinks[0];
      let { data: taskData } = await axios({
        url: `${baseUrl}/spotify/mp3-convert-task/${metaData.gid}/${track.mediaUrl}`,
        headers: { 'User-Agent': userAgent },
        timeout: 7000
      });
      let downloadMediaUrl;
      while (!downloadMediaUrl) {
        if (taskData.error) {
          downloadMediaUrl = taskData.data || taskData.error.message;
        } else if (taskData.url || taskData.result?.download_url) {
          downloadMediaUrl = taskData.url || `${baseUrl}${taskData.result.download_url}`;
        } else {
          await new Promise((resolve) => setTimeout(resolve, 500));
          const { data: json } = await axios.get(`${baseUrl}/spotify/mp3-convert-progress/${taskData.result?.tid}`, { timeout: 7000 });
          taskData = json;
        }
      }
      if (downloadMediaUrl && downloadMediaUrl.startsWith('http')) {
        return {
          title: result.title,
          artists: result.artists,
          album: result.album,
          thumbnail: result.thumbnail,
          mediaUrl: downloadMediaUrl
        };
      }
    }
    throw new Error('fabdl failed');
  }
};

export async function downloadSpotify(
  spotifyUrl: string,
  outputDir: string,
  options?: { quality?: string }
): Promise<AppDownloadResult> {
  const pathParams = spotifyUrl.match(/(track|album|playlist|episode|show)\/[A-Za-z0-9]+/)?.[0];
  if (!pathParams) throw new Error('Invalid Spotify URL');
  const cleanSpotifyUrl = `https://open.spotify.com/${pathParams}`;
  const isEpisode = pathParams.startsWith('episode') || pathParams.startsWith('show');

  let trackMeta: SpotifyTrackResult | null = null;

  // Try direct Spotify conversion servers in parallel
  const promises = Object.keys(SpotifyServers).map(async (sName) => {
    try {
      const res = await (SpotifyServers as any)[sName](cleanSpotifyUrl);
      if (res && res.mediaUrl) {
        console.log(`[downloadSpotify] Succeeded via Spotify server: ${sName}`);
        return res;
      }
    } catch (e: any) {
      console.warn(`[downloadSpotify] Server ${sName} failed:`, e?.message || e);
    }
    throw new Error(`${sName} failed`);
  });

  try {
    trackMeta = await Promise.any(promises);
  } catch (e) {
    console.warn('[downloadSpotify] All parallel Spotify conversion servers failed');
  }

  const safeTitle = (trackMeta?.title || 'spotify_track').replace(/[\/\\?%*:|"<>]/g, '_');
  const artistsStr = Array.isArray(trackMeta?.artists) ? trackMeta!.artists.join(', ') : (trackMeta?.artists || 'Unknown Artist');
  const fileName = `${safeTitle}.mp3`;
  const filePath = path.join(outputDir, fileName);

  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  let downloadedSuccessfully = false;

  // 1. Download direct Spotify audio stream
  if (trackMeta && trackMeta.mediaUrl) {
    const rawPath = path.join(outputDir, `.raw_spotify_${Date.now()}`);
    try {
      const writer = fs.createWriteStream(rawPath);
      const res = await axios({
        url: trackMeta.mediaUrl,
        method: 'GET',
        responseType: 'stream',
        headers: { 'User-Agent': userAgent },
        timeout: 60000
      });

      await new Promise<void>((resolve, reject) => {
        res.data.pipe(writer);
        writer.on('finish', resolve);
        writer.on('error', reject);
      });

      if (fs.existsSync(rawPath) && fs.statSync(rawPath).size > 1000) {
        // Convert raw audio stream (which might be MP4/AAC container) to proper MP3 format for Telegram
        try {
          execFileSync(FFMPEG_PATH, [
            '-y',
            '-i', rawPath,
            '-vn',
            '-c:a', 'libmp3lame',
            '-q:a', '2',
            filePath
          ], { stdio: ['ignore', 'ignore', 'ignore'] });

          if (fs.existsSync(filePath) && fs.statSync(filePath).size > 1000) {
            downloadedSuccessfully = true;
          }
        } catch (convErr) {
          console.warn('[downloadSpotify] ffmpeg mp3 conversion failed, fallback to raw copy:', convErr);
          fs.copyFileSync(rawPath, filePath);
          if (fs.existsSync(filePath) && fs.statSync(filePath).size > 1000) {
            downloadedSuccessfully = true;
          }
        }
      }
    } catch (e: any) {
      console.warn('[downloadSpotify] Direct MP3 stream download failed:', e?.message || e);
    } finally {
      if (fs.existsSync(rawPath)) {
        try { fs.unlinkSync(rawPath); } catch {}
      }
    }
  }

  // 2. Fallback to audio search if direct Spotify servers failed
  if (!downloadedSuccessfully) {
    const audioQuality = options?.quality || 'high';
    const query = `ytsearch1:${trackMeta?.title || safeTitle} ${artistsStr} audio`.trim();
    const downloadedPath = await downloadMedia({
      url: query,
      format: 'mp3',
      outputDir,
      quality: audioQuality
    });

    if (downloadedPath && fs.existsSync(downloadedPath)) {
      if (path.resolve(downloadedPath) !== path.resolve(filePath)) {
        fs.copyFileSync(downloadedPath, filePath);
        try { fs.unlinkSync(downloadedPath); } catch {}
      }
      downloadedSuccessfully = true;
    }
  }

  if (!downloadedSuccessfully || !fs.existsSync(filePath)) {
    throw new Error('Could not download Spotify audio track');
  }

  let thumbPath: string | undefined;
  if (trackMeta?.thumbnail) {
    try {
      const rawThumb = path.join(outputDir, `.thumb_spotify_${Date.now()}.jpg`);
      const thumbWriter = fs.createWriteStream(rawThumb);
      const thumbRes = await axios({ url: trackMeta.thumbnail, method: 'GET', responseType: 'stream', timeout: 10000 });
      await new Promise<void>((resolve, reject) => {
        thumbRes.data.pipe(thumbWriter);
        thumbWriter.on('finish', resolve);
        thumbWriter.on('error', reject);
      });
      thumbPath = resizeThumbnailTo320(rawThumb);
      if (rawThumb !== thumbPath && fs.existsSync(rawThumb)) {
        try { fs.unlinkSync(rawThumb); } catch {}
      }
    } catch (e) {}
  }

  if (thumbPath && fs.existsSync(thumbPath)) {
    embedCoverToMp3(filePath, thumbPath, trackMeta?.title || safeTitle, artistsStr);
  }

  return {
    isVideo: false,
    isAudio: true,
    localPath: filePath,
    title: trackMeta?.title || safeTitle,
    artists: artistsStr,
    album: trackMeta?.album || 'Spotify',
    thumbPath
  };
}

export default {
  name: 'spotify',
  domains: ['spotify.com', 'open.spotify.com'],
  download: downloadSpotify
};
