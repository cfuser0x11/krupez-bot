import * as fs from 'fs';
import { downloadVideo } from '../engine';

export async function downloadRutube(url: string, outputDir: string) {
  const dlPath = await downloadVideo({ url: url.trim(), outputDir });
  if (!dlPath || !fs.existsSync(dlPath)) throw new Error('Rutube download failed');
  return { isVideo: true, localPath: dlPath };
}

export default {
  name: 'rutube',
  domains: ['rutube.ru'],
  download: downloadRutube
};

