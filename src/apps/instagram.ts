import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { downloadVideo } from '../engine';

export interface InstagramResult {
  isVideo: boolean;
  localPath?: string;
  imagePaths?: string[];
  title?: string;
}

export async function downloadInstagram(url: string, outputDir: string): Promise<InstagramResult> {
  const cleanUrl = url.split('?')[0].replace(/\/+$/, '');

  // 1. Try Direct API parse first (Cobalt strategy: fast 1-2s response for videos & carousels)
  try {
    const jsonUrl = `${cleanUrl}/?__a=1&__d=dis`;
    console.debug('[downloadInstagram] Fetching direct Instagram media JSON:', jsonUrl);
    const res = await axios.get(jsonUrl, {
      headers: {
        'user-agent': 'Instagram 275.0.0.27.98 Android (33/13; 280dpi; 720x1423; Xiaomi; Redmi 7; onclite; qcom; en_US; 458229237)',
        'sec-fetch-site': 'same-origin',
        'x-ig-app-id': '936619743392459',
        'accept-language': 'en-US'
      },
      timeout: 8000
    });

    const items = res.data?.graphql?.shortcode_media || res.data?.items?.[0];
    if (items) {
      if (items.is_video && items.video_url) {
        console.debug('[downloadInstagram] Direct video URL extracted, streaming MP4 via axios...');
        const vUrl = items.video_url;
        const filePath = path.join(outputDir, `instagram_${Date.now()}.mp4`);
        const writer = fs.createWriteStream(filePath);
        const vRes = await axios({ url: vUrl, method: 'GET', responseType: 'stream', timeout: 15000 });
        await new Promise<void>((resolve, reject) => {
          vRes.data.pipe(writer);
          writer.on('finish', resolve);
          writer.on('error', reject);
        });
        if (fs.existsSync(filePath) && fs.statSync(filePath).size > 1000) {
          console.debug('[downloadInstagram] Direct video stream complete in 1-2s!');
          return { isVideo: true, localPath: filePath };
        }
      }

      // Carousel / Single photo
      const sidecar = items.edge_sidecar_to_children?.edges || items.carousel_media;
      if (sidecar && sidecar.length > 1) {
        console.debug('[downloadInstagram] Direct photo carousel extracted, downloading slides...');
        const imagePaths: string[] = [];
        for (let i = 0; i < sidecar.length; i++) {
          const node = sidecar[i].node || sidecar[i];
          const imgUrl = node.display_url || node.image_versions2?.candidates?.[0]?.url;
          if (imgUrl) {
            const ext = 'jpg';
            const imgPath = path.join(outputDir, `instagram_${Date.now()}_${i}.${ext}`);
            const w = fs.createWriteStream(imgPath);
            const r = await axios({ url: imgUrl, method: 'GET', responseType: 'stream', timeout: 15000 });
            await new Promise<void>((res, rej) => {
              r.data.pipe(w);
              w.on('finish', res);
              w.on('error', rej);
            });
            if (fs.existsSync(imgPath) && fs.statSync(imgPath).size > 1000) imagePaths.push(imgPath);
          }
        }
        if (imagePaths.length > 0) return { isVideo: false, imagePaths };
      } else {
        const imgUrl = items.display_url || items.display_resources?.[items.display_resources.length - 1]?.src;
        if (imgUrl) {
          console.debug('[downloadInstagram] Direct single photo extracted, downloading...');
          const filePath = path.join(outputDir, `instagram_${Date.now()}.jpg`);
          const writer = fs.createWriteStream(filePath);
          const iRes = await axios({ url: imgUrl, method: 'GET', responseType: 'stream', timeout: 15000 });
          await new Promise<void>((resolve, reject) => {
            iRes.data.pipe(writer);
            writer.on('finish', resolve);
            writer.on('error', reject);
          });
          if (fs.existsSync(filePath) && fs.statSync(filePath).size > 1000) {
            return { isVideo: false, localPath: filePath };
          }
        }
      }
    }
  } catch (e: any) {
    console.warn('[downloadInstagram] Direct API fast parse skipped/failed, falling back to yt-dlp:', e?.message || e);
  }

  // 2. Fallback to yt-dlp if direct API parsing did not return items
  try {
    console.debug('[downloadInstagram] Falling back to yt-dlp for Instagram download...');
    const dlPath = await downloadVideo({ url: cleanUrl, outputDir });
    if (dlPath && fs.existsSync(dlPath)) {
      return { isVideo: true, localPath: dlPath };
    }
  } catch (e: any) {
    console.warn('[downloadInstagram] yt-dlp fallback failed:', e?.message || e);
  }

  throw new Error('Instagram download failed');
}

export default {
  name: 'instagram',
  domains: ['instagram.com', 'instagr.am'],
  download: downloadInstagram
};
