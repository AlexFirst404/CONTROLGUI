'use strict';
/* Прямой удалённый доступ к панели: HTTPS-листенер + пользователи с правами
   ПО КАЖДОМУ СЕРВЕРУ. Без центральных серверов: пробрасываешь порт на роутере,
   заходишь по https://ip:порт, вводишь логин+пароль — получаешь ровно те серверы
   и права, что тебе выдали. Серт самоподписанный (lib/selfsigned.js), пароли pbkdf2,
   сессии HttpOnly-куки, анти-брутфорс по адресу сокета. Без зависимостей.

   Конфиг data/remote-access.json:
     { enabled, port, users: [ { username, salt, hash, pwVersion,
         access: { "<serverId>"|"*": { "console.view": true, ... } } } ] } */
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./paths');
const selfsigned = require('./selfsigned');
const perms = require('./users');

const FILE = path.join(DATA_DIR, 'remote-access.json');
const CERT_FILE = path.join(DATA_DIR, 'remote-cert.pem');
const KEY_FILE = path.join(DATA_DIR, 'remote-key.pem');

const COOKIE = 'cg_remote';
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 дней
const DEFAULT_PORT = 8433;
const MAX_USERS = 100;

const sessions = new Map(); // token -> { username, pwVersion, expires }

// ---------- конфиг ----------
function loadCfg() {
  let c;
  try { c = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { c = {}; }
  if (!c || typeof c !== 'object') c = {};
  if (!Array.isArray(c.users)) c.users = [];
  // миграция старого single-password: одна учётка admin с полным доступом ко всем серверам
  if (c.hash && c.salt && !c.users.length) {
    c.users = [{ username: 'admin', salt: c.salt, hash: c.hash, pwVersion: 1, access: { '*': perms.presetPerms('full') } }];
    delete c.hash; delete c.salt; delete c.pwEpoch;
    try { saveCfg(c); } catch (e) { /* сохраним при следующей записи */ }
  }
  return c;
}
function saveCfg(cfg) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // уникальный tmp на процесс — иначе одновременная запись из CLI и панели затирает друг друга
  const tmp = FILE + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}
// монотонная «версия пароля»: у нового/пересозданного юзера гарантированно НЕ совпадёт со
// старыми сессиями (иначе removeUser+создание того же ника воскресило бы старые куки).
// Счётчик гарантирует строгий рост даже при двух вызовах в пределах одной миллисекунды.
let _pwSeq = 0;
function newPwVersion() { _pwSeq = Math.max(Date.now(), _pwSeq + 1); return _pwSeq; }
function portOf(cfg) {
  const p = parseInt((cfg || loadCfg()).port, 10);
  return (p >= 1 && p <= 65535) ? p : DEFAULT_PORT;
}

// ---------- пользователи ----------
function hashPw(password, salt) {
  return crypto.pbkdf2Sync(String(password), salt, 120000, 32, 'sha256').toString('hex');
}
function validName(n) { return typeof n === 'string' && /^[A-Za-z0-9_.\-]{1,32}$/.test(n); }
function findUser(cfg, username) {
  const lc = String(username || '').toLowerCase();
  return (cfg.users || []).find((u) => String(u.username).toLowerCase() === lc) || null;
}
/* Санитизация access-карты: ключи "*" или id серверов, значения — чистый набор прав; пустые отбрасываем. */
function sanitizeAccess(access) {
  const out = {};
  if (!access || typeof access !== 'object') return out;
  let n = 0;
  for (const key of Object.keys(access)) {
    if (n >= 500) break;
    if (key !== '*' && !/^[A-Za-z0-9_\-]{1,64}$/.test(key)) continue; // id серверов — простые токены
    const p = perms.sanitizePerms(access[key]);
    if (Object.keys(p).length) { out[key] = p; n += 1; }
  }
  return out;
}
/* Добавить/обновить пользователя. password: пустой при обновлении = не менять. */
function saveUser(input) {
  const username = String((input && input.username) || '').trim();
  if (!validName(username)) return { error: 'Ник: 1–32 символа (буквы, цифры, _ . -)' };
  const access = sanitizeAccess(input.access);
  if (!Object.keys(access).length) return { error: 'Выберите хотя бы один сервер с правами' };
  const cfg = loadCfg();
  let u = findUser(cfg, username);
  const isNew = !u;
  if (isNew) {
    if (cfg.users.length >= MAX_USERS) return { error: 'Достигнут лимит пользователей' };
    if (String(input.password || '').length < 6) return { error: 'Пароль: минимум 6 символов' };
    const salt = crypto.randomBytes(16).toString('hex');
    u = { username, salt, hash: hashPw(input.password, salt), pwVersion: newPwVersion(), access };
    cfg.users.push(u);
  } else {
    u.username = username; // сохраняем регистр
    u.access = access;
    if (input.password) {
      if (String(input.password).length < 6) return { error: 'Пароль: минимум 6 символов' };
      u.salt = crypto.randomBytes(16).toString('hex');
      u.hash = hashPw(input.password, u.salt);
      u.pwVersion = newPwVersion(); // рвём старые сессии этого юзера
    }
  }
  saveCfg(cfg);
  // сбрасываем сессии этого пользователя в текущем процессе (смена прав/пароля)
  for (const [t, s] of sessions) if (String(s.username).toLowerCase() === username.toLowerCase()) sessions.delete(t);
  sync();
  dropConnections(); // закрыть живые соединения (SSE) — переподключатся с новыми правами
  return { ok: true };
}
function removeUser(username) {
  const cfg = loadCfg();
  const before = cfg.users.length;
  cfg.users = cfg.users.filter((u) => String(u.username).toLowerCase() !== String(username).toLowerCase());
  if (cfg.users.length === before) return { error: 'Пользователь не найден' };
  // нет пользователей → удалёнку выключаем (иначе висит открытый порт без входа)
  if (!cfg.users.length) cfg.enabled = false;
  saveCfg(cfg);
  for (const [t, s] of sessions) if (String(s.username).toLowerCase() === String(username).toLowerCase()) sessions.delete(t);
  sync();
  dropConnections(); // оборвать живую SSE-консоль удалённого пользователя немедленно
  return { ok: true };
}
/* Публичный список пользователей (без хэшей) — для UI/CLI. */
function listUsers() {
  return loadCfg().users.map((u) => ({ username: u.username, access: u.access || {} }));
}
function userCount() { return loadCfg().users.length; }

/* Проверка входа: возвращает { username, pwVersion } или null. Время постоянно (dummy-хэш). */
function verify(username, password) {
  const cfg = loadCfg();
  const u = findUser(cfg, username);
  if (!u || !u.hash || !u.salt) {
    crypto.pbkdf2Sync(String(password), 'cg-dummy-salt', 120000, 32, 'sha256');
    return null;
  }
  const cand = Buffer.from(hashPw(password, u.salt));
  const stored = Buffer.from(u.hash);
  if (cand.length !== stored.length || !crypto.timingSafeEqual(cand, stored)) return null;
  return { username: u.username, pwVersion: parseInt(u.pwVersion, 10) || 0 };
}
/* Полный пользователь по нику (для скоупинга прав в server.js). */
function getUser(username) { return findUser(loadCfg(), username); }

// ---------- сертификат ----------
function lanIPv4() {
  try {
    const mgr = require('./manager');
    return (mgr.lanAddresses() || []).filter((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip));
  } catch (e) { return []; }
}
function ensureCert() {
  if (fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE)) return readCert();
  const os = require('os');
  const { certPem, keyPem, fingerprint } = selfsigned.generate({
    commonName: 'CONTROLGUI', days: 3650,
    dnsNames: [os.hostname()].filter(Boolean),
    ips: lanIPv4(),
  });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(KEY_FILE, keyPem, { mode: 0o600 });
  fs.writeFileSync(CERT_FILE, certPem);
  return { certPem, keyPem, fingerprint };
}
function readCert() {
  const certPem = fs.readFileSync(CERT_FILE, 'utf8');
  const keyPem = fs.readFileSync(KEY_FILE, 'utf8');
  const der = Buffer.from(certPem.replace(/-----[^-]+-----|\s/g, ''), 'base64');
  return { certPem, keyPem, fingerprint: crypto.createHash('sha256').update(der).digest('hex') };
}
function regenerateCert() {
  try { fs.rmSync(CERT_FILE, { force: true }); fs.rmSync(KEY_FILE, { force: true }); } catch (e) { /* */ }
  const c = ensureCert();
  restartIfRunning();
  return { ok: true, fingerprint: c.fingerprint };
}

// ---------- сессии ----------
function genOf(cfg) { return parseInt((cfg || loadCfg()).generation, 10) || 0; }
function createSession(username, pwVersion) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { username, pwVersion, gen: genOf(), expires: Date.now() + TTL_MS });
  return token;
}
function sessionCookie(token) {
  return COOKIE + '=' + token + '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + Math.floor(TTL_MS / 1000);
}
function clearCookie() { return COOKIE + '=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0'; }
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
/* Пользователь текущей сессии или null. Проверяет: жива, юзер существует, пароль не менялся
   (pwVersion по файлу — ловит смену из другого процесса/CLI), удалёнка включена. */
function sessionUserFromReq(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expires) { sessions.delete(token); return null; }
  const cfg = loadCfg();
  if (!cfg.enabled) return null;
  if ((s.gen || 0) !== genOf(cfg)) { sessions.delete(token); return null; } // disable/поколение сбросило все сессии
  const u = findUser(cfg, s.username);
  if (!u || (parseInt(u.pwVersion, 10) || 0) !== s.pwVersion) { sessions.delete(token); return null; }
  return u;
}
/* Совместимость с прежним интерфейсом: только факт наличия сессии. */
function sessionFromReq(req) {
  const u = sessionUserFromReq(req);
  return u ? { remote: true, username: u.username } : null;
}

// ---------- анти-брутфорс (по адресу сокета: XFF подделывается клиентом) ----------
const MAX_FAILS = 5;
const LOCK_MS = 5 * 60 * 1000;
const attempts = new Map(); // ip -> { fails, lockedUntil, lastSeen }
function socketIp(req) {
  return String((req.socket && req.socket.remoteAddress) || 'unknown').replace(/^::ffff:/, '');
}
function lockMs(ip) {
  const a = attempts.get(ip);
  return a && a.lockedUntil > Date.now() ? a.lockedUntil - Date.now() : 0;
}
function noteFail(ip) {
  const a = attempts.get(ip) || { fails: 0, lockedUntil: 0 };
  a.fails += 1; a.lastSeen = Date.now();
  if (a.fails >= MAX_FAILS) { a.lockedUntil = Date.now() + LOCK_MS; a.fails = 0; }
  attempts.set(ip, a);
  return a;
}
const _sweep = setInterval(() => {
  const now = Date.now();
  for (const [t, s] of sessions) if (now > s.expires) sessions.delete(t);
  for (const [ip, a] of attempts) if (a.lockedUntil <= now && now - (a.lastSeen || 0) > LOCK_MS) attempts.delete(ip);
}, 10 * 60 * 1000);
if (_sweep.unref) _sweep.unref();

function readJsonBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; if (data.length > 8192) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { resolve({}); } });
    req.on('close', () => resolve({}));
    req.on('error', () => resolve({}));
  });
}
function sendJson(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); }

/* Вход/выход на HTTPS-листенере. true — маршрут обработан. */
async function handleAuthRoutes(req, res, urlPath) {
  if (urlPath === '/api/auth/login' && req.method === 'POST') {
    const body = await readJsonBody(req);
    // ключуем по (IP + ник): успешный вход в СВОЮ учётку не сбрасывает блок, заработанный
    // перебором ЧУЖОЙ учётки с того же IP (иначе анти-брутфорс обходится своим аккаунтом)
    const key = socketIp(req) + '|' + String(body.username || '').toLowerCase();
    const locked = lockMs(key);
    if (locked > 0) {
      const sec = Math.ceil(locked / 1000);
      res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': String(sec) });
      res.end(JSON.stringify({ error: 'Слишком много попыток. Подождите ' + Math.ceil(sec / 60) + ' мин.', lockedSec: sec }));
      return true;
    }
    const v = verify(body.username, body.password);
    if (v) {
      attempts.delete(key);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': sessionCookie(createSession(v.username, v.pwVersion)) });
      res.end(JSON.stringify({ ok: true, username: v.username }));
    } else {
      const a = noteFail(key);
      const lm = lockMs(key);
      if (lm > 0) {
        res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': String(Math.ceil(lm / 1000)) });
        res.end(JSON.stringify({ error: 'Слишком много неверных попыток. Вход заблокирован на 5 минут.', lockedSec: Math.ceil(lm / 1000) }));
      } else {
        sendJson(res, 401, { error: 'Неверный логин или пароль. Осталось попыток: ' + (MAX_FAILS - a.fails) });
      }
    }
    return true;
  }
  if (urlPath === '/api/auth/logout' && req.method === 'POST') {
    const token = parseCookies(req)[COOKIE];
    if (token) sessions.delete(token);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': clearCookie() });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }
  return false;
}

// ---------- HTTPS-листенер ----------
let httpsServer = null;
let runningPort = 0;
let requestHandler = null;

function wantRunning(cfg) { return !!(cfg.enabled && cfg.users && cfg.users.length); }
function startListener() {
  const cfg = loadCfg();
  if (!wantRunning(cfg)) return;
  if (httpsServer) return;
  let cert;
  try { cert = ensureCert(); } catch (e) { console.error('[удалённый доступ] серт:', e.message); return; }
  const port = portOf(cfg);
  const srv = https.createServer({ cert: cert.certPem, key: cert.keyPem }, requestHandler);
  srv.requestTimeout = 0;               // SSE-консоль живёт минутами
  srv.headersTimeout = 30 * 1000;
  srv.on('error', (err) => {
    console.error('[удалённый доступ] ' + (err.code === 'EADDRINUSE'
      ? 'порт ' + port + ' занят — удалённый доступ не запущен'
      : 'ошибка: ' + (err.message || err)));
    httpsServer = null; runningPort = 0;
  });
  srv.listen(port, () => {
    console.log('[удалённый доступ] HTTPS слушает порт ' + port + ' (отпечаток серта: ' + cert.fingerprint.slice(0, 16) + '…)');
  });
  httpsServer = srv;
  runningPort = port;
}
function stopListener() {
  if (!httpsServer) return;
  dropConnections(); // рвём живые соединения (в т.ч. SSE-консоль), а не только слушающий сокет
  try { httpsServer.close(); } catch (e) { /* */ }
  httpsServer = null;
  runningPort = 0;
  console.log('[удалённый доступ] HTTPS-листенер остановлен');
}
/* Оборвать все активные удалённые соединения (Node ≥18.2). Нужно при отзыве доступа:
   удаление/смена прав пользователя должны закрыть его живую SSE-консоль сразу. */
function dropConnections() {
  try { if (httpsServer && typeof httpsServer.closeAllConnections === 'function') httpsServer.closeAllConnections(); } catch (e) { /* */ }
}
function restartIfRunning() { if (!requestHandler) return; stopListener(); startListener(); }
function sync() {
  if (!requestHandler) return;
  const cfg = loadCfg();
  const run = wantRunning(cfg);
  if (run && httpsServer && runningPort !== portOf(cfg)) stopListener();
  if (run && !httpsServer) startListener();
  if (!run && httpsServer) stopListener();
}
function init(handler) {
  requestHandler = handler;
  sync();
  fs.watchFile(FILE, { interval: 2000 }, () => { try { sync(); } catch (e) { console.error('[удалённый доступ]', e.message); } });
}

// ---------- статус/управление ----------
function status() {
  const cfg = loadCfg();
  let fingerprint = null;
  try { if (fs.existsSync(CERT_FILE)) fingerprint = readCert().fingerprint; } catch (e) { /* */ }
  return {
    enabled: !!cfg.enabled,
    running: !!httpsServer,
    port: portOf(cfg),
    userCount: (cfg.users || []).length,
    users: listUsers(),
    fingerprint,
    lanIps: lanIPv4(),
  };
}
function enable() {
  const cfg = loadCfg();
  if (!cfg.users.length) return { error: 'Сначала добавьте хотя бы одного пользователя' };
  cfg.enabled = true;
  saveCfg(cfg);
  sync();
  return { ok: true, status: status() };
}
function disable() {
  const cfg = loadCfg();
  cfg.enabled = false;
  // поколение++ → все ранее выданные куки недействительны навсегда (даже после повторного
  // enable и даже если их выдал другой процесс) — иначе старые сессии «оживали» бы
  cfg.generation = (parseInt(cfg.generation, 10) || 0) + 1;
  saveCfg(cfg);
  sessions.clear();
  sync();
  return { ok: true };
}
function setPort(p) {
  const port = parseInt(p, 10);
  if (!(port >= 1 && port <= 65535)) return { error: 'Порт: число 1–65535' };
  const cfg = loadCfg();
  cfg.port = port;
  saveCfg(cfg);
  sync();
  return { ok: true, port };
}

module.exports = {
  COOKIE, DEFAULT_PORT, FILE,
  status, enable, disable, setPort, regenerateCert,
  verify, getUser, saveUser, removeUser, listUsers, userCount, validName,
  sessionFromReq, sessionUserFromReq, handleAuthRoutes, init, sync,
};
