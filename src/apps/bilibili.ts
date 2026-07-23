import * as fs from 'fs';
import { downloadVideo } from '../engine';

export async function downloadBilibili(url: string, outputDir: string) {
  const dlPath = await downloadVideo({ url: url.trim(), outputDir });
  if (!dlPath || !fs.existsSync(dlPath)) throw new Error('Bilibili download failed');
  return { isVideo: true, localPath: dlPath };
}

export default {
  name: 'bilibili',
  domains: ['bilibili.com', 'b23.tv'],
  download: downloadBilibili
};

