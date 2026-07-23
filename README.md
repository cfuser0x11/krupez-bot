# 🚀 Krupez Bot (`krupez-bot`)

**Krupez Bot** is a high-speed, multi-instance Telegram bot daemon designed for downloading videos, audio tracks, photos, and media slideshows from YouTube, TikTok, Instagram, Twitter/X, Spotify, Yandex Music, VK, and 20+ other platforms.

Built with **Node.js**, **TypeScript**, **Telegraf**, **Prisma ORM** (SQLite), **yt-dlp**, and **FFmpeg**.

---

## ✨ Features

- **⚡ Ultra-Fast Media Extraction**: Direct Cobalt-style API scrapers for TikTok, Instagram, Twitter/X, and YouTube for 1–3 second delivery times.
- **🤖 Multi-Bot Architecture**: Run multiple Telegram bot instances simultaneously in a single process.
- **💾 Database Caching**: Prisma + SQLite caching to immediately resend cached media without re-downloading.
- **💬 Dual Delivery Modes**:
  - **Direct Chat**: Interactive commands (`/d`, `/download`, `/ddd`), format choice prompts, and settings menu.
  - **Inline Query Mode**: Type `@botusername <link>` in any chat to share media directly.
- **📢 Group & Channel Support**: Automatic cleanup of `/d` command messages in public groups and channels before starting downloads.
- **🎨 ANSI Colored Logger**: Configurable `LOG_LEVEL` (`debug`, `info`, `warn`, `error`, `silent`) with real-time colored timestamps.
- **🧹 Auto Storage Cleanup**: Automatic sweeping of temporary files (`downloads/`), sidecar thumbnails, and covers.
- **🧩 External Module Ecosystem**: App platform modules are managed and extended via [krupez-modules](https://github.com/cfuser0x11/krupez-modules).

---

## 📋 Requirements

- **Node.js**: v18.0.0 or higher
- **npm** / **bun**
- **SQLite3**
- **yt-dlp**: Placed in `bin/yt-dlp`
- **FFmpeg**: Placed in `bin/ffmpeg` (or available in system `PATH`)

---

## 🛠️ Installation & Setup

1. **Clone the Repository**:
   ```bash
   git clone https://github.com/cfuser0x11/krupez-bot.git
   cd krupez-bot
   ```

2. **Install Dependencies**:
   ```bash
   npm install
   ```

3. **Configure Environment Variables**:
   Create a `.env` file in the project root:
   ```env
   # Single Bot Mode
   BOT_TOKEN="123456789:ABCdefGHIjklMNOpqrsTUVwxyZ"

   # Multi-Bot Mode (optional)
   MULTIPLE_TOKENS="true"
   TOKENS="token1,token2,token3"

   # Database URL (SQLite)
   DATABASE_URL="file:./dev.db"

   # Default Logging Level (debug, info, warn, error, silent)
   LOG_LEVEL="info"
   ```

4. **Initialize Database**:
   ```bash
   npx prisma generate
   npx prisma db push
   ```

5. **Ensure Executable Binaries**:
   ```bash
   chmod +x bin/yt-dlp bin/ffmpeg
   ```

---

## 🚀 Running the Bot

### Manual Launch (Foreground)
Compile TypeScript and start the bot with live console logs:
```bash
npm run build && npm run start
```

### Running with Debug Logging
Enable detailed step-by-step diagnostic logs (requests, API payloads, execution steps):
```bash
npm run build && LOG_LEVEL=debug npm start
```

### Background Daemon Management
Use the included helper script in `./dev/st.sh`:
- **Start / Restart**:
  ```bash
  ./dev/st.sh reart
  ```
- **Stop**:
  ```bash
  ./dev/st.sh op
  ```
- **Build & Start**:
  ```bash
  ./dev/st.sh art
  ```

---

## 🤖 Bot Usage & Commands

| Command | Description |
| :--- | :--- |
| `/download <url>` or `/d <url>` | Download video or audio from the provided media link |
| `/ddd <url>` | Force video download mode regardless of user defaults |
| `/settings` | Open interactive settings menu (audio quality, preferred platform modes) |
| `/info` | Display bot statistics, uptime, and database metrics |

### Inline Query Mode
Type the bot username followed by any link in any chat:
```text
@krupezbot https://tiktok.com/...
```

---

## 📊 Logging Levels (`LOG_LEVEL`)

Set `LOG_LEVEL` in your `.env` or pass it inline on launch:

| Level | Description |
| :--- | :--- |
| `debug` | Extremely verbose. Logs all API payloads, `yt-dlp` stdout/stderr, cache checks, and execution steps. |
| `info` *(default)* | Standard operational logs (bot startup, file operations, warnings, errors). |
| `warn` | Displays warnings and errors only. |
| `error` | Displays critical failure errors only. |
| `silent` | Disables all console output. |

---

## 🧩 External App Modules

Extensible platform extractors (TikTok, Instagram, Twitter/X, Spotify, Yandex, etc.) are hosted in a dedicated repository:
👉 **[krupez-modules](https://github.com/cfuser0x11/krupez-modules)**

---

## 📄 License

Distributed under the **MIT License**. See [`LICENSE`](LICENSE) for more details.
