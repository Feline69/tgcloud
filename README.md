# tgcloud

Self-hosted cloud storage that uses a private Telegram channel as backend, bypassing the 2 GB-per-file limit by application-level chunking. Multi-user web UI with thumbnails, previews, drag-and-drop, and per-channel file scoping.

## Features

- **Telegram as backend** — unlimited storage; files >1.95 GB are split and reassembled transparently
- **Web UI** — folder navigation, drag-and-drop move, breadcrumbs, history-aware back/forward
- **Live previews** — images, video, audio, PDF (native browser), text/code (~50 syntaxes), Office
- **Auto-generated thumbnails** — images, video frames, audio cover art, PDF first page
- **Per-channel storage** — switching channels hides the files of the previous one without deleting them
- **Auto-sync** — automatically imports existing files from the channel on connection
- **Multi-user with sessions** — admin/user roles, scrypt-hashed passwords, HttpOnly session cookies
- **Configuration from the UI** — API credentials, Telegram OTP wizard with 2FA support, channel picker
- **TUS uploads** — resumable, chunked, drag-and-drop or button picker
- **Range-request streaming** — seekable video/audio playback
- **On-the-fly transcoding** — "lite" download as MP3 128 kbps / JPEG q5 / MP4 720p

## Quick start

1. Get `API_ID` and `API_HASH` at <https://my.telegram.org/apps>.
2. Create a private Telegram channel and add your account as admin.
3. `cp .env.example .env` and fill the values (or leave them empty and configure from the UI).
4. `docker compose up -d --build`
5. Open the configured URL, create the first admin user, and finish setup from the in-app settings modal (gear icon).

## Stack

- Node.js 20 (Fastify) + better-sqlite3
- GramJS (MTProto) for Telegram access
- TUS for resumable uploads
- ffmpeg + poppler-utils for thumbnails / transcoding
- Vanilla JS frontend, no build step

## License

MIT
