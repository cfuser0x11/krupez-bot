import { Context } from 'telegraf';
import { showMainMenu, updateUserSettings, getUserSettings } from './menu';

export async function showSettings(ctx: Context) {
  await showMainMenu(ctx);
}

export async function updateSetting(ctx: Context, key: string, value: string) {
  await updateUserSettings(ctx.from!.id, { [key]: value });
}
