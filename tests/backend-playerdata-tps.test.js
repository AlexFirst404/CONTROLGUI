'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const playerdata = require('../lib/playerdata');
const tps = require('../lib/tps');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'controlgui-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function touch(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content == null ? 'x' : content);
}

test('TPS разбирается из Paper, Forge, NeoForge и многострочного ответа', () => {
  assert.deepEqual(tps.parseLine('TPS from last 1m, 5m, 15m: *19.87, 20.0, 20.0'),
    { tps: 19.87, kind: 'rolling' });
  assert.deepEqual(tps.parseLine('Overall: Mean tick time: 12.3 ms. Mean TPS: 18.125'),
    { tps: 18.125, kind: 'overall' });
  assert.deepEqual(tps.parseLine('Dim minecraft:overworld: Mean tick time: 2 ms. Mean TPS: 20.000'),
    { tps: 20, kind: 'dimension' });
  assert.deepEqual(tps.parseLine('TPS from last 5s, 10s, 1m:'), { header: true });
  assert.deepEqual(tps.parseLine('*17,5, 18.0, 19.0', true), { tps: 17.5, kind: 'rolling' });
  assert.equal(tps.isCommandError('Unknown or incomplete command, see below for error at position 0', 'forge tps'), false);
  assert.equal(tps.isCommandError('forge tps<--[HERE]', 'forge tps'), true);
  assert.equal(tps.isCommandError('ban Player<--[HERE]', 'forge tps'), false);
});

test('Команда TPS выбирается по семейству модового ядра', (t) => {
  const paper = tempDir(t);
  assert.deepEqual(tps.commandsFor({ type: 'paper' }, paper), ['tps']);

  const forge = tempDir(t);
  assert.deepEqual(tps.commandsFor({ type: 'forge', jarFile: 'forge-server.jar' }, forge),
    ['forge tps', 'neoforge tps', 'tps']);

  const neo = tempDir(t);
  fs.mkdirSync(path.join(neo, 'libraries', 'net', 'neoforged'), { recursive: true });
  assert.deepEqual(tps.commandsFor({ type: 'forge' }, neo), ['neoforge tps', 'forge tps', 'tps']);

  const arclight = tempDir(t);
  touch(path.join(arclight, 'arclight-forge-1.21.jar'));
  assert.deepEqual(tps.commandsFor({ type: 'forge' }, arclight), ['tps', 'forge tps']);

  const uploadedForge = tempDir(t);
  fs.mkdirSync(path.join(uploadedForge, 'libraries', 'net', 'minecraftforge'), { recursive: true });
  assert.deepEqual(tps.commandsFor({ type: 'custom', jarFile: 'server.jar' }, uploadedForge),
    ['forge tps', 'neoforge tps', 'tps']);

  const uploadedArclight = tempDir(t);
  touch(path.join(uploadedArclight, 'logs', 'latest.log'), '[Server thread/INFO]: Arclight 1.0 is starting');
  assert.deepEqual(tps.commandsFor({ type: 'custom', jarFile: 'server.jar' }, uploadedArclight),
    ['tps', 'forge tps']);
});

test('Удаляются UUID-файлы из всех миров, но не из папок плагинов', (t) => {
  const root = tempDir(t);
  const uuid = '12345678-1234-4234-9234-1234567890ab';
  const compact = uuid.replace(/-/g, '').toUpperCase();
  const other = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const world = path.join(root, 'world');
  const world2 = path.join(root, 'creative');
  touch(path.join(world, 'level.dat'));
  touch(path.join(world2, 'level.dat'));
  const targets = [
    path.join(world, 'playerdata', uuid + '.dat'),
    path.join(world, 'playerdata', uuid + '.dat_old'),
    path.join(world, 'stats', uuid + '.json'),
    path.join(world, 'advancements', uuid + '.json'),
    path.join(world, 'players', 'data', compact + '.dat'),
    path.join(world2, 'stats', uuid + '.json'),
  ];
  for (const file of targets) touch(file);
  const preservedOther = path.join(world, 'stats', other + '.json');
  const preservedPlugin = path.join(root, 'plugins', 'Example', 'stats', uuid + '.json');
  touch(preservedOther);
  touch(preservedPlugin);

  const result = playerdata.removeUuidFiles(root, world, [uuid]);
  assert.equal(result.errors.length, 0);
  assert.equal(result.removed.length, targets.length);
  for (const file of targets) assert.equal(fs.existsSync(file), false, file);
  assert.equal(fs.existsSync(preservedOther), true);
  assert.equal(fs.existsSync(preservedPlugin), true);
  assert.equal(result.worldDirs, 2);
});

test('Явный level-name и Bukkit-миры очищаются до появления level.dat', (t) => {
  const root = tempDir(t);
  const uuid = '12345678-1234-4234-9234-1234567890ab';
  const world = path.join(root, 'custom');
  const nether = path.join(root, 'custom_nether');
  const first = path.join(world, 'playerdata', uuid + '.dat');
  const second = path.join(nether, 'stats', uuid + '.json');
  touch(first);
  touch(second);
  const result = playerdata.removeUuidFiles(root, world, [uuid]);
  assert.equal(result.errors.length, 0);
  assert.equal(fs.existsSync(first), false);
  assert.equal(fs.existsSync(second), false);
});

test('Ошибка одного файла возвращается как частичная и не скрывает остальные удаления', (t) => {
  const root = tempDir(t);
  const uuid = '12345678-1234-4234-9234-1234567890ab';
  const world = path.join(root, 'world');
  touch(path.join(world, 'level.dat'));
  const busy = path.join(world, 'playerdata', uuid + '.dat');
  const removable = path.join(world, 'stats', uuid + '.json');
  touch(busy);
  touch(removable);
  const fakeFs = Object.create(fs);
  fakeFs.unlinkSync = (file) => {
    if (file === busy) throw Object.assign(new Error('занят'), { code: 'EBUSY' });
    return fs.unlinkSync(file);
  };
  const result = playerdata.removeUuidFiles(root, world, [uuid], fakeFs);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, 'EBUSY');
  assert.equal(fs.existsSync(busy), true);
  assert.equal(fs.existsSync(removable), false);
});

test('каждый UUID-файл повторно проходит безопасный резолвер перед удалением', (t) => {
  const root = tempDir(t);
  const uuid = '12345678-1234-4234-9234-1234567890ab';
  const world = path.join(root, 'world');
  touch(path.join(world, 'level.dat'));
  const target = path.join(world, 'playerdata', uuid + '.dat');
  touch(target);
  const checked = [];
  const result = playerdata.removeUuidFiles(root, world, [uuid], null, (rel) => {
    checked.push(rel);
    return path.join(root, rel);
  });
  assert.equal(result.errors.length, 0);
  assert.deepEqual(checked, ['world/playerdata/' + uuid + '.dat']);
  assert.equal(fs.existsSync(target), false);
});

test('usercache очищается и по нику, и по UUID без затрагивания других игроков', () => {
  const uuid = '12345678-1234-4234-9234-1234567890ab';
  const other = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const input = [
    { name: 'Player', uuid },
    { name: 'OldName', uuid: uuid.replace(/-/g, '') },
    { name: 'Other', uuid: other },
  ];
  const result = playerdata.filterUserCache(input, 'player', [uuid]);
  assert.equal(result.removed, 2);
  assert.deepEqual(result.cache, [{ name: 'Other', uuid: other }]);
});

test('история панели удаляется атомарно по нику и прежнему UUID', (t) => {
  const root = tempDir(t);
  const previousData = process.env.CONTROLGUI_DATA;
  process.env.CONTROLGUI_DATA = root;
  t.after(() => {
    if (previousData === undefined) delete process.env.CONTROLGUI_DATA;
    else process.env.CONTROLGUI_DATA = previousData;
  });
  // manager загружается здесь впервые, чтобы paths увидел изолированный каталог теста.
  const manager = require('../lib/manager');
  const serverId = 'history-test';
  const dir = path.join(root, 'servers', serverId);
  fs.mkdirSync(dir, { recursive: true });
  const uuid = '12345678-1234-4234-9234-1234567890ab';
  const file = path.join(dir, 'panel-players.json');
  fs.writeFileSync(file, JSON.stringify({
    player: { name: 'Player', uuid, ips: ['127.0.0.1'] },
    oldname: { name: 'OldName', uuid, ips: [] },
    other: { name: 'Other', uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ips: [] },
  }));
  assert.equal(manager.historyView(serverId).length, 3);
  assert.equal(manager.removeHistory(serverId, 'Player', [uuid]).removed, 2);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(saved), ['other']);
  assert.equal(fs.readdirSync(dir).some((name) => name.endsWith('.tmp')), false);
  manager.dropState(serverId);
  fs.writeFileSync(file, '{повреждено');
  assert.deepEqual(manager.historyView(serverId), []);
  assert.throws(() => manager.removeHistory(serverId, 'Player', [uuid]));
  manager.dropState(serverId);
});
