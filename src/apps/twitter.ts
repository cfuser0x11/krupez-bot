import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { AppDownloadResult } from './index';
import { downloadVideo } from '../engine';

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9'
};

export async function downloadTwitter(
  tweetUrl: string,
  outputDir: string
): Promise<AppDownloadResult> {
  const match = tweetUrl.match(/(?:twitter\.com|x\.com)\/([^\/]+)\/status\/(\d+)/i);
  if (!match) throw new Error('Invalid Twitter/X URL');

  const [, screenName, statusId] = match;

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  let imageUrls: string[] = [];
  let videoUrl = '';
  let tweetText = '';

  // 1. Try vxtwitter API first
  try {
    const res = await axios.get(`https://api.vxtwitter.com/${screenName}/status/${statusId}`, {
      headers: DEFAULT_HEADERS,
      timeout: 10000
    });
    const data = res.data;
    if (data) {
      tweetText = data.text || '';
      if (Array.isArray(data.media_extended)) {
        for (const item of data.media_extended) {
          if ((item.type === 'video' || item.type === 'gif') && item.url) {
            videoUrl = item.url;
            break;
          } else if (item.type === 'image' && item.url) {
            imageUrls.push(item.url);
          }
        }
      }
      if (!videoUrl && !imageUrls.length && Array.isArray(data.mediaURLs)) {
        for (const u of data.mediaURLs) {
          if (u.includes('.mp4')) videoUrl = u;
          else imageUrls.push(u);
        }
      }
    }
  } catch (e: any) {
    console.warn('[downloadTwitter] vxtwitter API failed:', e?.message || e);
  }

  // 2. Fallback to fxtwitter API
  if (!videoUrl && imageUrls.length === 0) {
    try {
      const res = await axios.get(`https://api.fxtwitter.com/${screenName}/status/${statusId}`, {
        headers: DEFAULT_HEADERS,
        timeout: 10000
      });
      const data = res.data;
      if (data?.tweet) {
        if (!tweetText) tweetText = data.tweet.text || '';
        const media = data.tweet.media;
        if (media?.videos && Array.isArray(media.videos) && media.videos.length > 0) {
          videoUrl = media.videos[0].url;
        } else if (media?.photos && Array.isArray(media.photos)) {
          imageUrls = media.photos.map((item: any) => item.url).filter(Boolean);
        }
      }
    } catch (e: any) {
      console.warn('[downloadTwitter] fxtwitter API failed:', e?.message || e);
    }
  }

  // Download Video if present
  if (videoUrl) {
    const filePath = path.join(outputDir, `twitter_video_${statusId}.mp4`);
    const writer = fs.createWriteStream(filePath);
    const response = await axios({
      url: videoUrl,
      method: 'GET',
      headers: DEFAULT_HEADERS,
      responseType: 'stream',
      timeout: 30000
    });

    await new Promise<void>((resolve, reject) => {
      response.data.pipe(writer);
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    if (fs.existsSync(filePath) && fs.statSync(filePath).size > 1000) {
      return { isVideo: true, localPath: filePath, title: tweetText };
    }
  }

  // Download Photos if present
  if (imageUrls.length > 0) {
    const imagePaths: string[] = [];
    for (let i = 0; i < imageUrls.length; i++) {
      const imgUrl = imageUrls[i];
      const fileName = `twitter_${statusId}_${i + 1}.jpg`;
      const filePath = path.join(outputDir, fileName);

      try {
        const writer = fs.createWriteStream(filePath);
        const response = await axios({
          url: imgUrl,
          method: 'GET',
          headers: DEFAULT_HEADERS,
          responseType: 'stream',
          timeout: 15000
        });

        await new Promise<void>((resolve, reject) => {
          response.data.pipe(writer);
          writer.on('finish', resolve);
          writer.on('error', reject);
        });

        if (fs.existsSync(filePath) && fs.statSync(filePath).size > 1000) {
          imagePaths.push(filePath);
        }
      } catch (err) {}
    }

    if (imagePaths.length === 1) {
      return { isVideo: false, localPath: imagePaths[0], title: tweetText };
    } else if (imagePaths.length > 1) {
      return { isVideo: false, localPath: imagePaths[0], imagePaths, title: tweetText };
    }
  }

  // 3. Fallback to yt-dlp for Twitter video
  try {
    const dlPath = await downloadVideo({ url: tweetUrl, outputDir });
    if (dlPath && fs.existsSync(dlPath)) {
      return { isVideo: true, localPath: dlPath };
    }
  } catch (e: any) {
    console.warn('[downloadTwitter] yt-dlp fallback failed:', e?.message || e);
  }

  throw new Error('Twitter/X media download failed');
}

export default {
  name: 'twitter',
  domains: ['twitter.com', 'x.com'],
  download: downloadTwitter
};
