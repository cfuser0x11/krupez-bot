import * as fs from 'fs';
import { downloadVideo } from '../engine';

export async function downloadFacebook(url: string, outputDir: string) {
  const dlPath = await downloadVideo({ url: url.trim(), outputDir });
  if (!dlPath || !fs.existsSync(dlPath)) throw new Error('Facebook download failed');
  return { isVideo: true, localPath: dlPath };
}

export default {
  name: 'facebook',
  domains: ['facebook.com', 'fb.watch'],
  download: downloadFacebook
};

