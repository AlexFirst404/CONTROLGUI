'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { handleApi } = require('./lib/api');
const { serveStatic } = require('./lib/static');
const { serverDir } = require('./lib/paths');
const manager = require('./lib/manager');
const users = require('./lib/users');
const remoteaccess = require('./lib/remoteaccess');

const PORT = parseInt(process.env.PORT, 10) || 8400;
// HTTP-сокет слушаем на всех интерфейсах: ресурспак (/rp/) игровые клиенты тянут
// по LAN-адресу хоста. НО админку (UI+API) по HTTP отдаём ТОЛЬКО с loopback —
// локальная панель = полный доступ владельца без пароля, поэтому LAN-доступ к
// управлению — дыра. Доступ по сети — через HTTPS-листенер удалённого доступа
// (пароль + самоподписанный серт), включается в настройках. Кто осознанно хочет
// открыть HTTP-панель в сеть — ставит CONTROLGUI_ALLOW_LAN=1.
const ALLOW_LAN = process.env.CONTROLGUI_ALLOW_LAN === '1';
function isLoopbackReq(req) {
  const ra = (req.socket && req.socket.remoteAddress) || '';
  return ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
}

// Сеть защиты: единичный кривой запрос (напр. NUL в пути) не должен ронять весь процесс
// вместе с запущенными Minecraft-серверами. Логируем и продолжаем.
process.on('uncaughtException', (e) => { console.error('[uncaughtException]', e && e.stack || e); });
process.on('unhandledRejection', (e) => { console.error('[unhandledRejection]', e && e.stack || e); });

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

function sendJson(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); }

/* Anti-CSRF: изменяющий запрос принимаем, только если его источник — сама панель.
   Локальная HTTP-панель доверяет любому loopback как владельцу (без пароля), поэтому
   БЕЗ этой проверки JS сторонней страницы в браузере владельца (в т.ч. контент удалённой
   панели, открытой через прокси «Удалённых панелей» под origin 127.0.0.1:<эфемерный>)
   мог бы слепо (no-cors) слать POST/PUT/DELETE на 127.0.0.1:8400 и управлять машиной.
   Браузер на любом cross-origin fetch обязан слать Origin; сверяем host:port с адресом,
   по которому открыта сама панель (Host). Не-браузерные клиенты (CLI, нативный лаунчер)
   Origin не шлют — им доступ по прежним гейтам (loopback + x-cg-local у /api/quit). */
function sameOriginRequest(req) {
  const m = req.method;
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return true; // читающие/preflight — не мутируют
  const origin = req.headers.origin;
  if (!origin) return true; // не-браузер: Origin отсутствует (браузер на fetch его всегда ставит)
  let u;
  try { u = new URL(origin); } catch (e) { return false; } // 'null' и мусор — отвергаем
  return u.host === String(req.headers.host || ''); // host включает порт → прокси-origin (другой порт) не пройдёт
}

/* Единый обработчик запросов для ОБОИХ листенеров: HTTP (локальный, 8400) и
   HTTPS (удалённый доступ, включается в настройках). Различаем по req.socket.encrypted. */
async function handleRequest(req, res) {
  const urlPath = (req.url || '/').split('?')[0];
  const viaRemote = !!req.socket.encrypted; // запрос пришёл на HTTPS-листенер удалёнки

  // ресурспак сервера — без авторизации: его скачивают игровые клиенты Minecraft
  // (обязан оставаться на plain-HTTP листенере: клиент MC не умеет куки и самоподписанный TLS)
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

  let remoteUser = null; // пользователь удалённой сессии (для скоупа прав)
  if (viaRemote) {
    // -------- HTTPS-листенер: вход по логину/паролю, права по каждому серверу --------
    if (await remoteaccess.handleAuthRoutes(req, res, urlPath)) return;

    // ресурсы страницы входа — без сессии
    const isPublicAsset = urlPath === '/login' || urlPath === '/login.html' ||
      urlPath.startsWith('/css/') || urlPath.startsWith('/fonts/') ||
      urlPath.startsWith('/assets/') || urlPath.startsWith('/icons/') ||
      urlPath === '/js/api.js' || urlPath === '/logo.png' || urlPath === '/favicon.ico';

    remoteUser = remoteaccess.sessionUserFromReq(req);
    if (!remoteUser && !isPublicAsset) {
      if (urlPath.startsWith('/api/')) return sendJson(res, 401, { error: 'Требуется вход', login: true });
      res.writeHead(302, { Location: '/login' });
      return res.end();
    }
    if (urlPath === '/login' || urlPath === '/login.html') {
      if (remoteUser) { res.writeHead(302, { Location: '/' }); return res.end(); }
      req.url = '/login.html';
      return serveStatic(req, res);
    }
  } else {
    // -------- HTTP-листенер: только loopback (или явный CONTROLGUI_ALLOW_LAN=1) --------
    if (!ALLOW_LAN && !isLoopbackReq(req)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('403: панель доступна только локально. Удалённый доступ включается в настройках панели (HTTPS + пароль).');
      return;
    }
    if (urlPath === '/login' || urlPath === '/login.html') {
      // локально вход не нужен — на главную
      res.writeHead(302, { Location: '/' });
      return res.end();
    }
  }

  if (req.url.startsWith('/api/')) {
    // anti-CSRF: изменяющий запрос — только со своего origin (см. sameOriginRequest)
    if (!sameOriginRequest(req)) {
      return sendJson(res, 403, { error: 'Запрос отклонён: чужой источник (cross-origin)' });
    }
    req.cgRemote = viaRemote; // для локально-only операций (quit, системный проводник)
    if (viaRemote && remoteUser) {
      // ВАЖНО: права НЕ скоупим здесь по сырому пути — api.js резолвит целевой сервер
      // через new URL() (нормализует «..»), и разбор тут отдельным regex давал бы РАСХОЖДЕНИЕ
      // (/api/servers/A/../B → права A на операции над B). Скоуп делаем в api.js по
      // каноническому id сервера (единый источник с проверкой доступа). Здесь perms пусты —
      // не-серверные операции (server.create и пр.) удалённым закрыты.
      req.cgUser = { remote: true, username: remoteUser.username, admin: false, access: remoteUser.access || {}, perms: {} };
      req.cgRemoteUser = remoteUser; // сырой юзер: api.js посчитает perms под конкретный сервер
    } else {
      req.cgUser = users.currentUser(req); // локально — полный доступ владельцу
    }

    // штатное завершение панели (CLI `controlgui stop`, деинсталлятор, обновление):
    // строго локально (loopback), с кастомным заголовком (браузер не пошлёт его
    // cross-origin без CORS-preflight). Заголовок x-cg-stop-servers:1 (от CLI stop)
    // разрешает корректно остановить запущенные Minecraft-серверы перед выходом —
    // это нужно, т.к. на Windows process.kill(SIGTERM) = жёсткий TerminateProcess и
    // штатный обработчик сигналов не срабатывает.
    if (urlPath === '/api/quit' && req.method === 'POST') {
      if (viaRemote || !isLoopbackReq(req) || req.headers['x-cg-local'] !== '1') {
        return sendJson(res, 403, { error: 'Только локально' });
      }
      const stopServers = req.headers['x-cg-stop-servers'] === '1';
      // anyActive: живые процессы + автоустановка Java (proc ещё null) +
      // переходные статусы + живые «осиротевшие» серверы
      if (!stopServers && manager.anyActive()) return sendJson(res, 409, { error: 'Есть работающие серверы' });
      sendJson(res, 200, { ok: true });
      if (stopServers && manager.anyRunning()) {
        manager.stopAll();
        setTimeout(() => process.exit(0), 5000); // ждём сохранения миров
      } else {
        setTimeout(() => process.exit(0), 300);
      }
      return;
    }
    return handleApi(req, res);
  }
  serveStatic(req, res);
}

const server = http.createServer(handleRequest);

server.listen(PORT, () => {
  console.log('');
  console.log('  ============================================');
  console.log('   CONTROLGUI — панель Minecraft-серверов');
  console.log('   Откройте в браузере: http://localhost:' + PORT);
  console.log('  ============================================');
  console.log('');
  // найти java-процессы серверов, запущенные прошлым экземпляром панели
  try { manager.adoptOrphans(); } catch (e) { console.error('Поиск осиротевших процессов:', e.message); }
  // поднять HTTPS-листенер удалённого доступа, если он включён в настройках,
  // и следить за конфигом (правки из CLI подхватываются без рестарта панели)
  try { remoteaccess.init(handleRequest); } catch (e) { console.error('Удалённый доступ:', e.message); }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('Порт ' + PORT + ' занят. Запустите с другим портом: set PORT=8500 && node server.js');
  } else {
    console.error('Не удалось запустить сервер панели:', err && err.message || err);
  }
  // Ошибка привязки сокета неисправима — выходим ЯВНО (process.exit), а не throw:
  // иначе исключение перехватит process.on('uncaughtException') и процесс зависнет
  // живым без слушающего сокета (зомби).
  process.exit(1);
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
