import * as fs from 'fs';
import { downloadVideo } from '../engine';

export async function downloadSnapchat(url: string, outputDir: string) {
  const dlPath = await downloadVideo({ url: url.trim(), outputDir });
  if (!dlPath || !fs.existsSync(dlPath)) throw new Error('Snapchat download failed');
  return { isVideo: true, localPath: dlPath };
}

export default {
  name: 'snapchat',
  domains: ['snapchat.com'],
  download: downloadSnapchat
};
