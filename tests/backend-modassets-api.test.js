'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

/* Отдельный test-файл получает свой процесс: реестр и каталоги настоящих
   серверов пользователя никогда не участвуют в проверке бинарного endpoint. */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'controlgui-modassets-api-'));
process.env.CONTROLGUI_DATA = root;
global.__controlguiSkipDataInit = true;
fs.mkdirSync(path.join(root, 'data'), { recursive: true });
for (const id of ['allowed', 'denied']) fs.mkdirSync(path.join(root, 'servers', id, 'mods'), { recursive: true });
fs.writeFileSync(path.join(root, 'data', 'servers.json'), JSON.stringify({
  servers: [
    { id: 'allowed', name: 'Разрешённый', type: 'forge', version: '1.21.4', memoryMb: 1024, port: 25565 },
    { id: 'denied', name: 'Запрещённый', type: 'forge', version: '1.21.4', memoryMb: 1024, port: 25566 },
  ],
}));

const modassets = require('../lib/modassets');
const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const calls = [];
const originalResolveIcon = modassets.resolveIcon;
modassets.resolveIcon = async (modsDir, itemId) => {
  calls.push({ modsDir, itemId });
  return { buffer: image, etag: '"fixture-icon"' };
};
const { handleApi } = require('../lib/api');

function apiRequest(url, options) {
  options = options || {};
  return new Promise((resolve) => {
    const req = {
      method: options.method || 'GET',
      url,
      headers: options.headers || {},
      cgRemote: !!options.remote,
      cgRemoteUser: options.remoteUser || null,
      cgUser: options.user || { admin: false, perms: { 'files.read': true } },
    };
    const result = { status: 0, headers: {}, body: null };
    const res = {
      headersSent: false,
      writeHead(status, headers) {
        result.status = status;
        result.headers = headers || {};
        this.headersSent = true;
      },
      end(body) { result.body = body; resolve(result); },
    };
    handleApi(req, res);
  });
}

test('endpoint отдаёт PNG, ETag и поддерживает условный запрос/HEAD', async () => {
  const first = await apiRequest('/api/servers/allowed/item-icon?item=demo%3Ahammer');
  assert.equal(first.status, 200);
  assert.equal(first.headers['Content-Type'], 'image/png');
  assert.equal(first.headers['Content-Length'], image.length);
  assert.equal(first.headers.ETag, '"fixture-icon"');
  assert.equal(first.headers['X-Content-Type-Options'], 'nosniff');
  assert.deepEqual(first.body, image);
  assert.equal(calls.at(-1).itemId, 'demo:hammer');
  assert.equal(calls.at(-1).modsDir, path.join(root, 'servers', 'allowed', 'mods'));

  const cached = await apiRequest('/api/servers/allowed/item-icon?item=demo%3Ahammer', {
    headers: { 'if-none-match': '"fixture-icon"' },
  });
  assert.equal(cached.status, 304);
  assert.equal(cached.body, undefined);

  const head = await apiRequest('/api/servers/allowed/item-icon?item=demo%3Ahammer', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers['Content-Length'], image.length);
  assert.equal(head.body, undefined);
});

test('невалидный resource ID и отсутствие права отсекаются до чтения JAR', async () => {
  const before = calls.length;
  const bad = await apiRequest('/api/servers/allowed/item-icon?item=demo%3A..%2Fsecret');
  assert.equal(bad.status, 400);
  assert.equal(calls.length, before);

  const forbidden = await apiRequest('/api/servers/allowed/item-icon?item=demo%3Ahammer', {
    user: { admin: false, perms: {} },
  });
  assert.equal(forbidden.status, 403);
  assert.equal(calls.length, before);
});

test('права удалённого пользователя считаются по каноническому ID после нормализации пути', async () => {
  const remoteUser = {
    username: 'tester',
    admin: false,
    access: {
      allowed: { 'files.read': true },
      denied: {},
    },
  };
  const makeUser = () => ({ remote: true, username: 'tester', admin: false, access: remoteUser.access, perms: {} });
  const ok = await apiRequest('/api/servers/fake/../allowed/item-icon?item=demo%3Ahammer', {
    remote: true, remoteUser, user: makeUser(),
  });
  assert.equal(ok.status, 200);

  const before = calls.length;
  const denied = await apiRequest('/api/servers/allowed/../denied/item-icon?item=demo%3Ahammer', {
    remote: true, remoteUser, user: makeUser(),
  });
  assert.equal(denied.status, 403);
  assert.equal(calls.length, before);
});

test.after(() => {
  modassets.resolveIcon = originalResolveIcon;
  modassets.invalidate();
  fs.rmSync(root, { recursive: true, force: true });
});
