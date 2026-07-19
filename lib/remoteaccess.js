'use strict';
/* Прямой удалённый доступ к панели: второй HTTPS-листенер с единым паролем.
   Без центральных серверов и аккаунтов: пользователь пробрасывает порт на роутере,
   заходит по https://свой-ip:порт, вводит пароль — получает полную панель.
   Сертификат — самоподписанный (lib/selfsigned.js), пароль — pbkdf2,
   сессии — HttpOnly-куки, анти-брутфорс по адресу сокета. Без зависимостей. */
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./paths');
const selfsigned = require('./selfsigned');

const FILE = path.join(DATA_DIR, 'remote-access.json');
const CERT_FILE = path.join(DATA_DIR, 'remote-cert.pem');
const KEY_FILE = path.join(DATA_DIR, 'remote-key.pem');

const COOKIE = 'cg_remote';
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 дней
const DEFAULT_PORT = 8433;

const sessions = new Map(); // token -> { expires }

// ---------- конфиг ----------
function loadCfg() {
  try {
    const c = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return (c && typeof c === 'object') ? c : {};
  } catch (e) { return {}; }
}
function saveCfg(cfg) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}
function portOf(cfg) {
  const p = parseInt((cfg || loadCfg()).port, 10);
  return (p >= 1 && p <= 65535) ? p : DEFAULT_PORT;
}

// ---------- пароль ----------
function hashPw(password, salt) {
  return crypto.pbkdf2Sync(String(password), salt, 120000, 32, 'sha256').toString('hex');
}
function setPassword(password) {
  if (String(password || '').length < 6) return { error: 'Пароль: минимум 6 символов' };
  const cfg = loadCfg();
  cfg.salt = crypto.randomBytes(16).toString('hex');
  cfg.hash = hashPw(password, cfg.salt);
  saveCfg(cfg);
  // пароль сменился — все старые сессии удалёнки недействительны
  sessions.clear();
  return { ok: true };
}
function verify(password) {
  const cfg = loadCfg();
  if (!cfg.hash || !cfg.salt) {
    // фиктивный хэш: время ответа не выдаёт, задан ли пароль вообще
    crypto.pbkdf2Sync(String(password), 'cg-dummy-salt', 120000, 32, 'sha256');
    return false;
  }
  const cand = Buffer.from(hashPw(password, cfg.salt));
  const stored = Buffer.from(cfg.hash);
  return cand.length === stored.length && crypto.timingSafeEqual(cand, stored);
}

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
/* Пересоздать серт (напр. сменился LAN-IP и хочется корректный SAN). */
function regenerateCert() {
  try { fs.rmSync(CERT_FILE, { force: true }); fs.rmSync(KEY_FILE, { force: true }); } catch (e) { /* */ }
  const c = ensureCert();
  restartIfRunning();
  return { ok: true, fingerprint: c.fingerprint };
}

// ---------- сессии ----------
function createSession() {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { expires: Date.now() + TTL_MS });
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
function sessionFromReq(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expires) { sessions.delete(token); return null; }
  return { remote: true };
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
    const ip = socketIp(req);
    const locked = lockMs(ip);
    if (locked > 0) {
      const sec = Math.ceil(locked / 1000);
      res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': String(sec) });
      res.end(JSON.stringify({ error: 'Слишком много попыток. Подождите ' + Math.ceil(sec / 60) + ' мин.', lockedSec: sec }));
      return true;
    }
    const body = await readJsonBody(req);
    if (verify(body.password)) {
      attempts.delete(ip);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': sessionCookie(createSession()) });
      res.end(JSON.stringify({ ok: true }));
    } else {
      const a = noteFail(ip);
      const lm = lockMs(ip);
      if (lm > 0) {
        res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': String(Math.ceil(lm / 1000)) });
        res.end(JSON.stringify({ error: 'Слишком много неверных попыток. Вход заблокирован на 5 минут.', lockedSec: Math.ceil(lm / 1000) }));
      } else {
        sendJson(res, 401, { error: 'Неверный пароль. Осталось попыток: ' + (MAX_FAILS - a.fails) });
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
let httpsServer = null;   // текущий инстанс (null = не запущен)
let runningPort = 0;
let requestHandler = null; // общий хендлер панели (задаётся в init)

function startListener() {
  const cfg = loadCfg();
  if (!cfg.enabled || !cfg.hash) return;
  if (httpsServer) return;
  let cert;
  try { cert = ensureCert(); } catch (e) { console.error('[удалённый доступ] серт:', e.message); return; }
  const port = portOf(cfg);
  const srv = https.createServer({ cert: cert.certPem, key: cert.keyPem }, requestHandler);
  // SSE консоли живёт минутами — не даём Node прибивать «неактивные» ответы
  srv.requestTimeout = 0;
  srv.headersTimeout = 30 * 1000;
  srv.on('error', (err) => {
    // отказ HTTPS-порта НЕ фатален для панели: локальный HTTP продолжает работать
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
  try { httpsServer.close(); } catch (e) { /* */ }
  httpsServer = null;
  runningPort = 0;
  console.log('[удалённый доступ] HTTPS-листенер остановлен');
}
function restartIfRunning() {
  if (!requestHandler) return; // панель не инициализировала модуль (мы в CLI-процессе)
  stopListener();
  startListener();
}
/* Привести листенер в соответствие конфигу (вызывается при изменениях). */
function sync() {
  if (!requestHandler) return;
  const cfg = loadCfg();
  const wantRunning = !!(cfg.enabled && cfg.hash);
  if (wantRunning && httpsServer && runningPort !== portOf(cfg)) { stopListener(); }
  if (wantRunning && !httpsServer) startListener();
  if (!wantRunning && httpsServer) stopListener();
}

/* Инициализация из server.js: запускает листенер (если включён) и следит за
   конфигом — правки из CLI (controlgui remote ...) подхватываются без рестарта. */
function init(handler) {
  requestHandler = handler;
  sync();
  // fs.watchFile переживает атомарные rename-записи (fs.watch на них теряет файл)
  fs.watchFile(FILE, { interval: 2000 }, () => { try { sync(); } catch (e) { console.error('[удалённый доступ]', e.message); } });
}

// ---------- статус/управление (для API и CLI) ----------
function status() {
  const cfg = loadCfg();
  let fingerprint = null;
  try { if (fs.existsSync(CERT_FILE)) fingerprint = readCert().fingerprint; } catch (e) { /* */ }
  return {
    enabled: !!cfg.enabled,
    running: !!httpsServer,
    port: portOf(cfg),
    hasPassword: !!cfg.hash,
    fingerprint,
    lanIps: lanIPv4(),
  };
}
function enable() {
  const cfg = loadCfg();
  if (!cfg.hash) return { error: 'Сначала задайте пароль удалённого доступа' };
  cfg.enabled = true;
  saveCfg(cfg);
  sync();
  return { ok: true, status: status() };
}
function disable() {
  const cfg = loadCfg();
  cfg.enabled = false;
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
  status, enable, disable, setPort, setPassword, verify, regenerateCert,
  sessionFromReq, handleAuthRoutes, init, sync,
};
