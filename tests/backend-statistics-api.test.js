'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'controlgui-statistics-api-'));
process.env.CONTROLGUI_DATA = root;
fs.mkdirSync(path.join(root, 'data'), { recursive: true });
fs.writeFileSync(path.join(root, 'data', 'servers.json'), JSON.stringify({ servers: [
  { id: 'allowed', name: 'Первый', type: 'paper', port: 25565, memoryMb: 1024 },
  { id: 'denied', name: 'Второй', type: 'paper', port: 25566, memoryMb: 1024 },
] }));
const { handleApi } = require('../lib/api');
const manager = require('../lib/manager');

async function request(url, options) {
  options = options || {};
  return new Promise((resolve) => {
    const req = Readable.from(options.body === undefined ? [] : [Buffer.from(options.body)]);
    Object.assign(req, { method: options.method || 'GET', url, headers: {}, cgRemote: !!options.remoteUser,
      cgRemoteUser: options.remoteUser || null, cgUser: options.user || { admin: true, perms: { admin: true } } });
    const res = { headersSent: false,
      writeHead(status) { this.status = status; this.headersSent = true; },
      end(body) { resolve({ status: this.status, body: JSON.parse(body) }); },
    };
    handleApi(req, res);
  });
}

test('история доступна с правом консоли, но не раскрывается постороннему серверу', async () => {
  const remoteUser = { access: { allowed: { 'console.view': true }, denied: { 'files.read': true } } };
  const user = { admin: false, access: remoteUser.access, perms: {} };
  const allowed = await request('/api/servers/allowed/statistics?days=7', { remoteUser, user: { ...user } });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.period.days, 7);
  assert.equal(allowed.body.summary.uptimeMs, 0);
  assert.equal(allowed.body.summary.averagePlayers, null);
  assert.equal(allowed.body.current.running, false);
  assert.doesNotMatch(JSON.stringify(allowed.body), /controlgui-statistics-api|[A-Z]:\\/);
  const denied = await request('/api/servers/allowed/../denied/statistics', { remoteUser, user: { ...user } });
  assert.equal(denied.status, 403, 'права должны вычисляться после канонизации URL');
  const inaccessible = await request('/api/servers/denied/statistics', {
    remoteUser: { access: { allowed: { 'console.view': true } } },
    user: { admin: false, access: { allowed: { 'console.view': true } }, perms: {} },
  });
  assert.equal(inaccessible.status, 403);
});

test('период статистики ограничен допустимыми целыми значениями', async () => {
  for (const days of ['-1', '7x', 'NaN', '366', '7.5', '']) {
    assert.equal((await request('/api/servers/allowed/statistics?days=' + encodeURIComponent(days))).status, 400);
  }
  assert.equal((await request('/api/servers/allowed/statistics')).body.period.days, 30);
  assert.equal((await request('/api/servers/allowed/statistics?days=0')).body.period.days, 0);
  assert.equal((await request('/api/servers/allowed/statistics', { method: 'POST' })).status, 405);
});

test('JSON null, массив и скаляр возвращают понятную 400 и освобождают мутацию', async () => {
  for (const body of ['null', '[]', '"строка"', '42', 'true']) {
    const response = await request('/api/servers/allowed/command', { method: 'POST', body });
    assert.equal(response.status, 400);
    assert.match(response.body.error, /JSON-объектом/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(manager.getState('allowed').activeMutations, 0);
  }
});

test.after(() => {
  manager.dropState('allowed');
  manager.dropState('denied');
  fs.rmSync(root, { recursive: true, force: true });
});
