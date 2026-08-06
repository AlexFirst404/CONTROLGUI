'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

/* Отдельный test-файл Node запускает в своём процессе: временный DATA_ROOT не
   затрагивает реальные серверы, Java и сохранённые удалённые подключения. */
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'controlgui-java-remote-test-'));
process.env.CONTROLGUI_DATA = dataRoot;

const remoteclient = require('../lib/remoteclient');

test('сетевой retry разрешён только для чтения до получения заголовков', () => {
  const { isSafeRetryMethod, canRetryNetwork } = remoteclient._test;
  for (const method of ['GET', 'get', 'HEAD', 'OPTIONS']) {
    assert.equal(isSafeRetryMethod(method), true, method);
    assert.equal(canRetryNetwork(method, { code: 'ECONNRESET' }, false), true, method);
  }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal(isSafeRetryMethod(method), false, method);
    assert.equal(canRetryNetwork(method, { code: 'ECONNRESET' }, false), false, method);
  }
  assert.equal(canRetryNetwork('GET', { code: 'ECONNRESET' }, true), false,
    'после заголовков повтор мог бы смешать два ответа');
  assert.equal(canRetryNetwork('GET', { code: 'CERT_HAS_EXPIRED' }, false), false,
    'ошибки TLS и пиннинга повторять нельзя');
  assert.equal(canRetryNetwork('GET', new Error('обычная ошибка'), false), false);
});

test('ручная установка Java пропускает скачивание, если нужный major уже есть на ПК', () => {
  const javasId = require.resolve('../lib/javas');
  const downloadId = require.resolve('../lib/download');
  const installId = require.resolve('../lib/javainstall');
  const oldJavas = require.cache[javasId];
  const oldDownload = require.cache[downloadId];
  const oldInstall = require.cache[installId];
  let clearCalls = 0;
  const findCalls = [];
  let downloadCalls = 0;

  require.cache[javasId] = {
    id: javasId, filename: javasId, loaded: true,
    exports: {
      clearCache() { clearCalls += 1; },
      findJava(major) { findCalls.push(major); return 'C:\\Java\\jdk-21\\bin\\java.exe'; },
    },
  };
  require.cache[downloadId] = {
    id: downloadId, filename: downloadId, loaded: true,
    exports: { downloadFile() { downloadCalls += 1; throw new Error('скачивание не должно начаться'); } },
  };
  delete require.cache[installId];

  try {
    const javainstall = require('../lib/javainstall');
    const state = javainstall.installJava(21);
    assert.equal(state.phase, 'done');
    assert.equal(state.major, 21);
    assert.equal(state.progress, 1);
    assert.equal(state.path, 'C:\\Java\\jdk-21\\bin\\java.exe');
    assert.equal(clearCalls, 1);
    assert.deepEqual(findCalls, [21]);
    assert.equal(downloadCalls, 0);
  } finally {
    if (oldJavas) require.cache[javasId] = oldJavas; else delete require.cache[javasId];
    if (oldDownload) require.cache[downloadId] = oldDownload; else delete require.cache[downloadId];
    if (oldInstall) require.cache[installId] = oldInstall; else delete require.cache[installId];
  }
});

test.after(() => {
  remoteclient.stopAll();
  fs.rmSync(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
