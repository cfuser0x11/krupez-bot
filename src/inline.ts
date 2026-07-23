import { Context } from 'telegraf';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { getCachedItem, buildUserCaption, uploadToChannelAndCache, sendMediaToChat, getChannelId, sendAlbumToUser, trySendFromCache, getFileIdForBot, importFileIdFromChannel } from './cache';
import { normalizeUrl, detectPlatform } from './handler';
import { downloadSpotify } from './apps/spotify';
import { scrapeYandexMetadata } from './apps/yandex';
import { downloadMedia, downloadVideo, extractCover, resizeThumbnailTo320, isAnimationFile, embedCoverToMp3 } from './engine';
import { findAppForUrl } from './apps';
import { getUserSettings, getPlatformMode } from './menu';
import { getUserLang, getText } from './i18n';

// Store in-memory map of short hash -> full URL for pending inline downloads
const pendingUrls = new Map<string, string>();

export function getUrlHash(url: string): string {
  const hash = crypto.createHash('md5').update(url).digest('hex').substring(0, 12);
  pendingUrls.set(hash, url);
  return hash;
}

export function getUrlFromHash(hash: string): string | undefined {
  return pendingUrls.get(hash);
}

/** Detect what kind of inline result type a local file path should map to */
function detectMediaType(filePath: string): 'audio' | 'video' | 'animation' | 'photo' {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.mp3') || lower.endsWith('.m4a') || lower.endsWith('.ogg') || lower.endsWith('.flac')) return 'audio';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.png') || lower.endsWith('.webp')) return 'photo';
  if (lower.endsWith('.mp4')) {
    return isAnimationFile(filePath) ? 'animation' : 'video';
  }
  return 'audio';
}

/** Edit the inline placeholder message in-place to show the downloaded media */
async function editInlineToMedia(
  ctx: Context,
  inlineMessageId: string,
  fileId: string,
  mediaType: 'audio' | 'video' | 'animation' | 'photo',
  caption: string,
  meta?: any
) {
  const payload: any = {
    type: mediaType,
    media: fileId,
    caption,
    parse_mode: 'HTML'
  };
  if (mediaType === 'audio') {
    if (meta?.title) payload.title = meta.title;
    if (meta?.artists) payload.performer = meta.artists;
  }
  try {
    await ctx.telegram.editMessageMedia(undefined, undefined, inlineMessageId, payload as any);
    return true;
  } catch (e: any) {
    console.warn('[editInlineToMedia] failed type=%s fileId=%s err=%s', mediaType, fileId?.substring(0, 20), e?.message || e);
    return false;
  }
}

/** Edit the inline placeholder message to a text notification */
async function editInlineToText(ctx: Context, inlineMessageId: string, text: string) {
  try {
    await (ctx.telegram as any).editMessageText(undefined, undefined, inlineMessageId, text, { parse_mode: 'HTML' });
  } catch (e: any) {
    console.warn('[editInlineToText] failed:', e?.message || e);
  }
}

/**
 * Handles incoming inline queries (@krupezbot <link>)
 */
export async function handleInlineQuery(ctx: Context) {
  try {
    const query = ctx.inlineQuery?.query?.trim() || '';
    const userId = ctx.from?.id;
    const lang = userId ? await getUserLang(userId) : 'en';

    if (!query) {
      return await ctx.answerInlineQuery([], {
        button: { text: getText(lang, 'inline_paste_link'), start_parameter: 'start' }
      });
    }

    const settings = userId ? await getUserSettings(userId) : undefined;
    const cleanUrl = normalizeUrl(query);
    const platform = detectPlatform(cleanUrl);
    const mode = userId && platform !== 'other' ? await getPlatformMode(userId, platform) : 'ask';

    const matchedApp = findAppForUrl(cleanUrl);
    const isVideoLink = cleanUrl.includes('youtube.com') || cleanUrl.includes('youtu.be') || cleanUrl.includes('vimeo.com');
    const isLink = Boolean(matchedApp) || isVideoLink;

    if (!isLink) {
      return await ctx.answerInlineQuery([], { cache_time: 0 });
    }

    const hash = getUrlHash(cleanUrl);
    const userCaption = buildUserCaption(cleanUrl, settings);
    const inlineResults: any[] = [];

    const isSpotify = cleanUrl.includes('spotify.com');
    const isYandex = cleanUrl.includes('music.yandex.');
    const isSoundCloud = cleanUrl.includes('soundcloud.com');
    const isYTMusic = cleanUrl.includes('music.youtube.com');
    const isPinterest = cleanUrl.includes('pinterest.com') || cleanUrl.includes('pin.it');
    const isReddit = cleanUrl.includes('reddit.com') || cleanUrl.includes('redd.it');

    const isAudioOnlyPlatform = isSpotify || isYandex || isSoundCloud;
    const isVideoOnlyPlatform = isPinterest || isReddit;

    const cached = await getCachedItem(cleanUrl);
    const botKey = ctx.botInfo?.username?.toLowerCase() || 'default';
    let audioFileId = cached ? getFileIdForBot(cached.audioFileId, botKey) : null;
    let videoFileId = cached ? getFileIdForBot(cached.videoFileId, botKey) : null;

    if (cached) {
      if (!audioFileId && cached.audioMessageId) {
        audioFileId = await importFileIdFromChannel(ctx.telegram, cached.audioMessageId, botKey, 'audio', cleanUrl);
      }
      if (!videoFileId && cached.videoMessageId) {
        videoFileId = await importFileIdFromChannel(ctx.telegram, cached.videoMessageId, botKey, 'video', cleanUrl);
      }
    }

    // 1. If cached, try returning direct cached audio/video results first (instant direct send)
    if (cached) {
      if (audioFileId && !isVideoOnlyPlatform && (isAudioOnlyPlatform || mode === 'ask' || mode === 'audio' || isYTMusic)) {
        inlineResults.push({
          type: 'audio',
          id: `audio_${hash}`,
          audio_file_id: audioFileId,
          caption: userCaption
        });
      }
      if (videoFileId && !isAudioOnlyPlatform && (isVideoOnlyPlatform || mode === 'ask' || mode === 'video')) {
        const isAlbum = videoFileId.startsWith('{') || videoFileId.startsWith('[');
        if (!isAlbum) {
          inlineResults.push({
            type: 'video',
            id: `video_${hash}`,
            video_file_id: videoFileId,
            title: cached.title || 'Video',
            caption: userCaption
          });
        }
      }
    }

    // 2. If not cached, or as a fallback/alternative, return article placeholders
    if (inlineResults.length === 0) {
      if (!isAudioOnlyPlatform && (isVideoOnlyPlatform || mode === 'ask' || mode === 'video')) {
        inlineResults.push({
          type: 'article',
          id: `dl_video_${hash}`,
          title: getText(lang, 'inline_title_video'),
          description: cleanUrl,
          input_message_content: { message_text: getText(lang, 'inline_downloading_video', { url: cleanUrl }), parse_mode: 'HTML' },
          reply_markup: {
            inline_keyboard: [[{ text: `${getText(lang, 'processing')}...`, callback_data: `inlinedl_${hash}` }]]
          }
        });
      }

      if (!isVideoOnlyPlatform && (isAudioOnlyPlatform || mode === 'ask' || mode === 'audio' || isYTMusic)) {
        inlineResults.push({
          type: 'article',
          id: `dl_audio_${hash}`,
          title: getText(lang, 'inline_title_audio'),
          description: cleanUrl,
          input_message_content: { message_text: getText(lang, 'inline_downloading_audio', { url: cleanUrl }), parse_mode: 'HTML' },
          reply_markup: {
            inline_keyboard: [[{ text: `${getText(lang, 'processing')}...`, callback_data: `inlinedl_${hash}` }]]
          }
        });
      }
    }

    return await ctx.answerInlineQuery(inlineResults, { cache_time: 0, is_personal: false });
  } catch (err) {
    console.warn('[handleInlineQuery] error:', err);
  }
}


/** Helper to deliver single media item in inline mode with in-place edit and DM fallback */
async function deliverInlineMedia(
  ctx: Context,
  inlineMessageId: string | undefined,
  userId: number | undefined,
  fileId: string,
  mediaType: 'photo' | 'video' | 'animation' | 'audio',
  userCaption: string,
  lang: string,
  meta?: any
) {
  if (inlineMessageId) {
    const success = await editInlineToMedia(ctx, inlineMessageId, fileId, mediaType, userCaption, meta);
    if (!success) {
      await editInlineToText(ctx, inlineMessageId, getText(lang, 'inline_error', { error: 'Failed to display media' }));
    }
    return;
  }
  if (userId) {
    await sendMediaToChat(userId, fileId, userCaption, meta, mediaType as any, ctx.telegram);
  }
}

/**
 * Automatically handles chosen inline results (auto-download on selection)
 */
export async function handleChosenInlineResult(ctx: Context) {
  const chosen = ctx.chosenInlineResult;
  if (!chosen) return;

  const resultId = chosen.result_id || '';
  if (resultId.startsWith('audio_') || resultId.startsWith('video_')) return;

  const cleanUrl = normalizeUrl(chosen.query);
  if (!cleanUrl) return;

  const inlineMessageId = chosen.inline_message_id;
  const userId = ctx.from?.id || chosen.from?.id;
  const lang = userId ? await getUserLang(userId) : 'en';
  const settings = userId ? await getUserSettings(userId) : undefined;

  const isExplicitAudio = resultId.startsWith('dl_audio_');
  const isExplicitVideo = resultId.startsWith('dl_video_');
  const platform = detectPlatform(cleanUrl);
  const mode = userId && platform !== 'other' ? await getPlatformMode(userId, platform) : 'video';
  const targetType: 'video' | 'audio' = isExplicitAudio ? 'audio' : (isExplicitVideo ? 'video' : (mode === 'audio' ? 'audio' : 'video'));

  const userCaption = buildUserCaption(cleanUrl, settings);

  const cached = await getCachedItem(cleanUrl);
  if (cached) {
    if (targetType === 'audio' && cached.audioFileId) {
      await deliverInlineMedia(ctx, inlineMessageId, userId, cached.audioFileId, 'audio', userCaption, lang, { title: cached.title || undefined, artists: cached.artists || undefined });
      return;
    }

    if (targetType === 'video' && cached.videoFileId) {
      const isAlbum = cached.videoFileId.startsWith('{') || cached.videoFileId.startsWith('[');
      if (inlineMessageId && !isAlbum) {
        const mediaType = detectMediaType(cached.fileName || '');
        const success = await editInlineToMedia(ctx, inlineMessageId, cached.videoFileId, mediaType, userCaption);
        if (success) return;
      }
      const sentFromCache = await trySendFromCache(ctx, cleanUrl, settings, 'video');
      if (sentFromCache) {
        if (inlineMessageId && isAlbum) {
          const dmText = getText(lang, 'inline_album_dm');
          await editInlineToText(ctx, inlineMessageId, userCaption ? `${dmText}\n${userCaption}` : dmText);
        }
        return;
      }
    }
  }

  // --- 2. Fresh download for targetType ---
  const outputDir = 'downloads';
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  try {
    if (targetType === 'audio') {
      // DOWNLOAD AUDIO
      const isSpotify = cleanUrl.includes('open.spotify.com');
      const isYandex = cleanUrl.includes('music.yandex.');
      const isYTMusic = cleanUrl.includes('music.youtube.com');

      let downloadedFilePath = '';
      let meta: any = {};

      if (isSpotify) {
        const appRes = await downloadSpotify(cleanUrl, outputDir);
        if (appRes.localPath && fs.existsSync(appRes.localPath)) {
          downloadedFilePath = appRes.localPath;
          meta = {
            title: appRes.title,
            artists: appRes.artists,
            album: appRes.album || 'Spotify',
            fileName: path.basename(appRes.localPath),
            thumbPath: appRes.thumbPath
          };
        }
      } else if (isYandex) {
        const yMeta = await scrapeYandexMetadata(cleanUrl);
        const safeTitle = (yMeta.title || 'track').replace(/[\/\\?%*:|"<>]/g, '_');
        const fileName = `${safeTitle}.mp3`;
        const filePath = path.join(outputDir, fileName);
        const query = `ytsearch1:${yMeta.artists} ${yMeta.title} audio`.trim();

        const dp = await downloadMedia({ url: query, format: 'mp3', outputDir, quality: 'high' });
        if (dp && fs.existsSync(dp)) {
          if (path.resolve(dp) !== path.resolve(filePath)) {
            fs.copyFileSync(dp, filePath);
            try { fs.unlinkSync(dp); } catch {}
          }
          downloadedFilePath = filePath;

          let thumbPath: string | undefined;
          if (yMeta.thumbnail) {
            try {
              const rawThumb = path.join(outputDir, `.thumb_raw_${Date.now()}.jpg`);
              const thumbWriter = fs.createWriteStream(rawThumb);
              const thumbResponse = await axios({ url: yMeta.thumbnail, method: 'GET', responseType: 'stream' });
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
            embedCoverToMp3(filePath, thumbPath, yMeta.title, yMeta.artists);
          }

          meta = { title: yMeta.title, artists: yMeta.artists, album: yMeta.album || 'Unknown', fileName, thumbPath };
        }
      } else {
        const userFmt = 'mp3';
        const dp = await downloadMedia({ url: cleanUrl, format: userFmt, outputDir, quality: 'high' });
        if (dp && fs.existsSync(dp)) {
          downloadedFilePath = dp;
          const coverPath = extractCover(dp);
          if (coverPath && fs.existsSync(coverPath)) {
            embedCoverToMp3(dp, coverPath);
          }
          meta = { fileName: path.basename(dp), thumbPath: coverPath };
        }
      }

      if (!downloadedFilePath || !fs.existsSync(downloadedFilePath)) {
        throw new Error('Could not download audio');
      }

      const { fileId } = await uploadToChannelAndCache(downloadedFilePath, cleanUrl, meta, 'audio', ctx.telegram);
      await deliverInlineMedia(ctx, inlineMessageId, userId, fileId, 'audio', userCaption, lang, meta);
      return;
    } else {
      // DOWNLOAD VIDEO / PHOTO
      const matchedApp = findAppForUrl(cleanUrl);
      if (matchedApp) {
        const appRes = await matchedApp.download(cleanUrl, outputDir);
        if (appRes.imagePaths && appRes.imagePaths.length > 1) {
          const validImages = appRes.imagePaths.filter(p => fs.existsSync(p));
          try {
            await sendAlbumToUser(ctx, validImages, cleanUrl, userId, settings);
          } finally {
            for (const p of validImages) { try { fs.unlinkSync(p); } catch {} }
            if (inlineMessageId) await editInlineToText(ctx, inlineMessageId, getText(lang, 'inline_album_dm') + (userCaption ? `\n${userCaption}` : ''));
          }
        } else if (appRes.localPath && fs.existsSync(appRes.localPath)) {
          const mediaType = appRes.isAudio ? 'audio' : (appRes.isVideo !== false ? 'video' : 'photo');
          const { fileId } = await uploadToChannelAndCache(appRes.localPath, cleanUrl, {
            fileName: path.basename(appRes.localPath),
            title: appRes.title,
            artists: appRes.artists,
            album: appRes.album
          }, mediaType as any, ctx.telegram);
          await deliverInlineMedia(ctx, inlineMessageId, userId, fileId, mediaType as any, userCaption, lang, { title: appRes.title, artists: appRes.artists });
        }
        return;
      }

      // Generic Video Download (YouTube, Vimeo, etc.)
      const dlPath = await downloadVideo({ url: cleanUrl, outputDir });
      if (!dlPath || !fs.existsSync(dlPath)) throw new Error('Video download failed');

      const mediaType = detectMediaType(dlPath);
      const { fileId } = await uploadToChannelAndCache(dlPath, cleanUrl, { fileName: path.basename(dlPath) }, 'video', ctx.telegram);
      await deliverInlineMedia(ctx, inlineMessageId, userId, fileId, mediaType, userCaption, lang);
      return;
    }
  } catch (err: any) {
    console.error('[DEBUG handleChosenInlineResult] FAILED:', err);
    if (inlineMessageId) {
      try { await editInlineToText(ctx, inlineMessageId, getText(lang, 'inline_error', { error: err?.message || 'Download failed' })); } catch {}
    }
  }
}

/**
 * Optional fallback for callback query button clicks (`inlinedl_<hash>`)
 */
export async function handleInlineDownloadCallback(ctx: Context) {
  const cb = ctx.callbackQuery;
  if (!cb || !('data' in cb)) return;
  const data = cb.data;
  const hash = data.replace('inlinedl_', '');
  const cleanUrl = getUrlFromHash(hash) || '';
  if (!cleanUrl) return ctx.answerCbQuery('Link not found or expired.', { show_alert: true });
  await ctx.answerCbQuery('Downloading started...');
}
