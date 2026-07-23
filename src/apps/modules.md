# Modules (`src/apps/`)

This directory contains modular media extractors for `krupez`. The system dynamically loads all modules in this folder at startup.

---

## Quick Summary
- **Modular Architecture**: To add a new platform, create a `.ts` file in `src/apps/`. To remove a platform, simply **delete its file**.
- **No manual registration**: `src/apps/index.ts` automatically discovers and registers all modules exporting a valid `AppModule`.

---

## Module File Structure

Each module must export a `default` object matching the `AppModule` interface:

```typescript
import { AppModule, AppDownloadResult } from './index';

export async function downloadMyPlatform(url: string, outputDir: string, options?: any): Promise<AppDownloadResult> {
  // 1. Download or resolve media links
  // 2. Return AppDownloadResult
  return {
    isVideo: true, // true if video, false if photo/album/audio
    localPath: '/path/to/downloaded/file.mp4',
    title: 'Media Title'
  };
}

const myPlatformApp: AppModule = {
  name: 'myplatform',
  domains: ['myplatform.com', 'myplat.form'], // Domains matched against incoming URLs
  download: downloadMyPlatform
};

export default myPlatformApp;
```

---

## `AppDownloadResult` Return Format

| Field | Type | Description |
| :--- | :--- | :--- |
| `isVideo` | `boolean` | `true` if media is video, `false` if photo/album. |
| `isAudio` | `boolean` | (Optional) `true` if media is audio only. |
| `localPath` | `string` | Absolute path to single downloaded photo or video file. |
| `imagePaths` | `string[]` | (Optional) Array of file paths if media is a multi-photo album. |
| `title` | `string` | (Optional) Title or description of the media. |
| `artists` | `string` | (Optional) Artist / performer name for audio files. |
| `album` | `string` | (Optional) Album name for audio files. |
| `thumbPath` | `string` | (Optional) Path to resized cover thumbnail (320x320 px). |

---

## How to Remove a Module

Simply delete the corresponding file from `src/apps/` (e.g. `rm src/apps/someapp.ts`) and rebuild/restart the bot (`npm run build && ./st.sh reart`). The bot will automatically handle requests for that platform using the fallback engine (`yt-dlp`).
