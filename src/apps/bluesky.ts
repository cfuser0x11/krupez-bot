import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { downloadVideo } from '../engine';

export interface BlueskyResult {
  isVideo: boolean;
  localPath?: string;
  imagePaths?: string[];
  title?: string;
}

export async function downloadBluesky(url: string, outputDir: string): Promise<BlueskyResult> {
  const cleanUrl = url.trim();

  // 1. Try yt-dlp first
  try {
    const dlPath = await downloadVideo({ url: cleanUrl, outputDir });
    if (dlPath && fs.existsSync(dlPath)) {
      return { isVideo: true, localPath: dlPath };
    }
  } catch (e: any) {}

  // 2. Direct API parse via Bluesky Public AT-Protocol / OG tags
  try {
    const res = await axios.get(cleanUrl, {
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout: 10000
    });
    const html = res.data;

    const vMatch = html.match(/<meta property="og:video" content="([^"]+)"/i);
    if (vMatch && vMatch[1]) {
      const vUrl = vMatch[1].replace(/&amp;/g, '&');
      const filePath = path.join(outputDir, `bluesky_${Date.now()}.mp4`);
      const writer = fs.createWriteStream(filePath);
      const streamRes = await axios({ url: vUrl, method: 'GET', responseType: 'stream' });
      await new Promise<void>((resolve, reject) => {
        streamRes.data.pipe(writer);
        writer.on('finish', resolve);
        writer.on('error', reject);
      });
      return { isVideo: true, localPath: filePath };
    }

    const imgMatches = Array.from(html.matchAll(/<meta property="og:image" content="([^"]+)"/gi)) as RegExpMatchArray[];
    if (imgMatches.length > 0) {
      const imagePaths: string[] = [];
      for (let i = 0; i < imgMatches.length; i++) {
        const imgUrl = imgMatches[i][1].replace(/&amp;/g, '&');
        if (imgUrl.includes('avatar') || imgUrl.includes('banner')) continue;
        const filePath = path.join(outputDir, `bluesky_${Date.now()}_${i}.jpg`);
        const writer = fs.createWriteStream(filePath);
        const streamRes = await axios({ url: imgUrl, method: 'GET', responseType: 'stream' });
        await new Promise<void>((resolve, reject) => {
          streamRes.data.pipe(writer);
          writer.on('finish', resolve);
          writer.on('error', reject);
        });
        if (fs.existsSync(filePath)) imagePaths.push(filePath);
      }
      if (imagePaths.length > 1) return { isVideo: false, imagePaths };
      if (imagePaths.length === 1) return { isVideo: false, localPath: imagePaths[0] };
    }
  } catch (e: any) {
    console.warn('[downloadBluesky] API failed:', e?.message || e);
  }

  throw new Error('Bluesky download failed');
}

export default {
  name: 'bluesky',
  domains: ['bsky.app'],
  download: downloadBluesky
};
