import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { downloadVideo } from '../engine';

export interface StreamableResult {
  isVideo: boolean;
  localPath?: string;
  title?: string;
}

export async function downloadStreamable(url: string, outputDir: string): Promise<StreamableResult> {
  const cleanUrl = url.trim();

  // 1. Try yt-dlp first
  try {
    const dlPath = await downloadVideo({ url: cleanUrl, outputDir });
    if (dlPath && fs.existsSync(dlPath)) {
      return { isVideo: true, localPath: dlPath };
    }
  } catch (e: any) {}

  // 2. Direct Streamable API (api.streamable.com/videos/SHORTCODE)
  try {
    const shortcode = cleanUrl.split('/').pop()?.split('?')[0];
    if (shortcode) {
      const apiRes = await axios.get(`https://api.streamable.com/videos/${shortcode}`, { timeout: 10000 });
      const files = apiRes.data?.files;
      const directUrl = files?.['mp4-high']?.url || files?.mp4?.url || files?.['mp4-mobile']?.url;
      if (directUrl) {
        const fullUrl = directUrl.startsWith('//') ? `https:${directUrl}` : directUrl;
        const filePath = path.join(outputDir, `streamable_${Date.now()}.mp4`);
        const writer = fs.createWriteStream(filePath);
        const res = await axios({ url: fullUrl, method: 'GET', responseType: 'stream' });
        await new Promise<void>((resolve, reject) => {
          res.data.pipe(writer);
          writer.on('finish', resolve);
          writer.on('error', reject);
        });
        return { isVideo: true, localPath: filePath, title: apiRes.data?.title };
      }
    }
  } catch (e: any) {
    console.warn('[downloadStreamable] API failed:', e?.message || e);
  }

  throw new Error('Streamable download failed');
}

export default {
  name: 'streamable',
  domains: ['streamable.com'],
  download: downloadStreamable
};

