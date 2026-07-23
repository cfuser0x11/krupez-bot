import axios from 'axios';
import { load } from 'cheerio';
import * as path from 'path';
import * as fs from 'fs';
import { downloadVideo } from '../engine';

export interface PinterestResult {
  isVideo: boolean;
  mediaUrl?: string;
  mediaUrls?: string[];
  title?: string;
  localPath?: string;
  imagePaths?: string[];
}

export async function scrapePinterestMetadata(url: string): Promise<PinterestResult> {
  let cleanUrl = url.trim();
  cleanUrl = cleanUrl.replace(/https?:\/\/[a-z]{2,3}\.pinterest\.com/i, 'https://www.pinterest.com');

  try {
    const res = await axios.get(cleanUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      maxRedirects: 5,
      timeout: 10000
    });

    const $ = load(res.data);

    let videoUrl = $('meta[property="og:video"]').attr('content') || $('meta[property="og:video:secure_url"]').attr('content');
    let imageUrl = $('meta[property="og:image"]').attr('content');
    let title = $('meta[property="og:title"]').attr('content') || '';

    const pwsData = $('#__PWS_DATA__').html();
    if (pwsData) {
      try {
        const data = JSON.parse(pwsData);
        const pins = data.props?.initialReduxState?.pins;
        if (pins) {
          const pinId = Object.keys(pins)[0];
          const pin = pins[pinId];
          if (pin) {
            if (!title) title = pin.title || pin.grid_title || '';
            const vList = pin.videos?.video_list;
            if (vList) {
              const bestV = Object.values(vList).sort((a: any, b: any) => (b.width || 0) - (a.width || 0))[0] as any;
              if (bestV?.url) videoUrl = bestV.url;
            }
            if (pin.images?.originals?.url) {
              imageUrl = pin.images.originals.url;
            }
          }
        }
      } catch (e) {}
    }

    if (imageUrl) {
      imageUrl = imageUrl.replace(/\/(236x|474x|736x)\//, '/originals/');
    }

    if (videoUrl) {
      return { isVideo: true, mediaUrl: videoUrl, title };
    }

    // Extract all unique original-resolution images from HTML (for multi-photo Idea Pins)
    const allMatches = (res.data as string).match(
      /https:\/\/i\.pinimg\.com\/(?:236x|474x|736x|originals)\/[a-zA-Z0-9\/._-]+\.(?:jpg|png|jpeg|gif|webp)/gi
    ) || [];
    // Known Pinterest branding image fragment to exclude
    const EXCLUDE = 'd53b014d86a6b6761bf649a0ed813c2b';
    const allOriginals = Array.from(new Set(
      allMatches
        .map((u: string) => u.replace(/\/(236x|474x|736x)\//, '/originals/'))
        .filter((u: string) => !u.includes(EXCLUDE))
    ));

    if (allOriginals.length > 1) {
      return { isVideo: false, mediaUrls: allOriginals, mediaUrl: allOriginals[0], title };
    }

    if (imageUrl) {
      return { isVideo: false, mediaUrl: imageUrl, title };
    }
  } catch (err) {
    console.warn('[scrapePinterestMetadata] scraping failed:', (err as any)?.message || err);
  }

  return { isVideo: false };
}

async function downloadImageToFile(url: string, filePath: string): Promise<void> {
  const response = await axios({
    url,
    method: 'GET',
    responseType: 'stream',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    }
  });
  const writer = fs.createWriteStream(filePath);
  await new Promise<void>((resolve, reject) => {
    response.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

export async function downloadPinterest(url: string, outputDir: string = 'downloads'): Promise<PinterestResult> {
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const cleanUrl = url.trim().replace(/https?:\/\/[a-z]{2,3}\.pinterest\.com/i, 'https://www.pinterest.com');

  // 1. Try yt-dlp first for Pinterest Video Pins — with timeout to avoid hanging on photo pins
  try {
    const dlPath = await Promise.race<string | undefined>([
      downloadVideo({ url: cleanUrl, outputDir }),
      new Promise<undefined>((_, reject) => setTimeout(() => reject(new Error('yt-dlp timeout')), 25000))
    ]);
    if (dlPath && fs.existsSync(dlPath) && dlPath.toLowerCase().endsWith('.mp4')) {
      return { isVideo: true, localPath: dlPath };
    }
  } catch (e: any) {
    console.warn('[downloadPinterest] yt-dlp video download failed (likely a photo pin):', e?.message || e);
  }

  // 2. If yt-dlp failed (photo pin), scrape original high-res photo URL(s)
  const meta = await scrapePinterestMetadata(cleanUrl);

  // Multi-photo Idea Pin
  if (meta.mediaUrls && meta.mediaUrls.length > 1) {
    const imagePaths: string[] = [];
    for (let i = 0; i < meta.mediaUrls.length; i++) {
      const imgUrl = meta.mediaUrls[i];
      const ext = imgUrl.includes('.png') ? 'png' : imgUrl.includes('.gif') ? 'gif' : 'jpg';
      const filePath = path.join(outputDir, `pinterest_${Date.now()}_${i}.${ext}`);
      try {
        await downloadImageToFile(imgUrl, filePath);
        imagePaths.push(filePath);
      } catch (e: any) {
        console.warn('[downloadPinterest] failed to download image', imgUrl, e?.message || e);
      }
    }
    if (imagePaths.length > 0) {
      return { isVideo: false, imagePaths, localPath: imagePaths[0] };
    }
  }

  // Single photo
  if (meta.mediaUrl) {
    const ext = meta.mediaUrl.includes('.png') ? 'png' : meta.mediaUrl.includes('.gif') ? 'gif' : 'jpg';
    const filePath = path.join(outputDir, `pinterest_${Date.now()}.${ext}`);
    await downloadImageToFile(meta.mediaUrl, filePath);
    return { ...meta, localPath: filePath };
  }

  throw new Error('Pinterest download failed');
}

export default {
  name: 'pinterest',
  domains: ['pinterest.com', 'pin.it'],
  download: downloadPinterest
};
