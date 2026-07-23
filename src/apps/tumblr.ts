import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { downloadVideo } from '../engine';

export interface TumblrResult {
  isVideo: boolean;
  localPath?: string;
  imagePaths?: string[];
  title?: string;
}

export async function downloadTumblr(url: string, outputDir: string): Promise<TumblrResult> {
  const cleanUrl = url.trim();

  // 1. Try yt-dlp first
  try {
    const dlPath = await downloadVideo({ url: cleanUrl, outputDir });
    if (dlPath && fs.existsSync(dlPath)) {
      return { isVideo: true, localPath: dlPath };
    }
  } catch (e: any) {}

  // 2. Direct API parse fallback
  try {
    const res = await axios.get(cleanUrl, {
      headers: { 'User-Agent': 'Tumblr/iPhone/33.3/333010/17.3.1/tumblr' },
      timeout: 10000
    });
    const html = res.data;
    const vMatch = html.match(/<meta property="og:video" content="([^"]+)"/i) || html.match(/<source src="([^"]+\.mp4)"/i);
    if (vMatch && vMatch[1]) {
      const vUrl = vMatch[1].replace(/&amp;/g, '&');
      const filePath = path.join(outputDir, `tumblr_${Date.now()}.mp4`);
      const writer = fs.createWriteStream(filePath);
      const streamRes = await axios({ url: vUrl, method: 'GET', responseType: 'stream' });
      await new Promise<void>((resolve, reject) => {
        streamRes.data.pipe(writer);
        writer.on('finish', resolve);
        writer.on('error', reject);
      });
      return { isVideo: true, localPath: filePath };
    }

    const imgMatch = html.match(/<meta property="og:image" content="([^"]+)"/i);
    if (imgMatch && imgMatch[1]) {
      const imgUrl = imgMatch[1].replace(/&amp;/g, '&');
      const filePath = path.join(outputDir, `tumblr_${Date.now()}.jpg`);
      const writer = fs.createWriteStream(filePath);
      const streamRes = await axios({ url: imgUrl, method: 'GET', responseType: 'stream' });
      await new Promise<void>((resolve, reject) => {
        streamRes.data.pipe(writer);
        writer.on('finish', resolve);
        writer.on('error', reject);
      });
      return { isVideo: false, localPath: filePath };
    }
  } catch (e: any) {
    console.warn('[downloadTumblr] API failed:', e?.message || e);
  }

  throw new Error('Tumblr download failed');
}

export default {
  name: 'tumblr',
  domains: ['tumblr.com'],
  download: downloadTumblr
};
