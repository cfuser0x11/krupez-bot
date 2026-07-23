import axios from 'axios';
import { load } from 'cheerio';
import * as fs from 'fs';
import * as path from 'path';
import { downloadVideo } from '../engine';

export interface OkruResult {
  isVideo: boolean;
  localPath?: string;
  imagePaths?: string[];
  title?: string;
}

const chromeAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export async function downloadOkru(url: string, outputDir: string): Promise<OkruResult> {
  const cleanUrl = url.trim();

  // 1. OK.ru Clip & Video Link Extraction
  if (cleanUrl.includes('/clip/') || cleanUrl.includes('/video/') || cleanUrl.includes('/videoembed/')) {
    try {
      const pageRes = await axios.get(cleanUrl, {
        headers: {
          'user-agent': chromeAgent,
          'accept-language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7'
        },
        timeout: 10000
      });

      const $ = load(pageRes.data);
      const title = $('meta[property="og:title"]').attr('content') || $('title').text();
      let metadataUrl = '';

      $('[data-options]').each((_, el) => {
        const raw = $(el).attr('data-options');
        if (!raw || metadataUrl) return;
        try {
          const json = JSON.parse(raw);
          if (json.flashvars?.metadataUrl) {
            metadataUrl = decodeURIComponent(json.flashvars.metadataUrl);
          }
        } catch (e) {}
      });

      if (!metadataUrl) {
        const match = pageRes.data.match(/https?%3A%2F%2Fok\.ru%2Fdk%3Fcmd%3DvideoPlayerMetadata[^\s"'\\]+/gi) ||
                      pageRes.data.match(/https:\/\/ok\.ru\/dk\?cmd=videoPlayerMetadata[^\s"'\\]+/gi);
        if (match) metadataUrl = decodeURIComponent(match[0]);
      }

      if (metadataUrl) {
        const metaRes = await axios.post(metadataUrl, '', {
          headers: { 'user-agent': chromeAgent }
        });

        const videos = metaRes.data?.videos || [];
        const priority = ['full', '1080', '720', 'hd', 'sd', 'low', 'lowest', 'mobile'];
        let bestUrl = '';

        for (const p of priority) {
          const match = videos.find((v: any) => v.name === p || (v.name && v.name.includes(p)));
          if (match && match.url) {
            bestUrl = match.url;
            break;
          }
        }

        if (!bestUrl && videos.length > 0) bestUrl = videos[videos.length - 1].url;

        if (bestUrl) {
          const filePath = path.join(outputDir, `ok_clip_${Date.now()}.mp4`);
          const writer = fs.createWriteStream(filePath);
          const streamRes = await axios({
            url: bestUrl,
            method: 'GET',
            responseType: 'stream',
            headers: {
              'user-agent': chromeAgent,
              'referer': 'https://ok.ru/'
            }
          });

          await new Promise<void>((resolve, reject) => {
            streamRes.data.pipe(writer);
            writer.on('finish', resolve);
            writer.on('error', reject);
          });

          if (fs.existsSync(filePath) && fs.statSync(filePath).size > 1000) {
            return { isVideo: true, localPath: filePath, title };
          }
        }
      }
    } catch (e: any) {
      console.warn('[downloadOkru] Clip video extraction failed, falling back:', e?.message || e);
    }
  }

  // 2. OK.ru Topic / Group Post / Photo post extraction
  if (cleanUrl.includes('/topic/') || cleanUrl.includes('/post/') || cleanUrl.includes('/group/')) {
    try {
      const mobileUrl = cleanUrl.replace('ok.ru', 'm.ok.ru');
      const res = await axios.get(mobileUrl, {
        headers: {
          'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
          'accept-language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7'
        },
        timeout: 10000
      });

      const $ = load(res.data);
      const title = $('meta[property="og:title"]').attr('content') || $('title').text();
      const ogVideo = $('meta[property="og:video"]').attr('content') || $('meta[property="og:video:url"]').attr('content');

      if (ogVideo) {
        try {
          const dlPath = await downloadVideo({ url: ogVideo, outputDir });
          if (dlPath && fs.existsSync(dlPath)) {
            return { isVideo: true, localPath: dlPath, title };
          }
        } catch (e) {}
      }

      const photoUrls: string[] = [];

      $('.media-photos_img, .media_img, img.photo_img, .collage_i img, .media-text_media img, .image_inner_img').each((_, el) => {
        const src = $(el).attr('src') || $(el).attr('data-src');
        const parentCls = $(el).parent().attr('class') || '';
        if (
          src &&
          src.includes('okcdn.ru') &&
          !src.includes('emoji') &&
          !src.includes('holder') &&
          !src.includes('ava') &&
          !src.includes('logo') &&
          !parentCls.includes('ava') &&
          !parentCls.includes('logo')
        ) {
          if (!photoUrls.includes(src)) photoUrls.push(src);
        }
      });

      if (photoUrls.length > 0) {
        const downloadedPaths: string[] = [];
        for (let i = 0; i < photoUrls.length; i++) {
          try {
            const imgUrl = photoUrls[i];
            const filePath = path.join(outputDir, `ok_photo_${Date.now()}_${i + 1}.jpg`);
            const imgRes = await axios.get(imgUrl, { responseType: 'arraybuffer', timeout: 15000 });
            fs.writeFileSync(filePath, imgRes.data);
            if (fs.existsSync(filePath) && fs.statSync(filePath).size > 1000) {
              downloadedPaths.push(filePath);
            }
          } catch (e) {}
        }

        if (downloadedPaths.length === 1) {
          return { isVideo: false, localPath: downloadedPaths[0], title };
        } else if (downloadedPaths.length > 1) {
          return { isVideo: false, localPath: downloadedPaths[0], imagePaths: downloadedPaths, title };
        }
      }
    } catch (e: any) {
      console.warn('[downloadOkru] Topic extraction failed:', e?.message || e);
    }
  }

  // 3. Fallback try yt-dlp first for OK.ru Video
  try {
    const dlPath = await downloadVideo({ url: cleanUrl, outputDir });
    if (dlPath && fs.existsSync(dlPath)) {
      return { isVideo: true, localPath: dlPath };
    }
  } catch (e: any) {
    console.warn('[downloadOkru] yt-dlp video download failed:', e?.message || e);
  }

  throw new Error('OK.ru download failed');
}

export default {
  name: 'okru',
  domains: ['ok.ru'],
  download: downloadOkru
};
