import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { Server as TusServer } from '@tus/server';
import { FileStore } from '@tus/file-store';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { computeCheck } from 'telegram/Password.js';
import bigInt from 'big-integer';
import Database from 'better-sqlite3';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import mime from 'mime-types';
import archiver from 'archiver';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config base ───────────────────────────────────────────────────────────
const PORT       = parseInt(process.env.PORT || '3000', 10);
const BASE_PATH  = (process.env.BASE_PATH || '/cloud').replace(/\/$/, '');
const TUS_PATH   = `${BASE_PATH}/files`;
const UPLOAD_TMP = process.env.UPLOAD_TMP || '/tmp/cloud-uploads';
const DATA_DIR   = process.env.DATA_DIR   || '/data';
const MAX_CHUNK  = parseInt(process.env.MAX_CHUNK_MB || '1950', 10) * 1024 * 1024;
const PART_SIZE  = 1024 * 1024;

await fs.mkdir(UPLOAD_TMP, { recursive: true });
await fs.mkdir(DATA_DIR,   { recursive: true });

// ─── SQLite ────────────────────────────────────────────────────────────────
const db = new Database(path.join(DATA_DIR, 'cloud.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Migración: si existe el esquema viejo (con users.password), borramos todo y recreamos
{
  const usersCols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
  if (usersCols.length && usersCols.includes('password')) {
    console.log('[migration] esquema anterior detectado — recreando para multi-tenant');
    db.exec(`
      DROP TABLE IF EXISTS chunks;
      DROP TABLE IF EXISTS files;
      DROP TABLE IF EXISTS folders;
      DROP TABLE IF EXISTS sessions;
      DROP TABLE IF EXISTS users;
    `);
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    phone       TEXT    NOT NULL UNIQUE,
    tg_api_id   TEXT    NOT NULL DEFAULT '',
    tg_api_hash TEXT    NOT NULL DEFAULT '',
    tg_session  TEXT    NOT NULL DEFAULT '',
    tg_chat     TEXT    NOT NULL DEFAULT '',
    display_name TEXT,
    session_ttl_days INTEGER NOT NULL DEFAULT 30,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT    PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS folders (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name      TEXT    NOT NULL,
    parent_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
    channel   TEXT    NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS files (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name      TEXT    NOT NULL,
    folder_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
    size      INTEGER NOT NULL DEFAULT 0,
    mime_type TEXT    NOT NULL DEFAULT 'application/octet-stream',
    thumb     BLOB,
    channel   TEXT    NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS chunks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id    INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    idx        INTEGER NOT NULL,
    tg_msg_id  INTEGER NOT NULL,
    tg_dc_id   INTEGER NOT NULL DEFAULT 0,
    chunk_size INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS ux_folder ON folders(user_id, channel, COALESCE(parent_id,0), name);
  CREATE UNIQUE INDEX IF NOT EXISTS ux_file   ON files(user_id, channel, COALESCE(folder_id,0), name);
  CREATE INDEX  IF NOT EXISTS ix_folders_user    ON folders(user_id);
  CREATE INDEX  IF NOT EXISTS ix_files_user      ON files(user_id);
  CREATE INDEX  IF NOT EXISTS ix_chunks_file     ON chunks(file_id, idx);
  CREATE INDEX  IF NOT EXISTS ix_sessions_user   ON sessions(user_id);
`);

// Migración: añadir session_ttl_days si la tabla ya existía sin esa columna
{
  const cols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
  if (!cols.includes('session_ttl_days')) {
    db.exec("ALTER TABLE users ADD COLUMN session_ttl_days INTEGER NOT NULL DEFAULT 30");
  }
}

// Limpiar sesiones expiradas
setInterval(() => {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Math.floor(Date.now() / 1000));
}, 3_600_000);

// Cada usuario aporta sus propias api_id / api_hash en el primer paso del wizard.

// ─── Settings (globales, opcionales) ───────────────────────────────────────
function getSetting(key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row !== undefined ? row.value : fallback;
}
function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO settings(key, value) VALUES(?,?)').run(key, String(value ?? ''));
}

// ─── Auth helpers ──────────────────────────────────────────────────────────
function createSession(userId) {
  const u = db.prepare('SELECT session_ttl_days FROM users WHERE id=?').get(userId);
  const ttl = Math.min(60, Math.max(1, parseInt(u?.session_ttl_days, 10) || 30));
  const token = randomBytes(32).toString('hex');
  const exp = Math.floor(Date.now() / 1000) + ttl * 86400;
  db.prepare('INSERT INTO sessions(token, user_id, expires_at) VALUES(?,?,?)').run(token, userId, exp);
  return { token, exp, ttl };
}
function getSession(token) {
  if (!token) return null;
  return db.prepare(
    `SELECT s.token, s.expires_at, u.id AS user_id, u.phone, u.tg_chat
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > ?`
  ).get(token, Math.floor(Date.now() / 1000)) || null;
}
function parseCookies(h) {
  const o = {};
  if (!h) return o;
  for (const p of h.split(';')) {
    const i = p.indexOf('=');
    if (i < 0) continue;
    o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  }
  return o;
}
function sessionCookie(token, ttlDays) {
  const ttl = Math.min(60, Math.max(1, parseInt(ttlDays, 10) || 30));
  return `session=${token}; Path=${BASE_PATH}; HttpOnly; SameSite=Strict; Max-Age=${ttl * 86400}`;
}
function clearCookie() { return `session=; Path=${BASE_PATH}; HttpOnly; SameSite=Strict; Max-Age=0`; }

function getUser(userId) {
  return db.prepare('SELECT * FROM users WHERE id=?').get(userId);
}
function normPhone(s) { return String(s || '').replace(/[^+0-9]/g, ''); }

// ─── Per-user Telegram client manager ──────────────────────────────────────
const userClients = new Map(); // userId → { client, peer, channel, lastUsed, status, error }
const CLIENT_IDLE_MS = 5 * 60 * 1000;

async function getUserClient(userId) {
  const u = getUser(userId);
  if (!u) throw new Error('Usuario no encontrado');
  if (!u.tg_api_id || !u.tg_api_hash || !u.tg_session) {
    const err = new Error('Sesión de Telegram no configurada');
    err.code = 'no_session'; throw err;
  }
  if (!u.tg_chat) {
    const err = new Error('Canal no configurado'); err.code = 'no_chat'; throw err;
  }

  let entry = userClients.get(userId);
  // Reusar si está conectado y mismo canal
  if (entry && entry.client?.connected && entry.channel === u.tg_chat) {
    entry.lastUsed = Date.now();
    return entry;
  }
  // Cerrar el anterior si cambió de canal o se desconectó
  if (entry?.client) { try { await entry.client.disconnect(); } catch {} userClients.delete(userId); }

  const client = new TelegramClient(
    new StringSession(u.tg_session), parseInt(u.tg_api_id, 10), u.tg_api_hash,
    { connectionRetries: 3, useWSS: false }
  );
  await client.connect();
  if (!await client.isUserAuthorized()) {
    try { await client.disconnect(); } catch {}
    const err = new Error('Sesión expirada — vuelve a autenticarte');
    err.code = 'session_expired'; throw err;
  }
  const peer_ = await client.getInputEntity(u.tg_chat);
  entry = {
    client, peer: peer_, channel: u.tg_chat,
    lastUsed: Date.now(), status: 'connected', error: '',
  };
  userClients.set(userId, entry);
  return entry;
}

async function closeUserClient(userId) {
  const e = userClients.get(userId);
  if (!e) return;
  try { await e.client.disconnect(); } catch {}
  userClients.delete(userId);
}

setInterval(async () => {
  const now = Date.now();
  for (const [id, e] of [...userClients]) {
    if (now - e.lastUsed > CLIENT_IDLE_MS) {
      try { await e.client.disconnect(); } catch {}
      userClients.delete(id);
    }
  }
}, 60_000);

// ─── Telegram media helpers ────────────────────────────────────────────────
function pickLargestPhotoSize(photo) {
  const sizes = (photo?.sizes || []).filter(s =>
    s.className === 'PhotoSize' || s.className === 'PhotoSizeProgressive'
  );
  if (!sizes.length) return null;
  return sizes.reduce((a, b) => ((b.size || (b.sizes?.at(-1)) || 0) > (a.size || (a.sizes?.at(-1)) || 0) ? b : a));
}
function pickSmallestPhotoSize(photo) {
  const sizes = (photo?.sizes || []).filter(s => s.className === 'PhotoSize');
  if (!sizes.length) return null;
  return sizes.reduce((a, b) => ((b.size || 0) < (a.size || 0) ? b : a));
}
function extractMessageMedia(msg) {
  if (!msg) return null;
  if (msg.document) {
    const doc = msg.document;
    const fnAttr = doc.attributes?.find(a => a.className === 'DocumentAttributeFilename');
    const filename = fnAttr?.fileName || msg.message?.trim() || `file_${msg.id}`;
    return {
      kind: 'document',
      name: String(filename).replace(/[/\\]/g, '_'),
      size: Number(doc.size),
      mimeType: doc.mimeType || mime.lookup(filename) || 'application/octet-stream',
      dcId: Number(doc.dcId || 0),
    };
  }
  if (msg.photo) {
    const largest = pickLargestPhotoSize(msg.photo);
    if (!largest) return null;
    const size = Number(largest.size || (largest.sizes?.at(-1)) || 0);
    if (!size) return null;
    return {
      kind: 'photo',
      name: `photo_${msg.id}.jpg`,
      size,
      mimeType: 'image/jpeg',
      dcId: Number(msg.photo.dcId || 0),
    };
  }
  return null;
}

async function* tgStream(client, peer_, msgId, dcId, start = 0, end = Infinity) {
  const [msg] = await client.getMessages(peer_, { ids: [msgId] });
  if (!msg) throw new Error(`mensaje ${msgId} no encontrado`);

  let loc, total, fileDcId;
  if (msg.document) {
    const doc = msg.document;
    total = Number(doc.size);
    fileDcId = dcId || Number(doc.dcId);
    loc = new Api.InputDocumentFileLocation({
      id: doc.id, accessHash: doc.accessHash,
      fileReference: doc.fileReference, thumbSize: '',
    });
  } else if (msg.photo) {
    const largest = pickLargestPhotoSize(msg.photo);
    if (!largest) throw new Error(`mensaje ${msgId} foto sin tamaños`);
    total = Number(largest.size || (largest.sizes?.at(-1)) || 0);
    fileDcId = dcId || Number(msg.photo.dcId);
    loc = new Api.InputPhotoFileLocation({
      id: msg.photo.id, accessHash: msg.photo.accessHash,
      fileReference: msg.photo.fileReference, thumbSize: largest.type || 'x',
    });
  } else {
    throw new Error(`mensaje ${msgId} sin documento ni foto`);
  }

  const realEnd = Math.min(end, total - 1), length = realEnd - start + 1;
  if (length <= 0) return;
  const aligned = Math.floor(start / PART_SIZE) * PART_SIZE, skip = start - aligned;
  let yielded = 0, first = true;
  for await (const buf of client.iterDownload({ file: loc, dcId: fileDcId, offset: bigInt(aligned), limit: length + skip, requestSize: PART_SIZE, fileSize: bigInt(total) })) {
    let data = (first && skip > 0) ? buf.slice(skip) : buf;
    first = false;
    const rem = length - yielded; if (rem <= 0) break;
    const out = data.length > rem ? data.slice(0, rem) : data;
    yield out; yielded += out.length; if (yielded >= length) break;
  }
}

async function tgSend(client, peer_, filePath, displayName, thumbBuf = null) {
  let thumbPath = null;
  if (thumbBuf?.length) {
    thumbPath = path.join(UPLOAD_TMP, `thumb_${Date.now()}_${randomBytes(4).toString('hex')}.jpg`);
    await fs.writeFile(thumbPath, thumbBuf);
  }
  try {
    const opts = {
      file: filePath, caption: displayName, forceDocument: true, workers: 4,
      attributes: [new Api.DocumentAttributeFilename({ fileName: displayName })],
      onProgress: (prog) => process.stdout.write(`\r[tg] ${displayName} ${(prog * 100).toFixed(0)}%   `),
    };
    if (thumbPath) opts.thumb = thumbPath;
    const msg = await client.sendFile(peer_, opts);
    console.log('');
    return { msgId: msg.id, dcId: msg.document?.dcId ?? 0 };
  } finally {
    if (thumbPath) await fs.rm(thumbPath, { force: true });
  }
}

async function tgDelete(client, peer_, msgIds) {
  if (!msgIds.length) return;
  try { await client.deleteMessages(peer_, msgIds, { revoke: true }); } catch {}
}

// ─── Thumb fetching/caching ────────────────────────────────────────────────
const thumbInFlight = new Map(); // file_id → Promise

async function fetchTgThumb(userId, fileId) {
  if (thumbInFlight.has(fileId)) return thumbInFlight.get(fileId);
  const p = (async () => {
    let ctx; try { ctx = await getUserClient(userId); } catch { return null; }
    const chunk = db.prepare('SELECT tg_msg_id FROM chunks WHERE file_id=? AND idx=0').get(fileId);
    if (!chunk) return null;
    const [msg] = await ctx.client.getMessages(ctx.peer, { ids: [chunk.tg_msg_id] });
    if (!msg) return null;

    if (msg.document?.thumbs?.length) {
      const ordered = [...msg.document.thumbs].reverse();
      for (const t of ordered) {
        try {
          const buf = await ctx.client.downloadMedia(msg, { thumb: t });
          if (buf?.length) {
            db.prepare('UPDATE files SET thumb=? WHERE id=?').run(Buffer.from(buf), fileId);
            return Buffer.from(buf);
          }
        } catch { /* siguiente */ }
      }
    }
    if (msg.photo?.sizes?.length) {
      const small = pickSmallestPhotoSize(msg.photo);
      if (small) {
        try {
          const buf = await ctx.client.downloadMedia(msg, { thumb: small });
          if (buf?.length) {
            db.prepare('UPDATE files SET thumb=? WHERE id=?').run(Buffer.from(buf), fileId);
            return Buffer.from(buf);
          }
        } catch { /* nada */ }
      }
    }
    return null;
  })().catch(err => { console.error('[thumb]', err.message); return null; })
       .finally(() => thumbInFlight.delete(fileId));
  thumbInFlight.set(fileId, p);
  return p;
}

// ─── Thumbnail generation (uploads) ────────────────────────────────────────
function spawnThumb(cmd, args) {
  return new Promise(resolve => {
    const parts = [];
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    proc.stdout.on('data', d => parts.push(d));
    proc.on('close', code => resolve(code !== 0 || !parts.length ? null : Buffer.concat(parts)));
    proc.on('error', () => resolve(null));
    setTimeout(() => { try { proc.kill(); } catch {}; resolve(null); }, 30_000);
  });
}

async function generateThumb(filePath, mimeType) {
  const mt = (mimeType || '').toLowerCase();
  const isV = mt.startsWith('video/');
  const isI = mt.startsWith('image/');
  const isA = mt.startsWith('audio/');
  const isP = mt === 'application/pdf' || /\.pdf$/i.test(filePath);
  if (isP) return await spawnThumb('pdftoppm', ['-jpeg', '-f', '1', '-l', '1', '-scale-to', '320', filePath, '-']);
  if (isV) return await spawnThumb('ffmpeg', ['-ss','2','-i',filePath,'-vframes','1','-vf','scale=320:240:force_original_aspect_ratio=decrease,pad=320:240:(ow-iw)/2:(oh-ih)/2:black','-f','image2','pipe:1']);
  if (isI) return await spawnThumb('ffmpeg', ['-i',filePath,'-vf','scale=320:240:force_original_aspect_ratio=decrease','-q:v','5','-f','image2','pipe:1']);
  if (isA) return await spawnThumb('ffmpeg', ['-i',filePath,'-an','-vf','scale=320:320:force_original_aspect_ratio=decrease','-frames:v','1','-f','image2','pipe:1']);
  return null;
}

// ─── Folder helpers ────────────────────────────────────────────────────────
function resolveFolderByPath(userId, channel, p) {
  const parts = (p || '').split('/').filter(Boolean);
  if (!parts.length) return { id: null };
  let pid = null;
  for (const part of parts) {
    const row = db.prepare('SELECT id FROM folders WHERE user_id=? AND channel=? AND parent_id IS ? AND name=?').get(userId, channel, pid, part);
    if (!row) return null;
    pid = row.id;
  }
  return db.prepare('SELECT * FROM folders WHERE id=?').get(pid);
}
function ensureFolderPath(userId, channel, p) {
  const parts = (p || '').split('/').filter(Boolean);
  if (!parts.length) return null;
  let pid = null;
  for (const part of parts) {
    let row = db.prepare('SELECT id FROM folders WHERE user_id=? AND channel=? AND parent_id IS ? AND name=?')
                .get(userId, channel, pid, part);
    if (!row) {
      row = db.prepare('INSERT INTO folders(user_id, name, parent_id, channel) VALUES(?,?,?,?) RETURNING id')
              .get(userId, part, pid, channel);
    }
    pid = row.id;
  }
  return pid;
}

function uniqueName(userId, channel, name, folderId) {
  const ext = path.extname(name), base = name.slice(0, -ext.length || undefined);
  let c = name, n = 1;
  while (db.prepare(`
    SELECT 1 FROM files   WHERE user_id=? AND channel=? AND COALESCE(folder_id,0)=? AND name=?
    UNION ALL
    SELECT 1 FROM folders WHERE user_id=? AND channel=? AND COALESCE(parent_id,0)=? AND name=?
  `).get(userId, channel, folderId ?? 0, c, userId, channel, folderId ?? 0, c)) {
    c = `${base} (${++n})${ext}`;
  }
  return c;
}

async function uploadToTelegram(userId, tmpPath, originalName, mimeType, folderId) {
  const u = getUser(userId);
  if (!u) throw new Error('Usuario');
  const ctx = await getUserClient(userId);
  const stat = await fs.stat(tmpPath);
  const totalSize = stat.size;
  const detectedMime = mimeType || mime.lookup(originalName) || 'application/octet-stream';
  const thumb = await generateThumb(tmpPath, detectedMime);
  const finalName = uniqueName(u.id, u.tg_chat, originalName, folderId);
  const info = db.prepare('INSERT INTO files(user_id, name, folder_id, size, mime_type, thumb, channel) VALUES(?,?,?,?,?,?,?) RETURNING id').get(u.id, finalName, folderId, totalSize, detectedMime, thumb, u.tg_chat);
  const fileId = info.id;

  if (totalSize <= MAX_CHUNK) {
    const { msgId, dcId } = await tgSend(ctx.client, ctx.peer, tmpPath, finalName, thumb);
    db.prepare('INSERT INTO chunks(file_id,idx,tg_msg_id,tg_dc_id,chunk_size) VALUES(?,0,?,?,?)').run(fileId, msgId, dcId, totalSize);
  } else {
    const numChunks = Math.ceil(totalSize / MAX_CHUNK);
    const chunkDir = path.join(UPLOAD_TMP, `split_${fileId}_${randomBytes(4).toString('hex')}`);
    await fs.mkdir(chunkDir, { recursive: true });
    try {
      for (let i = 0; i < numChunks; i++) {
        const start = i * MAX_CHUNK, chunkSize = Math.min(MAX_CHUNK, totalSize - start);
        const chunkPath = path.join(chunkDir, `part_${i}`);
        await pipeline(createReadStream(tmpPath, { start, end: start + chunkSize - 1 }), createWriteStream(chunkPath));
        const { msgId, dcId } = await tgSend(ctx.client, ctx.peer, chunkPath, `${finalName}.part${i+1}of${numChunks}`, i === 0 ? thumb : null);
        db.prepare('INSERT INTO chunks(file_id,idx,tg_msg_id,tg_dc_id,chunk_size) VALUES(?,?,?,?,?)').run(fileId, i, msgId, dcId, chunkSize);
        await fs.rm(chunkPath, { force: true });
      }
    } finally { await fs.rm(chunkDir, { recursive: true, force: true }); }
  }
  return fileId;
}

// ─── Auto-sync por usuario (con progreso) ──────────────────────────────────
const syncStatus = new Map();   // userId → { running, imported, scanned, total, error, done }
const syncedKey  = new Set();   // `${userId}:${channel}` → ya sincronizado esta sesión

async function autoSyncForUser(userId, force = false) {
  const u = getUser(userId);
  if (!u || !u.tg_chat) return;
  const key = `${userId}:${u.tg_chat}`;
  if (!force && syncedKey.has(key)) return;

  const cur = syncStatus.get(userId);
  if (cur?.running) return;

  const status = { running: true, imported: 0, scanned: 0, error: null, done: false, startedAt: Date.now() };
  syncStatus.set(userId, status);

  try {
    const ctx = await getUserClient(userId);
    const existing = new Set(
      db.prepare('SELECT c.tg_msg_id FROM chunks c JOIN files f ON c.file_id=f.id WHERE f.user_id=? AND f.channel=?')
        .all(u.id, u.tg_chat).map(r => Number(r.tg_msg_id))
    );
    for await (const msg of ctx.client.iterMessages(ctx.peer, { limit: 2000 })) {
      status.scanned++;
      if (existing.has(Number(msg?.id))) continue;
      try {
        const meta = extractMessageMedia(msg);
        if (!meta) continue;
        const finalName = uniqueName(u.id, u.tg_chat, meta.name, null);
        const info = db.prepare('INSERT INTO files(user_id, name, folder_id, size, mime_type, thumb, channel) VALUES(?,?,?,?,?,NULL,?) RETURNING id').get(u.id, finalName, null, meta.size, meta.mimeType, u.tg_chat);
        db.prepare('INSERT INTO chunks(file_id,idx,tg_msg_id,tg_dc_id,chunk_size) VALUES(?,0,?,?,?)').run(info.id, Number(msg.id), meta.dcId, meta.size);
        status.imported++;
      } catch (e) { /* skip */ }
    }
    syncedKey.add(key);
    status.done = true;
    console.log(`[auto-sync] user ${userId} canal ${u.tg_chat}: ${status.imported} importados de ${status.scanned} mensajes`);
  } catch (err) {
    status.error = err.errorMessage || err.message;
    console.error('[auto-sync] error:', status.error);
  } finally {
    status.running = false;
    status.finishedAt = Date.now();
  }
}

// ─── Estado OTP (login flow) ───────────────────────────────────────────────
const pendingSetup = new Map(); // tempId → { client, apiId, apiHash, phone, phoneCodeHash, existingUserId, createdAt }
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of pendingSetup) {
    if (now - s.createdAt > 600_000) { s.client?.disconnect().catch(() => {}); pendingSetup.delete(id); }
  }
}, 60_000);

// ─── Fastify ───────────────────────────────────────────────────────────────
const fastify = Fastify({ logger: { level: 'warn' } });
fastify.addContentTypeParser(['application/offset+octet-stream'], (_r, _p, done) => done(null));

const PUBLIC_API = [
  `${BASE_PATH}/api/auth/check-phone`,
  `${BASE_PATH}/api/auth/send-code`,
  `${BASE_PATH}/api/auth/verify-code`,
  `${BASE_PATH}/api/auth/verify-2fa`,
];

fastify.addHook('preHandler', async (req, reply) => {
  const url = req.raw.url || '';
  if (!url.startsWith(`${BASE_PATH}/api/`)) return;
  if (PUBLIC_API.some(p => url.startsWith(p))) return;
  const s = getSession(parseCookies(req.headers.cookie).session);
  if (!s) { reply.code(401).send({ error: 'no autenticado' }); return; }
  req.session = s;
});

// ─── AUTH ENDPOINTS ────────────────────────────────────────────────────────
fastify.post(`${BASE_PATH}/api/auth/check-phone`, async (req, reply) => {
  const phone = normPhone(req.body?.phone);
  if (!phone) { reply.code(400); return { error: 'Falta teléfono' }; }
  const u = db.prepare('SELECT id, tg_api_id, tg_api_hash FROM users WHERE phone=?').get(phone);
  return {
    exists: !!u,
    has_credentials: !!(u?.tg_api_id && u?.tg_api_hash),
  };
});

fastify.post(`${BASE_PATH}/api/auth/send-code`, async (req, reply) => {
  const phone = normPhone(req.body?.phone);
  if (!phone) { reply.code(400); return { error: 'Falta teléfono' }; }
  const existing = db.prepare('SELECT id, tg_api_id, tg_api_hash FROM users WHERE phone=?').get(phone);
  let apiId, apiHash;
  if (req.body?.apiId && req.body?.apiHash) {
    // Credenciales explícitas (usuario nuevo o cambio de credenciales)
    apiId   = parseInt(req.body.apiId, 10);
    apiHash = String(req.body.apiHash);
  } else if (existing && existing.tg_api_id && existing.tg_api_hash) {
    // Usuario que vuelve después de que expire la sesión: usar las suyas guardadas
    apiId   = parseInt(existing.tg_api_id, 10);
    apiHash = existing.tg_api_hash;
  } else {
    reply.code(400); return { error: 'Faltan credenciales API. Para usuarios nuevos hay que pasarlas.' };
  }
  if (!apiId || apiId <= 0)             { reply.code(400); return { error: 'API ID inválido' }; }
  if (!/^[0-9a-f]{32}$/i.test(apiHash)) { reply.code(400); return { error: 'API Hash inválido (32 caracteres hexadecimales)' }; }

  try {
    const tempClient = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5, useWSS: false });
    await tempClient.connect();
    const result = await tempClient.sendCode({ apiId, apiHash }, phone);
    const tempId = randomBytes(16).toString('hex');
    pendingSetup.set(tempId, {
      client: tempClient, apiId, apiHash, phone,
      phoneCodeHash: result.phoneCodeHash,
      existingUserId: existing?.id || null,
      createdAt: Date.now(),
    });
    return { ok: true, tempId };
  } catch (err) {
    reply.code(400); return { error: err.errorMessage || err.message };
  }
});

async function _completeAuth(state) {
  const session = state.client.session.save();
  let userId;
  if (state.existingUserId) {
    db.prepare('UPDATE users SET tg_session=?, tg_api_id=?, tg_api_hash=? WHERE id=?')
      .run(session, String(state.apiId), state.apiHash, state.existingUserId);
    userId = state.existingUserId;
  } else {
    const r = db.prepare('INSERT INTO users(phone, tg_api_id, tg_api_hash, tg_session) VALUES(?,?,?,?)')
      .run(state.phone, String(state.apiId), state.apiHash, session);
    userId = r.lastInsertRowid;
  }
  // Cerrar el cliente temporal — el de "producción" se crea bajo demanda
  await state.client.disconnect().catch(() => {});
  const u = getUser(userId);
  // Si el canal ya estaba configurado, intentar conectar (background)
  if (u?.tg_chat) getUserClient(userId).then(() => autoSyncForUser(userId).catch(()=>{})).catch(()=>{});
  return userId;
}

fastify.post(`${BASE_PATH}/api/auth/verify-code`, async (req, reply) => {
  const { tempId, code } = req.body || {};
  const state = pendingSetup.get(tempId);
  if (!state) { reply.code(400); return { error: 'Sesión expirada — empieza de nuevo' }; }
  const cleanCode = String(code || '').replace(/\s/g, '');
  if (!cleanCode) { reply.code(400); return { error: 'Falta el código' }; }
  try {
    await state.client.connect();
    await state.client.invoke(new Api.auth.SignIn({
      phoneNumber: state.phone, phoneCodeHash: state.phoneCodeHash, phoneCode: cleanCode,
    }));
    const userId = await _completeAuth(state);
    pendingSetup.delete(tempId);
    const { token, ttl } = createSession(userId);
    reply.header('Set-Cookie', sessionCookie(token, ttl));
    const u = getUser(userId);
    return { ok: true, user_id: userId, has_chat: !!u.tg_chat };
  } catch (err) {
    const msg = err.errorMessage || err.message || '';
    if (msg.includes('SESSION_PASSWORD_NEEDED')) return { ok: false, needs2fa: true };
    pendingSetup.delete(tempId);
    reply.code(400); return { error: msg };
  }
});

fastify.post(`${BASE_PATH}/api/auth/verify-2fa`, async (req, reply) => {
  const { tempId, password } = req.body || {};
  const state = pendingSetup.get(tempId);
  if (!state) { reply.code(400); return { error: 'Sesión expirada' }; }
  if (!password) { reply.code(400); return { error: 'Falta contraseña' }; }
  try {
    await state.client.connect();
    await state.client.signInWithPassword(
      { apiId: state.apiId, apiHash: state.apiHash },
      { password: async () => String(password) }
    );
    const userId = await _completeAuth(state);
    pendingSetup.delete(tempId);
    const { token, ttl } = createSession(userId);
    reply.header('Set-Cookie', sessionCookie(token, ttl));
    const u = getUser(userId);
    return { ok: true, user_id: userId, has_chat: !!u.tg_chat };
  } catch (err) {
    reply.code(400); return { error: err.errorMessage || err.message };
  }
});

fastify.post(`${BASE_PATH}/api/auth/logout`, async (req, reply) => {
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.session) db.prepare('DELETE FROM sessions WHERE token=?').run(cookies.session);
  reply.header('Set-Cookie', clearCookie());
  return { ok: true };
});

fastify.get(`${BASE_PATH}/api/auth/me`, async (req) => {
  const u = getUser(req.session.user_id);
  if (!u) return { error: 'no encontrado' };
  const entry = userClients.get(u.id);
  let tg_status = 'disconnected', tg_error = '';
  if (entry?.client?.connected) tg_status = entry.status;
  else if (!u.tg_chat) tg_status = 'no_chat';
  else tg_status = 'idle';
  return {
    id: u.id, phone: u.phone,
    has_chat: !!u.tg_chat, tg_chat: u.tg_chat,
    tg_api_id: u.tg_api_id, tg_api_hash: u.tg_api_hash,
    session_ttl_days: u.session_ttl_days,
    tg_status,
  };
});

// Cambiar las credenciales API del usuario (fuerza relogin con OTP nuevo)
fastify.post(`${BASE_PATH}/api/me/update-credentials`, async (req, reply) => {
  const u = getUser(req.session.user_id);
  if (!u) { reply.code(404); return { error: 'usuario' }; }
  const apiId   = parseInt(req.body?.apiId, 10);
  const apiHash = String(req.body?.apiHash || '');
  if (!apiId || apiId <= 0)             { reply.code(400); return { error: 'API ID inválido' }; }
  if (!/^[0-9a-f]{32}$/i.test(apiHash)) { reply.code(400); return { error: 'API Hash inválido (32 caracteres hexadecimales)' }; }
  // Guardar nuevas credenciales y borrar la sesión Telegram (ya no es válida)
  db.prepare('UPDATE users SET tg_api_id=?, tg_api_hash=?, tg_session=? WHERE id=?')
    .run(String(apiId), apiHash, '', u.id);
  // Cerrar el cliente Telegram en memoria si lo había
  await closeUserClient(u.id);
  // Borrar todas las sesiones del navegador del usuario para forzar logout
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
  reply.header('Set-Cookie', clearCookie());
  return { ok: true };
});

// Cambiar duración de sesión del usuario (1-60 días)
fastify.post(`${BASE_PATH}/api/me/update-ttl`, async (req, reply) => {
  const u = getUser(req.session.user_id);
  if (!u) { reply.code(404); return { error: 'usuario' }; }
  const days = Math.min(60, Math.max(1, parseInt(req.body?.days, 10) || 30));
  db.prepare('UPDATE users SET session_ttl_days=? WHERE id=?').run(days, u.id);
  return { ok: true, session_ttl_days: days };
});

// ─── ME ENDPOINTS (per-user) ───────────────────────────────────────────────

// Listar chats accesibles del usuario (necesita auth Telegram completa, sin canal aún)
fastify.get(`${BASE_PATH}/api/me/dialogs`, async (req, reply) => {
  const u = getUser(req.session.user_id);
  if (!u || !u.tg_session) { reply.code(400); return { error: 'sin sesión Telegram' }; }
  // Crear cliente temporal sin peer (no necesitamos canal para listar dialogs)
  let client;
  try {
    client = new TelegramClient(new StringSession(u.tg_session), parseInt(u.tg_api_id, 10), u.tg_api_hash, { connectionRetries: 3, useWSS: false });
    await client.connect();
    const list = await client.getDialogs({ limit: 200 });
    const result = list
      .filter(d => d.entity && (d.entity.className === 'Channel' || d.entity.className === 'Chat'))
      .map(d => {
        const rawId = typeof d.entity.id === 'bigint' ? d.entity.id.toString() : String(d.entity.id);
        return {
          id:       d.entity.className === 'Channel' ? `-100${rawId}` : `-${rawId}`,
          name:     d.entity.title || `ID: ${rawId}`,
          type:     d.entity.broadcast ? 'canal' : 'grupo',
          username: d.entity.username ? `@${d.entity.username}` : null,
        };
      });
    await client.disconnect().catch(() => {});
    return result;
  } catch (err) {
    if (client) await client.disconnect().catch(() => {});
    reply.code(500); return { error: err.errorMessage || err.message };
  }
});

// Crear nuevo canal privado para almacenar archivos
fastify.post(`${BASE_PATH}/api/me/create-channel`, async (req, reply) => {
  const u = getUser(req.session.user_id);
  if (!u || !u.tg_session) { reply.code(400); return { error: 'sin sesión Telegram' }; }
  const title = String(req.body?.title || '').trim();
  if (!title) { reply.code(400); return { error: 'Falta título' }; }
  let client;
  try {
    client = new TelegramClient(new StringSession(u.tg_session), parseInt(u.tg_api_id, 10), u.tg_api_hash, { connectionRetries: 3, useWSS: false });
    await client.connect();
    const result = await client.invoke(new Api.channels.CreateChannel({
      title, about: 'Cloud personal', broadcast: true, megagroup: false,
    }));
    const channel = result.chats?.[0];
    if (!channel) throw new Error('No se pudo crear');
    const rawId = typeof channel.id === 'bigint' ? channel.id.toString() : String(channel.id);
    const channelId = `-100${rawId}`;
    await client.disconnect().catch(() => {});
    return { ok: true, id: channelId, name: channel.title };
  } catch (err) {
    if (client) await client.disconnect().catch(() => {});
    reply.code(500); return { error: err.errorMessage || err.message };
  }
});

// Seleccionar el canal donde guardar archivos (dispara reconexión + auto-sync)
fastify.post(`${BASE_PATH}/api/me/select-chat`, async (req, reply) => {
  const u = getUser(req.session.user_id);
  if (!u) { reply.code(404); return { error: 'usuario no encontrado' }; }
  const tg_chat = String(req.body?.tg_chat || '').trim();
  if (!tg_chat) { reply.code(400); return { error: 'Falta canal' }; }
  db.prepare('UPDATE users SET tg_chat=? WHERE id=?').run(tg_chat, u.id);
  await closeUserClient(u.id);
  // Reset sync para ese canal y dispara auto-sync
  syncedKey.delete(`${u.id}:${tg_chat}`);
  // Conectar y sync en background
  getUserClient(u.id).then(() => autoSyncForUser(u.id, true).catch(()=>{})).catch(err => {
    console.error('[select-chat]', err.message);
  });
  return { ok: true, tg_chat };
});

// Estado del auto-sync (para barra de progreso)
fastify.get(`${BASE_PATH}/api/me/sync-status`, async (req) => {
  const s = syncStatus.get(req.session.user_id);
  return s || { running: false, imported: 0, scanned: 0, done: true, error: null };
});

// Disparar sync manual
fastify.post(`${BASE_PATH}/api/me/sync`, async (req) => {
  autoSyncForUser(req.session.user_id, true).catch(() => {});
  return { ok: true };
});

// Reconectar Telegram explícitamente
fastify.post(`${BASE_PATH}/api/me/reconnect`, async (req, reply) => {
  await closeUserClient(req.session.user_id);
  try {
    await getUserClient(req.session.user_id);
    return { ok: true, tg_status: 'connected', tg_error: '' };
  } catch (err) {
    reply.code(400); return { ok: false, tg_status: err.code || 'error', tg_error: err.errorMessage || err.message };
  }
});

// ─── FILE ENDPOINTS (todos requieren sesión, scoped por user_id+canal) ─────

fastify.get(`${BASE_PATH}/api/browse`, async (req) => {
  const u = getUser(req.session.user_id);
  if (!u) return { dirs: [], files: [], path: '', folder_id: null, crumbs: [] };
  const ch = u.tg_chat || '';
  const pathStr = String(req.query.path || '');
  const folder = resolveFolderByPath(u.id, ch, pathStr);
  const fid = folder?.id ?? null;
  const crumbs = [];
  let cur = folder;
  while (cur) {
    crumbs.unshift({ id: cur.id, name: cur.name });
    cur = cur.parent_id ? db.prepare('SELECT * FROM folders WHERE id=?').get(cur.parent_id) : null;
  }
  return {
    path: pathStr,
    folder_id: fid,
    crumbs,
    dirs:  db.prepare('SELECT id, name, created_at FROM folders WHERE user_id=? AND channel=? AND parent_id IS ? ORDER BY name COLLATE NOCASE').all(u.id, ch, fid),
    files: db.prepare(`SELECT f.id, f.name, f.size, f.mime_type, f.created_at, (f.thumb IS NOT NULL) AS has_thumb, (SELECT COUNT(*) FROM chunks c WHERE c.file_id=f.id) AS chunk_count FROM files f WHERE f.user_id=? AND f.channel=? AND f.folder_id IS ? ORDER BY f.name COLLATE NOCASE`).all(u.id, ch, fid),
  };
});

fastify.get(`${BASE_PATH}/api/thumb`, async (req, reply) => {
  const u = getUser(req.session.user_id); if (!u) { reply.code(404); return; }
  const fileId = Number(req.query.id);
  if (!fileId) { reply.code(400); return; }
  const row = db.prepare('SELECT thumb FROM files WHERE id=? AND user_id=? AND channel=?').get(fileId, u.id, u.tg_chat);
  if (!row) { reply.code(404); return; }
  if (row.thumb) {
    reply.header('Content-Type', 'image/jpeg').header('Cache-Control', 'public, max-age=604800');
    return reply.send(row.thumb);
  }
  const buf = await fetchTgThumb(u.id, fileId);
  if (!buf) { reply.code(404); return; }
  reply.header('Content-Type', 'image/jpeg').header('Cache-Control', 'public, max-age=604800');
  return reply.send(buf);
});

fastify.get(`${BASE_PATH}/api/stream`, async (req, reply) => {
  const u = getUser(req.session.user_id); if (!u) { reply.code(404); return; }
  const file = db.prepare('SELECT * FROM files WHERE id=? AND user_id=? AND channel=?').get(Number(req.query.id), u.id, u.tg_chat);
  if (!file) { reply.code(404); return; }
  const chunks = db.prepare('SELECT * FROM chunks WHERE file_id=? ORDER BY idx').all(file.id);
  if (!chunks.length) { reply.code(404); return; }
  let ctx; try { ctx = await getUserClient(u.id); }
  catch (err) { reply.code(503); return { error: err.errorMessage || err.message }; }

  const inline = req.query.inline === '1', total = file.size, rangeHdr = req.headers.range;
  let start = 0, end = total - 1;
  if (rangeHdr) { const m = rangeHdr.match(/bytes=(\d+)-(\d*)/); if (m) { start = +m[1]; if (m[2]) end = +m[2]; } end = Math.min(end, total - 1); }
  reply.raw.writeHead(rangeHdr ? 206 : 200, {
    'Content-Type': file.mime_type, 'Content-Length': String(end - start + 1),
    'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store',
    'Content-Disposition': inline ? `inline; filename*=UTF-8''${encodeURIComponent(file.name)}` : `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    ...(rangeHdr ? { 'Content-Range': `bytes ${start}-${end}/${total}` } : {}),
  });
  reply.hijack();
  try {
    if (chunks.length === 1) {
      for await (const b of tgStream(ctx.client, ctx.peer, chunks[0].tg_msg_id, chunks[0].tg_dc_id, start, end)) reply.raw.write(b);
    } else {
      let off = 0;
      for (const chunk of chunks) {
        const ce = off + chunk.chunk_size - 1;
        if (ce < start) { off += chunk.chunk_size; continue; } if (off > end) break;
        for await (const b of tgStream(ctx.client, ctx.peer, chunk.tg_msg_id, chunk.tg_dc_id, Math.max(0, start - off), Math.min(chunk.chunk_size - 1, end - off))) reply.raw.write(b);
        off += chunk.chunk_size;
      }
    }
  } catch (e) { console.error('[stream]', e.message); }
  reply.raw.end();
});

fastify.get(`${BASE_PATH}/api/transcode`, async (req, reply) => {
  const u = getUser(req.session.user_id); if (!u) { reply.code(404); return; }
  const file = db.prepare('SELECT * FROM files WHERE id=? AND user_id=? AND channel=?').get(Number(req.query.id), u.id, u.tg_chat);
  if (!file) { reply.code(404); return; }
  const chunks = db.prepare('SELECT * FROM chunks WHERE file_id=? ORDER BY idx').all(file.id);
  if (!chunks.length) { reply.code(404); return; }
  const mt = file.mime_type;
  let outMime, outExt, ffArgs;
  if (mt.startsWith('audio/'))      { outMime='audio/mpeg';outExt='mp3';ffArgs=['-i','pipe:0','-c:a','libmp3lame','-b:a','128k','-f','mp3','pipe:1']; }
  else if (mt.startsWith('image/')) { outMime='image/jpeg';outExt='jpg';ffArgs=['-i','pipe:0','-vf','scale=1280:1280:force_original_aspect_ratio=decrease','-q:v','5','-f','image2','pipe:1']; }
  else if (mt.startsWith('video/')) { outMime='video/mp4'; outExt='mp4';ffArgs=['-i','pipe:0','-vf','scale=1280:720:force_original_aspect_ratio=decrease','-c:v','libx264','-preset','veryfast','-crf','28','-c:a','aac','-b:a','128k','-movflags','frag_keyframe+empty_moov','-f','mp4','pipe:1']; }
  else { reply.code(400); return { error: 'No transcodificable' }; }

  let ctx; try { ctx = await getUserClient(u.id); }
  catch (err) { reply.code(503); return { error: err.errorMessage || err.message }; }

  const base = file.name.replace(/\.[^.]+$/, '');
  reply.raw.writeHead(200, { 'Content-Type': outMime, 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(base+'.'+outExt)}` });
  reply.hijack();
  const proc = spawn('ffmpeg', ffArgs, { stdio: ['pipe','pipe','ignore'] });
  proc.stdout.pipe(reply.raw);
  proc.on('close', () => reply.raw.end());
  (async () => { try { for (const c of chunks) for await (const b of tgStream(ctx.client, ctx.peer, c.tg_msg_id, c.tg_dc_id)) proc.stdin.write(b); } catch (e) { console.error('[transcode]', e.message); } proc.stdin.end(); })();
});

fastify.get(`${BASE_PATH}/api/zip`, async (req, reply) => {
  const u = getUser(req.session.user_id); if (!u) { reply.code(404); return; }
  const fid  = Number(req.query.id) || null;
  if (fid && !db.prepare('SELECT 1 FROM folders WHERE id=? AND user_id=? AND channel=?').get(fid, u.id, u.tg_chat)) { reply.code(404); return { error: 'No encontrado' }; }
  const name = fid ? (db.prepare('SELECT name FROM folders WHERE id=?').get(fid)?.name || 'carpeta') : 'raiz';
  let ctx; try { ctx = await getUserClient(u.id); }
  catch (err) { reply.code(503); return { error: err.errorMessage || err.message }; }

  reply.raw.writeHead(200, { 'Content-Type':'application/zip','Cache-Control':'no-store','Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(name+'.zip')}` });
  reply.hijack();
  const archive = archiver('zip', { store: true });
  archive.on('error', () => { try { reply.raw.destroy(); } catch {} });
  archive.pipe(reply.raw);
  async function addDir(folderId, prefix) {
    const { PassThrough } = await import('node:stream');
    for (const f of db.prepare('SELECT * FROM files WHERE user_id=? AND channel=? AND folder_id IS ?').all(u.id, u.tg_chat, folderId)) {
      const ch = db.prepare('SELECT * FROM chunks WHERE file_id=? ORDER BY idx').all(f.id);
      const pass = new PassThrough();
      archive.append(pass, { name: prefix + f.name });
      (async () => { try { for (const c of ch) for await (const b of tgStream(ctx.client, ctx.peer, c.tg_msg_id, c.tg_dc_id)) pass.write(b); } catch {} pass.end(); })();
    }
    for (const d of db.prepare('SELECT * FROM folders WHERE user_id=? AND channel=? AND parent_id IS ?').all(u.id, u.tg_chat, folderId)) await addDir(d.id, prefix + d.name + '/');
  }
  await addDir(fid, '');
  archive.finalize();
});

fastify.post(`${BASE_PATH}/api/mkdir`, async (req, reply) => {
  const u = getUser(req.session.user_id); if (!u) { reply.code(404); return { error: 'usuario' }; }
  const name = String(req.body?.name || '').trim().replace(/[/\\]/g, '_');
  if (!name) { reply.code(400); return { error: 'Nombre requerido' }; }
  const pf = resolveFolderByPath(u.id, u.tg_chat, String(req.body?.parent || ''));
  const pid = pf?.id ?? null;
  if (db.prepare('SELECT 1 FROM folders WHERE user_id=? AND channel=? AND parent_id IS ? AND name=?').get(u.id, u.tg_chat, pid, name)) { reply.code(409); return { error: 'Ya existe' }; }
  const r = db.prepare('INSERT INTO folders(user_id, name, parent_id, channel) VALUES(?,?,?,?) RETURNING id').get(u.id, name, pid, u.tg_chat);
  return { ok: true, id: r.id };
});

fastify.post(`${BASE_PATH}/api/rename`, async (req, reply) => {
  const u = getUser(req.session.user_id); if (!u) { reply.code(404); return { error: 'usuario' }; }
  const { type, id, newName } = req.body || {};
  const clean = String(newName || '').trim().replace(/[/\\]/g, '_');
  if (!type || !id || !clean) { reply.code(400); return { error: 'Faltan datos' }; }
  if (type === 'file') {
    const row = db.prepare('SELECT * FROM files WHERE id=? AND user_id=? AND channel=?').get(+id, u.id, u.tg_chat);
    if (!row) { reply.code(404); return { error: 'No encontrado' }; }
    if (db.prepare('SELECT 1 FROM files WHERE user_id=? AND channel=? AND COALESCE(folder_id,0)=? AND name=? AND id!=?').get(u.id, u.tg_chat, row.folder_id ?? 0, clean, row.id)) { reply.code(409); return { error: 'Ya existe' }; }
    db.prepare('UPDATE files SET name=? WHERE id=?').run(clean, row.id);
  } else {
    const row = db.prepare('SELECT * FROM folders WHERE id=? AND user_id=? AND channel=?').get(+id, u.id, u.tg_chat);
    if (!row) { reply.code(404); return { error: 'No encontrado' }; }
    if (db.prepare('SELECT 1 FROM folders WHERE user_id=? AND channel=? AND COALESCE(parent_id,0)=? AND name=? AND id!=?').get(u.id, u.tg_chat, row.parent_id ?? 0, clean, row.id)) { reply.code(409); return { error: 'Ya existe' }; }
    db.prepare('UPDATE folders SET name=? WHERE id=?').run(clean, row.id);
  }
  return { ok: true };
});

fastify.post(`${BASE_PATH}/api/move`, async (req, reply) => {
  const u = getUser(req.session.user_id); if (!u) { reply.code(404); return { error: 'usuario' }; }
  const { type, id, targetFolderId } = req.body || {};
  if (!type || !id) { reply.code(400); return { error: 'Faltan datos' }; }
  const target = (targetFolderId == null || targetFolderId === '') ? null : Number(targetFolderId);
  if (target !== null && !db.prepare('SELECT 1 FROM folders WHERE id=? AND user_id=? AND channel=?').get(target, u.id, u.tg_chat)) { reply.code(404); return { error: 'Carpeta destino no existe' }; }
  if (type === 'file') {
    const row = db.prepare('SELECT * FROM files WHERE id=? AND user_id=? AND channel=?').get(+id, u.id, u.tg_chat);
    if (!row) { reply.code(404); return { error: 'No encontrado' }; }
    const newName = uniqueName(u.id, u.tg_chat, row.name, target);
    db.prepare('UPDATE files SET folder_id=?, name=? WHERE id=?').run(target, newName, row.id);
  } else if (type === 'dir') {
    const idNum = +id;
    if (target === idNum) { reply.code(400); return { error: 'No puedes moverla en sí misma' }; }
    let cur = target;
    while (cur !== null) {
      if (cur === idNum) { reply.code(400); return { error: 'No puedes moverla en sí misma' }; }
      const p = db.prepare('SELECT parent_id FROM folders WHERE id=?').get(cur);
      cur = p?.parent_id ?? null;
    }
    const row = db.prepare('SELECT * FROM folders WHERE id=? AND user_id=? AND channel=?').get(idNum, u.id, u.tg_chat);
    if (!row) { reply.code(404); return { error: 'No encontrada' }; }
    let newName = row.name, n = 1;
    while (db.prepare('SELECT 1 FROM folders WHERE user_id=? AND channel=? AND COALESCE(parent_id,0)=? AND name=? AND id!=?').get(u.id, u.tg_chat, target ?? 0, newName, idNum)) {
      newName = `${row.name} (${++n})`;
    }
    db.prepare('UPDATE folders SET parent_id=?, name=? WHERE id=?').run(target, newName, idNum);
  } else { reply.code(400); return { error: 'Tipo inválido' }; }
  return { ok: true };
});

fastify.post(`${BASE_PATH}/api/delete`, async (req, reply) => {
  const u = getUser(req.session.user_id); if (!u) { reply.code(404); return { error: 'usuario' }; }
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) { reply.code(400); return { error: 'Items requeridos' }; }
  let ctx; try { ctx = await getUserClient(u.id); } catch { ctx = null; }
  const results = [];
  for (const { type, id } of items) {
    try {
      if (type === 'file') {
        const f = db.prepare('SELECT 1 FROM files WHERE id=? AND user_id=? AND channel=?').get(+id, u.id, u.tg_chat);
        if (!f) { results.push({ id, ok: false, error: 'no encontrado' }); continue; }
        const msgs = db.prepare('SELECT tg_msg_id FROM chunks WHERE file_id=?').all(+id).map(c => c.tg_msg_id);
        if (ctx) await tgDelete(ctx.client, ctx.peer, msgs);
        db.prepare('DELETE FROM files WHERE id=?').run(+id);
      } else {
        const fol = db.prepare('SELECT 1 FROM folders WHERE id=? AND user_id=? AND channel=?').get(+id, u.id, u.tg_chat);
        if (!fol) { results.push({ id, ok: false, error: 'no encontrada' }); continue; }
        const del = (fId) => {
          for (const f of db.prepare('SELECT id FROM files WHERE folder_id=?').all(fId)) {
            const msgs = db.prepare('SELECT tg_msg_id FROM chunks WHERE file_id=?').all(f.id).map(c => c.tg_msg_id);
            if (ctx) tgDelete(ctx.client, ctx.peer, msgs).catch(()=>{});
          }
          for (const d of db.prepare('SELECT id FROM folders WHERE parent_id=?').all(fId)) del(d.id);
        };
        del(+id); db.prepare('DELETE FROM folders WHERE id=?').run(+id);
      }
      results.push({ id, ok: true });
    } catch (e) { results.push({ id, ok: false, error: e.message }); }
  }
  return { ok: results.every(r => r.ok), results };
});

// ─── TUS uploads (per-user) ────────────────────────────────────────────────
const tusServer = new TusServer({
  path: TUS_PATH,
  datastore: new FileStore({ directory: UPLOAD_TMP }),
  respectForwardedHeaders: true,
  async onUploadFinish(req, res, upload) {
    const meta = upload.metadata || {};
    const userId = upload.metadata?.userId ? Number(upload.metadata.userId) : null;
    if (!userId) return { res, status_code: 401, body: '{"ok":false,"error":"no auth"}' };
    const origName   = meta.filename || `file_${upload.id}`;
    const mimeType   = meta.type    || mime.lookup(origName) || 'application/octet-stream';
    const folderPath = meta.folder  ? decodeURIComponent(meta.folder) : '';
    const tmpPath    = path.join(UPLOAD_TMP, upload.id);
    const u = getUser(userId);
    if (!u) return { res, status_code: 404, body: '{"ok":false,"error":"user"}' };
    let folderId = null;
    if (folderPath) { folderId = ensureFolderPath(u.id, u.tg_chat, folderPath); }
    try {
      const fileId = await uploadToTelegram(u.id, tmpPath, origName, mimeType, folderId);
      await fs.rm(tmpPath,           { force: true });
      await fs.rm(`${tmpPath}.json`, { force: true });
      return { res, status_code: 200, body: JSON.stringify({ ok: true, id: fileId }) };
    } catch (err) {
      console.error('[upload] error:', err.message);
      return { res, status_code: 500, body: JSON.stringify({ ok: false, error: err.message }) };
    }
  },
});

const tusHandler = async (req, reply) => {
  const s = getSession(parseCookies(req.headers.cookie).session);
  if (!s) { reply.code(401).send({ error: 'no autenticado' }); return; }
  // Inyectar user_id a metadata para onUploadFinish
  // Hack: leemos el header Upload-Metadata y le añadimos userId codificado
  const orig = req.headers['upload-metadata'] || '';
  const userMetaPair = `userId ${Buffer.from(String(s.user_id)).toString('base64')}`;
  req.headers['upload-metadata'] = orig ? `${orig},${userMetaPair}` : userMetaPair;
  reply.hijack(); tusServer.handle(req.raw, reply.raw);
};
fastify.all(TUS_PATH,        tusHandler);
fastify.all(`${TUS_PATH}/*`, tusHandler);

// ─── Estáticos ─────────────────────────────────────────────────────────────
await fastify.register(fastifyStatic, { root: path.join(__dirname, 'public'), prefix: `${BASE_PATH}/`, index: ['index.html'] });
fastify.get('/',        (_req, reply) => reply.redirect(`${BASE_PATH}/`));
fastify.get(BASE_PATH,  (_req, reply) => reply.redirect(`${BASE_PATH}/`));
fastify.get(`${BASE_PATH}/health`, async () => ({ ok: true }));
fastify.get(`${BASE_PATH}/api/config`, async () => ({ tusEndpoint: TUS_PATH, basePath: BASE_PATH }));

// ─── Inicio ────────────────────────────────────────────────────────────────
await fastify.listen({ host: '0.0.0.0', port: PORT });
console.log(`tgcloud :${PORT}  base=${BASE_PATH}`);
