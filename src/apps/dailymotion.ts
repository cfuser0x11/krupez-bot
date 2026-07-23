import * as fs from 'fs';
import { downloadVideo } from '../engine';

export async function downloadDailymotion(url: string, outputDir: string) {
  const dlPath = await downloadVideo({ url: url.trim(), outputDir });
  if (!dlPath || !fs.existsSync(dlPath)) throw new Error('Dailymotion download failed');
  return { isVideo: true, localPath: dlPath };
}

export default {
  name: 'dailymotion',
  domains: ['dailymotion.com', 'dai.ly'],
  download: downloadDailymotion
};
