import * as fs from 'fs';
import { downloadVideo } from '../engine';

export async function downloadNewgrounds(url: string, outputDir: string) {
  const dlPath = await downloadVideo({ url: url.trim(), outputDir });
  if (!dlPath || !fs.existsSync(dlPath)) throw new Error('Newgrounds download failed');
  return { isVideo: true, localPath: dlPath };
}

export default {
  name: 'newgrounds',
  domains: ['newgrounds.com'],
  download: downloadNewgrounds
};
