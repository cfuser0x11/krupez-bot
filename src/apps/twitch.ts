import * as fs from 'fs';
import { downloadVideo } from '../engine';

export async function downloadTwitch(url: string, outputDir: string) {
  const dlPath = await downloadVideo({ url: url.trim(), outputDir });
  if (!dlPath || !fs.existsSync(dlPath)) throw new Error('Twitch clip download failed');
  return { isVideo: true, localPath: dlPath };
}

export default {
  name: 'twitch',
  domains: ['twitch.tv'],
  download: downloadTwitch
};

