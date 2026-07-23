import { Context } from 'telegraf';
import { initUser, prisma } from './db';
import { getUserLang, getText } from './i18n';
import { getDownloaderVersionInfo } from './engine';
import { getAllApps } from './apps';

export interface UserSettings {
  format?: 'mp3' | 'm4a' | 'flac' | 'wav' | 'aac';
  quality?: string;
  outputDir?: string;
  ytmusic_mode?: 'video' | 'audio' | 'ask';
  youtube_mode?: 'video' | 'audio' | 'ask';
  tiktok_mode?: 'video' | 'audio' | 'ask';
  x_mode?: 'video' | 'audio' | 'ask';
  pinterest_mode?: 'video' | 'audio' | 'ask';
  audio_quality?: 'high' | 'medium' | 'low';
  video_quality?: '1080' | '720' | '480';
  show_debug?: boolean;
  show_link?: boolean;
  show_via?: boolean;
  cawaii_mode?: boolean;
}

const DEFAULT_PLATFORM_MODES: Record<string, 'video' | 'audio' | 'ask'> = {
  ytmusic: 'audio',
  youtube: 'video',
  tiktok: 'video',
  x: 'video',
  pinterest: 'video'
};

export async function getUserSettings(telegramId: bigint | number): Promise<UserSettings> {
  const user = await initUser(BigInt(telegramId));
  try {
    return JSON.parse(user.settings || '{}');
  } catch {
    return {};
  }
}

export async function getPlatformMode(
  telegramId: bigint | number,
  platform: 'ytmusic' | 'youtube' | 'tiktok' | 'x' | 'pinterest'
): Promise<'video' | 'audio' | 'ask'> {
  const settings = await getUserSettings(telegramId);
  const key = `${platform}_mode` as keyof UserSettings;
  return (settings[key] as 'video' | 'audio' | 'ask') || DEFAULT_PLATFORM_MODES[platform] || 'video';
}

export async function updateUserSettings(
  telegramId: bigint | number,
  newSettings: Partial<UserSettings>
) {
  const user = await initUser(BigInt(telegramId));
  let currentSettings: UserSettings = {};
  try {
    currentSettings = JSON.parse(user.settings || '{}');
  } catch {}

  const updated = { ...currentSettings, ...newSettings };
  await prisma.user.update({
    where: { telegramId: BigInt(telegramId) },
    data: { settings: JSON.stringify(updated) }
  });
  return updated;
}

export async function setUserLang(telegramId: bigint | number, lang: 'en' | 'ru') {
  await prisma.user.update({
    where: { telegramId: BigInt(telegramId) },
    data: { language: lang }
  });
}

function check(active: boolean): string {
  return active ? ' [x]' : '';
}

/**
 * Render Main Menu with Downloader Debug Info and Button Previews (1x vertical layout)
 */
export async function showMainMenu(ctx: Context, isEdit = false) {
  const userId = ctx.from!.id;
  const lang = await getUserLang(userId);
  const settings = await getUserSettings(userId);
  const versions = getDownloaderVersionInfo();

  const pkg = require('../package.json');
  const pkgVersion = pkg.version || '1.5.0';
  const fmt = (settings.format || 'mp3').toUpperCase();
  const vQ = settings.video_quality || '720';

  const fullText = `<b>krupez downloader v${pkgVersion} prod</b>

<b>yt-dlp:</b> v${versions.ytdlpVersion} (spawn, --newline, --progress)
<b>ffmpeg:</b> ${versions.ffmpegVersion}`;

  const keyboard = {
    inline_keyboard: [
      [{ text: `${getText(lang, 'menu_btn_language')} [${lang.toUpperCase()}]`, callback_data: 'menu_lang' }],
      [{ text: getText(lang, 'menu_btn_apps'), callback_data: 'menu_apps' }],
      [{ text: `${getText(lang, 'menu_audio_btn')} [${fmt}]`, callback_data: 'menu_audio' }],
      [{ text: `${getText(lang, 'menu_video_btn')} [${vQ}p]`, callback_data: 'menu_video' }],
      [{ text: 'Info', callback_data: 'menu_info' }],
      [{ text: getText(lang, 'menu_system_btn'), callback_data: 'menu_system' }]
    ]
  };

  if (isEdit) {
    try {
      await ctx.editMessageText(fullText, { reply_markup: keyboard, parse_mode: 'HTML' });
      return;
    } catch {}
  }
  await ctx.reply(fullText, { reply_markup: keyboard, parse_mode: 'HTML' });
}

/**
 * Language Submenu (1x vertical layout)
 */
export async function showLanguageMenu(ctx: Context) {
  const userId = ctx.from!.id;
  const lang = await getUserLang(userId);
  const title = getText(lang, 'language_title');

  const keyboard = {
    inline_keyboard: [
      [{ text: `Русский${check(lang === 'ru')}`, callback_data: 'lang_ru' }],
      [{ text: `English${check(lang === 'en')}`, callback_data: 'lang_en' }],
      [{ text: getText(lang, 'back'), callback_data: 'menu_main' }]
    ]
  };

  try {
    await ctx.editMessageText(title, { reply_markup: keyboard, parse_mode: 'HTML' });
  } catch {}
}

/**
 * Apps List Submenu (1x vertical layout)
 */
export async function showAppsMenu(ctx: Context) {
  const userId = ctx.from!.id;
  const lang = await getUserLang(userId);
  const title = getText(lang, 'apps_title');

  const ytmusicMode = await getPlatformMode(userId, 'ytmusic');
  const youtubeMode = await getPlatformMode(userId, 'youtube');
  const tiktokMode = await getPlatformMode(userId, 'tiktok');
  const xMode = await getPlatformMode(userId, 'x');

  const getModeTag = (mode: string) => {
    if (mode === 'audio') return 'A';
    if (mode === 'video') return 'V';
    if (mode === 'ask') return 'C';
    return 'V';
  };

  const keyboard = {
    inline_keyboard: [
      [{ text: `${getText(lang, 'platform_ytmusic')} [${getModeTag(ytmusicMode)}]`, callback_data: 'app_ytmusic' }],
      [{ text: `${getText(lang, 'platform_youtube')} [${getModeTag(youtubeMode)}]`, callback_data: 'app_youtube' }],
      [{ text: `${getText(lang, 'platform_tiktok')} [${getModeTag(tiktokMode)}]`, callback_data: 'app_tiktok' }],
      [{ text: `${getText(lang, 'platform_x')} [${getModeTag(xMode)}]`, callback_data: 'app_x' }],
      [{ text: getText(lang, 'back'), callback_data: 'menu_main' }]
    ]
  };

  try {
    await ctx.editMessageText(title, { reply_markup: keyboard, parse_mode: 'HTML' });
  } catch {}
}

/**
 * Platform Mode Submenu (1x vertical layout)
 */
export async function showPlatformMenu(
  ctx: Context,
  platform: 'ytmusic' | 'youtube' | 'tiktok' | 'x'
) {
  const userId = ctx.from!.id;
  const lang = await getUserLang(userId);
  const currentMode = await getPlatformMode(userId, platform);

  const platformNameKey = `platform_${platform}`;
  const platformName = getText(lang, platformNameKey);
  const title = getText(lang, 'mode_select', { platform: platformName });

  const keyboard = {
    inline_keyboard: [
      [{ text: `${getText(lang, 'mode_video')}${check(currentMode === 'video')}`, callback_data: `mode_${platform}_video` }],
      [{ text: `${getText(lang, 'mode_audio')}${check(currentMode === 'audio')}`, callback_data: `mode_${platform}_audio` }],
      [{ text: `${getText(lang, 'mode_ask')}${check(currentMode === 'ask')}`, callback_data: `mode_${platform}_ask` }],
      [{ text: getText(lang, 'back'), callback_data: 'menu_apps' }]
    ]
  };

  try {
    await ctx.editMessageText(title, { reply_markup: keyboard, parse_mode: 'HTML' });
  } catch {}
}

/**
 * Submenu for Audio Settings (Format & Quality)
 */
export async function showAudioSettingsMenu(ctx: Context) {
  const userId = ctx.from!.id;
  const lang = await getUserLang(userId);
  const settings = await getUserSettings(userId);

  const audioFmt = 'MP3';
  const audioQ = (settings.audio_quality || 'high').toUpperCase();

  const title = `<b>${getText(lang, 'audio_settings_title')}</b>`;

  const keyboard = {
    inline_keyboard: [
      [{ text: `${getText(lang, 'audio_format_title')} [${audioFmt}]`, callback_data: 'menu_fmt_disabled' }],
      [{ text: `${getText(lang, 'audio_quality_title')} [${audioQ}]`, callback_data: 'menu_audio_q' }],
      [{ text: getText(lang, 'back'), callback_data: 'menu_main' }]
    ]
  };

  try {
    await ctx.editMessageText(title, { reply_markup: keyboard, parse_mode: 'HTML' });
  } catch {}
}

/**
 * Submenu for Video Settings (Resolution)
 */
export async function showVideoSettingsMenu(ctx: Context) {
  const userId = ctx.from!.id;
  const lang = await getUserLang(userId);
  const settings = await getUserSettings(userId);

  const videoQ = settings.video_quality || '720';

  const title = `<b>${getText(lang, 'video_settings_title')}</b>`;

  const keyboard = {
    inline_keyboard: [
      [{ text: `${getText(lang, 'video_quality_title')} [${videoQ}p]`, callback_data: 'menu_video_q' }],
      [{ text: getText(lang, 'back'), callback_data: 'menu_main' }]
    ]
  };

  try {
    await ctx.editMessageText(title, { reply_markup: keyboard, parse_mode: 'HTML' });
  } catch {}
}

/**
 * Submenu for System Settings (Debug Info, Show Link, Show Via)
 */
export async function showSystemMenu(ctx: Context) {
  const userId = ctx.from!.id;
  const lang = await getUserLang(userId);
  const settings = await getUserSettings(userId);

  const showDebug = settings.show_debug !== false;
  const showLink = settings.show_link !== false;
  const showVia = settings.show_via !== false;
  const isCawaii = settings.cawaii_mode === true;

  const title = `<b>${getText(lang, 'system_title')}</b>`;

  const keyboard = {
    inline_keyboard: [
      [{ text: `${getText(lang, 'sys_debug_label')}${check(showDebug)}`, callback_data: 'sys_toggle_debug' }],
      [{ text: `${getText(lang, 'sys_link_label')}${check(showLink)}`, callback_data: 'sys_toggle_link' }],
      [{ text: `${getText(lang, 'sys_via_label')}${check(showVia)}`, callback_data: 'sys_toggle_via' }],
      [{ text: `${getText(lang, 'sys_cawaii_label')}${check(isCawaii)}`, callback_data: 'sys_toggle_cawaii' }],
      [{ text: getText(lang, 'sys_clear_chat_label'), callback_data: 'sys_clear_chat' }],
      [{ text: getText(lang, 'back'), callback_data: 'menu_main' }]
    ]
  };

  try {
    await ctx.editMessageText(title, { reply_markup: keyboard, parse_mode: 'HTML' });
  } catch {}
}

/**
 * Submenu for Audio Format (1x vertical layout)
 */
export async function showAudioFormatMenu(ctx: Context) {
  const userId = ctx.from!.id;
  const lang = await getUserLang(userId);
  const settings = await getUserSettings(userId);
  const fmt = (settings.format || 'mp3').toLowerCase();

  const title = `<b>${getText(lang, 'audio_format_title')}</b>`;

  const keyboard = {
    inline_keyboard: [
      [{ text: `MP3${check(fmt === 'mp3')}`, callback_data: 'fmt_mp3' }],
      [{ text: `M4A${check(fmt === 'm4a')}`, callback_data: 'fmt_m4a' }],
      [{ text: `FLAC${check(fmt === 'flac')}`, callback_data: 'fmt_flac' }],
      [{ text: `WAV${check(fmt === 'wav')}`, callback_data: 'fmt_wav' }],
      [{ text: `AAC${check(fmt === 'aac')}`, callback_data: 'fmt_aac' }],
      [{ text: getText(lang, 'back'), callback_data: 'menu_audio' }]
    ]
  };

  try {
    await ctx.editMessageText(title, { reply_markup: keyboard, parse_mode: 'HTML' });
  } catch {}
}

/**
 * Submenu for Audio Quality (1x vertical layout)
 */
export async function showAudioQualityMenu(ctx: Context) {
  const userId = ctx.from!.id;
  const lang = await getUserLang(userId);
  const settings = await getUserSettings(userId);
  const audioQ = settings.audio_quality || 'high';

  const title = `<b>${getText(lang, 'audio_quality_title')}</b>`;

  const keyboard = {
    inline_keyboard: [
      [{ text: `High${check(audioQ === 'high')}`, callback_data: 'q_audio_high' }],
      [{ text: `Med${check(audioQ === 'medium')}`, callback_data: 'q_audio_medium' }],
      [{ text: `Low${check(audioQ === 'low')}`, callback_data: 'q_audio_low' }],
      [{ text: getText(lang, 'back'), callback_data: 'menu_audio' }]
    ]
  };

  try {
    await ctx.editMessageText(title, { reply_markup: keyboard, parse_mode: 'HTML' });
  } catch {}
}

/**
 * Submenu for Video Quality (1x vertical layout)
 */
export async function showVideoQualityMenu(ctx: Context) {
  const userId = ctx.from!.id;
  const lang = await getUserLang(userId);
  const settings = await getUserSettings(userId);
  const videoQ = settings.video_quality || '720';

  const title = `<b>${getText(lang, 'video_quality_title')}</b>`;

  const keyboard = {
    inline_keyboard: [
      [{ text: `1080p${check(videoQ === '1080')}`, callback_data: 'q_video_1080' }],
      [{ text: `720p${check(videoQ === '720')}`, callback_data: 'q_video_720' }],
      [{ text: `480p${check(videoQ === '480')}`, callback_data: 'q_video_480' }],
      [{ text: getText(lang, 'back'), callback_data: 'menu_video' }]
    ]
  };

  try {
    await ctx.editMessageText(title, { reply_markup: keyboard, parse_mode: 'HTML' });
  } catch {}
}

export async function showQualityMenu(ctx: Context) {
  return showAudioSettingsMenu(ctx);
}

export async function getInfoText(userId: bigint | number): Promise<string> {
  const lang = await getUserLang(userId);
  const loadedModules = getAllApps().map(app => app.name).join(', ');

  const versions = getDownloaderVersionInfo();
  const pkg = require('../package.json');
  const telegrafVer = (pkg.dependencies?.['telegraf'] || pkg.devDependencies?.['telegraf'])?.replace(/[\^~]/g, '') || 'unknown';
  const prismaVer = (pkg.dependencies?.['prisma'] || pkg.devDependencies?.['prisma'] || pkg.dependencies?.['@prisma/client'] || pkg.devDependencies?.['@prisma/client'])?.replace(/[\^~]/g, '') || 'unknown';

  return getText(lang, 'info_template', {
    ytdlp: versions.ytdlpVersion,
    ffmpeg: versions.ffmpegVersion,
    telegraf: telegrafVer,
    prisma: prismaVer,
    modules: loadedModules
  });
}

export async function showInfoMenu(ctx: Context, isEdit = false) {
  const userId = ctx.from!.id;
  const lang = await getUserLang(userId);
  const title = await getInfoText(userId);

  const keyboard = {
    inline_keyboard: [
      [{ text: getText(lang, 'back'), callback_data: 'menu_main' }]
    ]
  };

  if (isEdit) {
    try {
      await ctx.editMessageText(title, { reply_markup: keyboard, parse_mode: 'HTML' });
      return;
    } catch {}
  }
  await ctx.reply(title, { reply_markup: keyboard, parse_mode: 'HTML' });
}
