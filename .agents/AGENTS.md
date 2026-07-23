# Workspace Instructions & Guidelines for Agents

## Overview
This directory contains custom agent instructions and documentation for the **TGKRU** project.

- For full architecture and file details, refer to [PROJECT_MAP.md](file:///home/c4w/Desktop/tgkru/.agents/PROJECT_MAP.md).

## Quick Project Reference
- **Stack**: Node.js, TypeScript, Telegraf (Telegram Bot API), Prisma ORM (SQLite via `better-sqlite3`), `yt-dlp`, `ffmpeg-static`, `axios`, `cheerio`.
- **Entry point**: `src/index.ts`
- **Database**: `prisma/schema.prisma` (SQLite `prisma/dev.db`)
- **Background Control**: `./dev/st.sh {art|op|reart}`
