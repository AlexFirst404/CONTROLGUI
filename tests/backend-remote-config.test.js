'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tls = require('tls');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'controlgui-remote-config-'));
process.env.CONTROLGUI_DATA = root;
const remoteclient = require('../lib/remoteclient');
const remoteaccess = require('../lib/remoteaccess');
const realConnect = tls.connect;
const realRead = fs.readFileSync;
const realRename = fs.renameSync;
const certificate = Buffer.from('сертификат только для тестовой подмены TLS');
const fingerprint = crypto.createHash('sha256').update(certificate).digest('hex');
const pendingProbes = [];

tls.connect = (options, ready) => {
  const socket = new EventEmitter();
  socket.setTimeout = () => socket;
  socket.destroy = () => socket;
  socket.getPeerCertificate = () => ({ raw: certificate });
  pendingProbes.push(() => ready());
  return socket;
};

function connection(name, extra) {
  return Object.assign({ name, host: '127.0.0.1', port: 8433, username: 'qa',
    password: 'тестовый пароль', fingerprint }, extra || {});
}

async function login(body) {
  const req = new EventEmitter();
  req.method = 'POST'; req.headers = {}; req.socket = { remoteAddress: '127.0.0.1' };
  const result = { status: 0, headers: {}, body: '' };
  const response = {
    writeHead(status, headers) { result.status = status; result.headers = headers || {}; },
    end(value) { result.body = String(value || ''); },
  };
  const done = remoteaccess.handleAuthRoutes(req, response, '/api/auth/login');
  req.emit('data', Buffer.from(JSON.stringify(body)));
  req.emit('end');
  assert.equal(await done, true);
  return result;
}

test('параллельное сохранение не теряет другое подключение', async () => {
  fs.writeFileSync(remoteclient.FILE, JSON.stringify({ connections: [] }));
  const first = remoteclient.save(connection('Первая панель'));
  const second = remoteclient.save(connection('Вторая панель'));
  assert.equal(pendingProbes.length, 2);
  pendingProbes.shift()();
  assert.equal((await first).ok, true);
  pendingProbes.shift()();
  assert.equal((await second).ok, true);
  assert.deepEqual(remoteclient.list().map((item) => item.name), ['Первая панель', 'Вторая панель']);
});

test('завершившийся probe не воскрешает удалённую панель и не теряет новый пароль', async () => {
  const before = JSON.parse(fs.readFileSync(remoteclient.FILE, 'utf8'));
  const existing = before.connections[0];
  const update = remoteclient.save(connection('Поздняя правка', { id: existing.id, password: '' }));
  remoteclient.remove(existing.id);
  pendingProbes.shift()();
  assert.match((await update).error, /удалено/);
  assert.equal(remoteclient.list().some((item) => item.id === existing.id), false);

  const remaining = JSON.parse(fs.readFileSync(remoteclient.FILE, 'utf8')).connections[0];
  const keepPassword = remoteclient.save(connection('Правка имени', { id: remaining.id, password: '' }));
  const changed = JSON.parse(fs.readFileSync(remoteclient.FILE, 'utf8'));
  changed.connections[0].password = 'более новый тестовый пароль';
  fs.writeFileSync(remoteclient.FILE, JSON.stringify(changed));
  pendingProbes.shift()();
  assert.equal((await keepPassword).ok, true);
  assert.equal(JSON.parse(fs.readFileSync(remoteclient.FILE, 'utf8')).connections[0].password, changed.connections[0].password);
});

test('повреждённые настройки удалёнки не затираются пустыми списками', async () => {
  for (const contents of ['{', 'null', '[]', '{"users":null}', '{"users":[null]}']) {
    fs.writeFileSync(remoteaccess.FILE, contents);
    assert.throws(() => remoteaccess.setPort(8434), (error) => error.status === 503);
    assert.throws(() => remoteaccess.saveUser({ username: 'qa', password: 'тестовый пароль',
      access: { '*': { 'console.view': true } } }), (error) => error.status === 503);
    assert.equal(fs.readFileSync(remoteaccess.FILE, 'utf8'), contents);
    const result = await login({ username: 'qa', password: 'тестовый пароль' });
    assert.equal(result.status, 503);
    assert.doesNotMatch(result.body, /controlgui-remote-config|salt|\.pem/);
  }
  for (const contents of ['{', 'null', '[]', '{"connections":null}', '{"connections":[null]}']) {
    fs.writeFileSync(remoteclient.FILE, contents);
    assert.throws(() => remoteclient.remove('unknown'), (error) => error.status === 503);
    await assert.rejects(remoteclient.save(connection('Не затирать')), (error) => error.status === 503);
    assert.equal(fs.readFileSync(remoteclient.FILE, 'utf8'), contents);
  }
});

test('BOM Windows принимается, временный EACCES не уничтожает настройки', () => {
  fs.writeFileSync(remoteaccess.FILE, '\uFEFF' + JSON.stringify({ users: [] }));
  fs.writeFileSync(remoteclient.FILE, '\uFEFF' + JSON.stringify({ connections: [] }));
  assert.deepEqual(remoteaccess.listUsers(), []);
  assert.deepEqual(remoteclient.list(), []);
  const contents = fs.readFileSync(remoteclient.FILE, 'utf8');
  fs.readFileSync = function denied(file, ...args) {
    if (file === remoteclient.FILE || file === remoteaccess.FILE) {
      throw Object.assign(new Error('EACCES: секретный абсолютный путь'), { code: 'EACCES' });
    }
    return realRead.call(fs, file, ...args);
  };
  try {
    assert.throws(() => remoteaccess.setPort(8434), (error) => error.status === 503);
    assert.throws(() => remoteclient.remove('unknown'), (error) => error.status === 503);
  } finally { fs.readFileSync = realRead; }
  assert.equal(fs.readFileSync(remoteclient.FILE, 'utf8'), contents);
});

test('сбой rename удаляет секретный tmp и сохраняет прежний файл', async () => {
  const before = fs.readFileSync(remoteclient.FILE, 'utf8');
  fs.renameSync = function deniedRename(from, to) {
    if (to === remoteclient.FILE) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    return realRename.call(fs, from, to);
  };
  try {
    const pending = remoteclient.save(connection('Не удалось записать'));
    pendingProbes.shift()();
    await assert.rejects(pending, { code: 'EACCES' });
  } finally { fs.renameSync = realRename; }
  assert.equal(fs.readFileSync(remoteclient.FILE, 'utf8'), before);
  assert.equal(fs.readdirSync(path.dirname(remoteclient.FILE)).some((name) => name.endsWith('.tmp')), false);
});

test('некорректный JSON-тип запроса входа не оставляет необработанное исключение', async () => {
  fs.writeFileSync(remoteaccess.FILE, JSON.stringify({ users: [] }));
  for (const body of [null, [], 1, 'строка']) {
    const result = await login(body);
    assert.equal(result.status, 401);
  }
});

test('недоступный файл закрывает существующую сессию без исключения', async () => {
  remoteaccess.saveUser({ username: 'qa', password: 'тестовый пароль', access: { '*': { 'console.view': true } } });
  const config = JSON.parse(fs.readFileSync(remoteaccess.FILE, 'utf8'));
  config.enabled = true;
  fs.writeFileSync(remoteaccess.FILE, JSON.stringify(config));
  const result = await login({ username: 'qa', password: 'тестовый пароль' });
  assert.equal(result.status, 200);
  const request = { headers: { cookie: result.headers['Set-Cookie'].split(';')[0] } };
  assert.equal(remoteaccess.sessionUserFromReq(request).username, 'qa');
  fs.writeFileSync(remoteaccess.FILE, '{');
  assert.equal(remoteaccess.sessionUserFromReq(request), null);
});

test.after(() => {
  tls.connect = realConnect;
  fs.readFileSync = realRead;
  fs.renameSync = realRename;
  remoteclient.stopAll();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
