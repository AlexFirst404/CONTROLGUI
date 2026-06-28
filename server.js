'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { handleApi } = require('./lib/api');
const { serveStatic } = require('./lib/static');
const { serverDir } = require('./lib/paths');
const manager = require('./lib/manager');
const users = require('./lib/users');
const store = require('./lib/store');

const PORT = parseInt(process.env.PORT, 10) || 8400;

// Watchdog родителя: если панель запущена нативным окном (macOS .app передаёт свой PID),
// и это окно умерло ненормально (Force Quit/краш) — корректно выходим, освобождая порт.
// Java-серверы при этом ВЫЖИВАЮТ (их усыновит следующий запуск через adoptOrphans).
const PARENT_PID = parseInt(process.env.CONTROLGUI_PARENT_PID, 10);
if (PARENT_PID) {
  const wd = setInterval(() => {
    try { process.kill(PARENT_PID, 0); } // сигнал 0 — только проверка существования
    catch (e) { console.log('Родительское окно закрылось — выходим, серверы остаются жить.'); process.exit(0); }
  }, 3000);
  if (wd.unref) wd.unref();
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; if (data.length > 8192) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function sendJson(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); }

/* Аккаунт центрального сервера в десктопе: вход/выход/статус + привязка по коду. */
async function handleCentralRoutes(req, res, urlPath, cc) {
  if (urlPath === '/api/central' && req.method === 'GET') return sendJson(res, 200, cc.state());
  if (urlPath === '/api/central/login' && req.method === 'POST') { const b = await readJsonBody(req); const r = await cc.login(b.username || '', b.password || ''); return sendJson(res, r.error ? 400 : 200, r); }
  if (urlPath === '/api/central/register' && req.method === 'POST') { const b = await readJsonBody(req); const r = await cc.register(b.username || '', b.password || ''); return sendJson(res, r.error ? 400 : 200, r); }
  if (urlPath === '/api/central/logout' && req.method === 'POST') return sendJson(res, 200, cc.logout());
  if (urlPath === '/api/central/link' && req.method === 'POST') { const b = await readJsonBody(req); const r = await cc.linkByCode(String(b.code || '')); return sendJson(res, r.error ? 400 : 200, r); }
  if (urlPath === '/api/central/me' && req.method === 'GET') return sendJson(res, 200, await cc.me());
  if (urlPath === '/api/central/rename' && req.method === 'POST') { const b = await readJsonBody(req); const r = await cc.rename(String(b.newName || '')); return sendJson(res, r.error ? 400 : 200, r); }
  if (urlPath === '/api/central/password' && req.method === 'POST') { const b = await readJsonBody(req); const r = await cc.changePassword(String(b.current || ''), String(b.next || '')); return sendJson(res, r.error ? 400 : 200, r); }
  if (urlPath === '/api/central/discord/link' && req.method === 'POST') { const r = await cc.discordLinkInit(); return sendJson(res, r.error ? 400 : 200, r); }
  if (urlPath === '/api/central/discord/unlink' && req.method === 'POST') { const r = await cc.discordUnlink(); return sendJson(res, r.error ? 400 : 200, r); }
  return sendJson(res, 404, { error: 'Не найдено' });
}

/* Анти-брутфорс входа: 5 неверных попыток с одного IP -> блок на 5 минут. */
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCK_MS = 5 * 60 * 1000;
const loginAttempts = new Map(); // ip -> { fails, lockedUntil }

function clientIp(req) {
  // за реверс-прокси (рекомендуемый удалённый доступ) — X-Forwarded-For; иначе сокет
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || req.socket.remoteAddress || 'unknown';
}
function loginLockMs(ip) {
  const a = loginAttempts.get(ip);
  return a && a.lockedUntil > Date.now() ? a.lockedUntil - Date.now() : 0;
}
function noteLoginFail(ip) {
  const a = loginAttempts.get(ip) || { fails: 0, lockedUntil: 0 };
  a.fails += 1;
  if (a.fails >= LOGIN_MAX_FAILS) { a.lockedUntil = Date.now() + LOGIN_LOCK_MS; a.fails = 0; }
  loginAttempts.set(ip, a);
  return a;
}

/* Логин/логаут пользователей — доступны без сессии. */
async function handleAuthRoutes(req, res, urlPath) {
  if (urlPath === '/api/auth/login' && req.method === 'POST') {
    const ip = clientIp(req);
    const locked = loginLockMs(ip);
    if (locked > 0) {
      const sec = Math.ceil(locked / 1000);
      res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': String(sec) });
      res.end(JSON.stringify({ error: 'Слишком много попыток. Вход заблокирован, подождите ' + Math.ceil(sec / 60) + ' мин.', lockedSec: sec }));
      return true;
    }
    const body = await readJsonBody(req);
    const user = users.verify(body.username || '', body.password || '');
    if (user) {
      loginAttempts.delete(ip); // успех — сбрасываем счётчик
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': users.sessionCookie(users.createSession(user.username)),
      });
      res.end(JSON.stringify({ ok: true, user }));
    } else {
      const a = noteLoginFail(ip);
      const lockMs = loginLockMs(ip);
      if (lockMs > 0) {
        res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': String(Math.ceil(lockMs / 1000)) });
        res.end(JSON.stringify({ error: 'Слишком много неверных попыток. Вход заблокирован на 5 минут.', lockedSec: Math.ceil(lockMs / 1000) }));
      } else {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Неверный логин или пароль. Осталось попыток: ' + (LOGIN_MAX_FAILS - a.fails) }));
      }
    }
    return true;
  }
  if (urlPath === '/api/auth/logout' && req.method === 'POST') {
    users.destroySession(users.parseCookies(req)[users.COOKIE]);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': users.clearCookie() });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }
  return false;
}

const server = http.createServer(async (req, res) => {
  const urlPath = (req.url || '/').split('?')[0];

  // ресурспак сервера — без авторизации: его скачивают игровые клиенты Minecraft
  if (urlPath.startsWith('/rp/')) {
    const m = urlPath.match(/^\/rp\/([a-f0-9]+)\.zip$/i);
    if (m) {
      try {
        const zp = path.join(serverDir(m[1]), 'resourcepack.zip');
        const stat = fs.statSync(zp);
        res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': stat.size });
        fs.createReadStream(zp).pipe(res);
        return;
      } catch (e) { /* нет файла — 404 ниже */ }
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Resource pack not found');
    return;
  }

  // внутренний loopback-принципал полного удалённого управления (тот же процесс, 127.0.0.1 + секрет):
  // проксированный с центрального сервера запрос исполняется с проброшенными правами по ОДНОМУ серверу.
  if (urlPath.startsWith('/api/')) {
    const internal = require('./lib/remote').internalUserFor(req);
    if (internal) { req.cgUser = internal; return handleApi(req, res); }
  }

  if (await handleAuthRoutes(req, res, urlPath)) return;

  // ресурсы страницы входа — без сессии
  const isPublicAsset = urlPath === '/login' || urlPath === '/login.html' ||
    urlPath.startsWith('/css/') || urlPath.startsWith('/fonts/') ||
    urlPath.startsWith('/assets/') || urlPath.startsWith('/icons/') ||
    urlPath === '/js/api.js' || urlPath === '/logo.png';

  const user = users.currentUser(req); // null если вход нужен и не выполнен

  if (users.anyUsers() && !user && !isPublicAsset) {
    if (urlPath.startsWith('/api/')) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Требуется вход', login: true }));
    } else {
      res.writeHead(302, { Location: '/login?next=' + encodeURIComponent(req.url || '/') });
      res.end();
    }
    return;
  }

  if (urlPath === '/login' || urlPath === '/login.html') {
    // локальный вход убран: личность = аккаунт центра. Любой заход на /login — на главную.
    res.writeHead(302, { Location: '/' });
    return res.end();
  }
  if (req.url.startsWith('/api/')) {
    req.cgUser = user; // для проверки прав в api.js
    const cc = require('./lib/centralclient');
    // удалённый сервер (добавлен по коду) -> прозрачный прокси к центру (ДО чтения тела — нужен поток).
    // ВАЖНО: свой ЛОКАЛЬНЫЙ сервер всегда обслуживаем локально, даже если у него включена
    // удалёнка (его remoteLocalId == локальному id). Иначе запрос ушёл бы на центр, и при
    // удалении сервера из админки центр отдал бы 404 → панель убирала бы и локальный сервер.
    const m = urlPath.match(/^\/api\/servers\/([^/]+)(?:\/|$)/);
    if (m && !store.get(m[1])) { const gid = cc.gidForLocal(m[1]); if (gid) return cc.proxy(req, res, gid); }
    // управление аккаунтом центра в десктопе
    if (urlPath === '/api/central' || urlPath.startsWith('/api/central/')) return handleCentralRoutes(req, res, urlPath, cc);
    return handleApi(req, res);
  }
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log('');
  console.log('  ============================================');
  console.log('   CONTROLGUI — панель Minecraft-серверов');
  console.log('   Откройте в браузере: http://localhost:' + PORT);
  console.log('  ============================================');
  console.log('');
  // найти java-процессы серверов, запущенные прошлым экземпляром панели
  try { manager.adoptOrphans(); } catch (e) { console.error('Поиск осиротевших процессов:', e.message); }
  // переподключить туннели удалённого управления (серверы с включённой функцией)
  try { require('./lib/remote').initAll(); } catch (e) { console.error('Удалённое управление:', e.message); }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('Порт ' + PORT + ' занят. Запустите с другим портом: set PORT=8500 && node server.js');
    process.exit(1);
  }
  throw err;
});

// Аккуратно гасим запущенные серверы при закрытии панели
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (manager.anyRunning()) {
    console.log('Останавливаю запущенные Minecraft-серверы...');
    manager.stopAll();
    setTimeout(() => process.exit(0), 5000);
  } else {
    process.exit(0);
  }
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown); // закрытие окна консоли на Windows
