'use strict';
const http = require('http');
const { handleApi } = require('./lib/api');
const { serveStatic } = require('./lib/static');
const manager = require('./lib/manager');
const users = require('./lib/users');

const PORT = parseInt(process.env.PORT, 10) || 8400;

function readJsonBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; if (data.length > 8192) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

/* Логин/логаут пользователей — доступны без сессии. */
async function handleAuthRoutes(req, res, urlPath) {
  if (urlPath === '/api/auth/login' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const user = users.verify(body.username || '', body.password || '');
    if (user) {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': users.sessionCookie(users.createSession(user.username)),
      });
      res.end(JSON.stringify({ ok: true, user }));
    } else {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Неверный логин или пароль' }));
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

  if (urlPath === '/login') {
    return serveStatic(Object.assign(req, { url: '/login.html' }), res);
  }
  if (req.url.startsWith('/api/')) {
    req.cgUser = user; // для проверки прав в api.js
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
