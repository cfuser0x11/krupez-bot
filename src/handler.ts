import { Context } from 'telegraf';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import * as crypto from 'crypto';
import { initUser } from './db';
import { downloadMedia, downloadVideo, extractCover, resizeThumbnailTo320, embedCoverToMp3 } from './engine';
import { downloadSpotify } from './apps/spotify';
import { scrapeYandexMetadata } from './apps/yandex';
import { sendToUser, sendAlbumToUser, trySendFromCache } from './cache';
import { getUserSettings, getPlatformMode } from './menu';
import { t } from './i18n';
import { findAppForUrl } from './apps';
import { downloadTwitter } from './apps/twitter';

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// Map of URL hashes for "ask" mode callbacks
const askPendingUrls = new Map<string, string>();

function getAskUrlHash(url: string): string {
  const hash = crypto.createHash('md5').update(url).digest('hex').substring(0, 10);
  askPendingUrls.set(hash, url);
  return hash;
}

export function detectPlatform(url: string): 'ytmusic' | 'youtube' | 'tiktok' | 'x' | 'other' {
  if (url.includes('music.youtube.com')) return 'ytmusic';
  if (url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube';
  if (url.includes('tiktok.com')) return 'tiktok';
  if (url.includes('twitter.com') || url.includes('x.com')) return 'x';
  return 'other';
}

export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url.trim());
    if (parsed.hostname.includes('youtube.com') || parsed.hostname.includes('youtu.be')) {
      if (parsed.searchParams.has('si')) parsed.searchParams.delete('si');
      if (parsed.searchParams.has('pp')) parsed.searchParams.delete('pp');
      return parsed.toString();
    }
    if (parsed.hostname.includes('spotify.com')) {
      if (parsed.searchParams.has('si')) parsed.searchParams.delete('si');
      return parsed.toString();
    }
  } catch (e) {}
  return url.trim();
}

export function extractUrlFromCtx(ctx: Context): string | null {
  const msg: any = ctx.message || ctx.channelPost;
  if (!msg) return null;

  const text = msg.text || msg.caption || '';
  const urlMatch = text.match(/https?:\/\/[^\s]+/i);
  if (urlMatch) {
    return urlMatch[0];
  }

  if (msg.reply_to_message) {
    const replyText = msg.reply_to_message.text || msg.reply_to_message.caption || '';
    const replyMatch = replyText.match(/https?:\/\/[^\s]+/i);
    if (replyMatch) {
      return replyMatch[0];
    }
  }

  return null;
}

async function deleteRequestMessage(ctx: Context) {
  // In private chats (DM), NEVER delete user request messages or links
  if (ctx.chat?.type === 'private') {
    return;
  }

  const msg: any = ctx.message || ctx.channelPost || (ctx.update as any)?.edited_channel_post;
  if (!msg) return;

  const text = msg.text || msg.caption || '';
  const isCommand = /^\/(download|d|ddd)(\s+|$)/i.test(text.trim());

  // Only delete if it's an explicit /d, /ddd, or /download command in channels/groups
  if (isCommand && msg.message_id) {
    try {
      await ctx.telegram.deleteMessage(ctx.chat!.id, msg.message_id);
    } catch (e) {}
  }
}

async function deleteStatusMessage(ctx: Context, statusMsgId: number) {
  try {
    await ctx.telegram.deleteMessage(ctx.chat!.id, statusMsgId);
  } catch (e) {
    try {
      const userId = ctx.from?.id || ctx.chat?.id || 0;
      await ctx.telegram.editMessageText(ctx.chat!.id, statusMsgId, undefined, await t(userId, 'done'));
    } catch (e2) {}
  }
}

/**
 * Handle URL download requests for private chats, groups, and channels
 */
export async function handleDownload(ctx: Context, text?: string, overrideMode?: 'video' | 'audio') {
  const userId = ctx.from?.id || ctx.chat?.id || 0;
  await initUser(BigInt(userId));

  const urlText = text || (ctx.message && 'text' in ctx.message ? ctx.message.text : '');
  if (!urlText) {
    console.debug('[handleDownload] Empty urlText received, skipping.');
    return ctx.reply('Please provide a valid link.');
  }

  const cleanUrl = normalizeUrl(urlText);
  const settings = await getUserSettings(userId);
  const platform = detectPlatform(cleanUrl);

  console.debug('[handleDownload] Processing request:', {
    userId,
    chatId: ctx.chat?.id,
    chatType: ctx.chat?.type,
    urlText,
    cleanUrl,
    platform,
    overrideMode
  });

  // Delete request command message BEFORE download in groups/channels
  await deleteRequestMessage(ctx);

  // Check user mode preference if not explicitly overridden by interactive prompt
  if (platform !== 'other' && !overrideMode) {
    const mode = await getPlatformMode(userId, platform);
    if (mode === 'ask') {
      console.debug('[handleDownload] Platform mode is "ask", prompting format choice for:', cleanUrl);
      const hash = getAskUrlHash(cleanUrl);
      const btnVideo = await t(userId, 'mode_video');
      const btnAudio = await t(userId, 'mode_audio');
      await ctx.reply(await t(userId, 'ask_format'), {
        reply_markup: {
          inline_keyboard: [
            [
              { text: btnVideo, callback_data: `askdl_video_${hash}` },
              { text: btnAudio, callback_data: `askdl_audio_${hash}` }
            ]
          ]
        }
      });
      return;
    }
  }

  const userMode = overrideMode || (platform !== 'other' ? await getPlatformMode(userId, platform) : 'audio');
  const isAudioDownload = userMode === 'audio' || cleanUrl.includes('open.spotify.com') || cleanUrl.includes('music.yandex.');
  const requestedType: 'video' | 'audio' = isAudioDownload ? 'audio' : 'video';

  console.debug('[handleDownload] Target download mode resolved:', { userMode, isAudioDownload, requestedType });

  // 1. FAST CACHE CHECK
  ctx.sendChatAction('upload_video').catch(() => {});
  console.debug('[handleDownload] Checking cache database for:', cleanUrl);
  const cacheSent = await trySendFromCache(ctx, cleanUrl, settings, requestedType);
  if (cacheSent) {
    console.debug('[handleDownload] Fast cache HIT! Delivered cached media for:', cleanUrl);
    await deleteRequestMessage(ctx);
    return;
  }

  console.debug('[handleDownload] Cache MISS. Proceeding with active download pipeline.');
  const format = 'mp3';
  const outputDir = settings.outputDir || 'downloads';
  const audioQuality = settings.audio_quality || 'high';

  const processingText = await t(userId, 'processing');
  const initialStatusText = `${processingText} ${SPINNER[0]}`;
  const statusMsg = await ctx.reply(initialStatusText);
  console.debug('[handleDownload] Created status spinner message:', statusMsg.message_id);

  let spinnerIdx = 0;
  let lastProgressText = '';
  let lastEditedText = initialStatusText;

  const updateStatus = async () => {
    const showDebug = settings.show_debug !== false;
    const textToShow = (showDebug && lastProgressText)
      ? `${processingText} ${SPINNER[spinnerIdx]}\n${lastProgressText}`
      : `${processingText} ${SPINNER[spinnerIdx]}`;

    if (textToShow !== lastEditedText) {
      lastEditedText = textToShow;
      try {
        await ctx.telegram.editMessageText(ctx.chat!.id, statusMsg.message_id, undefined, textToShow);
      } catch (e) {}
    }
  };

  const onProgress = (pText: string) => {
    lastProgressText = pText;
    updateStatus();
  };

  const animInterval = setInterval(() => {
    spinnerIdx = (spinnerIdx + 1) % SPINNER.length;
    updateStatus();
  }, 400);

  try {
    const matchedApp = findAppForUrl(cleanUrl);
    if (matchedApp) {
      const appRes = await matchedApp.download(cleanUrl, outputDir, { quality: audioQuality, onProgress });
      clearInterval(animInterval);
      if (appRes && appRes.imagePaths && appRes.imagePaths.length === 1 && !appRes.localPath) {
        appRes.localPath = appRes.imagePaths[0];
        appRes.isVideo = false;
      }
      if (appRes && appRes.imagePaths && appRes.imagePaths.length > 1) {
        const validImages = appRes.imagePaths.filter(p => fs.existsSync(p));
        await sendAlbumToUser(ctx, validImages, cleanUrl, undefined, settings);
        for (const p of validImages) { try { fs.unlinkSync(p); } catch {} }
        try { await ctx.telegram.deleteMessage(ctx.chat!.id, statusMsg.message_id); } catch (e) {}
      } else if (appRes && appRes.localPath && fs.existsSync(appRes.localPath)) {
        const mediaType = appRes.isAudio ? 'audio' : (appRes.isVideo !== false ? 'video' : 'photo');
        await sendToUser(ctx, appRes.localPath, cleanUrl, {
          title: appRes.title,
          artists: appRes.artists,
          album: appRes.album,
          fileName: path.basename(appRes.localPath),
          thumbPath: appRes.thumbPath
        }, settings, mediaType as any);
        try { fs.unlinkSync(appRes.localPath); } catch {}
        await deleteStatusMessage(ctx, statusMsg.message_id);
      }
      await deleteRequestMessage(ctx);
    } else if (isAudioDownload && !cleanUrl.includes('tiktok.com')) {
      if (cleanUrl.includes('music.yandex.')) {
        const yandexMeta = await scrapeYandexMetadata(cleanUrl);
        clearInterval(animInterval);

        const safeTitle = (yandexMeta.title || 'yandex_track').replace(/[\/\\?%*:|"<>]/g, '_');
        const fileName = `${safeTitle}.mp3`;
        const filePath = path.join(outputDir, fileName);

        if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

        const query = `ytsearch1:${yandexMeta.artists} ${yandexMeta.title} audio`.trim();
        const downloadedPath = await downloadMedia({
          url: query,
          format,
          outputDir,
          quality: audioQuality
        });

        if (downloadedPath && fs.existsSync(downloadedPath)) {
          if (path.resolve(downloadedPath) !== path.resolve(filePath)) {
            fs.copyFileSync(downloadedPath, filePath);
            try { fs.unlinkSync(downloadedPath); } catch {}
          }

          let thumbPath: string | undefined;
          if (yandexMeta.thumbnail) {
            try {
              const rawThumb = path.join(outputDir, `.thumb_raw_${Date.now()}.jpg`);
              const thumbWriter = fs.createWriteStream(rawThumb);
              const thumbResponse = await axios({ url: yandexMeta.thumbnail, method: 'GET', responseType: 'stream' });
              await new Promise<void>((resolve, reject) => {
                thumbResponse.data.pipe(thumbWriter);
                thumbWriter.on('finish', resolve);
                thumbWriter.on('error', reject);
              });
              thumbPath = resizeThumbnailTo320(rawThumb);
              if (rawThumb !== thumbPath && fs.existsSync(rawThumb)) {
                try { fs.unlinkSync(rawThumb); } catch {}
              }
            } catch (tErr) {}
          }

          if (thumbPath && fs.existsSync(thumbPath)) {
            embedCoverToMp3(filePath, thumbPath, yandexMeta.title, yandexMeta.artists);
          }

          await sendToUser(ctx, filePath, cleanUrl, {
            title: yandexMeta.title,
            artists: yandexMeta.artists,
            album: yandexMeta.album || 'Unknown',
            fileName,
            thumbPath
          }, settings, 'audio');

          if (thumbPath && fs.existsSync(thumbPath)) {
            try { fs.unlinkSync(thumbPath); } catch {}
          }
          await deleteStatusMessage(ctx, statusMsg.message_id);
          await deleteRequestMessage(ctx);
        } else {
          await ctx.reply('Could not retrieve Yandex Music track.');
        }
      } else {
        // Generic Audio download via yt-dlp (YouTube, YT Music, SoundCloud, X audio)
        const downloadedFilePath = await downloadMedia({
          url: cleanUrl,
          format,
          outputDir,
          quality: audioQuality,
          onProgress
        });

        clearInterval(animInterval);

        if (downloadedFilePath && fs.existsSync(downloadedFilePath)) {
          const fileName = path.basename(downloadedFilePath);
          const coverPath = extractCover(downloadedFilePath);

          await sendToUser(ctx, downloadedFilePath, cleanUrl, {
            fileName,
            thumbPath: coverPath
          }, settings, 'audio');

          if (coverPath && fs.existsSync(coverPath)) {
            try { fs.unlinkSync(coverPath); } catch {}
          }

          await deleteStatusMessage(ctx, statusMsg.message_id);
          await deleteRequestMessage(ctx);
        } else {
          await ctx.reply('Could not retrieve audio file.');
        }
      }
    } else if (cleanUrl.includes('twitter.com') || cleanUrl.includes('x.com')) {
      // Handle X / Twitter Video or Photo Tweets
      let downloadedFilePath = '';
      try {
        downloadedFilePath = await downloadVideo({
          url: cleanUrl,
          outputDir,
          onProgress
        });
      } catch (xErr: any) {
        console.warn('[handleDownload] Twitter video download failed, checking for photos:', xErr?.message || xErr);
      }

      clearInterval(animInterval);

      if (downloadedFilePath && fs.existsSync(downloadedFilePath)) {
        const fileName = path.basename(downloadedFilePath);
        const coverPath = extractCover(downloadedFilePath);

        await sendToUser(ctx, downloadedFilePath, cleanUrl, {
          fileName,
          thumbPath: coverPath
        }, settings, 'video');

        if (coverPath && fs.existsSync(coverPath)) {
          try { fs.unlinkSync(coverPath); } catch {}
        }

        await deleteStatusMessage(ctx, statusMsg.message_id);
        await deleteRequestMessage(ctx);
      } else {
        // Try Twitter photo download via vxtwitter / fxtwitter API
        const photoResult = await downloadTwitter(cleanUrl, outputDir);
        if (photoResult?.imagePaths && photoResult.imagePaths.length > 0) {
          if (photoResult.imagePaths.length === 1) {
            await sendToUser(ctx, photoResult.imagePaths[0], cleanUrl, {
              fileName: path.basename(photoResult.imagePaths[0])
            }, settings, 'video');
          } else {
            await sendAlbumToUser(ctx, photoResult.imagePaths, cleanUrl, undefined, settings);
          }
          await deleteStatusMessage(ctx, statusMsg.message_id);
          await deleteRequestMessage(ctx);
        } else {
          throw new Error('Could not download video or photos from X / Twitter.');
        }
      }
    } else {
      // Handle YouTube Video (MP4)
      let downloadedFilePath = await downloadVideo({
        url: cleanUrl,
        outputDir,
        onProgress
      });

      clearInterval(animInterval);

      if (downloadedFilePath && fs.existsSync(downloadedFilePath)) {
        const fileName = path.basename(downloadedFilePath);
        const coverPath = extractCover(downloadedFilePath);

        await sendToUser(ctx, downloadedFilePath, cleanUrl, {
          fileName,
          thumbPath: coverPath
        }, settings, 'video');

        if (coverPath && fs.existsSync(coverPath)) {
          try { fs.unlinkSync(coverPath); } catch {}
        }

        await deleteStatusMessage(ctx, statusMsg.message_id);
        await deleteRequestMessage(ctx);
      } else {
        await ctx.reply('Download complete, but media file not found.');
      }
    }
  } catch (err: any) {
    clearInterval(animInterval);
    console.error('Error in handleDownload:', err);
    if (statusMsg) {
      await deleteStatusMessage(ctx, statusMsg.message_id);
    }
    const detail = err?.message ? `: ${err.message}` : '';
    await ctx.reply(`${await t(userId, 'error')}${detail}`);
  }
}

export async function handleAskCallback(ctx: Context) {
  const cb = ctx.callbackQuery;
  if (!cb || !('data' in cb)) return;

  const data = cb.data;
  const parts = data.split('_');
  const mode = parts[1] as 'video' | 'audio';
  const hash = parts[2];
  const cleanUrl = askPendingUrls.get(hash);

  try {
    await ctx.answerCbQuery();
    await ctx.deleteMessage();
  } catch {}

  if (!cleanUrl) {
    const userId = ctx.from!.id;
    return await ctx.reply(await t(userId, 'error'));
  }

  await handleDownload(ctx, cleanUrl, mode);
}
