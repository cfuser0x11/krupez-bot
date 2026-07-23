import * as fs from 'fs';
import * as path from 'path';

export interface AppDownloadResult {
  isVideo?: boolean;
  isAudio?: boolean;
  localPath?: string;
  imagePaths?: string[];
  title?: string;
  artists?: string;
  album?: string;
  thumbPath?: string;
}

export interface AppModule {
  name: string;
  domains: (string | RegExp)[];
  download: (url: string, outputDir: string, options?: any) => Promise<AppDownloadResult>;
}

const loadedApps: AppModule[] = [];

/**
 * Dynamically scans src/apps/ directory and loads all valid AppModule exports.
 * If a module file is removed from disk, it is simply skipped.
 */
export function loadApps(): AppModule[] {
  loadedApps.length = 0;
  const appsDir = __dirname;

  try {
    const files = fs.readdirSync(appsDir);

    for (const file of files) {
      if (
        file === 'index.ts' ||
        file === 'index.js' ||
        file.endsWith('.d.ts') ||
        file.endsWith('.md') ||
        file.startsWith('.')
      ) {
        continue;
      }

      if (file.endsWith('.ts') || file.endsWith('.js')) {
        try {
          const fullPath = path.join(appsDir, file);
          // Delete require cache so changes reload cleanly
          delete require.cache[require.resolve(fullPath)];
          const mod = require(fullPath);
          const appModule: AppModule = mod.default || mod.appModule;

          if (
            appModule &&
            typeof appModule.name === 'string' &&
            Array.isArray(appModule.domains) &&
            typeof appModule.download === 'function'
          ) {
            loadedApps.push(appModule);
          }
        } catch (err: any) {
          console.warn(`[AppsManager] Failed to load module ${file}:`, err?.message || err);
        }
      }
    }
  } catch (err: any) {
    console.error('[AppsManager] Error reading apps directory:', err);
  }

  console.log(`[AppsManager] Successfully loaded ${loadedApps.length} app modules: [${loadedApps.map(a => a.name).join(', ')}]`);
  return loadedApps;
}

/**
 * Finds a matching loaded AppModule for the given URL.
 */
export function findAppForUrl(url: string): AppModule | undefined {
  if (loadedApps.length === 0) loadApps();
  const cleanUrl = url.toLowerCase();
  return loadedApps.find(app =>
    app.domains.some(domain =>
      typeof domain === 'string'
        ? cleanUrl.includes(domain.toLowerCase())
        : domain.test(cleanUrl)
    )
  );
}

/**
 * Returns all currently loaded AppModules.
 */
export function getAllApps(): AppModule[] {
  if (loadedApps.length === 0) loadApps();
  return loadedApps;
}
