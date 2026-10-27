'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Исполняем настоящую функцию SPA в изолированном окружении: управляемые
// ответы воспроизводят медленную удалёнку без сетевых задержек и реальных данных.
const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
const start = source.indexOf('  async function refreshServer() {');
const end = source.indexOf('  function renderServerHead()', start);
assert.ok(start >= 0 && end > start);

function deferred() {
  let resolve, reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function fixture() {
  const pending = [];
  const toasts = [];
  const state = { screen: 'server', currentId: 'a', currentTab: 'info', current: { id: 'a' }, servers: [{ id: 'a' }, { id: 'b' }] };
  const context = vm.createContext({ state,
    API: { server(id) { const next = deferred(); pending.push({ id, ...next }); return next.promise; } },
    tabAllowed: () => true, switchTab: async () => {}, firstAllowedTab: () => 'info',
    renderServerHead: () => {}, loadStats: () => {}, loadStatistics: () => {}, renderPlayers: () => {},
    showToast: (text) => toasts.push(text), showScreen: (screen) => { state.screen = screen; }, renderList: () => {},
  });
  vm.runInContext(source.slice(start, end) + '\nthis.refresh = refreshServer;', context);
  return { state, pending, toasts, refresh: context.refresh };
}

test('медленный опрос не отменяется каждым новым тиком и не создаёт параллельные запросы', async () => {
  const f = fixture();
  const first = f.refresh();
  await f.refresh();
  await f.refresh();
  assert.equal(f.pending.length, 1);
  f.pending[0].resolve({ id: 'a', name: 'Свежий ответ' });
  await first;
  assert.equal(f.state.current.name, 'Свежий ответ');
  assert.equal(f.state.serverRefreshRequest, null);
  const next = f.refresh();
  assert.equal(f.pending.length, 2);
  f.pending[1].resolve({ id: 'a', name: 'Следующий ответ' });
  await next;
  assert.equal(f.state.current.name, 'Следующий ответ');
});

test('краткий сетевой сбой сохраняет экран и не повторяет уведомление до восстановления', async () => {
  const f = fixture();
  for (let i = 0; i < 2; i++) {
    const request = f.refresh();
    f.pending[i].reject(new Error('ECONNRESET'));
    await request;
    assert.equal(f.state.screen, 'server');
    assert.equal(f.state.currentId, 'a');
  }
  assert.equal(f.toasts.length, 1);
  const success = f.refresh();
  f.pending[2].resolve({ id: 'a', name: 'Связь восстановлена' });
  await success;
  assert.equal(f.state.serverRefreshErrorShown, false);
});

test('старый ответ не меняет новый сервер и не снимает блокировку его запроса', async () => {
  const f = fixture();
  const first = f.refresh();
  f.state.currentId = 'b';
  f.state.serverRefreshSeq += 1;
  f.state.serverRefreshRequest = null;
  const second = f.refresh();
  f.pending[0].resolve({ id: 'a', name: 'Устаревший' });
  await first;
  assert.equal(f.state.serverRefreshRequest.id, 'b');
  f.pending[1].resolve({ id: 'b', name: 'Нужный' });
  await second;
  assert.equal(f.state.current.id, 'b');
  assert.equal(f.state.serverRefreshRequest, null);
});

test('подтверждённое удаление сервера по-прежнему возвращает к списку', async () => {
  const f = fixture();
  const request = f.refresh();
  f.pending[0].reject(Object.assign(new Error('Сервер удалён'), { status: 404 }));
  await request;
  assert.equal(f.state.screen, 'list');
  assert.equal(f.state.servers.some((server) => server.id === 'a'), false);
});
