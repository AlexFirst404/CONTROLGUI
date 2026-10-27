'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const { once } = require('events');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'controlgui-host-test-'));
let panel = null;
let port = 0;

function request(host, pathname, method, extraHeaders) {
  return new Promise((resolve, reject) => {
    const headers = Object.assign({}, extraHeaders || {});
    if (host === false) headers.Host = '';
    else headers.Host = host || '127.0.0.1:' + port;
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname || '/api/status',
      method: method || 'GET', headers, setHost: host !== false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.setTimeout(3000, () => req.destroy(new Error('Тестовая панель не отвечает')));
    req.on('error', reject);
    req.end();
  });
}

test.before(async () => {
  // Отдельный пустой корень исключает поиск/запуск серверов пользователя.
  fs.mkdirSync(path.join(root, 'servers', 'aa'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  // Повреждённая удалёнка не должна мешать открыть локальную панель и починить её.
  fs.writeFileSync(path.join(root, 'data', 'remote-access.json'), '{');
  fs.writeFileSync(path.join(root, 'servers', 'aa', 'resourcepack.zip'), 'тестовый ресурспак');
  const reservation = net.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  panel = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    cwd: path.join(__dirname, '..'), windowsHide: true,
    env: Object.assign({}, process.env, { CONTROLGUI_DATA: root, PORT: String(port),
      CONTROLGUI_ALLOW_LAN: '0', CONTROLGUI_PARENT_PID: '' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  panel.stdout.on('data', (chunk) => { log += chunk; });
  panel.stderr.on('data', (chunk) => { log += chunk; });
  const until = Date.now() + 10000;
  while (Date.now() < until) {
    if (panel.exitCode != null) throw new Error('Панель завершилась: ' + log);
    try { if ((await request()).status === 200) return; } catch (e) { /* сокет ещё привязывается */ }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Тестовая панель не запустилась: ' + log);
});

test('локальный API принимает только loopback Host, включая канонические варианты', async () => {
  for (const host of ['127.0.0.1', '127.0.0.2', 'localhost', 'LOCALHOST', 'localhost.', '[::1]']) {
    assert.equal((await request(host + ':' + port)).status, 200, host);
  }
  for (const host of ['evil.example', 'localhost.evil.example', '127.0.0.1.evil.example',
    'localhost@evil.example', 'localhost/evil', 'localhost#evil', 'localhost?evil', false]) {
    assert.equal((await request(host)).status, 403, String(host));
  }
});

test('совпадающий чужой Origin не обходит защиту DNS rebinding', async () => {
  const result = await request('evil.example:' + port, '/api/servers', 'POST', {
    Origin: 'http://evil.example:' + port, 'Content-Length': '0',
  });
  assert.equal(result.status, 403);
  assert.equal(fs.existsSync(path.join(root, 'data', 'servers.json')), false);
});

test('публичный ресурспак остаётся доступен с любым Host', async () => {
  const result = await request('public.example:' + port, '/rp/aa.zip');
  assert.equal(result.status, 200);
  assert.equal(result.body, 'тестовый ресурспак');
});

test.after(async () => {
  if (panel && panel.exitCode == null) {
    try { await request(null, '/api/quit', 'POST', { 'x-cg-local': '1', 'x-cg-stop-servers': '1' }); }
    catch (e) { /* тест мог завершиться до открытия сокета */ }
    if (panel.exitCode == null) {
      const exit = once(panel, 'exit');
      const timeout = setTimeout(() => panel.kill(), 2000);
      await exit;
      clearTimeout(timeout);
    }
  }
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
