import * as fs from 'fs';
import * as path from 'path';
import { prisma } from './db';

function getLocalesDir(): string {
  const possiblePaths = [
    path.join(__dirname, 'locales'),
    path.join(__dirname, '..', 'src', 'locales'),
    path.join(process.cwd(), 'src', 'locales')
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p) && fs.existsSync(path.join(p, 'en.json'))) {
      return p;
    }
  }
  return path.join(process.cwd(), 'src', 'locales');
}

const localesDir = getLocalesDir();

const locales: Record<string, Record<string, string>> = {
  en: JSON.parse(fs.readFileSync(path.join(localesDir, 'en.json'), 'utf-8')),
  ru: JSON.parse(fs.readFileSync(path.join(localesDir, 'ru.json'), 'utf-8')),
  en_cwi: JSON.parse(fs.readFileSync(path.join(localesDir, 'en_cwi.json'), 'utf-8')),
  ru_cwi: JSON.parse(fs.readFileSync(path.join(localesDir, 'ru_cwi.json'), 'utf-8'))
};

export async function getUserLang(telegramId: bigint | number): Promise<string> {
  try {
    const user = await prisma.user.findUnique({
      where: { telegramId: BigInt(telegramId) }
    });
    let baseLang = 'en';
    if (user && (user.language === 'ru' || user.language === 'en')) {
      baseLang = user.language;
    }

    let settings: any = {};
    if (user?.settings) {
      try { settings = JSON.parse(user.settings); } catch {}
    }

    if (settings.cawaii_mode === true) {
      return `${baseLang}_cwi`;
    }
    return baseLang;
  } catch (e) {
    console.error('Error fetching user language:', e);
  }
  return 'en';
}

export function getText(lang: string, key: string, params?: Record<string, string>): string {
  const dict = locales[lang] || locales['en'];
  let text = dict[key] || locales['en'][key] || key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
    }
  }
  return text;
}

export async function t(telegramId: bigint | number, key: string, params?: Record<string, string>): Promise<string> {
  const lang = await getUserLang(telegramId);
  return getText(lang, key, params);
}
