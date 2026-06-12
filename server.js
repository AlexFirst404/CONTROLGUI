'use strict';
const http = require('http');
const os = require('os');
const { handleApi } = require('./lib/api');
const { serveStatic } = require('./lib/static');
const manager = require('./lib/manager');
const auth = require('./lib/auth');
const remotes = require('./lib/remotes');

const PORT = parseInt(process.env.PORT, 10) || 8400;

// авто-привязка к центральному дашборду (хабу)
const HUB_URL = process.env.CONTROLGUI_HUB || '';
const HUB_SECRET = process.env.CONTROLGUI_HUB_SECRET || '';
const PUBLIC_URL = process.env.CONTROLGUI_PUBLIC_URL || ('http://localhost:' + PORT);

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
  // авто-привязка: удалённая установка регистрируется на этом хабе по секрету
  // (без сессии — её приносит другой сервер, не браузер)
  if (url === '/api/admin/register' && req.method === 'POST') {
    const body = await readJsonBody(req);
    if (!auth.verifyHubSecret(body.secret)) {
      res.writeHead(auth.hubSecret() ? 401 : 403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: auth.hubSecret() ? 'Неверный секрет привязки' : 'Авто-привязка выключена (нет CONTROLGUI_HUB_SECRET)' }));
      return true;
    }
    try {
      remotes.upsertAuto(body.url, body.password, body.name || '');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: e.message }));
    }
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
  startSelfRegister();
});

/* Если заданы CONTROLGUI_HUB и CONTROLGUI_HUB_SECRET — эта установка сама
   регистрируется в центральном дашборде (адрес + пароль) на старте и далее
   раз в 2 минуты (heartbeat), чтобы появляться в нём автоматически. */
function selfRegisterOnce() {
  if (!HUB_URL || !HUB_SECRET) return;
  remotes.postRegister(HUB_URL, {
    secret: HUB_SECRET,
    url: PUBLIC_URL,
    password: process.env.CONTROLGUI_PASSWORD || '',
    name: os.hostname(),
  }).then(() => {
    console.log('Зарегистрировано в админ-дашборде ' + HUB_URL);
  }).catch((e) => {
    console.error('Авто-привязка к ' + HUB_URL + ' не удалась (повтор позже): ' + e.message);
  });
}

function startSelfRegister() {
  if (!HUB_URL || !HUB_SECRET) return;
  selfRegisterOnce();
  const timer = setInterval(selfRegisterOnce, 120000);
  timer.unref();
}

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
