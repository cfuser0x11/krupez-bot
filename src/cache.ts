import { Context } from 'telegraf';
import * as fs from 'fs';
import { prisma } from './db';
import { isAnimationFile, getVideoMetadata, cleanupMediaFiles, cleanStaleTempFiles } from './engine';
import { UserSettings } from './menu';

export const getChannelId = () => process.env.CHANNEL_ID || '';

export interface CacheMeta {
  title?: string;
  artists?: string;
  album?: string;
  fileName?: string;
  thumbPath?: string;
}

// Lazy reference to the bot instance (set in index.ts)
let botRef: any = null;
export function setBotInstance(bot: any) {
  botRef = bot;
}
function getBotInstance() {
  if (!botRef) throw new Error('Bot instance not set');
  return botRef;
}

export function getBotUsername(telegramInput?: any): string {
  const telegram = telegramInput || getBotInstance().telegram;
  const username = telegram.botInfo?.username || botRef?.botInfo?.username;
  return username ? username.toLowerCase() : 'default';
}

export function getFileIdForBot(storedVal: string | null, botKey: string): string | null {
  if (!storedVal) return null;
  if (storedVal.startsWith('{') && storedVal.endsWith('}')) {
    try {
      const map = JSON.parse(storedVal);
      return map[botKey] || map['default'] || null;
    } catch {
      return storedVal;
    }
  }
  const mainBotKey = getBotUsername();
  if (botKey === mainBotKey || botKey === 'default' || mainBotKey === 'default') {
    return storedVal;
  }
  return null;
}

export function updateFileIdMap(currentVal: string | null, newVal: string, botKey: string): string {
  let map: Record<string, string> = {};
  if (currentVal) {
    if (currentVal.startsWith('{') && currentVal.endsWith('}')) {
      try {
        map = JSON.parse(currentVal);
      } catch {
        map = { default: currentVal };
      }
    } else {
      map = { default: currentVal };
    }
  }
  map[botKey] = newVal;
  return JSON.stringify(map);
}

/**
 * Silent import of file_id for a secondary bot via self-forwarding in the shared channel.
 */
export async function importFileIdFromChannel(
  telegram: any,
  messageId: number,
  botKey: string,
  mediaType: 'video' | 'audio' | 'photo',
  sourceUrl: string
): Promise<string | null> {
  const channelId = getChannelId();
  try {
    const forwarded = await telegram.forwardMessage(channelId, channelId, messageId);
    let fileId = forwarded.audio?.file_id || forwarded.document?.file_id || forwarded.video?.file_id || forwarded.animation?.file_id || forwarded.voice?.file_id;
    if (!fileId && Array.isArray(forwarded.photo) && forwarded.photo.length > 0) {
      fileId = forwarded.photo[forwarded.photo.length - 1].file_id;
    }

    // Delete the temporary forwarded message immediately
    await telegram.deleteMessage(channelId, forwarded.message_id).catch(() => { });

    if (fileId) {
      // Save it to the cache so we don't have to import it again!
      if (mediaType === 'audio') {
        await saveToCache(sourceUrl, { audioFileId: fileId }, botKey);
      } else {
        await saveToCache(sourceUrl, { videoFileId: fileId }, botKey);
      }
      return fileId;
    }
  } catch (err: any) {
    console.error(`[importFileIdFromChannel] failed for messageId ${messageId}:`, err?.message || err);
  }
  return null;
}

/**
 * Builds caption for the archive channel: <a href="link">link</a> (no via)
 */
export function buildChannelCaption(sourceUrl: string): string {
  return `<a href="${sourceUrl}">link</a>`;
}

/**
 * Builds caption for user delivery based on user system settings (show_link, show_via)
 */
export function buildUserCaption(sourceUrl: string, settings?: UserSettings): string {
  const parts: string[] = [];
  if (settings?.show_link !== false) {
    parts.push(`<a href="${sourceUrl}">link</a>`);
  }
  if (settings?.show_via !== false) {
    const usernameClean = (process.env.BOT_USERNAME || 'krupezbot').replace(/^@/, '');
    parts.push(`<a href="https://t.me/${usernameClean}">via</a>`);
  }
  return parts.join(' | ');
}

/**
 * Check if a URL was already downloaded and cached.
 */
export async function getCachedItem(sourceUrl: string) {
  return await prisma.cache.findUnique({ where: { sourceUrl } });
}

export async function saveToCache(
  sourceUrl: string,
  data: {
    videoFileId?: string;
    audioFileId?: string;
    videoMessageId?: number;
    audioMessageId?: number;
    title?: string;
    artists?: string;
    album?: string;
    fileName?: string;
  },
  botKey: string = 'default'
) {
  const existing = await getCachedItem(sourceUrl);
  const updatedVideoFileId = data.videoFileId
    ? updateFileIdMap(existing?.videoFileId || null, data.videoFileId, botKey)
    : undefined;
  const updatedAudioFileId = data.audioFileId
    ? updateFileIdMap(existing?.audioFileId || null, data.audioFileId, botKey)
    : undefined;

  return await prisma.cache.upsert({
    where: { sourceUrl },
    update: {
      ...(updatedVideoFileId ? { videoFileId: updatedVideoFileId } : {}),
      ...(updatedAudioFileId ? { audioFileId: updatedAudioFileId } : {}),
      ...(data.videoMessageId ? { videoMessageId: data.videoMessageId } : {}),
      ...(data.audioMessageId ? { audioMessageId: data.audioMessageId } : {}),
      ...(data.title ? { title: data.title } : {}),
      ...(data.artists ? { artists: data.artists } : {}),
      ...(data.album ? { album: data.album } : {}),
      ...(data.fileName ? { fileName: data.fileName } : {})
    },
    create: {
      sourceUrl,
      videoFileId: updatedVideoFileId || null,
      audioFileId: updatedAudioFileId || null,
      videoMessageId: data.videoMessageId || null,
      audioMessageId: data.audioMessageId || null,
      title: data.title || null,
      artists: data.artists || null,
      album: data.album || null,
      fileName: data.fileName || null
    }
  });
}

/**
 * Delete a stale cache entry by sourceUrl if it was deleted from Telegram channel
 */
export async function removeStaleCache(sourceUrl: string) {
  try {
    await prisma.cache.deleteMany({ where: { sourceUrl } });
  } catch { }
}

/**
 * Send media to chat (user or channel)
 */
export async function sendMediaToChat(
  chatId: number | string,
  fileInput: any,
  caption?: string,
  meta?: CacheMeta,
  mediaType?: 'video' | 'audio' | 'photo',
  telegramInput?: any
) {
  const telegram = telegramInput || getBotInstance().telegram;
  const extra: any = {
    caption,
    parse_mode: 'HTML'
  };

  if (meta?.title || meta?.artists) {
    if (meta.title) extra.title = meta.title;
    if (meta.artists) extra.performer = meta.artists;
  }

  if (meta?.thumbPath && fs.existsSync(meta.thumbPath) && typeof fileInput !== 'string') {
    extra.thumbnail = { source: meta.thumbPath };
    extra.thumb = { source: meta.thumbPath };
  }

  const filePath = typeof fileInput === 'string' ? fileInput : (fileInput?.filename || fileInput?.source || '');
  const lowerPath = filePath.toLowerCase();

  // Determine actual type: use explicit mediaType, fallback to extension detection, fallback to 'video'
  let type = mediaType;
  if (!type) {
    if (lowerPath.endsWith('.mp4')) {
      type = 'video';
    } else if (lowerPath.endsWith('.jpg') || lowerPath.endsWith('.jpeg') || lowerPath.endsWith('.png') || lowerPath.endsWith('.webp')) {
      type = 'photo';
    } else if (lowerPath.endsWith('.mp3') || lowerPath.endsWith('.m4a') || lowerPath.endsWith('.ogg')) {
      type = 'audio';
    } else {
      type = 'video'; // default fallback
    }
  }

  try {
    if (type === 'video') {
      const filePath2 = typeof fileInput === 'string' ? fileInput : (fileInput as any).source || '';
      if (filePath2 && fs.existsSync(filePath2)) {
        if (isAnimationFile(filePath2)) {
          return await telegram.sendAnimation(chatId, fileInput as any, extra);
        }
        const vMeta = getVideoMetadata(filePath2);
        if (vMeta.width) extra.width = vMeta.width;
        if (vMeta.height) extra.height = vMeta.height;
        if (vMeta.duration) extra.duration = vMeta.duration;
        extra.supports_streaming = true;
      }
      return await telegram.sendVideo(chatId, fileInput as any, extra);
    } else if (type === 'photo') {
      return await telegram.sendPhoto(chatId, fileInput as any, extra);
    } else {
      return await telegram.sendAudio(chatId, fileInput as any, extra);
    }
  } catch (err: any) {
    if (err?.response?.error_code === 413 || err?.message?.includes('413')) {
      throw new Error('File exceeds Telegram 50MB bot upload limit.');
    }
    if (typeof fileInput !== 'string') {
      const docExtra = { ...extra };
      delete docExtra.title;
      delete docExtra.performer;
      delete docExtra.width;
      delete docExtra.height;
      delete docExtra.duration;
      delete docExtra.supports_streaming;
      return await telegram.sendDocument(chatId, fileInput as any, docExtra);
    }
    throw err;
  }
}

/**
 * Try sending a cached file/album to the user for the requested media type ('video' | 'audio' | 'photo').
 * Returns true if delivery succeeded, or false if not cached or stale.
 */
export async function trySendFromCache(
  ctx: Context,
  sourceUrl: string,
  userSettings?: UserSettings,
  requestedType: 'video' | 'audio' | 'photo' = 'video'
): Promise<boolean> {
  const cached = await getCachedItem(sourceUrl);
  if (!cached) return false;

  const botKey = ctx.botInfo?.username?.toLowerCase() || 'default';
  let audioFileId = getFileIdForBot(cached.audioFileId, botKey);
  let videoFileId = getFileIdForBot(cached.videoFileId, botKey);

  // If we don't have the fileId but have the channel message ID, import it silently!
  if (requestedType === 'audio' && !audioFileId && cached.audioMessageId) {
    audioFileId = await importFileIdFromChannel(ctx.telegram, cached.audioMessageId, botKey, 'audio', sourceUrl);
  } else if (requestedType !== 'audio' && !videoFileId && cached.videoMessageId) {
    videoFileId = await importFileIdFromChannel(ctx.telegram, cached.videoMessageId, botKey, 'video', sourceUrl);
  }

  const userCaption = buildUserCaption(sourceUrl, userSettings);
  const targetChatId = ctx.chat?.id ?? ctx.from?.id;
  if (!targetChatId) return false;

  if (requestedType === 'audio') {
    if (audioFileId) {
      try {
        await sendMediaToChat(targetChatId, audioFileId, userCaption, {
          title: cached.title || undefined,
          artists: cached.artists || undefined,
          album: cached.album || undefined,
          fileName: cached.fileName || undefined
        }, 'audio', ctx.telegram);
        return true;
      } catch (err: any) {
        console.warn(`sendMediaToChat audio failed for fileId ${audioFileId}:`, err?.message || err);
      }
    }
    return false;
  }

  // Requested type === 'video' or 'photo' (includes single video, photo, or photo album)
  if (videoFileId) {
    try {
      if (videoFileId.startsWith('[') || videoFileId.startsWith('{')) {
        let fileIds: string[] = [];
        try {
          const parsed = JSON.parse(videoFileId);
          fileIds = Array.isArray(parsed) ? parsed : (parsed.fileIds || []);
        } catch {
          fileIds = [];
        }

        if (fileIds.length > 0) {
          const mediaGroup = fileIds.map((fId: string, i: number) => ({
            type: 'photo' as const,
            media: fId,
            caption: i === 0 ? userCaption : undefined,
            parse_mode: 'HTML' as const
          }));
          await ctx.telegram.sendMediaGroup(targetChatId, mediaGroup);
          return true;
        }
      } else {
        await sendMediaToChat(targetChatId, videoFileId, userCaption, {
          title: cached.title || undefined,
          artists: cached.artists || undefined,
          album: cached.album || undefined,
          fileName: cached.fileName || undefined
        }, requestedType, ctx.telegram);
        return true;
      }
    } catch (err: any) {
      console.warn(`sendMediaToChat video/photo failed for fileId ${videoFileId}:`, err?.message || err);
    }
  }

  return false;
}

/**
 * Upload a local file to the channel, store the resulting file_id in DB under
 * the appropriate column (video vs audio), then delete local file.
 */
export async function uploadToChannelAndCache(
  localPath: string,
  sourceUrl: string,
  meta: CacheMeta,
  mediaType: 'video' | 'audio' | 'photo' = 'video',
  telegramInput?: any
): Promise<{ fileId: string }> {
  const telegram = telegramInput || getBotInstance().telegram;
  const botKey = getBotUsername(telegram);
  const fileName = meta.fileName || require('path').basename(localPath);
  const channelCaption = buildChannelCaption(sourceUrl);

  const sent = await sendMediaToChat(
    getChannelId(),
    { source: localPath, filename: fileName },
    channelCaption,
    meta,
    mediaType,
    telegram
  );

  let fileId = sent.audio?.file_id || sent.document?.file_id || (sent as any).video?.file_id || (sent as any).animation?.file_id || (sent as any).voice?.file_id;
  if (!fileId && Array.isArray((sent as any).photo) && (sent as any).photo.length > 0) {
    const photos = (sent as any).photo;
    fileId = photos[photos.length - 1].file_id;
  }

  if (!fileId) throw new Error('Failed to get file_id from channel upload');
  const messageId = sent.message_id;

  if (mediaType === 'audio') {
    await saveToCache(sourceUrl, {
      audioFileId: fileId,
      audioMessageId: messageId,
      title: meta.title,
      artists: meta.artists,
      album: meta.album,
      fileName
    }, botKey);
  } else {
    await saveToCache(sourceUrl, {
      videoFileId: fileId,
      videoMessageId: messageId,
      title: meta.title,
      artists: meta.artists,
      album: meta.album,
      fileName
    }, botKey);
  }

  // Delete local file after successful upload
  if (fs.existsSync(localPath)) {
    try { fs.unlinkSync(localPath); } catch { }
  }

  return { fileId };
}

/**
 * Send a file to the user. If it's cached in the channel, send from file_id.
 * Otherwise upload to channel, cache, and send to user.
 */
export async function sendToUser(
  ctx: Context,
  localPath: string,
  sourceUrl: string,
  meta: CacheMeta,
  userSettings?: UserSettings,
  mediaType: 'video' | 'audio' | 'photo' = 'video'
) {
  const userCaption = buildUserCaption(sourceUrl, userSettings);
  try {
    const sentFromCache = await trySendFromCache(ctx, sourceUrl, userSettings, mediaType);
    if (!sentFromCache) {
      const { fileId } = await uploadToChannelAndCache(localPath, sourceUrl, meta, mediaType, ctx.telegram);
      await sendMediaToChat(ctx.chat!.id, fileId, userCaption, meta, mediaType, ctx.telegram);
    }
  } finally {
    if (meta?.thumbPath) {
      cleanupMediaFiles(meta.thumbPath);
    }
    if (localPath) {
      cleanupMediaFiles(localPath);
    }
    cleanStaleTempFiles();
  }
}

/**
 * Sends a multi-photo album (2+ photos) to the user in a single native Telegram MediaGroup message,
 * archiving all photos into the channel as a single native MediaGroup album and caching in DB.
 */
export async function sendAlbumToUser(
  ctx: Context,
  localPaths: string[],
  sourceUrl: string,
  chatId?: number | string,
  userSettings?: UserSettings
) {
  const targetChatId = chatId ?? ctx.chat!.id;
  const botKey = ctx.botInfo?.username?.toLowerCase() || 'default';
  const userCaption = buildUserCaption(sourceUrl, userSettings);
  const channelCaption = buildChannelCaption(sourceUrl);
  const path = require('path');

  try {
    // 1. Try sending from cache if album already uploaded
    const sentFromCache = await trySendFromCache(ctx, sourceUrl, userSettings, 'video');
    if (sentFromCache) return;

    // 2. Not cached: upload all photos to channel as a single native MediaGroup
    const channelMediaGroup = localPaths.map((p, i) => ({
      type: 'photo' as const,
      media: { source: p, filename: path.basename(p) },
      caption: i === 0 ? channelCaption : undefined,
      parse_mode: 'HTML' as const
    }));

    const channelSentMessages: any[] = await ctx.telegram.sendMediaGroup(getChannelId(), channelMediaGroup);
    const fileIds = channelSentMessages.map(m => {
      const photos = m.photo;
      return photos[photos.length - 1].file_id;
    });
    const messageId = channelSentMessages[0]?.message_id;

    // Save album file IDs to Cache DB as JSON array inside the botKey map
    const albumData = JSON.stringify(fileIds);
    const existing = await getCachedItem(sourceUrl);
    const updatedVideoFileId = updateFileIdMap(existing?.videoFileId || null, albumData, botKey);

    await prisma.cache.upsert({
      where: { sourceUrl },
      update: {
        videoFileId: updatedVideoFileId,
        videoMessageId: messageId
      },
      create: {
        sourceUrl,
        videoFileId: updatedVideoFileId,
        videoMessageId: messageId,
        fileName: path.basename(localPaths[0])
      }
    });

    // 3. Deliver to user chat via sendMediaGroup with fileIds + userCaption (respects user settings)
    const userMediaGroup = fileIds.map((fId, i) => ({
      type: 'photo' as const,
      media: fId,
      caption: i === 0 ? userCaption : undefined,
      parse_mode: 'HTML' as const
    }));
    await ctx.telegram.sendMediaGroup(targetChatId, userMediaGroup);
  } finally {
    for (const p of localPaths) {
      cleanupMediaFiles(p);
    }
    cleanStaleTempFiles();
  }
}
