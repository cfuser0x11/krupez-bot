import * as fs from 'fs';
import * as path from 'path';
import { downloadMedia, extractCover, resizeThumbnailTo320, embedCoverToMp3 } from '../engine';

export interface SoundcloudResult {
  localPath: string;
  title?: string;
  artists?: string;
  album?: string;
  thumbPath?: string;
  isAudio?: boolean;
}

export async function downloadSoundcloud(url: string, outputDir: string, quality: 'high' | 'medium' | 'low' = 'high'): Promise<SoundcloudResult> {
  const cleanUrl = url.trim();

  const dp = await downloadMedia({
    url: cleanUrl,
    format: 'mp3',
    outputDir,
    quality
  });

  if (!dp || !fs.existsSync(dp)) {
    throw new Error('SoundCloud download failed');
  }

  let thumbPath: string | undefined;
  const coverPath = extractCover(dp);
  if (coverPath && fs.existsSync(coverPath)) {
    thumbPath = resizeThumbnailTo320(coverPath);
  }

  if (thumbPath && fs.existsSync(thumbPath)) {
    embedCoverToMp3(dp, thumbPath);
  }

  const baseName = path.basename(dp, path.extname(dp));
  return {
    localPath: dp,
    title: baseName,
    thumbPath,
    isAudio: true
  };
}

export default {
  name: 'soundcloud',
  domains: ['soundcloud.com'],
  download: downloadSoundcloud
};
