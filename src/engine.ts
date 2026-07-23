import * as fs from 'fs';
import * as path from 'path';
import { execFileSync, spawn } from 'child_process';

export const YTDLP_PATH = path.join(__dirname, '..', 'bin', 'yt-dlp');

const ffmpegReq = require('ffmpeg-static');
export const FFMPEG_PATH: string = typeof ffmpegReq === 'string' ? ffmpegReq : (ffmpegReq?.path || ffmpegReq?.default || 'ffmpeg');

let cachedYtdlpVersion = '';
let cachedFfmpegVersion = '';

export function getDownloaderVersionInfo(): { ytdlpVersion: string; ffmpegVersion: string } {
  if (!cachedYtdlpVersion) {
    try {
      cachedYtdlpVersion = execFileSync(YTDLP_PATH, ['--version']).toString().trim();
    } catch {
      cachedYtdlpVersion = 'unknown';
    }
  }

  if (!cachedFfmpegVersion) {
    try {
      const out = execFileSync(FFMPEG_PATH, ['-version']).toString();
      cachedFfmpegVersion = out.split('\n')[0].trim();
    } catch {
      cachedFfmpegVersion = 'ffmpeg-static';
    }
  }

  return { ytdlpVersion: cachedYtdlpVersion, ffmpegVersion: cachedFfmpegVersion };
}

export interface DownloadOptions {
  url: string;
  format: string;
  outputDir: string;
  quality: string;
  onProgress?: (status: string) => void;
}

export interface VideoDownloadOptions {
  url: string;
  outputDir: string;
  /** If set, limits download size (e.g. '44M'). Defaults to 44M to respect Telegram 50MB bot upload limit. */
  maxFileSize?: string;
  onProgress?: (status: string) => void;
}

export async function downloadMedia(options: DownloadOptions): Promise<string> {
  const { url, format, outputDir } = options;
  console.debug('[downloadMedia] Starting audio download:', { url, format, outputDir, quality: options.quality });

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const outputPath = path.join(outputDir, '%(title)s.%(ext)s');
  const args = [
    '--js-runtimes', 'node',
    '--newline',
    '--progress',
    '--concurrent-fragments', '4',
    '--buffer-size', '64k',
    '--no-playlist',
    '--add-metadata',
    '--write-thumbnail',
    '--convert-thumbnails', 'jpg',
    '--embed-thumbnail',
    '-x',
    '--audio-format', format,
    '--print', 'after_move:filepath',
    '-o', outputPath,
    url
  ];
  console.debug('[downloadMedia] Spawning yt-dlp with args:', args.join(' '));

  return new Promise((resolve, reject) => {
    let stdoutData = '';
    let stderrData = '';
    const child = spawn(YTDLP_PATH, args, { env: { ...process.env, FFMPEG_LOCATION: FFMPEG_PATH } });
    
    child.stdout.on('data', (data) => {
      const text = data.toString();
      stdoutData += text;
      const lines = text.split(/[\r\n]+/);
      for (const line of lines) {
        if (line.trim()) console.debug('[downloadMedia yt-dlp stdout]:', line.trim());
        const match = line.match(/\[download\]\s+(\d+\.?\d*%.*)/i);
        if (match && options.onProgress) {
          options.onProgress(match[1].trim());
        }
      }
    });

    child.stderr.on('data', (data) => {
      const text = data.toString();
      stderrData += text;
      if (text.trim()) console.debug('[downloadMedia yt-dlp stderr]:', text.trim());
    });

    child.on('close', (code) => {
      console.debug('[downloadMedia] yt-dlp process closed with code:', code);
      if (code !== 0) {
        const errLine = stderrData.split(/[\r\n]+/).find(l => l.includes('ERROR:')) || 'Error downloading audio.';
        return reject(new Error(errLine.replace(/^ERROR:\s*/i, '').trim()));
      }
      const lines = stdoutData.split(/[\r\n]+/).map(l => l.trim()).filter(Boolean);
      const finalPath = lines[lines.length - 1];
      console.debug('[downloadMedia] Output file resolved to:', finalPath);
      resolve(finalPath || '');
    });
  });
}

export function isAnimationFile(filePath: string): boolean {
  if (!filePath.toLowerCase().endsWith('.mp4')) return false;
  try {
    const result = execFileSync('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_streams',
      filePath
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    const data = JSON.parse(result.toString());
    const streams: any[] = data.streams || [];
    const hasAudio = streams.some((s: any) => s.codec_type === 'audio');
    return !hasAudio;
  } catch {
    return false;
  }
}

export interface VideoMetadata {
  width?: number;
  height?: number;
  duration?: number;
}

export function getVideoMetadata(filePath: string): VideoMetadata {
  if (!filePath.toLowerCase().endsWith('.mp4') || !fs.existsSync(filePath)) return {};
  try {
    const result = execFileSync('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_streams',
      '-show_format',
      filePath
    ], { stdio: ['ignore', 'pipe', 'ignore'] });

    const data = JSON.parse(result.toString());
    const videoStream = (data.streams || []).find((s: any) => s.codec_type === 'video');

    let width = videoStream?.width;
    let height = videoStream?.height;
    let duration = Math.round(parseFloat(data.format?.duration || videoStream?.duration || '0'));

    const rotation = Math.abs(parseInt(videoStream?.side_data_list?.[0]?.rotation || '0'));
    if (rotation === 90 || rotation === 270) {
      const tmp = width;
      width = height;
      height = tmp;
    }

    return {
      width: width ? parseInt(String(width)) : undefined,
      height: height ? parseInt(String(height)) : undefined,
      duration: duration > 0 ? duration : undefined
    };
  } catch {
    return {};
  }
}

export function compressVideoToFit(filePath: string, maxBytes: number = 44 * 1024 * 1024): string {
  if (!fs.existsSync(filePath)) return filePath;
  const initialSize = fs.statSync(filePath).size;
  if (initialSize <= maxBytes) return filePath;

  try {
    // 1. Get video duration using ffprobe
    const result = execFileSync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath
    ], { stdio: ['ignore', 'pipe', 'ignore'] });

    const duration = parseFloat(result.toString().trim());
    if (isNaN(duration) || duration <= 0) return filePath;

    // 2. Calculate target total bitrate (target 42MB bits = maxBytes * 8 * 0.95)
    const targetTotalBitrate = Math.floor((maxBytes * 8 * 0.95) / duration);
    const audioBitrate = 128000; // 128k
    const videoBitrate = Math.max(150000, targetTotalBitrate - audioBitrate);

    const ext = path.extname(filePath);
    const compressedPath = filePath.replace(new RegExp(`${ext}$`), `_compressed${ext}`);

    // 3. Fast one-pass ffmpeg compression to fit under maxBytes
    execFileSync(FFMPEG_PATH, [
      '-y',
      '-i', filePath,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-b:v', `${Math.floor(videoBitrate / 1000)}k`,
      '-maxrate', `${Math.floor((videoBitrate * 1.2) / 1000)}k`,
      '-bufsize', `${Math.floor((videoBitrate * 2) / 1000)}k`,
      '-vf', 'scale=-2:\'min(720,ih)\'',
      '-c:a', 'aac',
      '-b:a', '128k',
      compressedPath
    ], { stdio: ['ignore', 'ignore', 'ignore'] });

    if (fs.existsSync(compressedPath) && fs.statSync(compressedPath).size <= maxBytes) {
      try { fs.unlinkSync(filePath); } catch {}
      return compressedPath;
    }
  } catch (err) {
    console.warn('[compressVideoToFit] Compression failed:', err);
  }

  return filePath;
}

export async function downloadVideo(options: VideoDownloadOptions): Promise<string> {
  const { url, outputDir } = options;
  const maxFileSize = options.maxFileSize || '44M';
  console.debug('[downloadVideo] Starting video download:', { url, outputDir, maxFileSize });

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const outputPath = path.join(outputDir, '%(title)s.%(ext)s');
  const formatFilter = `bestvideo[vcodec^=avc1][ext=mp4]+bestaudio[acodec^=mp4a]/bestvideo[vcodec^=avc1]+bestaudio[acodec^=mp4a]/bestvideo[filesize_approx<=${maxFileSize}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[filesize<=${maxFileSize}][ext=mp4]+bestaudio[ext=m4a]/best[filesize_approx<=${maxFileSize}][ext=mp4]/best[ext=mp4]/bv*+ba/best`;
  const args = [
    '--js-runtimes', 'node',
    '--newline',
    '--progress',
    '--concurrent-fragments', '4',
    '--buffer-size', '64k',
    '--no-playlist',
    '--max-filesize', maxFileSize,
    '-f', formatFilter,
    '--merge-output-format', 'mp4',
    '--print', 'after_move:filepath',
    '-o', outputPath,
    url
  ];
  console.debug('[downloadVideo] Spawning yt-dlp with args:', args.join(' '));

  return new Promise((resolve, reject) => {
    let stdoutData = '';
    let stderrData = '';
    const child = spawn(YTDLP_PATH, args, { env: { ...process.env, FFMPEG_LOCATION: FFMPEG_PATH } });

    child.stdout.on('data', (data) => {
      const text = data.toString();
      stdoutData += text;
      const lines = text.split(/[\r\n]+/);
      for (const line of lines) {
        if (line.trim()) console.debug('[downloadVideo yt-dlp stdout]:', line.trim());
        const match = line.match(/\[download\]\s+(\d+\.?\d*%.*)/i);
        if (match && options.onProgress) {
          options.onProgress(match[1].trim());
        }
      }
    });

    child.stderr.on('data', (data) => {
      const text = data.toString();
      stderrData += text;
      if (text.trim()) console.debug('[downloadVideo yt-dlp stderr]:', text.trim());
    });

    child.on('close', (code) => {
      console.debug('[downloadVideo] yt-dlp process closed with code:', code);
      if (code !== 0) {
        const errLine = stderrData.split(/[\r\n]+/).find(l => l.includes('ERROR:')) || 'Error downloading video.';
        return reject(new Error(errLine.replace(/^ERROR:\s*/i, '').trim()));
      }
      const lines = stdoutData.split(/[\r\n]+/).map(l => l.trim()).filter(Boolean);
      let finalPath = lines[lines.length - 1];
      console.debug('[downloadVideo] Output video path resolved to:', finalPath);

      if (finalPath && fs.existsSync(finalPath)) {
        finalPath = compressVideoToFit(finalPath, 44 * 1024 * 1024);
      }

      resolve(finalPath || '');
    });
  });
}

/**
 * Ensures a thumbnail image is scaled to Telegram-compliant dimensions (<= 320x320).
 */
export function resizeThumbnailTo320(rawThumbPath: string): string {
  try {
    const resizedPath = rawThumbPath.replace(/\.jpg$/, '_320.jpg');
    execFileSync(FFMPEG_PATH, [
      '-y',
      '-i', rawThumbPath,
      '-vf', 'scale=w=320:h=320:force_original_aspect_ratio=decrease',
      resizedPath
    ], { stdio: ['ignore', 'ignore', 'ignore'] });
    return fs.existsSync(resizedPath) ? resizedPath : rawThumbPath;
  } catch {
    return rawThumbPath;
  }
}

export function extractCover(audioPath: string): string | undefined {
  try {
    const coverPath = path.join(path.dirname(audioPath), `.cover_${Date.now()}.jpg`);
    execFileSync(FFMPEG_PATH, [
      '-y',
      '-i', audioPath,
      '-an',
      '-vcodec', 'copy',
      coverPath
    ], { stdio: ['ignore', 'ignore', 'ignore'] });

    if (fs.existsSync(coverPath) && fs.statSync(coverPath).size > 0) {
      return resizeThumbnailTo320(coverPath);
    }
  } catch {}
  return undefined;
}

/**
 * Embeds a JPG cover image into an MP3 file ID3v2 tags via FFmpeg
 */
export function embedCoverToMp3(mp3Path: string, coverPath: string, title?: string, performer?: string) {
  if (!fs.existsSync(mp3Path) || !fs.existsSync(coverPath)) return;
  const tempPath = mp3Path.replace(/\.mp3$/, `_cover_${Date.now()}.mp3`);
  try {
    const args = [
      '-y',
      '-i', mp3Path,
      '-i', coverPath,
      '-map', '0:0',
      '-map', '1:0',
      '-c', 'copy',
      '-id3v2_version', '3',
      '-metadata:s:v', 'title=Album cover',
      '-metadata:s:v', 'comment=Cover (front)'
    ];
    if (title) {
      args.push('-metadata', `title=${title}`);
    }
    if (performer) {
      args.push('-metadata', `artist=${performer}`);
    }
    args.push(tempPath);

    execFileSync(FFMPEG_PATH, args, { stdio: ['ignore', 'ignore', 'ignore'] });
    if (fs.existsSync(tempPath) && fs.statSync(tempPath).size > 0) {
      fs.copyFileSync(tempPath, mp3Path);
      try { fs.unlinkSync(tempPath); } catch {}
    }
  } catch (err) {
    console.warn('[embedCoverToMp3] failed:', err);
    if (fs.existsSync(tempPath)) {
      try { fs.unlinkSync(tempPath); } catch {}
    }
  }
}

/**
 * Automatically cleans up all temporary thumbnail files, raw covers, and yt-dlp sidecar files
 * associated with a downloaded media file or output directory.
 */
export function cleanupMediaFiles(filePath: string) {
  if (!filePath) return;
  try {
    const dir = path.dirname(filePath);
    const ext = path.extname(filePath);
    const baseName = path.basename(filePath, ext);

    if (fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch {}
    }

    if (!fs.existsSync(dir)) return;

    const files = fs.readdirSync(dir);
    for (const file of files) {
      const fullPath = path.join(dir, file);
      if (
        file.startsWith('.thumb_') ||
        file.startsWith('.cover_') ||
        (baseName && (file.startsWith(baseName) || file.includes(baseName)))
      ) {
        try {
          if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
            fs.unlinkSync(fullPath);
          }
        } catch {}
      }
    }
  } catch (err) {
    console.warn('[cleanupMediaFiles] Error during cleanup:', err);
  }
}

/**
 * Sweeps output directory and removes stale thumbnail files, raw covers, or leftover parts.
 */
export function cleanStaleTempFiles(outputDir: string = 'downloads') {
  if (!fs.existsSync(outputDir)) return;
  try {
    const files = fs.readdirSync(outputDir);
    for (const file of files) {
      if (file === '.' || file === '..') continue;
      const fullPath = path.join(outputDir, file);
      try {
        if (!fs.existsSync(fullPath)) continue;
        const stat = fs.statSync(fullPath);
        if (stat.isFile()) {
          const lower = file.toLowerCase();
          const isTemp = file.startsWith('.') ||
            lower.endsWith('.jpg') || lower.endsWith('.webp') || lower.endsWith('.png') ||
            lower.endsWith('.jpeg') || lower.endsWith('.part') || lower.endsWith('.ytdl');

          if (isTemp) {
            try { fs.unlinkSync(fullPath); } catch {}
          }
        }
      } catch {}
    }
  } catch {}
}
