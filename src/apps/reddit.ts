import axios from 'axios';
import { load } from 'cheerio';
import * as path from 'path';
import * as fs from 'fs';

export interface RedditResult {
  isVideo: boolean;
  localPath?: string;
  imagePaths?: string[];
  title?: string;
}

export async function downloadReddit(url: string, outputDir: string = 'downloads'): Promise<RedditResult> {
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const cleanUrl = url.trim();

  // 1. Try RapidSave first for Reddit Videos
  try {
    const infoUrl = 'https://rapidsave.com/info?url=' + encodeURIComponent(cleanUrl);
    const res = await axios.get(infoUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
      },
      timeout: 10000
    });

    const $ = load(res.data);
    let videoDownloadUrl: string | undefined;
    $('a[href]').each((i, el) => {
      const href = $(el).attr('href');
      if (href && (href.includes('download.php') || href.includes('video_url'))) {
        if (!videoDownloadUrl) videoDownloadUrl = href;
      }
    });

    if (videoDownloadUrl) {
      const fileName = `reddit_${Date.now()}.mp4`;
      const filePath = path.join(outputDir, fileName);
      const response = await axios({
        url: videoDownloadUrl,
        method: 'GET',
        responseType: 'stream',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
        }
      });
      const writer = fs.createWriteStream(filePath);
      await new Promise<void>((resolve, reject) => {
        response.data.pipe(writer);
        writer.on('finish', resolve);
        writer.on('error', reject);
      });
      return { isVideo: true, localPath: filePath };
    }
  } catch (e: any) {
    console.warn('[downloadReddit] RapidSave video check failed:', e?.message || e);
  }

  // 2. Try vxreddit for Single Photos & Multi-Photo Galleries
  try {
    let vxUrl = cleanUrl.replace(/https?:\/\/(www\.|old\.|sh\.)?reddit\.com/i, 'https://www.vxreddit.com');
    if (!vxUrl.startsWith('https://www.vxreddit.com')) {
      vxUrl = 'https://www.vxreddit.com' + (vxUrl.includes('/') ? vxUrl.slice(vxUrl.indexOf('/')) : '');
    }

    const res = await axios.get(vxUrl, {
      headers: {
        'User-Agent': 'TelegramBot (like TwitterBot)'
      },
      timeout: 10000
    });

    const $ = load(res.data);
    const imageLinks: string[] = [];
    $('meta[property="og:image"], meta[name="twitter:image"]').each((i, el) => {
      const c = $(el).attr('content');
      if (c && c.startsWith('http')) imageLinks.push(c);
    });

    const uniqueImages = Array.from(new Set(imageLinks.map(u => u.replace(/\?.*$/, ''))));
    if (uniqueImages.length > 0) {
      const localPaths: string[] = [];
      for (let i = 0; i < uniqueImages.length; i++) {
        const imgUrl = uniqueImages[i];
        const ext = imgUrl.includes('.png') ? 'png' : imgUrl.includes('.gif') ? 'gif' : 'jpg';
        const fileName = `reddit_${Date.now()}_${i + 1}.${ext}`;
        const filePath = path.join(outputDir, fileName);
        const response = await axios({
          url: imgUrl,
          method: 'GET',
          responseType: 'stream',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
          }
        });
        const writer = fs.createWriteStream(filePath);
        await new Promise<void>((resolve, reject) => {
          response.data.pipe(writer);
          writer.on('finish', resolve);
          writer.on('error', reject);
        });
        localPaths.push(filePath);
      }
      return {
        isVideo: false,
        imagePaths: localPaths,
        localPath: localPaths[0]
      };
    }
  } catch (e: any) {
    console.warn('[downloadReddit] vxreddit photo/gallery check failed:', e?.message || e);
  }

  throw new Error('Reddit download failed');
}

export default {
  name: 'reddit',
  domains: ['reddit.com', 'redd.it'],
  download: downloadReddit
};
