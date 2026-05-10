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
import { randomBytes, createHash as nodeCreateHash } from 'node:crypto';
import mime from 'mime-types';
import archiver from 'archiver';
import QRCode from 'qrcode';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config base ───────────────────────────────────────────────────────────
const PORT       = parseInt(process.env.PORT || '3000', 10);
const BASE_PATH  = (process.env.BASE_PATH || '/cloud').replace(/\/$/, '');
const TUS_PATH   = `${BASE_PATH}/files`;
const UPLOAD_TMP = process.env.UPLOAD_TMP || '/tmp/cloud-uploads';
const DATA_DIR   = process.env.DATA_DIR   || '/data';
const MAX_CHUNK  = parseInt(process.env.MAX_CHUNK_MB || '1950', 10) * 1024 * 1024;
const DL_CHUNK   = 512 * 1024; // 512 KB — máximo que permite Telegram por GetFile
const DL_WORKERS = parseInt(process.env.DL_WORKERS || '8', 10); // chunks en paralelo

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
  CREATE TABLE IF NOT EXISTS shares (
    token      TEXT    PRIMARY KEY,
    file_id    INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS ix_shares_file ON shares(file_id);
  CREATE TABLE IF NOT EXISTS folder_shares (
    token      TEXT    PRIMARY KEY,
    folder_id  INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS ix_fshares_folder ON folder_shares(folder_id);
`);

// Migración: añadir session_ttl_days si la tabla ya existía sin esa columna
{
  const cols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
  if (!cols.includes('session_ttl_days')) {
    db.exec("ALTER TABLE users ADD COLUMN session_ttl_days INTEGER NOT NULL DEFAULT 30");
  }
}
// Migración: añadir hash SHA-256 para detección robusta de duplicados
{
  const cols = db.prepare("PRAGMA table_info(files)").all().map(c => c.name);
  if (!cols.includes('hash')) {
    db.exec("ALTER TABLE files ADD COLUMN hash TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS ix_files_hash ON files(hash)");
  }
}

// Limpiar sesiones expiradas
setInterval(() => {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Math.floor(Date.now() / 1000));
}, 3_600_000);

// Limpiar shares expirados
setInterval(() => {
  const now = Math.floor(Date.now() / 1000);
  db.prepare('DELETE FROM shares WHERE expires_at IS NOT NULL AND expires_at < ?').run(now);
  db.prepare('DELETE FROM folder_shares WHERE expires_at IS NOT NULL AND expires_at < ?').run(now);
}, 3_600_000);

// Limpiar temporales TUS huérfanos (subidas canceladas o fallidas) con más de 24h
setInterval(async () => {
  try {
    const cutoff = Date.now() - 24 * 3_600_000;
    for (const entry of await fs.readdir(UPLOAD_TMP)) {
      if (entry.endsWith('.json')) continue;
      const full = path.join(UPLOAD_TMP, entry);
      const stat = await fs.stat(full).catch(() => null);
      if (stat && stat.mtimeMs < cutoff) {
        await fs.rm(full,               { force: true });
        await fs.rm(`${full}.json`,     { force: true });
        console.log(`[cleanup] temporal eliminado: ${entry}`);
      }
    }
  } catch (e) { console.error('[cleanup]', e.message); }
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

function msgToLocation(msg, dcId) {
  if (msg.document) {
    const doc = msg.document;
    return {
      loc: new Api.InputDocumentFileLocation({
        id: doc.id, accessHash: doc.accessHash,
        fileReference: doc.fileReference, thumbSize: '',
      }),
      total: Number(doc.size),
      fileDcId: dcId || Number(doc.dcId),
    };
  }
  if (msg.photo) {
    const largest = pickLargestPhotoSize(msg.photo);
    if (!largest) throw new Error(`mensaje ${msg.id} foto sin tamaños`);
    return {
      loc: new Api.InputPhotoFileLocation({
        id: msg.photo.id, accessHash: msg.photo.accessHash,
        fileReference: msg.photo.fileReference, thumbSize: largest.type || 'x',
      }),
      total: Number(largest.size || (largest.sizes?.at(-1)) || 0),
      fileDcId: dcId || Number(msg.photo.dcId),
    };
  }
  throw new Error(`mensaje ${msg.id} sin documento ni foto`);
}

// Resuelve en paralelo todos los mensajes de un array de chunks [{tg_msg_id, tg_dc_id}]
async function resolveChunkLocs(client, peer_, chunks) {
  const ids = chunks.map(c => c.tg_msg_id);
  const msgs = await client.getMessages(peer_, { ids });
  return chunks.map((c, i) => {
    const msg = msgs[i];
    if (!msg) throw new Error(`mensaje ${c.tg_msg_id} no encontrado`);
    return msgToLocation(msg, c.tg_dc_id);
  });
}

// Descarga exactamente un bloque de 512 KB desde Telegram
async function fetchTgChunk(client, loc, fileDcId, offset, total) {
  for await (const buf of client.iterDownload({
    file: loc, dcId: fileDcId,
    offset: bigInt(offset),
    limit: Math.min(DL_CHUNK, total - offset),
    requestSize: DL_CHUNK,
    fileSize: bigInt(total),
  })) {
    return Buffer.from(buf);
  }
  return Buffer.alloc(0);
}

// Ventana deslizante: mantiene DL_WORKERS peticiones en vuelo simultáneamente.
// Entrega datos en orden tan pronto llega el siguiente bloque esperado,
// sin esperar a que llegue todo un batch completo.
async function* tgStreamLoc({ loc, total, fileDcId }, client, start, end) {
  const realEnd = Math.min(end, total - 1);
  if (realEnd < start) return;

  const aligned = Math.floor(start / DL_CHUNK) * DL_CHUNK;
  const skip    = start - aligned;
  const length  = realEnd - start + 1;

  const offsets = [];
  for (let off = aligned; off <= realEnd; off += DL_CHUNK) offsets.push(off);

  const pending = new Map(); // idx → Buffer  (llegaron fuera de orden)
  let nextFire  = 0;
  let nextYield = 0;
  let yielded   = 0;
  let error     = null;
  let wakeup    = null;

  const signal = () => { if (wakeup) { const f = wakeup; wakeup = null; f(); } };
  const wait   = () => new Promise(r => { wakeup = r; });

  function fire(idx) {
    if (idx >= offsets.length) return;
    fetchTgChunk(client, loc, fileDcId, offsets[idx], total)
      .then(data => { pending.set(idx, data); signal(); })
      .catch(err  => { error = err;           signal(); });
  }

  // Llenar ventana inicial
  for (let i = 0; i < Math.min(DL_WORKERS, offsets.length); i++) fire(nextFire++);

  while (nextYield < offsets.length && yielded < length) {
    while (!pending.has(nextYield) && !error) await wait();
    if (error) throw error;

    const raw = pending.get(nextYield);
    pending.delete(nextYield);
    fire(nextFire++); // reponer la ventana de inmediato

    let data = (nextYield === 0 && skip > 0) ? raw.slice(skip) : raw;
    nextYield++;
    const rem = length - yielded;
    const out = data.length > rem ? data.slice(0, rem) : data;
    yield out;
    yielded += out.length;
  }
}

// Stream de un fichero completo que puede abarcar varios mensajes de Telegram
// (necesario para el bypass de >2 GB: cada mensaje es un chunk de hasta 1.95 GB)
async function* tgStreamFile(locs, client, fileSize, start, end) {
  const realEnd = Math.min(end, fileSize - 1);
  let msgStart = 0;
  for (const loc of locs) {
    if (msgStart > realEnd) break;
    const msgEnd = msgStart + loc.total - 1;
    if (msgEnd < start) { msgStart += loc.total; continue; }
    yield* tgStreamLoc(loc, client, Math.max(0, start - msgStart), Math.min(loc.total - 1, realEnd - msgStart));
    msgStart += loc.total;
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
const thumbInFlight    = new Map(); // file_id → Promise
const pdfThumbInFlight = new Map(); // file_id → Promise

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
  if (isP) {
    const tmpOut = path.join(UPLOAD_TMP, `pdfth_${Date.now()}_${randomBytes(4).toString('hex')}`);
    try {
      await new Promise((res, rej) => {
        const proc = spawn('pdftoppm', ['-jpeg', '-singlefile', '-scale-to', '320', filePath, tmpOut], { stdio: 'ignore' });
        proc.on('exit', code => code === 0 ? res() : rej(new Error('exit ' + code)));
        proc.on('error', rej);
        setTimeout(() => { try { proc.kill(); } catch {} rej(new Error('timeout')); }, 30_000);
      });
      const buf = await fs.readFile(`${tmpOut}.jpg`);
      await fs.rm(`${tmpOut}.jpg`, { force: true });
      return buf;
    } catch (e) { console.error('[pdf-thumb]', e.message); }
    return null;
  }
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

async function computeFileHash(filePath) {
  const hash = nodeCreateHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function uploadToTelegram(userId, tmpPath, originalName, mimeType, folderId) {
  const u = getUser(userId);
  if (!u) throw new Error('Usuario');
  const ctx = await getUserClient(userId);
  const stat = await fs.stat(tmpPath);
  const totalSize = stat.size;
  const detectedMime = mimeType || mime.lookup(originalName) || 'application/octet-stream';
  const [thumb, fileHash] = await Promise.all([
    generateThumb(tmpPath, detectedMime),
    computeFileHash(tmpPath).catch(() => null),
  ]);
  const finalName = uniqueName(u.id, u.tg_chat, originalName, folderId);
  const info = db.prepare('INSERT INTO files(user_id, name, folder_id, size, mime_type, thumb, channel, hash) VALUES(?,?,?,?,?,?,?,?) RETURNING id').get(u.id, finalName, folderId, totalSize, detectedMime, thumb, u.tg_chat, fileHash);
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
  `${BASE_PATH}/api/speedtest`,
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
    dirs:  db.prepare(`
      SELECT f.id, f.name, f.created_at,
        (SELECT token      FROM folder_shares WHERE folder_id=f.id AND (expires_at IS NULL OR expires_at > unixepoch()) ORDER BY created_at DESC LIMIT 1) AS share_token,
        (SELECT expires_at FROM folder_shares WHERE folder_id=f.id AND (expires_at IS NULL OR expires_at > unixepoch()) ORDER BY created_at DESC LIMIT 1) AS share_expires_at,
        (SELECT CASE WHEN expires_at IS NULL THEN 0 ELSE (expires_at - created_at) END FROM folder_shares WHERE folder_id=f.id AND (expires_at IS NULL OR expires_at > unixepoch()) ORDER BY created_at DESC LIMIT 1) AS share_duration
      FROM folders f WHERE f.user_id=? AND f.channel=? AND f.parent_id IS ?
      ORDER BY f.name COLLATE NOCASE`).all(u.id, ch, fid),
    files: db.prepare(`
      SELECT f.id, f.name, f.size, f.mime_type, f.created_at,
        (f.thumb IS NOT NULL) AS has_thumb,
        (SELECT COUNT(*) FROM chunks c WHERE c.file_id=f.id) AS chunk_count,
        (SELECT token      FROM shares WHERE file_id=f.id AND (expires_at IS NULL OR expires_at > unixepoch()) ORDER BY created_at DESC LIMIT 1) AS share_token,
        (SELECT expires_at FROM shares WHERE file_id=f.id AND (expires_at IS NULL OR expires_at > unixepoch()) ORDER BY created_at DESC LIMIT 1) AS share_expires_at,
        (SELECT CASE WHEN expires_at IS NULL THEN 0 ELSE (expires_at - created_at) END FROM shares WHERE file_id=f.id AND (expires_at IS NULL OR expires_at > unixepoch()) ORDER BY created_at DESC LIMIT 1) AS share_duration
      FROM files f WHERE f.user_id=? AND f.channel=? AND f.folder_id IS ?
      ORDER BY f.name COLLATE NOCASE`).all(u.id, ch, fid),
  };
});

fastify.get(`${BASE_PATH}/api/thumb`, async (req, reply) => {
  const u = getUser(req.session.user_id); if (!u) { reply.code(404); return; }
  const fileId = Number(req.query.id);
  if (!fileId) { reply.code(400); return; }
  const row = db.prepare('SELECT thumb, mime_type, size FROM files WHERE id=? AND user_id=? AND channel=?').get(fileId, u.id, u.tg_chat);
  if (!row) { reply.code(404); return; }
  if (row.thumb) {
    reply.header('Content-Type', 'image/jpeg').header('Cache-Control', 'public, max-age=604800');
    return reply.send(row.thumb);
  }
  // On-demand PDF thumbnail: download from Telegram, run pdftoppm, cache result
  const isPdf = row.mime_type === 'application/pdf' || (row.mime_type || '').includes('pdf');
  if (isPdf) {
    if (!pdfThumbInFlight.has(fileId)) {
      const p = (async () => {
        try {
          const chunks = db.prepare('SELECT * FROM chunks WHERE file_id=? ORDER BY idx').all(fileId);
          if (!chunks.length) return null;
          const ctx = await getUserClient(u.id);
          const tmpPdf = path.join(UPLOAD_TMP, `pdfreq_${fileId}_${randomBytes(4).toString('hex')}.pdf`);
          const ws = createWriteStream(tmpPdf);
          const locs = await resolveChunkLocs(ctx.client, ctx.peer, chunks);
          for await (const b of tgStreamFile(locs, ctx.client, row.size, 0, row.size - 1)) ws.write(b);
          await new Promise((res, rej) => { ws.end(); ws.on('finish', res); ws.on('error', rej); });
          const buf = await generateThumb(tmpPdf, 'application/pdf');
          await fs.rm(tmpPdf, { force: true });
          if (buf) db.prepare('UPDATE files SET thumb=? WHERE id=?').run(buf, fileId);
          return buf || null;
        } catch (e) { console.error('[pdf-thumb-req]', e.message); return null; }
      })();
      pdfThumbInFlight.set(fileId, p);
      p.finally(() => pdfThumbInFlight.delete(fileId));
    }
    const buf = await pdfThumbInFlight.get(fileId);
    if (buf) {
      reply.header('Content-Type', 'image/jpeg').header('Cache-Control', 'public, max-age=604800');
      return reply.send(buf);
    }
    reply.code(404); return;
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
    const locs = await resolveChunkLocs(ctx.client, ctx.peer, chunks);
    for await (const b of tgStreamFile(locs, ctx.client, file.size, start, end)) {
      const ok = reply.raw.write(b);
      if (!ok) await new Promise(r => reply.raw.once('drain', r));
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
  (async () => {
    try {
      const locs = await resolveChunkLocs(ctx.client, ctx.peer, chunks);
      for await (const b of tgStreamFile(locs, ctx.client, file.size, 0, file.size - 1))
        proc.stdin.write(b);
    } catch (e) { console.error('[transcode]', e.message); }
    proc.stdin.end();
  })();
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
      (async () => {
        try {
          const locs = await resolveChunkLocs(ctx.client, ctx.peer, ch);
          for await (const b of tgStreamFile(locs, ctx.client, f.size, 0, f.size - 1))
            pass.write(b);
        } catch {}
        pass.end();
      })();
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

// ─── Detección de duplicados ───────────────────────────────────────────────
fastify.post(`${BASE_PATH}/api/dedup/scan`, async (req, reply) => {
  const u = getUser(req.session.user_id); if (!u) { reply.code(401); return { error: 'no auth' }; }
  const folderId = (req.body?.folder_id == null) ? null : Number(req.body.folder_id);
  const files = db.prepare('SELECT id, name, size, mime_type, created_at, hash FROM files WHERE user_id=? AND channel=? AND folder_id IS ?').all(u.id, u.tg_chat, folderId);

  // Group by size first (catches files where one has a hash and the other doesn't)
  const bySize = {};
  for (const f of files) { (bySize[f.size] ??= []).push(f); }

  const groups = [];
  for (const grp of Object.values(bySize)) {
    if (grp.length < 2) continue;
    // If every file has a distinct non-null hash → confirmed different content → skip
    const nonNullHashes = grp.map(f => f.hash).filter(Boolean);
    if (nonNullHashes.length === grp.length && new Set(nonNullHashes).size === grp.length) continue;
    // Determine confidence: 'hash' if any two share the same hash, 'size' otherwise
    const method = (new Set(nonNullHashes).size < nonNullHashes.length) ? 'hash' : 'size';
    groups.push({ method, files: grp });
  }
  return { groups };
});

fastify.post(`${BASE_PATH}/api/dedup/check`, async (req, reply) => {
  const u = getUser(req.session.user_id); if (!u) { reply.code(401); return { error: 'no auth' }; }
  const folderId = (req.body?.folder_id == null) ? null : Number(req.body.folder_id);
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) return { matches: [] };

  const existing = db.prepare('SELECT id, name, size, hash FROM files WHERE user_id=? AND channel=? AND folder_id IS ?').all(u.id, u.tg_chat, folderId);
  const byHash = {}, bySize = {};
  for (const f of existing) {
    if (f.hash) byHash[f.hash] = f;
    (bySize[f.size] ??= []).push(f);
  }

  const matches = items.map(item => {
    if (item.hash) {
      if (byHash[item.hash]) return { idx: item.idx, method: 'hash', match: byHash[item.hash] };
      // Same size but existing has no hash — probable duplicate (can't confirm different)
      const probable = (bySize[item.size] || []).filter(f => !f.hash);
      if (probable.length) return { idx: item.idx, method: 'size', match: probable[0] };
    } else {
      if ((bySize[item.size] || []).length) return { idx: item.idx, method: 'size', match: bySize[item.size][0] };
    }
    return null;
  }).filter(Boolean);
  return { matches };
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
      return { res, status_code: 200, body: JSON.stringify({ ok: true, id: fileId }) };
    } catch (err) {
      console.error('[upload] error:', err.message);
      return { res, status_code: 500, body: JSON.stringify({ ok: false, error: err.message }) };
    } finally {
      await fs.rm(tmpPath,           { force: true });
      await fs.rm(`${tmpPath}.json`, { force: true });
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

// ─── Speed test (diagnóstico VPS→usuario) ─────────────────────────────────
fastify.get(`${BASE_PATH}/api/speedtest`, async (req, reply) => {
  const MB = parseInt(req.query.mb || '100', 10);
  const total = MB * 1024 * 1024;
  reply.raw.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(total),
    'Content-Disposition': `attachment; filename="speedtest_${MB}MB.bin"`,
    'Cache-Control': 'no-store',
  });
  reply.hijack();
  const chunk = Buffer.alloc(256 * 1024); // 256 KB de ceros
  let sent = 0;
  while (sent < total) {
    const slice = chunk.slice(0, Math.min(chunk.length, total - sent));
    const ok = reply.raw.write(slice);
    if (!ok) await new Promise(r => reply.raw.once('drain', r));
    sent += slice.length;
  }
  reply.raw.end();
});

// ─── Share helpers ─────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function fmtSizeServer(n) {
  const u = ['B','KB','MB','GB','TB']; let i = 0, x = Number(n) || 0;
  while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
  return (x < 10 && i > 0 ? x.toFixed(1) : Math.round(x)) + ' ' + u[i];
}
function shareFileIcon(mime) {
  if (!mime) return '📦';
  if (mime.startsWith('image/')) return '🖼️';
  if (mime.startsWith('video/')) return '🎬';
  if (mime.startsWith('audio/')) return '🎵';
  if (mime.includes('pdf'))      return '📕';
  if (mime.includes('zip') || mime.includes('tar') || mime.includes('compress')) return '🗜️';
  if (mime.startsWith('text/'))  return '📄';
  return '📦';
}
function getActiveShare(token) {
  if (!token) return null;
  const now = Math.floor(Date.now() / 1000);
  const file = db.prepare(`
    SELECT s.token, s.expires_at, s.file_id, s.user_id,
           f.name, f.size, f.mime_type, f.thumb
    FROM shares s
    JOIN files f ON f.id = s.file_id
    JOIN users u ON u.id = s.user_id AND u.tg_chat = f.channel
    WHERE s.token = ? AND (s.expires_at IS NULL OR s.expires_at > ?)
  `).get(token, now);
  if (file) return { ...file, type: 'file' };
  const folder = db.prepare(`
    SELECT fs.token, fs.expires_at, fs.folder_id, fs.user_id,
           fo.name, fo.channel
    FROM folder_shares fs
    JOIN folders fo ON fo.id = fs.folder_id
    JOIN users u ON u.id = fs.user_id AND u.tg_chat = fo.channel
    WHERE fs.token = ? AND (fs.expires_at IS NULL OR fs.expires_at > ?)
  `).get(token, now);
  if (folder) return { ...folder, type: 'folder' };
  return null;
}
async function sharePageHtml(share, token, shareUrl) {
  const mime    = share.mime_type || '';
  const isImg   = mime.startsWith('image/');
  const isVideo = mime.startsWith('video/');
  const isAudio = mime.startsWith('audio/');
  const hasThumb = share.thumb != null;
  const expiry  = share.expires_at
    ? `Expira el ${new Date(share.expires_at * 1000).toLocaleString('es', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' })}`
    : 'Enlace permanente';
  const dlUrl    = `${BASE_PATH}/s/${token}/download`;
  const thumbUrl = `${BASE_PATH}/s/${token}/thumb`;
  let preview = '';
  if (isImg) {
    preview = `<img class="sp-preview" src="${thumbUrl}" alt="${escHtml(share.name)}" onerror="this.hidden=true"/>`;
  } else if (isVideo) {
    preview = `<video class="sp-video" controls preload="metadata" src="${dlUrl}"></video>`;
  } else if (isAudio) {
    preview = `<audio controls src="${dlUrl}" style="width:100%;margin:12px 0 4px"></audio>`;
  } else if (hasThumb) {
    preview = `<img class="sp-preview sp-thumb" src="${thumbUrl}" alt="" onerror="this.hidden=true"/>`;
  }
  const icon = (isImg || isVideo || isAudio) ? '' : `<div class="sp-icon">${shareFileIcon(mime)}</div>`;
  const qrDataUrl = await QRCode.toDataURL(shareUrl, { width: 240, margin: 2, color: { dark: '#000000', light: '#ffffff' } });
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${escHtml(share.name)} — cloud</title>
  <meta property="og:title" content="${escHtml(share.name)}"/>
  <meta property="og:description" content="${escHtml(fmtSizeServer(share.size))} · ${escHtml(expiry)}"/>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    body{font-family:system-ui,sans-serif;background:#0b0b14;color:#f0edf8;display:flex;flex-direction:column;min-height:100svh;align-items:center;justify-content:center;padding:20px}
    .sp-card{background:#13131f;border:1px solid rgba(255,255,255,.08);border-radius:20px;padding:32px 28px;max-width:460px;width:100%;text-align:center;box-shadow:0 24px 64px rgba(0,0,0,.55);display:flex;flex-direction:column;align-items:center;gap:14px}
    .sp-icon{font-size:3.5rem}
    .sp-preview{max-width:100%;max-height:240px;object-fit:contain;border-radius:12px}
    .sp-video{width:100%;max-height:260px;border-radius:12px;background:#000}
    .sp-thumb{max-height:160px}
    .sp-name{font-size:1.1rem;font-weight:700;word-break:break-all;color:#f0edf8}
    .sp-meta{color:#7a7a9a;font-size:.88rem}
    .sp-btn{background:#7c3aed;color:#fff;border:none;border-radius:12px;padding:14px 40px;font-size:1rem;font-weight:700;cursor:pointer;text-decoration:none;transition:background .15s,transform .12s;display:inline-block}
    .sp-btn:hover{background:#6d28d9;transform:translateY(-1px)}
    .sp-expiry{color:rgba(122,122,154,.7);font-size:.78rem}
    .sp-countdown{font-size:.82rem;font-family:ui-monospace,monospace;min-height:1.2em}
    .sp-divider{width:100%;height:1px;background:rgba(255,255,255,.07);margin:4px 0}
    .sp-qr-wrap{display:flex;flex-direction:column;align-items:center;gap:10px;width:100%}
    .sp-qr-label{color:rgba(122,122,154,.55);font-size:.72rem;letter-spacing:.04em;text-transform:uppercase}
    .sp-qr{width:160px;height:160px;border-radius:14px;background:#fff;padding:8px;display:block;box-shadow:0 4px 24px rgba(0,0,0,.4)}
    .sp-qr-actions{display:flex;gap:8px}
    .sp-qr-btn{background:rgba(124,58,237,.18);border:1px solid rgba(124,58,237,.35);border-radius:9px;color:#c4b5fd;padding:7px 18px;font:inherit;font-size:.82rem;cursor:pointer;transition:background .15s,color .15s}
    .sp-qr-btn:hover{background:rgba(124,58,237,.32);color:#ede9fe}
    .sp-brand{color:rgba(122,122,154,.35);font-size:.7rem;margin-top:4px}
  </style>
</head>
<body>
  <div class="sp-card">
    ${icon}${preview}
    <div class="sp-name">${escHtml(share.name)}</div>
    <div class="sp-meta">${escHtml(fmtSizeServer(share.size))}</div>
    <a class="sp-btn" href="${dlUrl}">⬇ Descargar</a>
    ${share.expires_at
      ? `<div class="sp-countdown" id="sp-cd"></div>
  <script>
  (function(){
    var exp=${share.expires_at},el=document.getElementById('sp-cd');
    function upd(){
      var d=exp-Math.floor(Date.now()/1000);
      if(d<=0){el.textContent='⚠ Enlace expirado';el.style.color='#ff7a90';return;}
      var h=Math.floor(d/3600),m=Math.floor((d%3600)/60),s=d%60;
      var t='Expira en ';
      if(h)t+=h+'h ';
      if(h||m)t+=(h&&m<10?'0':'')+m+'m ';
      t+=(s<10?'0':'')+s+'s';
      el.style.color=d<300?'#ff7a90':d<3600?'#f59e0b':'rgba(122,122,154,.7)';
      el.textContent=t;
      setTimeout(upd,1000);
    }
    upd();
  })();
  </script>`
      : `<div class="sp-expiry">Enlace permanente</div>`}
    <div class="sp-divider"></div>
    <div class="sp-qr-wrap">
      <span class="sp-qr-label">Escanea para compartir</span>
      <img class="sp-qr" id="sp-qr" src="${qrDataUrl}" alt="QR"/>
      <div class="sp-qr-actions">
        <button class="sp-qr-btn" id="sp-share-btn">↗ Compartir enlace</button>
        <button class="sp-qr-btn" id="sp-dl-qr-btn">↗ Compartir QR</button>
      </div>
    </div>
    <div class="sp-brand">cloud</div>
  </div>
  <script>
  (function(){
    var url='${escHtml(shareUrl)}';
    var name='${escHtml(share.name)}';
    document.getElementById('sp-share-btn').addEventListener('click',function(){
      if(navigator.share){navigator.share({url:url,title:name});return;}
      navigator.clipboard&&navigator.clipboard.writeText(url);
    });
    document.getElementById('sp-dl-qr-btn').addEventListener('click',async function(){
      var dataUrl=document.getElementById('sp-qr').src;
      try{
        var res=await fetch(dataUrl);
        var blob=await res.blob();
        var file=new File([blob],'qr-'+name+'.png',{type:'image/png'});
        if(navigator.canShare&&navigator.canShare({files:[file]})){
          await navigator.share({files:[file],title:name,text:url});
          return;
        }
      }catch(e){}
      var a=document.createElement('a');a.href=dataUrl;a.download='qr-'+name+'.png';a.click();
    });
  })();
  </script>
</body>
</html>`;
}
async function folderSharePageHtml(share, token, shareUrl) {
  const dlUrl     = `${BASE_PATH}/s/${token}/download`;
  const lsBase    = `${BASE_PATH}/s/${token}/ls`;
  const fileBase  = `${BASE_PATH}/s/${token}/file`;
  const thumbBase = `${BASE_PATH}/s/${token}/thumb`;
  const qrDataUrl = await QRCode.toDataURL(shareUrl, { width: 200, margin: 2, color: { dark: '#000000', light: '#ffffff' } });
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${escHtml(share.name)} — cloud</title>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    :root{--bg:#07070f;--surf:#0f0f1c;--surf2:#13131f;--border:rgba(255,255,255,.08);--border2:rgba(255,255,255,.05);--text:#e8e4f4;--muted:#7a7a9a;--purple:#7c3aed;--purple-l:#a78bfa;--purple-dim:rgba(124,58,237,.18);--purple-border:rgba(124,58,237,.35)}
    html,body{height:100%}
    body{font-family:system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--text);display:flex;flex-direction:column;align-items:center;justify-content:flex-start;padding:28px 20px;min-height:100%}
    /* ── Window ── */
    .fe{width:100%;max-width:920px;background:var(--surf);border:1px solid var(--border);border-radius:14px;box-shadow:0 32px 80px rgba(0,0,0,.7);display:flex;flex-direction:column;overflow:hidden;min-height:520px}
    /* ── Title bar ── */
    .fe-bar{display:flex;align-items:center;gap:12px;padding:13px 18px;background:var(--surf2);border-bottom:1px solid var(--border);flex-shrink:0}
    .fe-bar-icon{font-size:1.3rem;flex-shrink:0}
    .fe-bar-info{flex:1;min-width:0}
    .fe-bar-name{font-size:.95rem;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .fe-bar-sub{font-size:.72rem;color:var(--muted);margin-top:1px}
    .fe-bar-actions{display:flex;gap:7px;flex-shrink:0;align-items:center}
    .fe-btn{display:inline-flex;align-items:center;gap:5px;background:var(--purple);color:#fff;border:none;border-radius:8px;padding:7px 13px;font:inherit;font-size:.8rem;font-weight:600;cursor:pointer;text-decoration:none;white-space:nowrap;transition:background .15s,transform .1s}
    .fe-btn:hover{background:#6d28d9;transform:translateY(-1px)}
    .fe-btn-ghost{background:var(--purple-dim);color:var(--purple-l);border:1px solid var(--purple-border)}
    .fe-btn-ghost:hover{background:rgba(124,58,237,.28)}
    /* ── Address bar ── */
    .fe-addr{display:flex;align-items:center;gap:3px;flex-wrap:wrap;padding:7px 16px;background:rgba(0,0,0,.25);border-bottom:1px solid var(--border2);min-height:36px;flex-shrink:0}
    .fe-addr-home{background:none;border:none;color:var(--purple-l);font:inherit;font-size:.8rem;cursor:pointer;padding:2px 6px;border-radius:5px}
    .fe-addr-home:hover{background:var(--purple-dim)}
    .fe-addr-sep{color:#3a3a5a;font-size:.78rem;user-select:none}
    .fe-addr-seg{background:none;border:none;color:var(--purple-l);font:inherit;font-size:.8rem;cursor:pointer;padding:2px 6px;border-radius:5px}
    .fe-addr-seg:hover{background:var(--purple-dim)}
    .fe-addr-cur{font-size:.8rem;color:var(--text);padding:2px 6px;font-weight:500}
    /* ── Content ── */
    .fe-content{flex:1;overflow-y:auto;padding:16px}
    /* ── Grid ── */
    .fe-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(108px,1fr));gap:4px}
    .fe-item{display:flex;flex-direction:column;align-items:center;gap:0;padding:8px 7px 9px;border-radius:10px;cursor:pointer;border:1px solid transparent;text-align:center;text-decoration:none;color:inherit;transition:background .12s,border-color .12s;position:relative;-webkit-user-select:none;user-select:none}
    .fe-item:hover{background:rgba(124,58,237,.1);border-color:rgba(124,58,237,.28)}
    .fe-item:active{background:rgba(124,58,237,.18);transform:scale(.97)}
    .fe-item-preview{width:100%;height:72px;display:flex;align-items:center;justify-content:center;border-radius:7px;overflow:hidden;margin-bottom:7px;background:rgba(255,255,255,.03)}
    .fe-item-thumb{width:100%;height:100%;object-fit:cover;display:block;border-radius:7px}
    .fe-item-icon{font-size:2.6rem;line-height:1;filter:drop-shadow(0 2px 6px rgba(0,0,0,.4))}
    .fe-item-name{font-size:.72rem;color:var(--text);line-height:1.35;word-break:break-word;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;max-width:100%;margin-bottom:2px}
    .fe-item-meta{font-size:.65rem;color:var(--muted)}
    .fe-dl-btn{width:100%;background:var(--purple-dim);border:1px solid var(--purple-border);color:var(--purple-l);border-radius:6px;font-size:.73rem;font-weight:600;padding:7px 0;text-align:center;opacity:0;transition:opacity .15s;margin-top:auto;flex-shrink:0}
    .fe-item:hover .fe-dl-btn{opacity:1}
    /* ── State ── */
    .fe-state{grid-column:1/-1;text-align:center;color:var(--muted);padding:56px 20px;font-size:.9rem}
    .fe-state-icon{font-size:2.5rem;margin-bottom:10px;opacity:.4}
    /* ── Status bar ── */
    .fe-status{display:flex;align-items:center;justify-content:space-between;padding:5px 16px;background:rgba(0,0,0,.2);border-top:1px solid var(--border2);flex-shrink:0;font-size:.72rem;color:var(--muted);gap:8px}
    .fe-status-cd{font-family:ui-monospace,monospace}
    /* ── Share bar ── */
    .fe-share-bar{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:10px 16px;background:rgba(0,0,0,.2);border-top:1px solid var(--border2);flex-shrink:0}
    .fe-share-sbtn{background:var(--purple-dim);border:1px solid var(--purple-border);border-radius:8px;color:var(--purple-l);padding:8px 16px;font:inherit;font-size:.8rem;font-weight:600;cursor:pointer;transition:background .15s,color .15s}
    .fe-share-sbtn:hover{background:rgba(124,58,237,.3);color:#ede9fe}
    /* ── QR Modal ── */
    .fe-qr-overlay{position:fixed;inset:0;background:rgba(0,0,0,.78);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;z-index:9999;padding:20px}
    .fe-qr-overlay.hidden{display:none}
    .fe-qr-card{position:relative;background:var(--surf);border:1px solid var(--border);border-radius:18px;padding:28px 22px 22px;display:flex;flex-direction:column;align-items:center;gap:14px;max-width:300px;width:100%;box-shadow:0 40px 100px rgba(0,0,0,.85)}
    .fe-qr-card-close{position:absolute;top:12px;right:12px;background:rgba(255,255,255,.07);border:1px solid var(--border);color:var(--muted);width:28px;height:28px;border-radius:50%;font-size:.9rem;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1;padding:0;transition:background .15s}
    .fe-qr-card-close:hover{background:rgba(255,255,255,.14)}
    .fe-qr-card-img{width:192px;height:192px;border-radius:10px;background:#fff;padding:8px;display:block}
    .fe-qr-card-url{font-size:.7rem;color:var(--muted);text-align:center;word-break:break-all;max-width:100%}
    .fe-qr-card-btns{display:flex;gap:8px;width:100%}
    .fe-qr-card-btn{flex:1;background:var(--purple-dim);border:1px solid var(--purple-border);border-radius:8px;color:var(--purple-l);padding:9px 10px;font:inherit;font-size:.78rem;font-weight:600;cursor:pointer;transition:background .15s,color .15s;text-align:center}
    .fe-qr-card-btn:hover{background:rgba(124,58,237,.3);color:#ede9fe}
    /* ── Mobile ── */
    @media(max-width:600px){
      body{padding:0}
      .fe{border-radius:0;border:none;min-height:100svh;max-width:100%}
      .fe-grid{grid-template-columns:1fr}
      .fe-item{flex-direction:row;padding:8px 12px;text-align:left;gap:10px;align-items:center;border-radius:8px}
      .fe-item-preview{width:44px;height:44px;min-width:44px;margin-bottom:0;flex-shrink:0}
      .fe-item-icon{font-size:1.7rem}
      .fe-item-name{-webkit-line-clamp:1;flex:1;margin-bottom:0}
      .fe-dl-btn{opacity:1;width:auto;padding:10px 18px;margin-top:0;flex-shrink:0}
      .fe-share-bar{justify-content:center}
    }
  </style>
</head>
<body>
<div class="fe">
  <!-- Title bar -->
  <div class="fe-bar">
    <div class="fe-bar-icon">📁</div>
    <div class="fe-bar-info">
      <div class="fe-bar-name">${escHtml(share.name)}</div>
      <div class="fe-bar-sub">Carpeta compartida</div>
    </div>
    <div class="fe-bar-actions">
      <a class="fe-btn" href="${dlUrl}">⬇ Descargar todo</a>
    </div>
  </div>
  <!-- Address bar -->
  <div class="fe-addr" id="fe-addr">
    <button class="fe-addr-home" onclick="window._load(null)">📁 ${escHtml(share.name)}</button>
  </div>
  <!-- File grid -->
  <div class="fe-content">
    <div class="fe-grid" id="fe-grid">
      <div class="fe-state"><div class="fe-state-icon">⏳</div>Cargando…</div>
    </div>
  </div>
  <!-- Status bar -->
  <div class="fe-status">
    <span id="fe-count"></span>
    <span class="fe-status-cd" id="fe-cd">${share.expires_at ? '' : 'Enlace permanente'}</span>
  </div>
  <!-- Share bar -->
  <div class="fe-share-bar">
    <button class="fe-share-sbtn" id="fe-copy-btn">🔗 Copiar enlace</button>
    <button class="fe-share-sbtn" id="fe-qr-open-btn">⬛ Ver QR</button>
  </div>
</div>
<!-- QR Modal -->
<div class="fe-qr-overlay hidden" id="fe-qr-overlay">
  <div class="fe-qr-card">
    <button class="fe-qr-card-close" id="fe-qr-close">✕</button>
    <img class="fe-qr-card-img" id="fe-qr" src="${qrDataUrl}" alt="QR">
    <div class="fe-qr-card-url">${escHtml(shareUrl)}</div>
    <div class="fe-qr-card-btns">
      <button class="fe-qr-card-btn" id="fe-qr-share-btn">↗ Compartir QR</button>
    </div>
  </div>
</div>
<script>
(function(){
  var LS='${lsBase}',FB='${fileBase}',TB='${thumbBase}',SU='${escHtml(shareUrl)}',NAME='${escHtml(share.name)}';
  function fmt(b){if(!b)return'0 B';var u=['B','KB','MB','GB'],i=0;while(b>=1024&&i<3){b/=1024;i++;}return b.toFixed(i?1:0)+' '+u[i];}
  function icon(m){if(!m)return'📄';if(m.startsWith('image/'))return'🖼️';if(m.startsWith('video/'))return'🎬';if(m.startsWith('audio/'))return'🎵';if(m.includes('pdf'))return'📑';if(m.includes('zip')||m.includes('tar')||m.includes('rar')||m.includes('7z'))return'🗜️';if(m.includes('word')||m.includes('document')||m.includes('odt'))return'📝';if(m.includes('sheet')||m.includes('excel')||m.includes('ods'))return'📊';if(m.startsWith('text/'))return'📃';return'📄';}
  function hasThumb(m){return m&&(m.startsWith('image/')||m.startsWith('video/')||m.startsWith('audio/')||m.includes('pdf'));}
  function esc(s){return String(s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
  function previewHtml(f){
    if(hasThumb(f.mime_type)){
      return '<div class="fe-item-preview">'
        +'<img class="fe-item-thumb" src="'+TB+'/'+f.id+'" alt="" data-icon="'+icon(f.mime_type)+'">'
        +'</div>';
    }
    return '<div class="fe-item-preview"><span class="fe-item-icon">'+icon(f.mime_type)+'</span></div>';
  }
  var _crumbs=[];
  async function load(fid){
    var g=document.getElementById('fe-grid');
    g.innerHTML='<div class="fe-state"><div class="fe-state-icon">⏳</div>Cargando…</div>';
    try{
      var r=await fetch(fid!=null?LS+'?f='+fid:LS);
      var d=await r.json();
      _crumbs=d.crumbs||[];
      renderAddr(_crumbs);
      renderGrid(d.folders,d.files);
    }catch(e){g.innerHTML='<div class="fe-state"><div class="fe-state-icon">⚠️</div>Error al cargar</div>';}
  }
  function renderAddr(crumbs){
    var el=document.getElementById('fe-addr');
    if(!crumbs||crumbs.length<=1){el.innerHTML='<button class="fe-addr-home" onclick="window._load(null)">📁 '+esc(NAME)+'</button>';return;}
    var html='<button class="fe-addr-home" onclick="window._load(null)">📁 '+esc(NAME)+'</button>';
    for(var i=0;i<crumbs.length;i++){
      html+='<span class="fe-addr-sep">›</span>';
      if(i<crumbs.length-1){html+='<button class="fe-addr-seg" onclick="window._load('+crumbs[i].id+')">'+esc(crumbs[i].name)+'</button>';}
      else{html+='<span class="fe-addr-cur">'+esc(crumbs[i].name)+'</span>';}
    }
    el.innerHTML=html;
  }
  function renderGrid(folders,files){
    var g=document.getElementById('fe-grid');
    var total=folders.length+files.length;
    document.getElementById('fe-count').textContent=total===0?'Carpeta vacía':total+' elemento'+(total===1?'':'s')+(folders.length?' ('+folders.length+' carpeta'+(folders.length===1?'':'s')+(files.length?', '+files.length+' archivo'+(files.length===1?'':'s'):'')+')':'');
    if(!total){g.innerHTML='<div class="fe-state"><div class="fe-state-icon">📭</div>Esta carpeta está vacía</div>';return;}
    var items=folders.map(function(f){
      return '<div class="fe-item" onclick="window._load('+f.id+')" title="'+esc(f.name)+'">'
        +'<div class="fe-item-preview"><span class="fe-item-icon">📁</span></div>'
        +'<div class="fe-item-name">'+esc(f.name)+'</div>'
        +'</div>';
    }).concat(files.map(function(f){
      return '<a class="fe-item" href="'+FB+'/'+f.id+'" download="'+esc(f.name)+'" title="'+esc(f.name)+' · '+fmt(f.size)+'">'
        +previewHtml(f)
        +'<div class="fe-item-name">'+esc(f.name)+'</div>'
        +'<div class="fe-item-meta">'+fmt(f.size)+'</div>'
        +'<div class="fe-dl-btn">⬇ Descargar</div>'
        +'</a>';
    }));
    g.innerHTML=items.join('');
    g.querySelectorAll('img[data-icon]').forEach(function(img){
      img.onerror=function(){
        img.parentNode.innerHTML='<span class="fe-item-icon">'+img.dataset.icon+'</span>';
      };
    });
  }
  window._load=load;
  load(null);
  ${share.expires_at?`
  (function(){
    var exp=${share.expires_at},el=document.getElementById('fe-cd');
    function upd(){var d=exp-Math.floor(Date.now()/1000);if(d<=0){el.textContent='⚠ Enlace expirado';el.style.color='#ff7a90';return;}var h=Math.floor(d/3600),m=Math.floor((d%3600)/60),s=d%60;var t='Expira en ';if(h)t+=h+'h ';if(h||m)t+=(h&&m<10?'0':'')+m+'m ';t+=(s<10?'0':'')+s+'s';el.style.color=d<300?'#ff7a90':d<3600?'#f59e0b':'';el.textContent=t;setTimeout(upd,1000);}upd();
  })();`:''}
  document.getElementById('fe-copy-btn').addEventListener('click',function(){
    var btn=document.getElementById('fe-copy-btn');
    navigator.clipboard&&navigator.clipboard.writeText(SU).then(function(){btn.textContent='✓ Copiado!';setTimeout(function(){btn.textContent='🔗 Copiar enlace';},2000);});
  });
  document.getElementById('fe-qr-open-btn').addEventListener('click',function(){
    document.getElementById('fe-qr-overlay').classList.remove('hidden');
  });
  document.getElementById('fe-qr-close').addEventListener('click',function(){
    document.getElementById('fe-qr-overlay').classList.add('hidden');
  });
  document.getElementById('fe-qr-overlay').addEventListener('click',function(e){
    if(e.target===this)this.classList.add('hidden');
  });
  document.getElementById('fe-qr-share-btn').addEventListener('click',async function(){
    var dataUrl=document.getElementById('fe-qr').src;
    try{var res=await fetch(dataUrl);var blob=await res.blob();var file=new File([blob],'qr-'+NAME+'.png',{type:'image/png'});if(navigator.canShare&&navigator.canShare({files:[file]})){await navigator.share({files:[file],title:NAME,text:SU});return;}}catch(e){}
    var a=document.createElement('a');a.href=dataUrl;a.download='qr-'+NAME+'.png';a.click();
  });
})();
</script>
</body>
</html>`;
}
function shareNotFoundHtml() {
  return `<!doctype html>
<html lang="es">
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Enlace expirado — cloud</title>
<style>*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,sans-serif;background:#0b0b14;color:#f0edf8;display:flex;flex-direction:column;min-height:100svh;align-items:center;justify-content:center;padding:20px}.sp-card{background:#13131f;border:1px solid rgba(255,255,255,.08);border-radius:20px;padding:32px 28px;max-width:400px;width:100%;text-align:center;box-shadow:0 24px 64px rgba(0,0,0,.5)}.sp-icon{font-size:3rem;margin-bottom:14px}.sp-title{font-size:1.1rem;font-weight:700;margin-bottom:8px}.sp-sub{color:#7a7a9a;font-size:.9rem;line-height:1.5}.sp-brand{color:rgba(122,122,154,.4);font-size:.72rem;margin-top:20px}</style></head>
<body><div class="sp-card">
  <div class="sp-icon">🔗</div>
  <div class="sp-title">Enlace no válido o expirado</div>
  <div class="sp-sub">Este enlace no existe o ha caducado.</div>
  <div class="sp-brand">cloud</div>
</div></body></html>`;
}

// ─── Share endpoints ────────────────────────────────────────────────────────

fastify.post(`${BASE_PATH}/api/share`, async (req, reply) => {
  const u = getUser(req.session.user_id);
  if (!u) { reply.code(404); return { error: 'usuario' }; }
  const fileId   = Number(req.body?.fileId)   || 0;
  const folderId = Number(req.body?.folderId) || 0;
  const dur      = Number(req.body?.duration) || 0;
  const token    = randomBytes(20).toString('hex');
  const expires_at = dur > 0 ? Math.floor(Date.now() / 1000) + dur : null;
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  if (fileId) {
    const file = db.prepare('SELECT id FROM files WHERE id=? AND user_id=? AND channel=?').get(fileId, u.id, u.tg_chat);
    if (!file) { reply.code(404); return { error: 'Archivo no encontrado' }; }
    db.prepare('INSERT INTO shares(token, file_id, user_id, expires_at) VALUES(?,?,?,?)').run(token, file.id, u.id, expires_at);
  } else if (folderId) {
    const folder = db.prepare('SELECT id FROM folders WHERE id=? AND user_id=? AND channel=?').get(folderId, u.id, u.tg_chat);
    if (!folder) { reply.code(404); return { error: 'Carpeta no encontrada' }; }
    db.prepare('INSERT INTO folder_shares(token, folder_id, user_id, expires_at) VALUES(?,?,?,?)').run(token, folder.id, u.id, expires_at);
  } else {
    reply.code(400); return { error: 'Falta fileId o folderId' };
  }
  return { ok: true, token, url: `https://${host}${BASE_PATH}/s/${token}`, expires_at };
});

fastify.delete(`${BASE_PATH}/api/share/:token`, async (req, reply) => {
  const uid = req.session.user_id;
  const r1 = db.prepare('DELETE FROM shares WHERE token=? AND user_id=?').run(req.params.token, uid);
  const r2 = db.prepare('DELETE FROM folder_shares WHERE token=? AND user_id=?').run(req.params.token, uid);
  if (!r1.changes && !r2.changes) { reply.code(404); return { error: 'No encontrado' }; }
  return { ok: true };
});

fastify.get(`${BASE_PATH}/s/:token`, async (req, reply) => {
  const share = getActiveShare(req.params.token);
  reply.header('Cache-Control', 'no-store');
  if (!share) { reply.code(404).type('text/html').send(shareNotFoundHtml()); return; }
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host  = req.headers['x-forwarded-host']  || req.headers.host || 'localhost';
  const shareUrl = `${proto}://${host}${BASE_PATH}/s/${req.params.token}`;
  const html = share.type === 'folder'
    ? await folderSharePageHtml(share, req.params.token, shareUrl)
    : await sharePageHtml(share, req.params.token, shareUrl);
  reply.type('text/html').send(html);
});

fastify.get(`${BASE_PATH}/s/:token/thumb`, async (req, reply) => {
  const share = getActiveShare(req.params.token);
  if (!share || share.type === 'folder') { reply.code(404); return; }
  if (share.thumb) {
    reply.header('Content-Type', 'image/jpeg').header('Cache-Control', 'public, max-age=604800');
    return reply.send(share.thumb);
  }
  const buf = await fetchTgThumb(share.user_id, share.file_id);
  if (!buf) { reply.code(404); return; }
  reply.header('Content-Type', 'image/jpeg').header('Cache-Control', 'public, max-age=604800');
  return reply.send(buf);
});

fastify.get(`${BASE_PATH}/s/:token/qr`, async (req, reply) => {
  const share = getActiveShare(req.params.token);
  if (!share) { reply.code(404); return; }
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  const shareUrl = `https://${host}${BASE_PATH}/s/${req.params.token}`;
  try {
    const png = await QRCode.toBuffer(shareUrl, { width: 260, margin: 2 });
    reply.header('Content-Type', 'image/png').header('Cache-Control', 'public, max-age=3600');
    return reply.send(png);
  } catch { reply.code(500); return; }
});

fastify.get(`${BASE_PATH}/s/:token/download`, async (req, reply) => {
  const share = getActiveShare(req.params.token);
  if (!share) { reply.code(404); return; }

  if (share.type === 'folder') {
    let ctx; try { ctx = await getUserClient(share.user_id); }
    catch { reply.code(503).send({ error: 'Servicio temporalmente no disponible' }); return; }
    reply.raw.writeHead(200, {
      'Content-Type': 'application/zip', 'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(share.name + '.zip')}`,
    });
    reply.hijack();
    const archive = archiver('zip', { store: true });
    archive.on('error', () => { try { reply.raw.destroy(); } catch {} });
    archive.pipe(reply.raw);
    async function addFolderToZip(folderId, prefix) {
      const { PassThrough } = await import('node:stream');
      for (const f of db.prepare('SELECT * FROM files WHERE user_id=? AND channel=? AND folder_id IS ?').all(share.user_id, share.channel, folderId)) {
        const ch = db.prepare('SELECT * FROM chunks WHERE file_id=? ORDER BY idx').all(f.id);
        const pass = new PassThrough();
        archive.append(pass, { name: prefix + f.name });
        (async () => {
          try {
            const locs = await resolveChunkLocs(ctx.client, ctx.peer, ch);
            for await (const b of tgStreamFile(locs, ctx.client, f.size, 0, f.size - 1)) pass.write(b);
          } catch {}
          pass.end();
        })();
      }
      for (const d of db.prepare('SELECT * FROM folders WHERE user_id=? AND channel=? AND parent_id IS ?').all(share.user_id, share.channel, folderId))
        await addFolderToZip(d.id, prefix + d.name + '/');
    }
    await addFolderToZip(share.folder_id, share.name + '/');
    archive.finalize();
    return;
  }

  const chunks = db.prepare('SELECT * FROM chunks WHERE file_id=? ORDER BY idx').all(share.file_id);
  if (!chunks.length) { reply.code(404); return; }
  let ctx; try { ctx = await getUserClient(share.user_id); }
  catch { reply.code(503).send({ error: 'Servicio temporalmente no disponible' }); return; }

  const total = share.size, rangeHdr = req.headers.range;
  let start = 0, end = total - 1;
  if (rangeHdr) { const m = rangeHdr.match(/bytes=(\d+)-(\d*)/); if (m) { start = +m[1]; if (m[2]) end = +m[2]; } end = Math.min(end, total - 1); }
  reply.raw.writeHead(rangeHdr ? 206 : 200, {
    'Content-Type': share.mime_type,
    'Content-Length': String(end - start + 1),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(share.name)}`,
    ...(rangeHdr ? { 'Content-Range': `bytes ${start}-${end}/${total}` } : {}),
  });
  reply.hijack();
  try {
    const locs = await resolveChunkLocs(ctx.client, ctx.peer, chunks);
    for await (const b of tgStreamFile(locs, ctx.client, share.size, start, end)) {
      const ok = reply.raw.write(b);
      if (!ok) await new Promise(r => reply.raw.once('drain', r));
    }
  } catch (e) { console.error('[share-dl]', e.message); }
  reply.raw.end();
});

// ─── Folder share browsing ─────────────────────────────────────────────────

function folderInShareTree(folderId, rootId) {
  let cur = folderId;
  const seen = new Set();
  while (cur != null) {
    if (cur === rootId) return true;
    if (seen.has(cur)) return false;
    seen.add(cur);
    const row = db.prepare('SELECT parent_id FROM folders WHERE id=?').get(cur);
    if (!row) return false;
    cur = row.parent_id;
  }
  return false;
}

fastify.get(`${BASE_PATH}/s/:token/ls`, async (req, reply) => {
  const share = getActiveShare(req.params.token);
  if (!share || share.type !== 'folder') { reply.code(404); return { error: 'not found' }; }
  const folderId = req.query.f ? Number(req.query.f) : share.folder_id;
  if (folderId !== share.folder_id && !folderInShareTree(folderId, share.folder_id)) {
    reply.code(403); return { error: 'forbidden' };
  }
  const folders = db.prepare('SELECT id, name FROM folders WHERE parent_id=? AND user_id=? ORDER BY name COLLATE NOCASE').all(folderId, share.user_id);
  const files   = db.prepare('SELECT id, name, size, mime_type FROM files WHERE folder_id=? AND user_id=? ORDER BY name COLLATE NOCASE').all(folderId, share.user_id);
  const crumbs  = [];
  let cur = folderId;
  const seen = new Set();
  while (cur != null) {
    if (seen.has(cur)) break;
    seen.add(cur);
    const row = db.prepare('SELECT id, name, parent_id FROM folders WHERE id=?').get(cur);
    if (!row) break;
    crumbs.unshift({ id: row.id, name: row.name });
    if (row.id === share.folder_id) break;
    cur = row.parent_id;
  }
  reply.header('Cache-Control', 'no-store');
  return { folders, files, crumbs };
});

fastify.get(`${BASE_PATH}/s/:token/file/:fileId`, async (req, reply) => {
  const share = getActiveShare(req.params.token);
  if (!share || share.type !== 'folder') { reply.code(404); return; }
  const file = db.prepare('SELECT * FROM files WHERE id=? AND user_id=?').get(Number(req.params.fileId), share.user_id);
  if (!file) { reply.code(404); return; }
  const fileFolderId = file.folder_id ?? null;
  if (fileFolderId !== share.folder_id && !folderInShareTree(fileFolderId, share.folder_id)) {
    reply.code(403); return;
  }
  const chunks = db.prepare('SELECT * FROM chunks WHERE file_id=? ORDER BY idx').all(file.id);
  if (!chunks.length) { reply.code(404); return; }
  let ctx; try { ctx = await getUserClient(share.user_id); }
  catch { reply.code(503); return; }
  reply.raw.writeHead(200, {
    'Content-Type': file.mime_type || 'application/octet-stream',
    'Content-Length': String(file.size),
    'Cache-Control': 'no-store',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
  });
  reply.hijack();
  try {
    const locs = await resolveChunkLocs(ctx.client, ctx.peer, chunks);
    for await (const b of tgStreamFile(locs, ctx.client, file.size, 0, file.size - 1)) {
      const ok = reply.raw.write(b);
      if (!ok) await new Promise(r => reply.raw.once('drain', r));
    }
  } catch (e) { console.error('[share-file-dl]', e.message); }
  reply.raw.end();
});

fastify.get(`${BASE_PATH}/s/:token/thumb/:fileId`, async (req, reply) => {
  const share = getActiveShare(req.params.token);
  if (!share || share.type !== 'folder') { reply.code(404); return; }
  const fileId = Number(req.params.fileId);
  const file = db.prepare('SELECT thumb, mime_type, size, folder_id FROM files WHERE id=? AND user_id=?').get(fileId, share.user_id);
  if (!file) { reply.code(404); return; }
  const fileFolderId = file.folder_id ?? null;
  if (fileFolderId !== share.folder_id && !folderInShareTree(fileFolderId, share.folder_id)) { reply.code(403); return; }
  if (file.thumb) {
    reply.header('Content-Type', 'image/jpeg').header('Cache-Control', 'public, max-age=3600');
    return reply.send(file.thumb);
  }
  const isPdf = file.mime_type === 'application/pdf' || (file.mime_type || '').includes('pdf');
  if (isPdf) {
    if (!pdfThumbInFlight.has(fileId)) {
      const p = (async () => {
        try {
          const chunks = db.prepare('SELECT * FROM chunks WHERE file_id=? ORDER BY idx').all(fileId);
          if (!chunks.length) return null;
          const ctx = await getUserClient(share.user_id);
          const tmpPdf = path.join(UPLOAD_TMP, `pdfreq_${fileId}_${randomBytes(4).toString('hex')}.pdf`);
          const ws = createWriteStream(tmpPdf);
          const locs = await resolveChunkLocs(ctx.client, ctx.peer, chunks);
          for await (const b of tgStreamFile(locs, ctx.client, file.size, 0, file.size - 1)) ws.write(b);
          await new Promise((res, rej) => { ws.end(); ws.on('finish', res); ws.on('error', rej); });
          const buf = await generateThumb(tmpPdf, 'application/pdf');
          await fs.rm(tmpPdf, { force: true });
          if (buf) db.prepare('UPDATE files SET thumb=? WHERE id=?').run(buf, fileId);
          return buf || null;
        } catch (e) { console.error('[pdf-thumb-share]', e.message); return null; }
      })();
      pdfThumbInFlight.set(fileId, p);
      p.finally(() => pdfThumbInFlight.delete(fileId));
    }
    const buf = await pdfThumbInFlight.get(fileId);
    if (buf) { reply.header('Content-Type', 'image/jpeg').header('Cache-Control', 'public, max-age=3600'); return reply.send(buf); }
    reply.code(404); return;
  }
  const buf = await fetchTgThumb(share.user_id, fileId);
  if (!buf) { reply.code(404); return; }
  reply.header('Content-Type', 'image/jpeg').header('Cache-Control', 'public, max-age=3600');
  return reply.send(buf);
});

// ─── Estáticos ─────────────────────────────────────────────────────────────
const BUILD_TS = Date.now();
const _rawHtml = await fs.readFile(path.join(__dirname, 'public', 'index.html'), 'utf8');
const _indexHtml = _rawHtml
  .replace(/styles\.css"/g,  `styles.css?v=${BUILD_TS}"`)
  .replace(/app\.js"/g,       `app.js?v=${BUILD_TS}"`);

const _serveIndex = (_req, reply) => {
  reply
    .header('Cache-Control', 'no-cache, no-store, must-revalidate')
    .header('Content-Type', 'text/html; charset=utf-8')
    .send(_indexHtml);
};
fastify.get(`${BASE_PATH}`,  _serveIndex);
fastify.get(`${BASE_PATH}/`, _serveIndex);

await fastify.register(fastifyStatic, {
  root: path.join(__dirname, 'public'),
  prefix: `${BASE_PATH}/`,
  decorateReply: false,
  etag: false,
  lastModified: false,
  setHeaders: (res, filePath) => {
    if (/\.(js|css)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
});
fastify.get('/', (_req, reply) => reply.redirect(`${BASE_PATH}/`));
fastify.get(`${BASE_PATH}/health`, async () => ({ ok: true }));
fastify.get(`${BASE_PATH}/api/config`, async () => ({ tusEndpoint: TUS_PATH, basePath: BASE_PATH }));

// ─── Inicio ────────────────────────────────────────────────────────────────
await fastify.listen({ host: '0.0.0.0', port: PORT });
console.log(`tgcloud :${PORT}  base=${BASE_PATH}`);
