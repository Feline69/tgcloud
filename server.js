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
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
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

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    password   TEXT    NOT NULL,
    is_admin   INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT    PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS folders (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT    NOT NULL,
    parent_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS files (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT    NOT NULL,
    folder_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
    size      INTEGER NOT NULL DEFAULT 0,
    mime_type TEXT    NOT NULL DEFAULT 'application/octet-stream',
    thumb     BLOB,
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
  CREATE UNIQUE INDEX IF NOT EXISTS ux_folder_parent_name ON folders(COALESCE(parent_id,0), name);
  CREATE UNIQUE INDEX IF NOT EXISTS ux_file_folder_name   ON files(COALESCE(folder_id,0), name);
  CREATE INDEX  IF NOT EXISTS ix_chunks_file   ON chunks(file_id, idx);
  CREATE INDEX  IF NOT EXISTS ix_sessions_user ON sessions(user_id);
`);

// ─── Settings helpers ──────────────────────────────────────────────────────
function getSetting(key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row !== undefined ? row.value : fallback;
}
function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO settings(key, value) VALUES(?,?)').run(key, String(value ?? ''));
}

// Migrar variables de entorno a la BD en primer arranque
for (const [key, envKey] of [
  ['tg_api_id',   'TG_API_ID'],
  ['tg_api_hash', 'TG_API_HASH'],
  ['tg_session',  'TG_SESSION'],
  ['tg_chat',     'TG_CHAT'],
]) {
  if (!getSetting(key) && process.env[envKey]) setSetting(key, process.env[envKey]);
}

// Migración: añadir columna `channel` a folders y files (archivos por canal)
const folderCols = db.prepare("PRAGMA table_info(folders)").all().map(c => c.name);
if (!folderCols.includes('channel')) {
  db.exec("ALTER TABLE folders ADD COLUMN channel TEXT NOT NULL DEFAULT ''");
  const cur = getSetting('tg_chat');
  if (cur) db.prepare("UPDATE folders SET channel=? WHERE channel=''").run(cur);
}
const fileCols = db.prepare("PRAGMA table_info(files)").all().map(c => c.name);
if (!fileCols.includes('channel')) {
  db.exec("ALTER TABLE files ADD COLUMN channel TEXT NOT NULL DEFAULT ''");
  const cur = getSetting('tg_chat');
  if (cur) db.prepare("UPDATE files SET channel=? WHERE channel=''").run(cur);
}
db.exec(`
  DROP INDEX IF EXISTS ux_folder_parent_name;
  DROP INDEX IF EXISTS ux_file_folder_name;
  CREATE UNIQUE INDEX IF NOT EXISTS ux_folder_parent_name ON folders(channel, COALESCE(parent_id,0), name);
  CREATE UNIQUE INDEX IF NOT EXISTS ux_file_folder_name   ON files(channel, COALESCE(folder_id,0), name);
  CREATE INDEX IF NOT EXISTS ix_folders_channel ON folders(channel);
  CREATE INDEX IF NOT EXISTS ix_files_channel   ON files(channel);
`);

function currentChannel() { return getSetting('tg_chat', ''); }

// Admin inicial si no hay usuarios
const ADMIN_PASS = process.env.ADMIN_PASSWORD || '';
const ADMIN_USER = process.env.ADMIN_USER     || 'admin';
if (!db.prepare('SELECT 1 FROM users LIMIT 1').get() && ADMIN_PASS) {
  db.prepare('INSERT INTO users(username, password, is_admin) VALUES(?,?,1)')
    .run(ADMIN_USER, hashPassword(ADMIN_PASS));
  console.log(`[auth] admin '${ADMIN_USER}' creado`);
}

// Limpiar sesiones expiradas cada hora
setInterval(() => {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Math.floor(Date.now() / 1000));
}, 3_600_000);

// ─── Auth helpers ──────────────────────────────────────────────────────────
function hashPassword(p) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(p, salt, 64).toString('hex')}`;
}
function verifyPassword(p, stored) {
  const [salt, hash] = (stored || '').split(':');
  if (!salt || !hash) return false;
  try { return timingSafeEqual(Buffer.from(hash, 'hex'), scryptSync(p, salt, 64)); } catch { return false; }
}
function createSession(userId) {
  const ttl   = parseInt(getSetting('session_ttl_days', '30'), 10);
  const token = randomBytes(32).toString('hex');
  const exp   = Math.floor(Date.now() / 1000) + ttl * 86400;
  db.prepare('INSERT INTO sessions(token, user_id, expires_at) VALUES(?,?,?)').run(token, userId, exp);
  return { token, exp };
}
function getSession(token) {
  if (!token) return null;
  return db.prepare(
    `SELECT s.token, s.expires_at, u.id AS user_id, u.username, u.is_admin
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
function sessionCookie(token) {
  const ttl = parseInt(getSetting('session_ttl_days', '30'), 10);
  return `session=${token}; Path=${BASE_PATH}; HttpOnly; SameSite=Strict; Max-Age=${ttl * 86400}`;
}
function clearCookie() { return `session=; Path=${BASE_PATH}; HttpOnly; SameSite=Strict; Max-Age=0`; }

function requireSession(req, reply) {
  const s = getSession(parseCookies(req.headers.cookie).session);
  if (!s) { reply.code(401).send({ error: 'no autenticado' }); return null; }
  return s;
}
function requireAdmin(req, reply) {
  const s = requireSession(req, reply);
  if (!s) return null;
  if (!s.is_admin) { reply.code(403).send({ error: 'se requiere admin' }); return null; }
  return s;
}

// ─── Telegram (lazy init) ──────────────────────────────────────────────────
let tg       = null;
let _peer    = null;
let tgStatus = 'not_configured';
let tgError  = '';

async function initTelegram() {
  const apiId   = parseInt(getSetting('tg_api_id'), 10);
  const apiHash = getSetting('tg_api_hash');
  const session = getSetting('tg_session');
  const chat    = getSetting('tg_chat');

  if (!apiId || !apiHash || !session || !chat) {
    tgStatus = 'not_configured';
    tgError  = 'Credenciales incompletas — configura en Ajustes';
    tg = null; _peer = null;
    return;
  }
  tgStatus = 'connecting';
  try {
    if (tg) { try { await tg.disconnect(); } catch {} tg = null; _peer = null; }
    tg = new TelegramClient(new StringSession(session), apiId, apiHash, { connectionRetries: 3, useWSS: false });
    await tg.connect();
    if (!await tg.isUserAuthorized()) {
      throw new Error('Sesión expirada o inválida — vuelve a autenticarte en Ajustes');
    }
    _peer    = await tg.getInputEntity(chat);
    tgStatus = 'connected';
    tgError  = '';
    console.log('[tg] conectado');
    autoSyncChannel().catch(e => console.error('[auto-sync]', e.message));
  } catch (err) {
    tgStatus = 'error'; tgError = err.errorMessage || err.message;
    tg = null; _peer = null;
    console.error('[tg] error:', err.message);
  }
}

async function peer() {
  if (tgStatus !== 'connected' || !tg) throw new Error('Telegram no conectado — configura en Ajustes');
  return _peer;
}

// Auto-sync: trae archivos del canal sin pedir botón
const syncedChannels = new Set();
let autoSyncRunning = false;

async function autoSyncChannel() {
  const channel = getSetting('tg_chat');
  if (!channel) return;
  if (syncedChannels.has(channel) || autoSyncRunning) return;
  if (!tg || tgStatus !== 'connected') return;
  autoSyncRunning = true;
  syncedChannels.add(channel);
  try {
    const p = await peer();
    const existing = new Set(
      db.prepare('SELECT c.tg_msg_id FROM chunks c JOIN files f ON c.file_id=f.id WHERE f.channel=?')
        .all(channel).map(r => Number(r.tg_msg_id))
    );
    let imported = 0;
    for await (const msg of tg.iterMessages(p, { limit: 1500 })) {
      if (!msg?.document) continue;
      if (existing.has(Number(msg.id))) continue;
      try {
        const doc = msg.document;
        const fnAttr = doc.attributes?.find(a => a.className === 'DocumentAttributeFilename');
        const filename = fnAttr?.fileName || msg.message?.trim() || `file_${msg.id}`;
        const cleanName = String(filename).replace(/[/\\]/g, '_');
        const size = Number(doc.size);
        const mimeType = doc.mimeType || mime.lookup(cleanName) || 'application/octet-stream';
        const finalName = uniqueName(cleanName, null);
        const info = db.prepare('INSERT INTO files(name, folder_id, size, mime_type, thumb, channel) VALUES(?,?,?,?,NULL,?) RETURNING id').get(finalName, null, size, mimeType, channel);
        db.prepare('INSERT INTO chunks(file_id,idx,tg_msg_id,tg_dc_id,chunk_size) VALUES(?,0,?,?,?)').run(info.id, Number(msg.id), Number(doc.dcId || 0), size);
        imported++;
      } catch (e) { /* skip */ }
    }
    console.log(`[auto-sync] ${channel}: ${imported} archivos`);
  } catch (err) {
    console.error('[auto-sync] error:', err.message);
    syncedChannels.delete(channel);
  } finally {
    autoSyncRunning = false;
  }
}

// Estado de sesiones de setup pendientes (OTP)
const pendingSetup = new Map(); // tempId → { client, apiId, apiHash, phone, phoneCodeHash, createdAt }
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of pendingSetup) {
    if (now - s.createdAt > 600_000) { s.client?.disconnect().catch(() => {}); pendingSetup.delete(id); }
  }
}, 60_000);

// Iniciar Telegram al arrancar
await initTelegram();

// ─── DB helpers ────────────────────────────────────────────────────────────
function resolveFolderByPath(p) {
  const ch = currentChannel();
  const parts = (p || '').split('/').filter(Boolean);
  if (!parts.length) return { id: null };
  let pid = null;
  for (const part of parts) {
    const row = db.prepare('SELECT id FROM folders WHERE channel=? AND parent_id IS ? AND name=?').get(ch, pid, part);
    if (!row) return null;
    pid = row.id;
  }
  return db.prepare('SELECT * FROM folders WHERE id=?').get(pid);
}
function uniqueName(name, folderId) {
  const ch = currentChannel();
  const ext = path.extname(name), base = name.slice(0, -ext.length || undefined);
  let c = name, n = 1;
  while (db.prepare(`
    SELECT 1 FROM files   WHERE channel=? AND COALESCE(folder_id,0)=? AND name=?
    UNION ALL
    SELECT 1 FROM folders WHERE channel=? AND COALESCE(parent_id,0)=? AND name=?
  `).get(ch, folderId ?? 0, c, ch, folderId ?? 0, c)) {
    c = `${base} (${++n})${ext}`;
  }
  return c;
}

// ─── Telegram ops ─────────────────────────────────────────────────────────
async function tgSend(filePath, displayName, thumbBuf = null) {
  const p = await peer();
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
    const msg = await tg.sendFile(p, opts);
    console.log('');
    return { msgId: msg.id, dcId: msg.document?.dcId ?? 0 };
  } finally {
    if (thumbPath) await fs.rm(thumbPath, { force: true });
  }
}

async function* tgStream(msgId, dcId, start = 0, end = Infinity) {
  const p     = await peer();
  const [msg] = await tg.getMessages(p, { ids: [msgId] });
  if (!msg?.document) throw new Error(`mensaje ${msgId} sin documento`);
  const doc = msg.document, total = Number(doc.size);
  const realEnd = Math.min(end, total - 1), length = realEnd - start + 1;
  if (length <= 0) return;
  const loc = new Api.InputDocumentFileLocation({ id: doc.id, accessHash: doc.accessHash, fileReference: doc.fileReference, thumbSize: '' });
  const aligned = Math.floor(start / PART_SIZE) * PART_SIZE, skip = start - aligned;
  let yielded = 0, first = true;
  for await (const buf of tg.iterDownload({ file: loc, dcId: dcId || doc.dcId, offset: bigInt(aligned), limit: length + skip, requestSize: PART_SIZE, fileSize: bigInt(total) })) {
    let data = (first && skip > 0) ? buf.slice(skip) : buf;
    first = false;
    const rem = length - yielded; if (rem <= 0) break;
    const out = data.length > rem ? data.slice(0, rem) : data;
    yield out; yielded += out.length; if (yielded >= length) break;
  }
}

async function tgDelete(msgIds) {
  if (!msgIds.length) return;
  try { await tg.deleteMessages(await peer(), msgIds, { revoke: true }); } catch {}
}

// ─── Upload helpers ────────────────────────────────────────────────────────
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
    return await spawnThumb('pdftoppm', ['-jpeg', '-f', '1', '-l', '1', '-scale-to', '320', filePath, '-']);
  }
  if (isV) {
    return await spawnThumb('ffmpeg', ['-ss','2','-i',filePath,'-vframes','1','-vf','scale=320:240:force_original_aspect_ratio=decrease,pad=320:240:(ow-iw)/2:(oh-ih)/2:black','-f','image2','pipe:1']);
  }
  if (isI) {
    return await spawnThumb('ffmpeg', ['-i',filePath,'-vf','scale=320:240:force_original_aspect_ratio=decrease','-q:v','5','-f','image2','pipe:1']);
  }
  if (isA) {
    // Extraer carátula embebida (mp3/flac/m4a/ogg con cover art)
    return await spawnThumb('ffmpeg', ['-i',filePath,'-an','-vf','scale=320:320:force_original_aspect_ratio=decrease','-frames:v','1','-f','image2','pipe:1']);
  }
  return null;
}

async function uploadToTelegram(tmpPath, originalName, mimeType, folderId) {
  const ch          = currentChannel();
  const stat        = await fs.stat(tmpPath);
  const totalSize   = stat.size;
  const detectedMime = mimeType || mime.lookup(originalName) || 'application/octet-stream';
  const thumb       = await generateThumb(tmpPath, detectedMime);
  const finalName   = uniqueName(originalName, folderId);
  const info = db.prepare('INSERT INTO files(name, folder_id, size, mime_type, thumb, channel) VALUES(?,?,?,?,?,?) RETURNING id').get(finalName, folderId, totalSize, detectedMime, thumb, ch);
  const fileId = info.id;

  if (totalSize <= MAX_CHUNK) {
    const { msgId, dcId } = await tgSend(tmpPath, finalName, thumb);
    db.prepare('INSERT INTO chunks(file_id,idx,tg_msg_id,tg_dc_id,chunk_size) VALUES(?,0,?,?,?)').run(fileId, msgId, dcId, totalSize);
  } else {
    const numChunks = Math.ceil(totalSize / MAX_CHUNK);
    const chunkDir  = path.join(UPLOAD_TMP, `split_${fileId}_${randomBytes(4).toString('hex')}`);
    await fs.mkdir(chunkDir, { recursive: true });
    try {
      for (let i = 0; i < numChunks; i++) {
        const start = i * MAX_CHUNK, chunkSize = Math.min(MAX_CHUNK, totalSize - start);
        const chunkPath = path.join(chunkDir, `part_${i}`);
        await pipeline(createReadStream(tmpPath, { start, end: start + chunkSize - 1 }), createWriteStream(chunkPath));
        const { msgId, dcId } = await tgSend(chunkPath, `${finalName}.part${i+1}of${numChunks}`, i === 0 ? thumb : null);
        db.prepare('INSERT INTO chunks(file_id,idx,tg_msg_id,tg_dc_id,chunk_size) VALUES(?,?,?,?,?)').run(fileId, i, msgId, dcId, chunkSize);
        await fs.rm(chunkPath, { force: true });
      }
    } finally { await fs.rm(chunkDir, { recursive: true, force: true }); }
  }
  return fileId;
}

// ─── Fastify ───────────────────────────────────────────────────────────────
const fastify = Fastify({ logger: { level: 'warn' } });
fastify.addContentTypeParser(['application/offset+octet-stream'], (_r, _p, done) => done(null));

// Middleware auth — protege /api/* salvo rutas públicas
const PUBLIC_API = [`${BASE_PATH}/api/auth/login`, `${BASE_PATH}/api/auth/first-setup`, `${BASE_PATH}/api/setup-status`];
fastify.addHook('preHandler', async (req, reply) => {
  const url = req.raw.url || '';
  if (!url.startsWith(`${BASE_PATH}/api/`)) return;
  if (PUBLIC_API.some(p => url.startsWith(p))) return;
  const s = getSession(parseCookies(req.headers.cookie).session);
  if (!s) { reply.code(401).send({ error: 'no autenticado' }); return; }
  req.session = s;
});

// ─── Endpoints públicos ────────────────────────────────────────────────────
fastify.get(`${BASE_PATH}/api/setup-status`, async () => ({
  needs_first_user: !db.prepare('SELECT 1 FROM users LIMIT 1').get(),
  tg_status: tgStatus,
}));

fastify.post(`${BASE_PATH}/api/auth/first-setup`, async (req, reply) => {
  if (db.prepare('SELECT 1 FROM users LIMIT 1').get()) { reply.code(403); return { error: 'Ya hay usuarios registrados' }; }
  const { username, password } = req.body || {};
  if (!username?.trim() || !password) { reply.code(400); return { error: 'Usuario y contraseña requeridos' }; }
  const info = db.prepare('INSERT INTO users(username, password, is_admin) VALUES(?,?,1)').run(username.trim(), hashPassword(password));
  const { token } = createSession(info.lastInsertRowid);
  reply.header('Set-Cookie', sessionCookie(token));
  return { ok: true, id: info.lastInsertRowid, username: username.trim(), is_admin: 1 };
});

fastify.post(`${BASE_PATH}/api/auth/login`, async (req, reply) => {
  const { username, password } = req.body || {};
  if (!username || !password) { reply.code(400); return { error: 'Faltan datos' }; }
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username));
  if (!user || !verifyPassword(String(password), user.password)) { reply.code(401); return { error: 'Credenciales incorrectas' }; }
  const { token } = createSession(user.id);
  reply.header('Set-Cookie', sessionCookie(token));
  return { ok: true, id: user.id, username: user.username, is_admin: user.is_admin };
});

fastify.post(`${BASE_PATH}/api/auth/logout`, async (req, reply) => {
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.session) db.prepare('DELETE FROM sessions WHERE token = ?').run(cookies.session);
  reply.header('Set-Cookie', clearCookie());
  return { ok: true };
});

fastify.get(`${BASE_PATH}/api/auth/me`, async (req) => ({
  id: req.session.user_id, username: req.session.username, is_admin: req.session.is_admin,
}));

// ─── Usuarios ──────────────────────────────────────────────────────────────
fastify.get(`${BASE_PATH}/api/users`, async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  return db.prepare('SELECT id, username, is_admin, created_at FROM users ORDER BY id').all();
});
fastify.post(`${BASE_PATH}/api/users`, async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const { username, password, is_admin } = req.body || {};
  if (!username?.trim() || !password) { reply.code(400); return { error: 'Usuario y contraseña requeridos' }; }
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username.trim())) { reply.code(409); return { error: 'Ya existe' }; }
  const r = db.prepare('INSERT INTO users(username, password, is_admin) VALUES(?,?,?)').run(username.trim(), hashPassword(password), is_admin ? 1 : 0);
  return { ok: true, id: r.lastInsertRowid };
});
fastify.delete(`${BASE_PATH}/api/users/:id`, async (req, reply) => {
  const s = requireAdmin(req, reply); if (!s) return;
  const tid = Number(req.params.id);
  if (tid === s.user_id) { reply.code(400); return { error: 'No puedes eliminarte a ti mismo' }; }
  if (!db.prepare('DELETE FROM users WHERE id = ?').run(tid).changes) { reply.code(404); return { error: 'No encontrado' }; }
  return { ok: true };
});
fastify.post(`${BASE_PATH}/api/users/:id/password`, async (req, reply) => {
  const s = requireSession(req, reply); if (!s) return;
  const tid = Number(req.params.id);
  if (tid !== s.user_id && !s.is_admin) { reply.code(403); return { error: 'Sin permiso' }; }
  const { password } = req.body || {};
  if (!password) { reply.code(400); return { error: 'Contraseña requerida' }; }
  if (!db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashPassword(password), tid).changes) { reply.code(404); return { error: 'No encontrado' }; }
  return { ok: true };
});

// ─── Settings ──────────────────────────────────────────────────────────────
fastify.get(`${BASE_PATH}/api/settings`, async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  return {
    tg_api_id:      getSetting('tg_api_id'),
    tg_api_hash:    getSetting('tg_api_hash'),
    tg_session_set: !!getSetting('tg_session'),
    tg_chat:        getSetting('tg_chat'),
    session_ttl_days: getSetting('session_ttl_days', '30'),
    tg_status:      tgStatus,
    tg_error:       tgError,
  };
});

fastify.post(`${BASE_PATH}/api/settings`, async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const { tg_api_id, tg_api_hash, tg_chat, session_ttl_days } = req.body || {};
  let reconnect = false;
  if (tg_api_id   !== undefined) { setSetting('tg_api_id',   tg_api_id);   reconnect = true; }
  if (tg_api_hash !== undefined) { setSetting('tg_api_hash', tg_api_hash); reconnect = true; }
  if (tg_chat     !== undefined) { setSetting('tg_chat',     tg_chat);     reconnect = true; }
  if (session_ttl_days !== undefined) setSetting('session_ttl_days', session_ttl_days);
  // Los archivos del canal anterior NO se borran — quedan ocultos por el filtro
  // de canal. Al volver a seleccionar ese canal vuelven a aparecer.
  if (reconnect) initTelegram().catch(console.error);
  return { ok: true, tg_status: tgStatus, tg_error: tgError };
});

fastify.post(`${BASE_PATH}/api/tg/reconnect`, async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  await initTelegram();
  return { ok: true, tg_status: tgStatus, tg_error: tgError };
});

// Lista de canales/grupos accesibles con la sesión activa
fastify.get(`${BASE_PATH}/api/tg/dialogs`, async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  if (!tg || tgStatus !== 'connected') { reply.code(400); return { error: 'Telegram no conectado' }; }
  try {
    const list = await tg.getDialogs({ limit: 200 });
    return list
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
  } catch (err) { reply.code(500); return { error: err.message }; }
});

// Paso 1: enviar OTP
fastify.post(`${BASE_PATH}/api/tg/send-code`, async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const { apiId, apiHash, phone } = req.body || {};
  if (!apiId || !apiHash || !phone) { reply.code(400); return { error: 'Faltan datos' }; }

  const parsedApiId = parseInt(apiId, 10);
  if (!parsedApiId || parsedApiId <= 0) { reply.code(400); return { error: 'API ID inválido — debe ser un número positivo' }; }
  if (!/^[0-9a-f]{32}$/i.test(String(apiHash))) { reply.code(400); return { error: 'API Hash inválido — debe ser 32 caracteres hexadecimales' }; }

  try {
    const tempClient = new TelegramClient(new StringSession(''), parsedApiId, String(apiHash), { connectionRetries: 5, useWSS: false });
    await tempClient.connect();
    const creds = { apiId: parsedApiId, apiHash: String(apiHash) };
    const result = await tempClient.sendCode(creds, String(phone).trim());
    const tempId = randomBytes(16).toString('hex');
    pendingSetup.set(tempId, {
      client: tempClient, apiId: parsedApiId, apiHash: String(apiHash),
      phone: String(phone).trim(), phoneCodeHash: result.phoneCodeHash, createdAt: Date.now(),
    });
    return { ok: true, tempId };
  } catch (err) {
    reply.code(400); return { error: err.errorMessage || err.message };
  }
});

// Paso 2: verificar código OTP (usa invoke directo — client.signIn no existe en GramJS 2.x)
fastify.post(`${BASE_PATH}/api/tg/verify-code`, async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const { tempId, code } = req.body || {};
  const state = pendingSetup.get(tempId);
  if (!state) { reply.code(400); return { error: 'Sesión expirada — empieza de nuevo' }; }
  const cleanCode = String(code).replace(/\s/g, '');
  try {
    await state.client.connect();
    await state.client.invoke(new Api.auth.SignIn({
      phoneNumber:   state.phone,
      phoneCodeHash: state.phoneCodeHash,
      phoneCode:     cleanCode,
    }));
    return await _finishTgSetup(tempId, state);
  } catch (err) {
    const msg = err.errorMessage || err.message || '';
    if (msg.includes('SESSION_PASSWORD_NEEDED')) return { ok: false, needs2fa: true };
    pendingSetup.delete(tempId);
    reply.code(400); return { error: msg };
  }
});

// Paso 3: contraseña 2FA (signInWithPassword requiere password como callback)
fastify.post(`${BASE_PATH}/api/tg/verify-2fa`, async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const { tempId, password } = req.body || {};
  const state = pendingSetup.get(tempId);
  if (!state) { reply.code(400); return { error: 'Sesión expirada' }; }
  const passStr = String(password);
  try {
    await state.client.connect();
    await state.client.signInWithPassword(
      { apiId: state.apiId, apiHash: state.apiHash },
      { password: async () => passStr }
    );
    return await _finishTgSetup(tempId, state);
  } catch (err) {
    reply.code(400); return { error: err.errorMessage || err.message };
  }
});

async function _finishTgSetup(tempId, state) {
  // Obtener lista de canales/grupos mientras el cliente temporal sigue conectado
  const dialogs = [];
  try {
    const list = await state.client.getDialogs({ limit: 200 });
    for (const d of list) {
      if (!d.entity) continue;
      const cls = d.entity.className;
      if (cls !== 'Channel' && cls !== 'Chat') continue;
      const rawId = typeof d.entity.id === 'bigint' ? d.entity.id.toString() : String(d.entity.id);
      dialogs.push({
        id:       cls === 'Channel' ? `-100${rawId}` : `-${rawId}`,
        name:     d.entity.title || `ID: ${rawId}`,
        type:     d.entity.broadcast ? 'canal' : 'grupo',
        username: d.entity.username ? `@${d.entity.username}` : null,
      });
    }
  } catch (e) { console.error('[dialogs]', e.message); }

  const session = state.client.session.save();
  setSetting('tg_api_id',   String(state.apiId));
  setSetting('tg_api_hash', state.apiHash);
  setSetting('tg_session',  session);
  pendingSetup.delete(tempId);
  await state.client.disconnect().catch(() => {});
  initTelegram().catch(console.error); // no await — puede tardar
  return { ok: true, tg_status: tgStatus, tg_error: tgError, dialogs };
}

// ─── TUS (subidas) ─────────────────────────────────────────────────────────
const tusServer = new TusServer({
  path: TUS_PATH,
  datastore: new FileStore({ directory: UPLOAD_TMP }),
  respectForwardedHeaders: true,
  async onUploadFinish(req, res, upload) {
    const meta = upload.metadata || {};
    const origName   = meta.filename || `file_${upload.id}`;
    const mimeType   = meta.type    || mime.lookup(origName) || 'application/octet-stream';
    const folderPath = meta.folder  ? decodeURIComponent(meta.folder) : '';
    const tmpPath    = path.join(UPLOAD_TMP, upload.id);
    let folderId = null;
    if (folderPath) { const f = resolveFolderByPath(folderPath); folderId = f?.id ?? null; }
    try {
      const fileId = await uploadToTelegram(tmpPath, origName, mimeType, folderId);
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
  if (!getSession(parseCookies(req.headers.cookie).session)) { reply.code(401).send({ error: 'no autenticado' }); return; }
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

// ─── Browse ─────────────────────────────────────────────────────────────────
fastify.get(`${BASE_PATH}/api/browse`, async (req, reply) => {
  const pathStr = String(req.query.path || '');
  const ch = currentChannel();
  const folder = resolveFolderByPath(pathStr);
  if (folder === null && pathStr) { reply.code(404); return { error: 'No encontrado' }; }
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
    dirs:  db.prepare('SELECT id, name, created_at FROM folders WHERE channel=? AND parent_id IS ? ORDER BY name COLLATE NOCASE').all(ch, fid),
    files: db.prepare(`SELECT f.id, f.name, f.size, f.mime_type, f.created_at, (f.thumb IS NOT NULL) AS has_thumb, (SELECT COUNT(*) FROM chunks c WHERE c.file_id=f.id) AS chunk_count FROM files f WHERE f.channel=? AND f.folder_id IS ? ORDER BY f.name COLLATE NOCASE`).all(ch, fid),
  };
});

// ─── Thumb ──────────────────────────────────────────────────────────────────
const thumbInFlight = new Map(); // file_id → Promise<Buffer|null>

async function fetchTgThumb(fileId) {
  if (thumbInFlight.has(fileId)) return thumbInFlight.get(fileId);
  const p = (async () => {
    if (!tg || tgStatus !== 'connected') return null;
    const chunk = db.prepare('SELECT tg_msg_id FROM chunks WHERE file_id=? AND idx=0').get(fileId);
    if (!chunk) return null;
    const peer_ = await peer();
    const [msg] = await tg.getMessages(peer_, { ids: [chunk.tg_msg_id] });
    const thumbs = msg?.document?.thumbs;
    if (!thumbs?.length) return null;
    // Probar de mayor a menor calidad (excepto stripped/path que son demasiado pequeños)
    const ordered = [...thumbs].reverse();
    for (const t of ordered) {
      try {
        const buf = await tg.downloadMedia(msg, { thumb: t });
        if (buf?.length) {
          db.prepare('UPDATE files SET thumb=? WHERE id=?').run(Buffer.from(buf), fileId);
          return Buffer.from(buf);
        }
      } catch (e) { /* probar siguiente */ }
    }
    return null;
  })().catch(err => { console.error('[thumb]', err.message); return null; })
       .finally(() => thumbInFlight.delete(fileId));
  thumbInFlight.set(fileId, p);
  return p;
}

fastify.get(`${BASE_PATH}/api/thumb`, async (req, reply) => {
  const fileId = Number(req.query.id);
  if (!fileId) { reply.code(400); return; }
  const row = db.prepare('SELECT thumb FROM files WHERE id=?').get(fileId);
  if (row?.thumb) {
    reply.header('Content-Type', 'image/jpeg').header('Cache-Control', 'public, max-age=604800');
    return reply.send(row.thumb);
  }
  // Sin thumb local — intentar bajarla de Telegram (cacheada en DB tras el primer hit)
  const buf = await fetchTgThumb(fileId);
  if (!buf) { reply.code(404); return; }
  reply.header('Content-Type', 'image/jpeg').header('Cache-Control', 'public, max-age=604800');
  return reply.send(buf);
});

// ─── Stream ─────────────────────────────────────────────────────────────────
fastify.get(`${BASE_PATH}/api/stream`, async (req, reply) => {
  const file = db.prepare('SELECT * FROM files WHERE id = ?').get(Number(req.query.id));
  if (!file) { reply.code(404); return; }
  const chunks = db.prepare('SELECT * FROM chunks WHERE file_id = ? ORDER BY idx').all(file.id);
  if (!chunks.length) { reply.code(404); return; }
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
      for await (const b of tgStream(chunks[0].tg_msg_id, chunks[0].tg_dc_id, start, end)) reply.raw.write(b);
    } else {
      let off = 0;
      for (const chunk of chunks) {
        const ce = off + chunk.chunk_size - 1;
        if (ce < start) { off += chunk.chunk_size; continue; } if (off > end) break;
        for await (const b of tgStream(chunk.tg_msg_id, chunk.tg_dc_id, Math.max(0, start - off), Math.min(chunk.chunk_size - 1, end - off))) reply.raw.write(b);
        off += chunk.chunk_size;
      }
    }
  } catch (e) { console.error('[stream]', e.message); }
  reply.raw.end();
});

// ─── Transcode ──────────────────────────────────────────────────────────────
fastify.get(`${BASE_PATH}/api/transcode`, async (req, reply) => {
  const file = db.prepare('SELECT * FROM files WHERE id = ?').get(Number(req.query.id));
  if (!file) { reply.code(404); return; }
  const chunks = db.prepare('SELECT * FROM chunks WHERE file_id = ? ORDER BY idx').all(file.id);
  if (!chunks.length) { reply.code(404); return; }
  const mt = file.mime_type;
  let outMime, outExt, ffArgs;
  if (mt.startsWith('audio/'))      { outMime='audio/mpeg';outExt='mp3';ffArgs=['-i','pipe:0','-c:a','libmp3lame','-b:a','128k','-f','mp3','pipe:1']; }
  else if (mt.startsWith('image/')) { outMime='image/jpeg';outExt='jpg';ffArgs=['-i','pipe:0','-vf','scale=1920:1080:force_original_aspect_ratio=decrease','-q:v','4','-f','image2','pipe:1']; }
  else if (mt.startsWith('video/')) { outMime='video/mp4';outExt='mp4';ffArgs=['-i','pipe:0','-c:v','libx264','-preset','fast','-crf','23','-vf','scale=-2:720','-c:a','aac','-b:a','128k','-movflags','frag_keyframe+empty_moov','-f','mp4','pipe:1']; }
  else { reply.code(400); return { error: 'Formato no soportado' }; }
  const base = path.basename(file.name, path.extname(file.name));
  reply.raw.writeHead(200, { 'Content-Type': outMime, 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(base+'.'+outExt)}` });
  reply.hijack();
  const proc = spawn('ffmpeg', ffArgs, { stdio: ['pipe','pipe','pipe'] });
  proc.stdout.pipe(reply.raw, { end: false });
  proc.stderr.on('data', () => {});
  (async () => { try { for (const c of chunks) for await (const b of tgStream(c.tg_msg_id, c.tg_dc_id)) { if (!proc.stdin.write(b)) await new Promise(r => proc.stdin.once('drain', r)); } proc.stdin.end(); } catch { proc.kill(); } })();
  proc.on('close', () => reply.raw.end());
});

// ─── Mkdir / Rename / Delete / ZIP ─────────────────────────────────────────
fastify.post(`${BASE_PATH}/api/mkdir`, async (req, reply) => {
  const ch = currentChannel();
  const name = String(req.body?.name || '').trim().replace(/[/\\]/g, '_');
  if (!name) { reply.code(400); return { error: 'Nombre requerido' }; }
  const pf = resolveFolderByPath(String(req.body?.parent || ''));
  const pid = pf?.id ?? null;
  if (db.prepare('SELECT 1 FROM folders WHERE channel=? AND parent_id IS ? AND name=?').get(ch, pid, name)) { reply.code(409); return { error: 'Ya existe' }; }
  const r = db.prepare('INSERT INTO folders(name, parent_id, channel) VALUES(?,?,?) RETURNING id').get(name, pid, ch);
  return { ok: true, id: r.id };
});

fastify.post(`${BASE_PATH}/api/move`, async (req, reply) => {
  const { type, id, targetFolderId } = req.body || {};
  if (!type || !id) { reply.code(400); return { error: 'Faltan datos' }; }
  const target = (targetFolderId === null || targetFolderId === undefined || targetFolderId === '')
    ? null : Number(targetFolderId);
  if (target !== null && !db.prepare('SELECT 1 FROM folders WHERE id=?').get(target)) {
    reply.code(404); return { error: 'Carpeta destino no existe' };
  }
  if (type === 'file') {
    const row = db.prepare('SELECT * FROM files WHERE id=?').get(+id);
    if (!row) { reply.code(404); return { error: 'Archivo no encontrado' }; }
    const newName = uniqueName(row.name, target);
    db.prepare('UPDATE files SET folder_id=?, name=? WHERE id=?').run(target, newName, row.id);
  } else if (type === 'dir') {
    const idNum = +id;
    if (target === idNum) { reply.code(400); return { error: 'No puedes mover una carpeta dentro de sí misma' }; }
    // Verificar que target no sea descendiente de la carpeta a mover
    let cur = target;
    while (cur !== null) {
      if (cur === idNum) { reply.code(400); return { error: 'No puedes mover una carpeta dentro de sí misma' }; }
      const p = db.prepare('SELECT parent_id FROM folders WHERE id=?').get(cur);
      cur = p?.parent_id ?? null;
    }
    const row = db.prepare('SELECT * FROM folders WHERE id=?').get(idNum);
    if (!row) { reply.code(404); return { error: 'Carpeta no encontrada' }; }
    let newName = row.name, n = 1;
    while (db.prepare('SELECT 1 FROM folders WHERE COALESCE(parent_id,0)=? AND name=? AND id!=?').get(target ?? 0, newName, idNum)) {
      newName = `${row.name} (${++n})`;
    }
    db.prepare('UPDATE folders SET parent_id=?, name=? WHERE id=?').run(target, newName, idNum);
  } else { reply.code(400); return { error: 'Tipo inválido' }; }
  return { ok: true };
});

// Importar manualmente archivos del canal (la sincro automática también ocurre al conectar)
fastify.post(`${BASE_PATH}/api/tg/sync-channel`, async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  if (!tg || tgStatus !== 'connected') { reply.code(400); return { error: 'Telegram no conectado' }; }
  const channel = currentChannel();
  const limit = Math.min(parseInt(req.body?.limit, 10) || 1500, 5000);
  let imported = 0, skipped = 0, errors = 0;
  try {
    const p = await peer();
    const existing = new Set(
      db.prepare('SELECT c.tg_msg_id FROM chunks c JOIN files f ON c.file_id=f.id WHERE f.channel=?')
        .all(channel).map(r => Number(r.tg_msg_id))
    );
    for await (const msg of tg.iterMessages(p, { limit })) {
      if (!msg?.document) continue;
      if (existing.has(Number(msg.id))) { skipped++; continue; }
      try {
        const doc = msg.document;
        const fnAttr = doc.attributes?.find(a => a.className === 'DocumentAttributeFilename');
        const filename = fnAttr?.fileName || msg.message?.trim() || `file_${msg.id}`;
        const cleanName = String(filename).replace(/[/\\]/g, '_');
        const size = Number(doc.size);
        const mimeType = doc.mimeType || mime.lookup(cleanName) || 'application/octet-stream';
        const finalName = uniqueName(cleanName, null);
        const info = db.prepare('INSERT INTO files(name, folder_id, size, mime_type, thumb, channel) VALUES(?,?,?,?,NULL,?) RETURNING id').get(finalName, null, size, mimeType, channel);
        db.prepare('INSERT INTO chunks(file_id,idx,tg_msg_id,tg_dc_id,chunk_size) VALUES(?,0,?,?,?)').run(info.id, Number(msg.id), Number(doc.dcId || 0), size);
        imported++;
      } catch (e) { errors++; console.error('[sync] msg', msg.id, e.message); }
    }
    return { ok: true, imported, skipped, errors };
  } catch (err) {
    console.error('[sync]', err);
    reply.code(500); return { error: err.message };
  }
});

fastify.post(`${BASE_PATH}/api/rename`, async (req, reply) => {
  const { type, id, newName } = req.body || {};
  const clean = String(newName || '').trim().replace(/[/\\]/g, '_');
  if (!type || !id || !clean) { reply.code(400); return { error: 'Faltan datos' }; }
  if (type === 'file') {
    const row = db.prepare('SELECT * FROM files WHERE id=?').get(+id); if (!row) { reply.code(404); return { error: 'No encontrado' }; }
    if (db.prepare('SELECT 1 FROM files WHERE COALESCE(folder_id,0)=? AND name=? AND id!=?').get(row.folder_id ?? 0, clean, row.id)) { reply.code(409); return { error: 'Ya existe' }; }
    db.prepare('UPDATE files SET name=? WHERE id=?').run(clean, row.id);
  } else {
    const row = db.prepare('SELECT * FROM folders WHERE id=?').get(+id); if (!row) { reply.code(404); return { error: 'No encontrado' }; }
    if (db.prepare('SELECT 1 FROM folders WHERE COALESCE(parent_id,0)=? AND name=? AND id!=?').get(row.parent_id ?? 0, clean, row.id)) { reply.code(409); return { error: 'Ya existe' }; }
    db.prepare('UPDATE folders SET name=? WHERE id=?').run(clean, row.id);
  }
  return { ok: true };
});

fastify.post(`${BASE_PATH}/api/delete`, async (req, reply) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) { reply.code(400); return { error: 'Items requeridos' }; }
  const results = [];
  for (const { type, id } of items) {
    try {
      if (type === 'file') {
        await tgDelete(db.prepare('SELECT tg_msg_id FROM chunks WHERE file_id=?').all(+id).map(c => c.tg_msg_id));
        db.prepare('DELETE FROM files WHERE id=?').run(+id);
      } else {
        const del = (fId) => { for (const f of db.prepare('SELECT id FROM files WHERE folder_id=?').all(fId)) { tgDelete(db.prepare('SELECT tg_msg_id FROM chunks WHERE file_id=?').all(f.id).map(c => c.tg_msg_id)).catch(()=>{}); } for (const d of db.prepare('SELECT id FROM folders WHERE parent_id=?').all(fId)) del(d.id); };
        del(+id); db.prepare('DELETE FROM folders WHERE id=?').run(+id);
      }
      results.push({ id, ok: true });
    } catch (e) { results.push({ id, ok: false, error: e.message }); }
  }
  return { ok: results.every(r => r.ok), results };
});

fastify.get(`${BASE_PATH}/api/zip`, async (req, reply) => {
  const fid  = Number(req.query.id) || null;
  const name = fid ? (db.prepare('SELECT name FROM folders WHERE id=?').get(fid)?.name || 'carpeta') : 'raiz';
  reply.raw.writeHead(200, { 'Content-Type':'application/zip','Cache-Control':'no-store','Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(name+'.zip')}` });
  reply.hijack();
  const archive = archiver('zip', { store: true });
  archive.on('error', e => { try { reply.raw.destroy(); } catch {} });
  archive.pipe(reply.raw);
  const channel = currentChannel();
  async function addDir(folderId, prefix) {
    const { PassThrough } = await import('node:stream');
    for (const f of db.prepare('SELECT * FROM files WHERE channel=? AND folder_id IS ?').all(channel, folderId)) {
      const ch = db.prepare('SELECT * FROM chunks WHERE file_id=? ORDER BY idx').all(f.id);
      const pass = new PassThrough();
      archive.append(pass, { name: prefix + f.name });
      (async () => { try { for (const c of ch) for await (const b of tgStream(c.tg_msg_id, c.tg_dc_id)) pass.write(b); } catch {} pass.end(); })();
    }
    for (const d of db.prepare('SELECT * FROM folders WHERE channel=? AND parent_id IS ?').all(channel, folderId)) await addDir(d.id, prefix + d.name + '/');
  }
  await addDir(fid, '');
  archive.finalize();
});

// ─── Inicio ─────────────────────────────────────────────────────────────────
await fastify.listen({ host: '0.0.0.0', port: PORT });
console.log(`tgcloud :${PORT}  base=${BASE_PATH}  tg=${tgStatus}`);
