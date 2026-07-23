import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { downloadVideo } from '../engine';

export async function downloadLoom(url: string, outputDir: string) {
  const cleanUrl = url.trim();

  try {
    const dlPath = await downloadVideo({ url: cleanUrl, outputDir });
    if (dlPath && fs.existsSync(dlPath)) return { isVideo: true, localPath: dlPath };
  } catch (e: any) {}

  try {
    const idMatch = cleanUrl.match(/share\/([a-f0-9-]+)/i);
    if (idMatch && idMatch[1]) {
      const apiRes = await axios.post(`https://www.loom.com/api/campaigns/sessions/${idMatch[1]}/transcoded-url`, {}, { timeout: 10000 });
      const vUrl = apiRes.data?.url;
      if (vUrl) {
        const filePath = path.join(outputDir, `loom_${Date.now()}.mp4`);
        const writer = fs.createWriteStream(filePath);
        const streamRes = await axios({ url: vUrl, method: 'GET', responseType: 'stream' });
        await new Promise<void>((resolve, reject) => {
          streamRes.data.pipe(writer);
          writer.on('finish', resolve);
          writer.on('error', reject);
        });
        return { isVideo: true, localPath: filePath };
      }
    }
  } catch (e: any) {
    console.warn('[downloadLoom] API failed:', e?.message || e);
  }

  throw new Error('Loom download failed');
}

export default {
  name: 'loom',
  domains: ['loom.com'],
  download: downloadLoom
};
