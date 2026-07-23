import axios from 'axios';
import { load } from 'cheerio';
import * as fs from 'fs';
import * as path from 'path';
import { downloadVideo } from '../engine';

export interface VkResult {
  isVideo: boolean;
  localPath?: string;
  imagePaths?: string[];
  title?: string;
}

const vkAgent = 'com.vk.vkvideo.prod/1955 (iPhone, iOS 16.7.15, iPhone10,4, Scale/2.0) SAK/1.135';

async function getAnonymToken(): Promise<string | null> {
  try {
    const deviceId = require('crypto').randomUUID().toUpperCase();
    const tokenRes = await axios.get('https://api.vk.ru/method/auth.getAnonymToken', {
      params: {
        client_id: '51552953',
        client_secret: 'qgr0yWwXCrsxA1jnRtRX',
        device_id: deviceId,
        v: '5.274'
      },
      headers: { 'user-agent': vkAgent },
      timeout: 7000
    });
    return tokenRes.data?.response?.token || null;
  } catch (e) {
    return null;
  }
}

export async function downloadVk(url: string, outputDir: string): Promise<VkResult> {
  const cleanUrl = url.trim();
  const isAudioLink = cleanUrl.includes('/audio') || cleanUrl.includes('audio-');
  const photoMatch = cleanUrl.match(/photo(-?\d+_\d+)/);
  const wallMatch = cleanUrl.match(/wall(-?\d+_\d+)/);

  // 1. VK Wall Post extraction via official VK API
  if (wallMatch) {
    try {
      const token = await getAnonymToken();
      if (token) {
        const postId = wallMatch[1];
        const res = await axios.get('https://api.vk.com/method/wall.getById', {
          params: { posts: postId, access_token: token, v: '5.274' },
          headers: { 'user-agent': vkAgent },
          timeout: 10000
        });

        const postItem = res.data?.response?.items?.[0] || res.data?.response?.[0];
        if (postItem && Array.isArray(postItem.attachments)) {
          const photoUrls: string[] = [];
          for (const att of postItem.attachments) {
            if (att.type === 'photo' && att.photo) {
              const orig = att.photo.orig_photo?.url;
              const sizes = att.photo.sizes || [];
              const sorted = sizes.slice().sort((a: any, b: any) => ((b.width || 0) * (b.height || 0)) - ((a.width || 0) * (a.height || 0)));
              const bestUrl = orig || sorted[0]?.url;
              if (bestUrl) photoUrls.push(bestUrl);
            }
          }

          if (photoUrls.length > 0) {
            const downloadedPaths: string[] = [];
            for (let i = 0; i < photoUrls.length; i++) {
              try {
                const imgUrl = photoUrls[i];
                const filePath = path.join(outputDir, `vk_wall_${Date.now()}_${i + 1}.jpg`);
                const imgRes = await axios.get(imgUrl, { responseType: 'arraybuffer', timeout: 15000 });
                fs.writeFileSync(filePath, imgRes.data);
                if (fs.existsSync(filePath) && fs.statSync(filePath).size > 1000) {
                  downloadedPaths.push(filePath);
                }
              } catch (e) {}
            }

            if (downloadedPaths.length === 1) {
              return { isVideo: false, localPath: downloadedPaths[0] };
            } else if (downloadedPaths.length > 1) {
              return { isVideo: false, localPath: downloadedPaths[0], imagePaths: downloadedPaths };
            }
          }
        }
      }
    } catch (e: any) {
      console.warn('[downloadVk] API Wall extraction failed, falling back to HTML scraper:', e?.message || e);
    }
  }

  // 2. VK Photo Viewer / Single Photo Scraping
  if (photoMatch || cleanUrl.includes('/photo') || cleanUrl.includes('z=photo')) {
    try {
      const photoId = photoMatch ? photoMatch[1] : '';
      const targetUrl = photoId ? `https://vk.com/photo${photoId}` : cleanUrl.replace('vk.ru', 'vk.com');

      const res = await axios.get(targetUrl, {
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'accept-language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7'
        },
        timeout: 10000
      });

      const $ = load(res.data);
      let imageUrl = $('meta[property="og:image"]').attr('content') ||
                     $('meta[name="twitter:image"]').attr('content') ||
                     $('.pv_img img').attr('src') ||
                     $('img.PhotoPage__image').attr('src');

      if (!imageUrl) {
        const matches = res.data.match(/https?:\\\/\\\/[^\s"'\\]+?\.(?:jpg|png|jpeg)[^\s"'\\]*/gi) ||
                        res.data.match(/https?:\/\/[^\s"'\\]+?\.(?:jpg|png|jpeg)[^\s"'\\]*/gi) || [];
        const cleaned: string[] = Array.from(new Set(matches.map((u: string) => u.replace(/\\/g, '').replace(/&amp;/g, '&').split('"')[0].split("'")[0])));
        const validPhotos = cleaned.filter((u: string) =>
          !u.includes('logo') &&
          !u.includes('icon') &&
          !u.includes('browser') &&
          !u.includes('camera') &&
          !u.includes('avatar') &&
          !u.includes('crop=') &&
          !u.includes('deactivated') &&
          (u.includes('vkuserphoto') || u.includes('userapi') || u.includes('/ig2/'))
        );
        if (validPhotos.length > 0) {
          imageUrl = validPhotos.find((u: string) => u.includes('quality=95') || u.includes('cs=')) || validPhotos[0];
        }
      }

      if (imageUrl) {
        const filePath = path.join(outputDir, `vk_photo_${Date.now()}.jpg`);
        const imgRes = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 15000 });
        fs.writeFileSync(filePath, imgRes.data);
        return { isVideo: false, localPath: filePath };
      }
    } catch (e: any) {
      console.warn('[downloadVk] Single Photo extraction failed:', e?.message || e);
    }
  }

  // 3. Try yt-dlp first for VK Video, Clips, & Wall posts
  try {
    if (isAudioLink) {
      const dp = await downloadVideo({ url: cleanUrl, outputDir });
      if (dp && fs.existsSync(dp)) {
        return { isVideo: false, localPath: dp };
      }
    } else {
      const dlPath = await downloadVideo({ url: cleanUrl, outputDir });
      if (dlPath && fs.existsSync(dlPath)) {
        return { isVideo: true, localPath: dlPath };
      }
    }
  } catch (e: any) {
    console.warn('[downloadVk] yt-dlp failed, trying direct VK API extraction:', e?.message || e);
  }

  // 4. Cobalt anonymous OAuth strategy for VK Video & Clips
  try {
    const token = await getAnonymToken();
    if (token) {
      const videoMatch = cleanUrl.match(/video(-?\d+_\d+)/) || cleanUrl.match(/clip(-?\d+_\d+)/);
      if (videoMatch) {
        const videoId = videoMatch[1];
        const vRes = await axios.get('https://api.vkvideo.ru/method/video.get', {
          params: {
            videos: videoId,
            access_token: token,
            v: '5.274'
          },
          headers: { 'user-agent': vkAgent },
          timeout: 10000
        });

        const videoItem = vRes.data?.response?.items?.[0];
        const files = videoItem?.files;
        if (files) {
          const directUrl = files.mp4_1080 || files.mp4_720 || files.mp4_480 || files.mp4_360 || files.mp4_240;
          if (directUrl) {
            const filePath = path.join(outputDir, `vk_${Date.now()}.mp4`);
            const writer = fs.createWriteStream(filePath);
            const streamRes = await axios({ url: directUrl, method: 'GET', responseType: 'stream', headers: { 'user-agent': vkAgent } });
            await new Promise<void>((resolve, reject) => {
              streamRes.data.pipe(writer);
              writer.on('finish', resolve);
              writer.on('error', reject);
            });
            return { isVideo: true, localPath: filePath, title: videoItem.title };
          }
        }
      }
    }
  } catch (e: any) {
    console.warn('[downloadVk] Video API fallback failed:', e?.message || e);
  }

  if (isAudioLink) {
    throw new Error('VK Audio requires VK login/authorization to download');
  }

  if (photoMatch || wallMatch || cleanUrl.includes('/photo') || cleanUrl.includes('z=photo')) {
    throw new Error('VK Photo/Wall post download failed');
  }

  throw new Error('VK Video download failed');
}

export default {
  name: 'vk',
  domains: ['vk.com', 'vk.ru', 'vkvideo.ru'],
  download: downloadVk
};
