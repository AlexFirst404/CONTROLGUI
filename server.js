'use strict';
const http = require('http');
const { handleApi } = require('./lib/api');
const { serveStatic } = require('./lib/static');
const manager = require('./lib/manager');
const auth = require('./lib/auth');

const PORT = parseInt(process.env.PORT, 10) || 8400;

function readJsonBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 4096) req.destroy(); // защита от мусора
    });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch (e) { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

/* Эндпоинты логина/логаута доступны без сессии. Возвращает true, если
   запрос обработан здесь и дальше идти не нужно. */
async function handleAuthRoutes(req, res, url) {
  if (url === '/api/login' && req.method === 'POST') {
    const body = await readJsonBody(req);
    if (!auth.enabled() || auth.verifyPassword(body.password || '')) {
      const token = auth.createSession();
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': auth.sessionCookie(token),
      });
      res.end(JSON.stringify({ ok: true }));
    } else {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Неверный пароль' }));
    }
    return true;
  }
  if (url === '/api/logout' && req.method === 'POST') {
    const token = auth.parseCookies(req)[auth.COOKIE];
    auth.destroySession(token);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': auth.clearCookie(),
    });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }
  return false;
}

const server = http.createServer(async (req, res) => {
  const urlPath = (req.url || '/').split('?')[0];

  // логин/логаут — всегда доступны
  if (await handleAuthRoutes(req, res, urlPath)) return;

  // страница входа и её ресурсы — без сессии (иначе нечего показать)
  const isPublicAsset = urlPath === '/login.html' || urlPath === '/login' ||
    urlPath.startsWith('/css/') || urlPath.startsWith('/fonts/') ||
    urlPath.startsWith('/assets/') || urlPath.startsWith('/icons/');

  if (auth.enabled() && !auth.isAuthed(req) && !isPublicAsset) {
    if (urlPath.startsWith('/api/')) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Требуется вход', login: true }));
    } else {
      // навигация — отдаём страницу логина (адрес сохраняем в next)
      res.writeHead(302, { Location: '/login?next=' + encodeURIComponent(req.url || '/') });
      res.end();
    }
    return;
  }

  if (urlPath === '/login') {
    return serveStatic(Object.assign(req, { url: '/login.html' }), res);
  }
  if (urlPath === '/admin') {
    return serveStatic(Object.assign(req, { url: '/admin.html' }), res);
  }
  if (req.url.startsWith('/api/')) return handleApi(req, res);
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
