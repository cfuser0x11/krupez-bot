import * as fs from 'fs';
import { downloadVideo } from '../engine';

export async function downloadVimeo(url: string, outputDir: string) {
  const dlPath = await downloadVideo({ url: url.trim(), outputDir });
  if (!dlPath || !fs.existsSync(dlPath)) throw new Error('Vimeo download failed');
  return { isVideo: true, localPath: dlPath };
}

export default {
  name: 'vimeo',
  domains: ['vimeo.com'],
  download: downloadVimeo
};
