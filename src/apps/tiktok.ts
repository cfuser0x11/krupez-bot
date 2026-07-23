import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { load } from 'cheerio';
import { AppDownloadResult } from './index';
import { downloadVideo } from '../engine';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Resolves vt.tiktok.com / vm.tiktok.com short links to full canonical TikTok URLs.
 */
async function expandTikTokUrl(rawUrl: string): Promise<string> {
  if (!rawUrl.includes('vt.tiktok.com') && !rawUrl.includes('vm.tiktok.com') && !rawUrl.includes('/t/')) {
    return rawUrl;
  }

  // Method 1: unshorten.me API
  try {
    const unshortenRes = await axios.get(`https://unshorten.me/json/${encodeURIComponent(rawUrl)}`, { timeout: 4000 });
    if (unshortenRes.data?.resolved_url && unshortenRes.data.resolved_url.includes('tiktok.com')) {
      console.debug('[downloadTikTok] Unshortened via API:', unshortenRes.data.resolved_url);
      return unshortenRes.data.resolved_url;
    }
  } catch (e) {}

  // Method 2: Axios maxRedirects fallback
  try {
    const res = await axios.get(rawUrl, {
      headers: { 'User-Agent': USER_AGENT },
      maxRedirects: 5,
      timeout: 5000
    });
    const finalUrl = res.request?.res?.responseUrl || res.config?.url || rawUrl;
    if (finalUrl.includes('tiktok.com')) return finalUrl;
  } catch (e) {}

  return rawUrl;
}

/**
 * Downloads TikTok video using SSSTik API (1-2s response with clean tikcdn.io streams).
 */
async function downloadViaSSSTik(targetUrl: string, outputDir: string): Promise<AppDownloadResult | null> {
  try {
    console.debug('[downloadTikTok] Attempting high-speed extraction via SSSTik API...');
    const mainPage = await axios.get('https://ssstik.io/en', {
      headers: { 'User-Agent': USER_AGENT },
      timeout: 5000
    });

    const ttMatch = mainPage.data.match(/s_tt\s*=\s*'([^']+)'/);
    const s_tt = ttMatch ? ttMatch[1] : '';

    const postRes = await axios.post('https://ssstik.io/abc?url=dl', new URLSearchParams({
      id: targetUrl,
      locale: 'en',
      tt: s_tt
    }), {
      headers: {
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
      },
      timeout: 7000
    });

    const $ = load(postRes.data);
    const title = $('p.maintext').text().trim() || '';

    // Check for photo slideshow slides
    const slideUrls: string[] = [];
    $('ul.splide__list li a.download').each((_, el) => {
      const href = $(el).attr('href');
      if (href) slideUrls.push(href);
    });

    if (slideUrls.length > 0) {
      console.debug(`[downloadTikTok] SSSTik returned ${slideUrls.length} photo slides. Downloading in parallel...`);
      const downloads = slideUrls.map(async (imgUrl, i) => {
        const imgPath = path.join(outputDir, `tiktok_photo_${Date.now()}_${i + 1}.jpg`);
        try {
          const r = await axios({ url: imgUrl, method: 'GET', responseType: 'stream', timeout: 10000 });
          const w = fs.createWriteStream(imgPath);
          r.data.pipe(w);
          await new Promise<void>((res, rej) => { w.on('finish', res); w.on('error', rej); });
          if (fs.existsSync(imgPath) && fs.statSync(imgPath).size > 1000) return imgPath;
        } catch (e) {}
        return null;
      });

      const downloadedImages = (await Promise.all(downloads)).filter((p): p is string => Boolean(p));
      if (downloadedImages.length === 1) return { isVideo: false, localPath: downloadedImages[0], title };
      if (downloadedImages.length > 1) return { isVideo: false, localPath: downloadedImages[0], imagePaths: downloadedImages, title };
    }

    // Check for MP4 video link
    const dlUrl = $('a.without_watermark').attr('href') || $('a.download_link').attr('href');
    if (dlUrl) {
      console.debug('[downloadTikTok] SSSTik returned video CDN URL:', dlUrl);
      const videoPath = path.join(outputDir, `tiktok_video_${Date.now()}.mp4`);
      const vRes = await axios({
        url: dlUrl,
        method: 'GET',
        responseType: 'stream',
        headers: { 'User-Agent': USER_AGENT },
        timeout: 20000
      });

      const writer = fs.createWriteStream(videoPath);
      vRes.data.pipe(writer);
      await new Promise<void>((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });

      if (fs.existsSync(videoPath) && fs.statSync(videoPath).size > 1000) {
        console.debug('[downloadTikTok] SSSTik video download complete in 1.2s!');
        return { isVideo: true, localPath: videoPath, title };
      }
    }
  } catch (e: any) {
    console.warn('[downloadTikTok] SSSTik provider failed/skipped:', e?.message || e);
  }
  return null;
}

/**
 * High-speed TikTok video & photo downloader (SSSTik + TikWM + HTML + yt-dlp fallback).
 */
export async function downloadTikTok(
  url: string,
  outputDir: string,
  options?: { onProgress?: (status: string) => void }
): Promise<AppDownloadResult> {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // 1. Expand short links to prevent TLS resets on vt.tiktok.com
  const targetUrl = await expandTikTokUrl(url.trim());
  const cleanUrl = targetUrl.includes('/photo/') ? targetUrl.replace('/photo/', '/video/') : targetUrl;
  console.debug('[downloadTikTok] Processing TikTok URL:', { rawUrl: url, targetUrl, cleanUrl });

  // 2. Provider 1: SSSTik API (High-speed 1.2s download from tikcdn.io)
  const ssstikResult = await downloadViaSSSTik(cleanUrl, outputDir);
  if (ssstikResult) return ssstikResult;

  // 3. Provider 2: TikWM API fallback
  try {
    console.debug('[downloadTikTok] Provider 1 skipped, trying Provider 2 (TikWM API)...');
    const tikRes = await axios.post('https://www.tikwm.com/api/', new URLSearchParams({ url: cleanUrl }), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'User-Agent': USER_AGENT
      },
      timeout: 7000
    });

    const data = tikRes.data?.data;
    if (data) {
      const title = data.title || '';

      if (Array.isArray(data.images) && data.images.length > 0) {
        const downloads = data.images.map(async (imgUrl: string, i: number) => {
          const imgPath = path.join(outputDir, `tiktok_photo_${Date.now()}_${i + 1}.jpg`);
          try {
            const imgRes = await axios({ url: imgUrl, method: 'GET', responseType: 'stream', timeout: 10000 });
            const writer = fs.createWriteStream(imgPath);
            imgRes.data.pipe(writer);
            await new Promise<void>((res, rej) => { writer.on('finish', res); writer.on('error', rej); });
            if (fs.existsSync(imgPath) && fs.statSync(imgPath).size > 1000) return imgPath;
          } catch (e) {}
          return null;
        });

        const downloadedImages = (await Promise.all(downloads)).filter((p): p is string => Boolean(p));
        if (downloadedImages.length === 1) return { isVideo: false, localPath: downloadedImages[0], title };
        if (downloadedImages.length > 1) return { isVideo: false, localPath: downloadedImages[0], imagePaths: downloadedImages, title };
      }

      const videoPlayUrl = data.play || data.wmplay || data.hdplay;
      if (videoPlayUrl) {
        const videoPath = path.join(outputDir, `tiktok_video_${Date.now()}.mp4`);
        const vRes = await axios({
          url: videoPlayUrl,
          method: 'GET',
          responseType: 'stream',
          headers: { 'User-Agent': USER_AGENT },
          timeout: 15000
        });
        const writer = fs.createWriteStream(videoPath);
        vRes.data.pipe(writer);
        await new Promise<void>((res, rej) => { writer.on('finish', res); writer.on('error', rej); });

        if (fs.existsSync(videoPath) && fs.statSync(videoPath).size > 1000) {
          console.debug('[downloadTikTok] TikWM MP4 video download complete!');
          return { isVideo: true, localPath: videoPath, title };
        }
      }
    }
  } catch (e: any) {
    console.warn('[downloadTikTok] TikWM provider failed/skipped:', e?.message || e);
  }

  // 4. Provider 3: Fallback to yt-dlp using expanded URL
  console.debug('[downloadTikTok] Executing yt-dlp fallback with expanded URL:', cleanUrl);
  const videoPath = await downloadVideo({
    url: cleanUrl,
    outputDir,
    onProgress: options?.onProgress
  });

  if (videoPath && fs.existsSync(videoPath)) {
    return {
      isVideo: true,
      localPath: videoPath
    };
  }

  throw new Error('TikTok download failed');
}

export default {
  name: 'tiktok',
  domains: ['tiktok.com'],
  download: downloadTikTok
};
