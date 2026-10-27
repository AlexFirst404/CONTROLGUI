'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

global.__controlguiSkipDataInit = true;
const { createTracker } = require('../lib/serverstats');
const DAY = 86400000;
const BASE = Date.UTC(2026, 9, 27, 10);

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'controlgui-statistics-'));
  let now = BASE;
  const messages = [];
  const options = { root, now: () => now, log: (message) => messages.push(message) };
  const tracker = createTracker(options);
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('controlgui-statistics-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, tracker, messages, options, at(value) { now = BASE + value; }, now() { return now; } };
}

test('средний онлайн взвешен по времени, ноль учитывается, запуск до готовности не искажает его', (t) => {
  const f = fixture(t);
  const tracker = f.tracker;
  tracker.begin('server', { pid: 123 });
  f.at(20000);
  tracker.observe('server', 0);
  f.at(30000);
  tracker.observe('server', 4);
  f.at(60000);
  tracker.observe('server', 0);
  f.at(80000);
  tracker.stop('server');
  const stats = tracker.getStatistics('server', 0);
  assert.equal(stats.lifetime.uptimeMs, 80000);
  assert.equal(stats.lifetime.onlineObservedMs, 60000);
  assert.equal(stats.lifetime.averagePlayers, 2);
  assert.equal(stats.lifetime.playerHours, 120000 / 3600000);
  assert.equal(stats.lifetime.starts, 1);
  assert.equal(stats.lifetime.longestSessionMs, 80000);
  assert.equal(stats.lifetime.peakPlayers, 4);
  assert.equal(stats.lifetime.peakPlayersAt, BASE + 30000);
  assert.equal(stats.current.running, false);
  assert.equal(stats.current.players, null);
});

test('пик фиксируется при входе, одинаковый пик сохраняет первое время, сирота имеет неизвестный онлайн', (t) => {
  const f = fixture(t);
  f.tracker.begin('zero', { pid: 1 });
  f.tracker.observe('zero', 0);
  f.at(10000);
  assert.equal(f.tracker.getStatistics('zero').summary.averagePlayers, 0);
  f.tracker.observe('zero', 3);
  f.at(20000);
  f.tracker.observe('zero', 3);
  assert.equal(f.tracker.getStatistics('zero').summary.peakPlayersAt, BASE + 10000);
  f.tracker.begin('orphan', { pid: 2, orphan: true });
  f.at(30000);
  f.tracker.observe('orphan', 20);
  const stats = f.tracker.getStatistics('orphan');
  assert.equal(stats.current.orphan, true);
  assert.equal(stats.current.playersKnown, false);
  assert.equal(stats.current.players, null);
  assert.equal(stats.summary.averagePlayers, null);
  assert.equal(stats.summary.peakPlayers, null);
  assert.equal(stats.summary.starts, 0);
  assert.equal(stats.summary.uptimeMs, 10000);
});

test('перезапуск панели не добавляет неизвестный промежуток и не считает усыновление новым запуском', (t) => {
  const f = fixture(t);
  f.tracker.begin('server', { pid: 42 });
  f.tracker.observe('server', 2);
  f.at(30000);
  f.tracker.flush();
  f.at(3600000);
  const restored = createTracker(f.options);
  assert.equal(restored.getStatistics('server', 0).lifetime.uptimeMs, 30000);
  restored.begin('server', { pid: 42, orphan: true });
  f.at(3610000);
  restored.observe('server', null);
  const stats = restored.getStatistics('server', 0);
  assert.equal(stats.lifetime.starts, 1);
  assert.equal(stats.lifetime.uptimeMs, 40000);
  assert.equal(stats.lifetime.onlineObservedMs, 30000);
  assert.equal(stats.lifetime.averagePlayers, 2);
  assert.equal(stats.current.uptimeMs, 40000);
  assert.equal(stats.current.startedAt, BASE);
  assert.equal(stats.current.players, null);
  assert.equal(stats.collectedSince, BASE);
});

test('UTC-полночь делит время и player-hours между сутками без потерь', (t) => {
  const f = fixture(t);
  const midnight = Date.UTC(2026, 9, 28);
  f.at(midnight - BASE - 10000);
  f.tracker.begin('server', { pid: 1 });
  f.tracker.observe('server', 6);
  f.at(midnight - BASE + 20000);
  f.tracker.stop('server');
  const stats = f.tracker.getStatistics('server', 7);
  assert.equal(stats.timeZone, 'UTC');
  assert.deepEqual(stats.daily.map((row) => [row.date, row.uptimeMs, row.starts]), [
    ['2026-10-27', 10000, 1], ['2026-10-28', 20000, 0],
  ]);
  assert.equal(stats.summary.uptimeMs, 30000);
  assert.equal(stats.summary.averagePlayers, 6);
  assert.equal(stats.summary.playerHours, 180000 / 3600000);
});

test('дневная история ограничена годом, lifetime не обрезается, период включает нужные календарные дни', (t) => {
  const f = fixture(t);
  for (let i = 0; i < 400; i++) {
    f.at(i * DAY);
    f.tracker.begin('server', { pid: i + 1 });
    f.tracker.observe('server', i);
    f.at(i * DAY + 10000);
    f.tracker.stop('server');
  }
  const all = f.tracker.getStatistics('server', 0);
  assert.equal(all.daily.length, 366);
  assert.equal(all.lifetime.starts, 400);
  assert.equal(all.lifetime.uptimeMs, 4000000);
  assert.equal(all.summary.uptimeMs, 4000000);
  const week = f.tracker.getStatistics('server', 7);
  assert.equal(week.daily.length, 7);
  assert.equal(week.summary.starts, 7);
  assert.equal(week.summary.uptimeMs, 70000);
  assert.equal(week.summary.peakPlayers, 399);
  assert.equal(week.lifetime.starts, 400);
  const saved = JSON.parse(fs.readFileSync(path.join(f.root, 'server.json'), 'utf8'));
  assert.equal(Object.keys(saved.daily).length, 366);
});

test('кэш остановленного сервера тоже удаляет суточные записи старше срока хранения', (t) => {
  const f = fixture(t);
  f.tracker.begin('server', { pid: 1 });
  f.at(10000);
  f.tracker.stop('server');
  assert.equal(f.tracker.getStatistics('server', 0).daily.length, 1);
  f.at(400 * DAY);
  const stats = f.tracker.getStatistics('server', 0);
  assert.equal(stats.daily.length, 0);
  assert.equal(stats.lifetime.uptimeMs, 10000);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(f.root, 'server.json'), 'utf8')).daily).length, 0);
});

test('пауза часов/сна не достраивает часы фиктивного онлайна', (t) => {
  const f = fixture(t);
  f.tracker.begin('server', { pid: 1 });
  f.tracker.observe('server', 10);
  f.at(4 * 3600000);
  const stats = f.tracker.getStatistics('server', 0);
  assert.equal(stats.lifetime.uptimeMs, 60000);
  assert.equal(stats.lifetime.onlineObservedMs, 60000);
  assert.equal(stats.lifetime.averagePlayers, 10);
});

test('сохранение атомарно, heartbeat не пишет каждые 15 секунд, remove удаляет только выбранный сервер', (t) => {
  const f = fixture(t);
  let writes = 0;
  const realWrite = fs.writeFileSync;
  fs.writeFileSync = (file, ...args) => { if (String(file).startsWith(f.root + path.sep)) writes++; return realWrite(file, ...args); };
  t.after(() => { fs.writeFileSync = realWrite; });
  f.tracker.begin('server', { pid: 1 });
  assert.equal(writes, 1);
  for (let i = 1; i <= 3; i++) { f.at(i * 15000); f.tracker.observe('server', 0); }
  assert.equal(writes, 1);
  f.at(60000);
  f.tracker.observe('server', 0);
  assert.equal(writes, 2);
  f.tracker.stop('server');
  assert.equal(writes, 3);
  assert.equal(fs.readdirSync(f.root).some((name) => name.endsWith('.tmp')), false);
  f.tracker.begin('other', { pid: 2 });
  f.tracker.remove('server');
  assert.equal(fs.existsSync(path.join(f.root, 'server.json')), false);
  assert.equal(fs.existsSync(path.join(f.root, 'other.json')), true);
  assert.throws(() => f.tracker.remove('../other'));
});

test('повреждённый файл не перезаписывается нулевой статистикой, API не раскрывает пути/служебную сессию', (t) => {
  const f = fixture(t);
  const source = '{повреждено';
  const file = path.join(f.root, 'server.json');
  fs.writeFileSync(file, source);
  f.tracker.begin('server', { pid: 123 });
  f.tracker.observe('server', 2);
  f.at(10000);
  f.tracker.stop('server');
  const stats = f.tracker.getStatistics('server');
  assert.equal(stats.persistenceError, true);
  assert.equal(fs.readFileSync(file, 'utf8'), source);
  assert.equal(f.messages.length, 1);
  assert.doesNotMatch(JSON.stringify(stats), /controlgui-statistics|\.json|"pid"|playerMs/);
  assert.throws(() => f.tracker.getStatistics('server', 100));
  assert.throws(() => f.tracker.getStatistics('bad:id', 7));
});

test('повторные GET не удваивают время, повторный begin не создаёт фиктивный запуск, longest выбирает длинную сессию', (t) => {
  const f = fixture(t);
  f.tracker.begin('server', { pid: 1 });
  f.tracker.observe('server', 0);
  f.at(30000);
  assert.equal(f.tracker.getStatistics('server', 0).summary.uptimeMs, 30000);
  assert.equal(f.tracker.getStatistics('server', 0).summary.uptimeMs, 30000);
  f.tracker.begin('server', { pid: 1 });
  f.at(40000);
  f.tracker.stop('server');
  f.at(100000);
  f.tracker.begin('server', { pid: 2 });
  f.at(110000);
  f.tracker.stop('server');
  const stats = f.tracker.getStatistics('server', 0);
  assert.equal(stats.lifetime.starts, 2);
  assert.equal(stats.lifetime.uptimeMs, 50000);
  assert.equal(stats.lifetime.longestSessionMs, 40000);
});

test('временная ошибка записи сохраняет старый файл и повторяется при следующем checkpoint', (t) => {
  const f = fixture(t);
  f.tracker.begin('server', { pid: 1 });
  const file = path.join(f.root, 'server.json');
  const before = fs.readFileSync(file, 'utf8');
  const realRename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === file) throw Object.assign(new Error('Временно занят'), { code: 'EBUSY' });
    return realRename(from, to);
  };
  try {
    f.at(60000);
    f.tracker.observe('server', 0);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal(f.tracker.getStatistics('server', 0).persistenceError, true);
    assert.equal(fs.readdirSync(f.root).some((name) => name.endsWith('.tmp')), false);
  } finally { fs.renameSync = realRename; }
  f.at(120000);
  f.tracker.observe('server', 0);
  assert.equal(f.tracker.getStatistics('server', 0).persistenceError, false);
  const restored = createTracker(f.options).getStatistics('server', 0);
  assert.equal(restored.lifetime.uptimeMs, 120000);
});

test('временный EACCES чтения повторяется без перезапуска и объединяет старую историю с новыми наблюдениями', (t) => {
  const f = fixture(t);
  f.tracker.begin('server', { pid: 1 });
  f.tracker.observe('server', 4);
  f.at(10000);
  f.tracker.stop('server');
  const file = path.join(f.root, 'server.json');
  const realRead = fs.readFileSync;
  let fail = true;
  fs.readFileSync = (name, ...args) => {
    if (String(name) === file && fail) throw Object.assign(new Error('Временно недоступен'), { code: 'EACCES' });
    return realRead(name, ...args);
  };
  try {
    const restored = createTracker(f.options);
    f.at(20000);
    restored.begin('server', { pid: 2 });
    restored.observe('server', 2);
    f.at(40000);
    restored.observe('server', 2);
    assert.equal(restored.getStatistics('server', 0).persistenceError, true);
    fail = false;
    f.at(80000);
    const stats = restored.getStatistics('server', 0);
    assert.equal(stats.persistenceError, false);
    assert.equal(stats.lifetime.starts, 2);
    assert.equal(stats.lifetime.uptimeMs, 70000);
    assert.equal(stats.lifetime.averagePlayers, 160000 / 70000);
    assert.equal(stats.lifetime.peakPlayers, 4);
    assert.equal(stats.lifetime.peakPlayersAt, BASE);
    assert.equal(stats.current.running, true);
    assert.equal(stats.current.uptimeMs, 60000);
    const disk = createTracker(f.options).getStatistics('server', 0);
    assert.equal(disk.lifetime.uptimeMs, 70000);
    assert.equal(disk.lifetime.starts, 2);
  } finally { fs.readFileSync = realRead; }
});

test('восстановление чтения объединяет длинную orphan-сессию даже после её остановки', (t) => {
  const f = fixture(t);
  f.tracker.begin('server', { pid: 42 });
  f.at(60000);
  f.tracker.flush();
  const file = path.join(f.root, 'server.json');
  const realRead = fs.readFileSync;
  let fail = true;
  fs.readFileSync = (name, ...args) => {
    if (String(name) === file && fail) throw Object.assign(new Error('Временно занят'), { code: 'EBUSY' });
    return realRead(name, ...args);
  };
  try {
    const restored = createTracker(f.options);
    restored.begin('server', { pid: 42, orphan: true });
    f.at(90000);
    restored.stop('server');
    fail = false;
    f.at(130000);
    const stats = restored.getStatistics('server', 0);
    assert.equal(stats.lifetime.uptimeMs, 90000);
    assert.equal(stats.lifetime.longestSessionMs, 90000);
    assert.equal(stats.lifetime.starts, 1);
    assert.equal(stats.current.running, false);
    assert.equal(stats.persistenceError, false);
    assert.equal(createTracker(f.options).getStatistics('server', 0).lifetime.longestSessionMs, 90000);
  } finally { fs.readFileSync = realRead; }
});

test('manager учитывает настоящий spawn, готовность, join/leave и exit без открытой консоли', (t) => {
  const f = fixture(t);
  const code = String.raw`
    const assert = require('node:assert/strict');
    const fs = require('fs'), path = require('path');
    const cp = require('child_process');
    const { EventEmitter } = require('events');
    const { PassThrough } = require('stream');
    let now = Date.UTC(2026, 9, 27, 10);
    const base = now;
    Date.now = () => now;
    const children = [];
    cp.spawnSync = () => ({ stdout: '' });
    cp.spawn = () => {
      const child = new EventEmitter();
      child.pid = 54321 + children.length;
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
      children.push(child);
      return child;
    };
    const manager = require('./lib/manager');
    const store = require('./lib/store');
    const statistics = require('./lib/serverstats');
    function server(id, type) {
      const dir = path.join(process.env.CONTROLGUI_DATA, 'servers', id);
      fs.mkdirSync(dir, {recursive:true});
      fs.writeFileSync(path.join(dir, 'server.jar'), 'тест');
      const value = {id, type, name:id, version:'-', port:25565 + children.length,
        javaPath:process.execPath, memoryMb:512, launch:{mode:'jar',target:'server.jar'}};
      store.add(value); return value;
    }
    const a = server('normal', 'custom');
    manager.start(a, true);
    const child = children[0];
    assert.equal(statistics.getStatistics(a.id, 0).lifetime.starts, 0);
    child.emit('spawn');
    now = base + 10000;
    child.stdout.emit('data', Buffer.from('[Server thread/INFO]: Done (1s)!\n'.replace('\\n', '\n')));
    now = base + 20000;
    child.stdout.emit('data', Buffer.from('[Server thread/INFO]: Alex joined the game\n'.replace('\\n', '\n')));
    now = base + 40000;
    child.stdout.emit('data', Buffer.from('[Server thread/INFO]: Alex left the game\n'.replace('\\n', '\n')));
    now = base + 50000;
    child.emit('exit', 0, null);
    const stats = statistics.getStatistics(a.id, 0);
    assert.equal(stats.lifetime.starts, 1);
    assert.equal(stats.lifetime.uptimeMs, 50000);
    assert.equal(stats.lifetime.onlineObservedMs, 40000);
    assert.equal(stats.lifetime.averagePlayers, 0.5);
    assert.equal(stats.lifetime.peakPlayers, 1);
    assert.equal(stats.lifetime.peakPlayersAt, base + 20000);
    assert.equal(stats.current.running, false);
    const proxy = server('proxy', 'bungeecord');
    manager.start(proxy, true);
    children[1].emit('spawn');
    children[1].stdout.emit('data', Buffer.from('[Server thread/INFO]: Done (1s)!\n'.replace('\\n', '\n')));
    now += 10000;
    assert.equal(statistics.getStatistics(proxy.id, 0).lifetime.averagePlayers, null);
    children[1].emit('exit', 0, null);
    const failed = server('failed', 'custom');
    manager.start(failed, true);
    children[2].emit('error', Object.assign(new Error('не запустился'), {code:'ENOENT'}));
    assert.equal(statistics.getStatistics(failed.id, 0).lifetime.starts, 0);
    assert.equal(statistics.getStatistics(failed.id, 0).lifetime.uptimeMs, 0);
    // Ошибка нового сборщика не вправе ломать основной lifecycle JVM.
    console.error = () => {};
    for (const method of ['begin', 'observe', 'stop']) {
      statistics[method] = () => { throw new Error('Ошибка статистики'); };
    }
    const resilient = server('resilient', 'custom');
    manager.start(resilient, true);
    children[3].emit('spawn');
    children[3].stdout.emit('data', Buffer.from('[Server thread/INFO]: Done (1s)!\n'.replace('\\n', '\n')));
    children[3].emit('exit', 0, null);
    assert.equal(manager.getState(resilient.id).proc, null);
    assert.equal(manager.getState(resilient.id).status, 'stopped');
    assert.equal(store.get(resilient.id).pid, null);
    const registryFailure = server('registry-failure', 'custom');
    store.update = () => { throw Object.assign(new Error('Диск недоступен'), { code:'ENOSPC' }); };
    manager.start(registryFailure, true);
    children[4].emit('spawn');
    children[4].stdout.emit('data', Buffer.from('[Server thread/INFO]: Done (1s)!\n'.replace('\\n', '\n')));
    children[4].stdout.emit('data', Buffer.from('[Server thread/INFO]: Alex joined the game\n'.replace('\\n', '\n')));
    assert.equal(manager.getState(registryFailure.id).players.size, 1);
    children[4].emit('exit', 0, null);
    assert.equal(manager.getState(registryFailure.id).proc, null);
    assert.equal(manager.getState(registryFailure.id).status, 'stopped');
    assert.equal(manager.getState(registryFailure.id).players.size, 0);
    assert.ok(manager.getState(registryFailure.id).console.some(line => /Не удалось сохранить PID/.test(line)));
  `;
  const output = execFileSync(process.execPath, ['-e', code], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, CONTROLGUI_DATA: path.join(f.root, 'panel') },
    encoding: 'utf8', timeout: 10000,
  });
  assert.equal(output, '');
});
