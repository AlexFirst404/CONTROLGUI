'use strict';
const http = require('http');
const crypto = require('crypto');
const { handleApi } = require('./lib/api');
const { serveStatic } = require('./lib/static');
const manager = require('./lib/manager');

const PORT = parseInt(process.env.PORT, 10) || 8400;

/* Если задан CONTROLGUI_PASSWORD — вся панель за HTTP Basic Auth
   (логин любой, например admin). Для удалённых серверов обязательно. */
const PASSWORD = process.env.CONTROLGUI_PASSWORD || '';

function checkAuth(req, res) {
  if (!PASSWORD) return true;
  const header = req.headers.authorization || '';
  const m = header.match(/^Basic (.+)$/);
  if (m) {
    let decoded = '';
    try { decoded = Buffer.from(m[1], 'base64').toString('utf8'); } catch (e) { /* мусор */ }
    const pass = decoded.slice(decoded.indexOf(':') + 1);
    const a = Buffer.from(pass);
    const b = Buffer.from(PASSWORD);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  res.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="CONTROLGUI", charset="UTF-8"',
    'Content-Type': 'text/plain; charset=utf-8',
  });
  res.end('Требуется авторизация: логин admin и пароль из установки.');
  return false;
}

const server = http.createServer((req, res) => {
  if (!checkAuth(req, res)) return;
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
