# tgcloud

☁️ Self-hosted cloud storage backed by your own Telegram account — upload, browse, share and stream files of any size with no monthly fees.

Files larger than 1.95 GB are split into chunks automatically and reassembled transparently on download. Everything lives in a private Telegram channel you own; tgcloud is just the web layer.

## Features

### Storage & Files
- **Unlimited storage** — uses a private Telegram channel as backend; no per-account quota
- **Large file support** — files >1.95 GB are chunked and reassembled transparently
- **Folder tree** — create nested folders, drag-and-drop move, rename, delete
- **Bulk operations** — multi-select, batch delete, batch move, zip-on-the-fly download
- **Deduplication scanner** — detects exact and probable duplicates by hash/size
- **Auto-sync** — imports existing files from the channel when you first connect

### Uploads
- **TUS resumable uploads** — survives network drops; resumes from the last byte
- **Drag-and-drop or file picker** — upload files and entire folder trees
- **Progress tracking** — per-file progress bars with cancel support

### Previews & Streaming
- **Live previews** — images, video, audio, PDF (native browser), text/code (~50 syntaxes highlighted), Office docs
- **Range-request streaming** — seekable video/audio directly in the browser
- **Auto-generated thumbnails** — images, video frames, audio cover art, PDF first page
- **Lite transcoding** — on-the-fly conversion to MP3 128 kbps / JPEG q5 / MP4 720p via ffmpeg

### Sharing
- **Public share links** — per-file and per-folder, with optional expiry
- **QR codes** — generated for every share link
- **Folder share pages** — recipients see a full file listing with individual downloads
- **Share language detection** — share pages auto-detect browser language (EN/ES/PT) and include a language switcher

### Interface
- **Multi-language UI** — English, Spanish, and Portuguese; persists per user via localStorage
- **SVG icon system** — crisp vector icons throughout (replaces emoji icons)
- **Touch drag-and-drop** — long-press to arm drag on mobile, with animated drag ghost showing item count
- **Responsive web UI** — works on desktop and mobile
- **History-aware navigation** — breadcrumbs, back/forward, deep-link support
- **Dark / light theme** — follows OS preference (CSS custom properties)
- **Configuration from the UI** — API credentials, Telegram OTP wizard (with 2FA), channel picker, TTL settings

### Auth & Multi-user
- **PIN quick-login** — after first OTP login, set a 4-digit PIN for instant re-access without re-authenticating via Telegram
- **Multi-user** — each user authenticates via their own Telegram account (phone + OTP + optional 2FA)
- **Secure sessions** — HttpOnly session cookies with configurable TTL
- **Per-channel scoping** — each channel has its own isolated file tree

## Quick start

1. Get `API_ID` and `API_HASH` at <https://my.telegram.org/apps>.
2. Create a private Telegram channel and add your account as admin.
3. `cp .env.example .env` and fill the values (or leave them blank and configure from the UI after first run).
4. `docker compose up -d --build`
5. Open the configured URL, log in with your Telegram account, and finish setup from the settings modal (⚙ gear icon).

## Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20 |
| HTTP | Fastify + @fastify/static |
| Database | better-sqlite3 |
| Telegram | GramJS (MTProto) |
| Uploads | @tus/server + @tus/file-store |
| Thumbnails / transcode | ffmpeg + poppler-utils |
| Frontend | Vanilla JS — no build step |

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `BASE_PATH` | `/cloud` | URL prefix (e.g. reverse-proxy subpath) |
| `PORT` | `3000` | Listening port inside the container |
| `TG_API_ID` | — | Telegram API ID from my.telegram.org |
| `TG_API_HASH` | — | Telegram API hash from my.telegram.org |

All variables can be left unset and configured later through the in-app settings wizard.

## License

MIT
