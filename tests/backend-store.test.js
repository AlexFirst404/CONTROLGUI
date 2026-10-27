'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'controlgui-store-test-'));
process.env.CONTROLGUI_DATA = root;
const { REGISTRY_FILE } = require('../lib/paths');
const storeId = require.resolve('../lib/store');
const originalRead = fs.readFileSync;

function freshStore() {
  delete require.cache[storeId];
  return require('../lib/store');
}

test('отсутствующий реестр создаётся штатно, а BOM Windows сохраняет серверы', () => {
  const store = freshStore();
  assert.deepEqual(store.all(), []);
  store.add({ id: 'existing', name: 'Существующий сервер' });
  assert.equal(JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8')).servers.length, 1);
  const text = '\uFEFF' + JSON.stringify({ servers: [{ id: 'legacy-id', name: 'Сервер с BOM' }], extra: 'сохранить' });
  fs.writeFileSync(REGISTRY_FILE, text);
  const reloaded = freshStore();
  assert.equal(reloaded.all()[0].name, 'Сервер с BOM');
  reloaded.update('legacy-id', { name: 'Новое имя' });
  const saved = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
  assert.equal(saved.extra, 'сохранить');
  assert.equal(saved.servers[0].id, 'legacy-id');
});

test('повреждённый или неизвестный формат не заменяется пустым реестром', () => {
  for (const contents of ['{"servers":[', 'null', '[]', '{}', '{"servers":null}', '{"servers":[null]}']) {
    fs.writeFileSync(REGISTRY_FILE, contents);
    const store = freshStore();
    assert.throws(() => store.all(), (error) => error.status === 503);
    assert.throws(() => store.add({ id: 'new', name: 'Не должен сохраниться' }),
      (error) => error.status === 503);
    assert.equal(fs.readFileSync(REGISTRY_FILE, 'utf8'), contents);
    assert.equal(fs.readdirSync(path.dirname(REGISTRY_FILE)).some((name) => name.endsWith('.tmp')), false);
    // После ручного исправления или восстановления доступа повторный запрос
    // обязан перечитать диск, а не сохранить ранее закэшированную пустоту.
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify({ servers: [{ id: 'restored' }] }));
    assert.equal(store.get('restored').id, 'restored');
  }
});

test('временный отказ чтения не прячет серверы и не портит исходный файл', () => {
  const contents = JSON.stringify({ servers: [{ id: 'kept', name: 'Сохранённый сервер' }] });
  fs.writeFileSync(REGISTRY_FILE, contents);
  const store = freshStore();
  fs.readFileSync = function temporarilyDenied(file, ...args) {
    if (file === REGISTRY_FILE) throw Object.assign(new Error('EACCES: служебный путь'), { code: 'EACCES' });
    return originalRead.call(fs, file, ...args);
  };
  try {
    assert.throws(() => store.add({ id: 'new' }), (error) => {
      assert.equal(error.status, 503);
      assert.doesNotMatch(error.message, /служебный путь|controlgui-store-test/);
      return true;
    });
  } finally {
    fs.readFileSync = originalRead;
  }
  assert.equal(fs.readFileSync(REGISTRY_FILE, 'utf8'), contents);
  assert.equal(store.all().length, 1);
  assert.equal(store.get('kept').name, 'Сохранённый сервер');
});

test.after(() => {
  fs.readFileSync = originalRead;
  delete require.cache[storeId];
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
