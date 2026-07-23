# TGKRU Project Map (Telegram Music Downloader Bot)

## 📌 Project Overview
**TGKRU** is a Node.js (TypeScript) Telegram bot built using the **Telegraf** framework. The bot downloads audio files from YouTube, Spotify, and other media platforms, converts them into user-specified formats and qualities, embeds cover art/thumbnails, and caches uploaded files in a Telegram channel via SQLite (Prisma ORM) for instant zero-download re-sending.

---

## 📁 Project Directory Structure

```
tgkru/
├── .agents/                    # 🤖 AI Agent configurations and documentation
│   ├── AGENTS.md               # Guidelines and context for AI agents
│   └── PROJECT_MAP.md          # Project Map (this file)
├── bin/                        # 🛠️ Executable binaries
│   └── yt-dlp                  # Media download utility for web platforms
├── prisma/                     # 🗄️ SQLite Database Schema & Migrations
│   ├── dev.db                  # Development SQLite database
│   ├── schema.prisma           # Prisma definitions for User and Cache models
│   └── migrations/             # Database migration history
├── src/                        # 💻 Source Code
│   ├── index.ts                # Entry point: bot initialization, command listeners, inline keyboard handlers
│   ├── db.ts                   # Prisma Client initialization (better-sqlite3) and user management
│   ├── settings.ts             # User settings configuration (format, quality, output directory)
│   ├── download.ts             # Command handling (/download), Spotify/YouTube routing, progress animations
│   ├── downloader.ts           # yt-dlp wrapper & ffmpeg cover extraction (extractCover)
│   ├── spotify.ts              # Spotify metadata parser & downloader via Spotmate API (axios/cheerio)
│   ├── cache.ts                # Channel uploads, file_id caching (audio/document/voice/video), user delivery
│   └── inline.ts               # Native Telegram Inline Query & editMessageMedia callback downloader
├── dev/                        # 🛠️ Scripts directory
│   ├── st.sh                   # 🚀 Process management script (art, op, reart)
│   └── cache.sh                # 🧹 Database and downloads cache clearing script
├── .env                        # 🔑 Environment variables (BOT_TOKEN, CHANNEL_ID)
├── .gitignore                  # Git ignore rules
├── package.json                # Node.js dependencies and scripts
├── prisma.config.ts            # Prisma ORM configuration
└── tsconfig.json               # TypeScript compiler configuration
```

---

## ⚙️ Core Components & Architecture

### 1. Entry Point (`src/index.ts`)
- Initializes the Telegraf bot instance using `BOT_TOKEN`.
- Registers the bot instance globally with `setBotInstance` in `src/cache.ts`.
- Sets up command listeners: `/start`, `/settings`, `/download`, `/help`.
- Automatically catches direct URLs sent in text messages (without requiring `/download`) and routes them to `handleDownload`.
- **Inline Mode (`bot.on('inline_query')`)**: Supports `@krupezbot <link>` in any Telegram chat to instantly query and attach cached audio files via `InlineQueryResultAudio` with cover art and formatted captions.
- Handles inline keyboard callbacks for format selection (`MP3`, `M4A`, `WAV`), quality (`High`, `Medium`, `Low`), and custom directory selection.

### 2. Database & Users (`src/db.ts` & `prisma/schema.prisma`)
- Uses **Prisma Client** with `@prisma/adapter-better-sqlite3`.
- **`User` Model**: Stores `telegramId` (BigInt) and user preferences `settings` (JSON string).
- **`Cache` Model**: Maps `sourceUrl` (normalized link) to `fileId` and channel `messageId` along with metadata (title, artists, album, filename).

### 3. Telegram Uploads & Caching (`src/cache.ts`)
- `buildChannelCaption(sourceUrl)` & `buildUserCaption(sourceUrl)`: Generates archive caption (`<a href="sourceUrl">link</a>`) and user caption (`<a href="sourceUrl">link</a> | <a href="botUrl">via</a>`).
- `sendMediaToChat(...)`: Sends media to target chat using `sendAudio` with HTML parse mode (with cover art/thumbnail, title, and performer tags for Telegram music player UI), falling back to `sendDocument` if necessary.
- `uploadToChannelAndCache(...)`: Uploads local audio/video to the archive channel (`CHANNEL_ID`), extracts `file_id` and `message_id`, stores them in SQLite, and cleans up the local file.
- `trySendFromCache(...)` & `removeStaleCache(...)`: Tries delivering cached media via `copyMessage`. If a channel post was accidentally deleted, automatically purges the stale SQLite cache record and triggers a clean re-download and re-upload.

### 4. Media Downloaders (`src/download.ts`, `src/downloader.ts`, `src/spotify.ts`)
- **Instant Cache Check (`normalizeUrl`)**: Normalizes Spotify and YouTube URLs (stripping tracking parameters like `?si=...`) and checks SQLite database *before* initiating any HTTP scraping or file downloads.
- **Dynamic Status Messages**: Edits status messages in-place with animations (`⏳ Processing ⠋`), sends the final audio track with cover art, and cleans up status messages.
- **Spotify (`src/spotify.ts`)**: Scrapes and converts track/album/playlist data via `spotmate.online` API (`axios` + `cheerio`).
- **YouTube & General Platforms (`src/downloader.ts`)**: Runs `bin/yt-dlp` binary with `--add-metadata` and `--embed-thumbnail`.
- **Cover Art Extraction (`extractCover`)**: Uses `ffmpeg` (`ffmpeg-static`) via `execFileSync` to extract embedded cover art into temporary JPG files for Telegram thumbnails.

### 5. Process Management (`dev/st.sh`)
Bash script for background bot execution and process control:
- `./dev/st.sh art` — Starts the bot in background mode (logs to `bot.log`, writes PID to `bot.pid`).
- `./dev/st.sh op` — Stops the running bot process using `bot.pid`.
- `./dev/st.sh reart` — Restarts the bot process (`op` followed by `art`).

---

## 🚀 Development Commands

| Command | Description |
|---|---|
| `npm run dev` | Runs the bot in development mode via `ts-node` |
| `npm run build` | Compiles TypeScript source code to `dist/` |
| `npm run start` | Executes compiled JavaScript from `dist/index.js` |
| `./dev/st.sh art` | Launches bot process in background |
| `./dev/st.sh op` | Stops background bot process |
| `./dev/st.sh reart` | Restarts background bot process |
| `./dev/cache.sh` | Clears all cache from database and downloads directory (with double confirmation) |

---

## 🔐 Environment Variables (`.env`)

- `BOT_TOKEN` — Telegram Bot token from BotFather.
- `CHANNEL_ID` — Telegram Channel ID used as the audio archive and file storage cache.
