import { Telegraf } from 'telegraf';
import * as dotenv from 'dotenv';
import { initUser } from './db';
import { setBotInstance } from './cache';
import { handleDownload, handleAskCallback, extractUrlFromCtx } from './handler';
import {
  showMainMenu,
  showLanguageMenu,
  showAppsMenu,
  showPlatformMenu,
  showQualityMenu,
  showAudioSettingsMenu,
  showVideoSettingsMenu,
  showSystemMenu,
  showAudioFormatMenu,
  showAudioQualityMenu,
  showVideoQualityMenu,
  setUserLang,
  updateUserSettings,
  getUserSettings,
  showInfoMenu,
  getInfoText
} from './menu';
import { getUserLang, getText, t } from './i18n';
import { handleInlineQuery, handleChosenInlineResult, handleInlineDownloadCallback } from './inline';
import { cleanStaleTempFiles } from './engine';
import { initLogger } from './logger';

dotenv.config();
initLogger();

const tokens: string[] = [];
const isMultiple = process.env.MULTIPLE_TOKENS === 'true';

if (isMultiple) {
  if (process.env.BOT_TOKEN) {
    tokens.push(process.env.BOT_TOKEN);
  }
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('BOT_TOKEN_') && process.env[key]) {
      tokens.push(process.env[key]!);
    }
  }
} else {
  if (process.env.BOT_TOKEN) {
    tokens.push(process.env.BOT_TOKEN);
  }
}

const uniqueTokens = Array.from(new Set(tokens.filter(Boolean)));

if (uniqueTokens.length === 0) {
  throw new Error('No bot tokens defined in .env file (check BOT_TOKEN or BOT_TOKEN_*)');
}

const bots: Telegraf[] = [];

for (const tok of uniqueTokens) {
  const b = new Telegraf(tok, {
    handlerTimeout: 600000
  });
  bots.push(b);
}

// Set the default bot reference in cache.ts to the first bot instance
setBotInstance(bots[0]);

/* Intercept and log all outbound Telegram Bot API calls for each bot */
for (let i = 0; i < bots.length; i++) {
  const b = bots[i];
  const originalCallApi = b.telegram.callApi.bind(b.telegram);
  (b.telegram as any).callApi = function (method: any, data: any) {
    try {
      const cleanData = JSON.parse(
        JSON.stringify(data, (key, value) => {
          if (value && typeof value === 'object') {
            if (value.source || value.pipe || value._readableState) {
              return '[File Stream/Buffer]';
            }
          }
          if (typeof value === 'string' && value.length > 500) {
            return value.substring(0, 500) + '... [TRUNCATED]';
          }
          return value;
        })
      );
      console.debug(`[BOT #${i} OUTBOUND] Method: ${method}, Payload:`, JSON.stringify(cleanData, null, 2));
    } catch (e) {
      console.debug(`[BOT #${i} OUTBOUND] Method: ${method} (Payload serialization failed)`);
    }
    return originalCallApi(method, data);
  };
}

for (const b of bots) {
  const botIdx = bots.indexOf(b);

  /* Global Debug Middleware Logger */
  b.use(async (ctx, next) => {
    console.debug(`[BOT #${botIdx} DEBUG UPDATE] Type: ${ctx.updateType}`, JSON.stringify(ctx.update, null, 2));
    return next();
  });

  const BLOCKED_CHAT_IDS = ['-1004455844876', -1004455844876];

  /* Blocked Chats Middleware */
  b.use(async (ctx, next) => {
    const chatId = ctx.chat?.id;
    if (chatId && (BLOCKED_CHAT_IDS.includes(chatId as any) || BLOCKED_CHAT_IDS.includes(String(chatId)))) {
      console.log(`[BOT #${botIdx} BLOCKED] Update ignored for blocked channel/chat: ${chatId}`);
      return;
    }
    return next();
  });

  /* Restrict menu interactions to private chats only */
  b.use(async (ctx, next) => {
    if (ctx.callbackQuery && ctx.chat?.type !== 'private') {
      const data = (ctx.callbackQuery as any).data || '';
      if (data.startsWith('askdl_') || data.startsWith('inlinedl_')) {
        return next();
      }
      await ctx.answerCbQuery('Method not allowed.', { show_alert: true });
      return;
    }
    return next();
  });

  /* Global Error Catchers */
  b.catch((err, ctx) => {
    console.error(`Telegraf error on BOT #${botIdx} for update ${ctx?.updateType}:`, err);
  });

  /* /start command */
  b.start(async (ctx) => {
    await initUser(BigInt(ctx.from.id));
    const startMsg = await t(ctx.from.id, 'start');
    ctx.reply(startMsg);
  });

  /* /menu and /settings commands (Private chats only) */
  b.command(['menu', 'settings'], async (ctx) => {
    if (ctx.chat?.type !== 'private') {
      ctx.deleteMessage().catch(() => {});
      return;
    }
    await initUser(BigInt(ctx.from.id));
    await showMainMenu(ctx);
  });

  /* /info command (All chats) */
  b.command('info', async (ctx) => {
    const userId = ctx.from?.id || 0;
    if (userId) {
      await initUser(BigInt(userId));
    }
    const infoText = await getInfoText(userId);
    await ctx.reply(infoText, { parse_mode: 'HTML' });
  });

  /* Handle commands and download links in channels (channel_post / edited_channel_post) */
  b.on(['channel_post', 'edited_channel_post'], async (ctx) => {
    const post = ctx.channelPost || (ctx.update as any)?.edited_channel_post;
    const text = post && 'text' in post ? post.text : (post && 'caption' in post ? post.caption : '');
    if (!text) return;

    const botUsername = ctx.botInfo?.username;
    const infoPattern = botUsername ? new RegExp(`^/info(@${botUsername})?(\\s+|$)`, 'i') : /^\/info(\s+|$)/i;
    if (infoPattern.test(text.trim())) {
      const infoText = await getInfoText(0);
      await ctx.reply(infoText, { parse_mode: 'HTML' });
      return;
    }

    const dlPattern = botUsername
      ? new RegExp(`^/(download|d|ddd)(@${botUsername})?(\\s+|$)(.*)`, 'i')
      : /^\/(download|d|ddd)(\s+|$)(.*)/i;

    const match = text.trim().match(dlPattern);
    if (match) {
      const cmd = match[1].toLowerCase();
      const isExplicitAudio = cmd === 'd';
      const isExplicitVideo = cmd === 'ddd';
      const requestedMode = isExplicitAudio ? 'audio' : (isExplicitVideo ? 'video' : undefined);

      const url = extractUrlFromCtx(ctx);
      if (url) {
        await handleDownload(ctx, url, requestedMode);
      }
    } else {
      const url = extractUrlFromCtx(ctx);
      if (url && (text.includes('http://') || text.includes('https://'))) {
        await handleDownload(ctx, url);
      }
    }
  });

  /* /clear command (Private chats only) */
  b.command('clear', async (ctx) => {
    if (ctx.chat?.type !== 'private') {
      ctx.deleteMessage().catch(() => {});
      return;
    }

    const chatId = ctx.chat.id;
    const currentMsgId = ctx.message.message_id;

    if (chatId && currentMsgId) {
      const minMsgId = Math.max(1, currentMsgId - 500);
      const maxMsgId = currentMsgId + 200;
      const allIds: number[] = [];

      // Add message IDs after command (newer messages)
      for (let msgId = currentMsgId; msgId <= maxMsgId; msgId++) {
        allIds.push(msgId);
      }
      // Add message IDs before command (older messages)
      for (let msgId = currentMsgId - 1; msgId >= minMsgId; msgId--) {
        allIds.push(msgId);
      }

      const chunkSize = 100;
      const batchPromises: Promise<any>[] = [];
      for (let i = 0; i < allIds.length; i += chunkSize) {
        const chunk = allIds.slice(i, i + chunkSize);
        batchPromises.push(
          (ctx.telegram as any).deleteMessages(chatId, chunk).catch(async () => {
            await Promise.all(chunk.map(id => ctx.telegram.deleteMessage(chatId, id).catch(() => {})));
          })
        );
      }
      await Promise.all(batchPromises);
    }
  });

  /* /download, /d, /ddd commands */
  b.command(['download', 'd', 'ddd'], async (ctx) => {
    const url = extractUrlFromCtx(ctx);
    if (url) {
      const isExplicitAudio = ctx.message.text.startsWith('/d ');
      const isExplicitVideo = ctx.message.text.startsWith('/ddd ');
      const requestedMode = isExplicitAudio ? 'audio' : (isExplicitVideo ? 'video' : undefined);
      await handleDownload(ctx, url, requestedMode);
    } else {
      const lang = await getUserLang(ctx.from.id);
      await ctx.reply(getText(lang, 'inline_paste_link'));
    }
  });

  /* Settings Menu Callbacks */
  b.action('menu_main', async (ctx) => {
    await ctx.answerCbQuery();
    await showMainMenu(ctx, true);
  });

  b.action('menu_lang', async (ctx) => {
    await ctx.answerCbQuery();
    await showLanguageMenu(ctx);
  });

  b.action('menu_apps', async (ctx) => {
    await ctx.answerCbQuery();
    await showAppsMenu(ctx);
  });

  b.action('menu_quality', async (ctx) => {
    await ctx.answerCbQuery();
    await showQualityMenu(ctx);
  });

  b.action('menu_audio', async (ctx) => {
    await ctx.answerCbQuery();
    await showAudioSettingsMenu(ctx);
  });

  b.action('menu_video', async (ctx) => {
    await ctx.answerCbQuery();
    await showVideoSettingsMenu(ctx);
  });

  b.action('menu_system', async (ctx) => {
    await ctx.answerCbQuery();
    await showSystemMenu(ctx);
  });

  b.action('menu_info', async (ctx) => {
    await ctx.answerCbQuery();
    await showInfoMenu(ctx, true);
  });

  b.action('sys_toggle_debug', async (ctx) => {
    const settings = await getUserSettings(ctx.from!.id);
    const current = settings.show_debug !== false;
    await updateUserSettings(ctx.from!.id, { show_debug: !current });
    const lang = await getUserLang(ctx.from!.id);
    await ctx.answerCbQuery(getText(lang, 'mode_saved'));
    await showSystemMenu(ctx);
  });

  b.action('sys_toggle_link', async (ctx) => {
    const settings = await getUserSettings(ctx.from!.id);
    const current = settings.show_link !== false;
    await updateUserSettings(ctx.from!.id, { show_link: !current });
    const lang = await getUserLang(ctx.from!.id);
    await ctx.answerCbQuery(getText(lang, 'mode_saved'));
    await showSystemMenu(ctx);
  });

  b.action('sys_toggle_via', async (ctx) => {
    const settings = await getUserSettings(ctx.from!.id);
    const current = settings.show_via !== false;
    await updateUserSettings(ctx.from!.id, { show_via: !current });
    const lang = await getUserLang(ctx.from!.id);
    await ctx.answerCbQuery(getText(lang, 'mode_saved'));
    await showSystemMenu(ctx);
  });

  b.action('sys_toggle_cawaii', async (ctx) => {
    const settings = await getUserSettings(ctx.from!.id);
    const current = settings.cawaii_mode === true;
    await updateUserSettings(ctx.from!.id, { cawaii_mode: !current });
    const lang = await getUserLang(ctx.from!.id);
    await ctx.answerCbQuery(getText(lang, 'mode_saved'));
    await showSystemMenu(ctx);
  });

  b.action('sys_clear_chat', async (ctx) => {
    const chatId = ctx.chat?.id;
    const currentMsgId = ctx.callbackQuery && 'message' in ctx.callbackQuery ? ctx.callbackQuery.message?.message_id : undefined;

    if (chatId && currentMsgId) {
      const minMsgId = Math.max(1, currentMsgId - 500);
      const maxMsgId = currentMsgId + 200;
      const allIds: number[] = [];

      for (let msgId = currentMsgId + 1; msgId <= maxMsgId; msgId++) {
        allIds.push(msgId);
      }
      for (let msgId = currentMsgId - 1; msgId >= minMsgId; msgId--) {
        allIds.push(msgId);
      }

      const chunkSize = 100;
      const batchPromises: Promise<any>[] = [];
      for (let i = 0; i < allIds.length; i += chunkSize) {
        const chunk = allIds.slice(i, i + chunkSize);
        batchPromises.push(
          (ctx.telegram as any).deleteMessages(chatId, chunk).catch(async () => {
            await Promise.all(chunk.map(id => ctx.telegram.deleteMessage(chatId, id).catch(() => {})));
          })
        );
      }
      await Promise.all(batchPromises);
    }

    const lang = await getUserLang(ctx.from!.id);
    await ctx.answerCbQuery(getText(lang, 'done'));
  });

  b.action('menu_fmt_disabled', async (ctx) => {
    await ctx.answerCbQuery();
  });

  b.action('menu_fmt', async (ctx) => {
    await ctx.answerCbQuery();
    await showAudioFormatMenu(ctx);
  });

  b.action('menu_audio_q', async (ctx) => {
    await ctx.answerCbQuery();
    await showAudioQualityMenu(ctx);
  });

  b.action('menu_video_q', async (ctx) => {
    await ctx.answerCbQuery();
    await showVideoQualityMenu(ctx);
  });

  b.action('lang_ru', async (ctx) => {
    await setUserLang(ctx.from!.id, 'ru');
    await ctx.answerCbQuery(getText('ru', 'language_saved'));
    await showMainMenu(ctx, true);
  });

  b.action('lang_en', async (ctx) => {
    await setUserLang(ctx.from!.id, 'en');
    await ctx.answerCbQuery(getText('en', 'language_saved'));
    await showMainMenu(ctx, true);
  });

  b.action('app_ytmusic', async (ctx) => {
    await ctx.answerCbQuery();
    await showPlatformMenu(ctx, 'ytmusic');
  });

  b.action('app_youtube', async (ctx) => {
    await ctx.answerCbQuery();
    await showPlatformMenu(ctx, 'youtube');
  });

  b.action('app_tiktok', async (ctx) => {
    await ctx.answerCbQuery();
    await showPlatformMenu(ctx, 'tiktok');
  });

  b.action('app_x', async (ctx) => {
    await ctx.answerCbQuery();
    await showPlatformMenu(ctx, 'x');
  });

  b.action(/^mode_(ytmusic|youtube|tiktok|x)_(video|audio|ask)$/, async (ctx) => {
    const platform = ctx.match[1] as 'ytmusic' | 'youtube' | 'tiktok' | 'x';
    const mode = ctx.match[2] as 'video' | 'audio' | 'ask';
    const key = `${platform}_mode` as any;
    await updateUserSettings(ctx.from!.id, { [key]: mode });
    const lang = await getUserLang(ctx.from!.id);
    await ctx.answerCbQuery(getText(lang, 'mode_saved'));
    await showPlatformMenu(ctx, platform);
  });

  b.action(/^fmt_(mp3|m4a|flac|wav|aac)$/, async (ctx) => {
    const fmt = ctx.match[1] as any;
    await updateUserSettings(ctx.from!.id, { format: fmt });
    const lang = await getUserLang(ctx.from!.id);
    await ctx.answerCbQuery(getText(lang, 'quality_saved'));
    await showAudioFormatMenu(ctx);
  });

  b.action(/^q_audio_(high|medium|low)$/, async (ctx) => {
    const quality = ctx.match[1] as 'high' | 'medium' | 'low';
    await updateUserSettings(ctx.from!.id, { audio_quality: quality });
    const lang = await getUserLang(ctx.from!.id);
    await ctx.answerCbQuery(getText(lang, 'quality_saved'));
    await showAudioQualityMenu(ctx);
  });

  b.action(/^q_video_(1080|720|480)$/, async (ctx) => {
    const quality = ctx.match[1] as '1080' | '720' | '480';
    await updateUserSettings(ctx.from!.id, { video_quality: quality });
    const lang = await getUserLang(ctx.from!.id);
    await ctx.answerCbQuery(getText(lang, 'quality_saved'));
    await showVideoQualityMenu(ctx);
  });

  /* Ask Format Prompt Callback */
  b.action(/^askdl_(video|audio)_/, handleAskCallback);

  /* Inline Query Handlers */
  b.on('inline_query', handleInlineQuery);
  b.on('chosen_inline_result', handleChosenInlineResult);
  b.action(/^inlinedl_/, handleInlineDownloadCallback);

  /* Text Messages (Links or fallback) */
  b.on('text', async (ctx) => {
    const isPrivate = ctx.chat?.type === 'private';
    const text = ctx.message?.text || '';

    // In groups / supergroups, ignore plain text (downloads require /d, /ddd, /download)
    if (!isPrivate) {
      return;
    }

    // In private chats, check if message contains a valid URL
    const url = extractUrlFromCtx(ctx);
    if (url) {
      await handleDownload(ctx, url);
    } else if (!text.startsWith('/')) {
      const lang = await getUserLang(ctx.from.id);
      await ctx.reply(getText(lang, 'inline_paste_link'));
    }
  });
}

// Clean stale temp files on startup
cleanStaleTempFiles('downloads');

// Start all bots
Promise.all(
  bots.map(async (b, i) => {
    let username = '';
    try {
      const me = await b.telegram.getMe();
      username = me.username ? `@${me.username}` : '';
    } catch {}
    console.log(`Bot #${i} ${username ? `(${username}) ` : ''}started successfully and is ready!`);

    return b.launch({
      allowedUpdates: [
        'message',
        'edited_message',
        'channel_post',
        'edited_channel_post',
        'callback_query',
        'inline_query',
        'chosen_inline_result'
      ]
    });
  })
).catch(err => {
  console.error('Failed to launch all bots:', err);
});

/* Graceful stop for all bots */
process.once('SIGINT', () => {
  console.log('SIGINT received. Stopping all bots...');
  for (const b of bots) b.stop('SIGINT');
});
process.once('SIGTERM', () => {
  console.log('SIGTERM received. Stopping all bots...');
  for (const b of bots) b.stop('SIGTERM');
});
