'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

/* Каждый test-файл Node запускает в отдельном процессе. Поэтому DATA_ROOT можно
   безопасно направить во временный каталог до первой загрузки модулей панели. */
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'controlgui-restore-test-'));
process.env.CONTROLGUI_DATA = dataRoot;

/* На реальной Windows-машине bsdtar вернул код 1 при ENOSPC. Обёртка подменяет
   exit code защитного снимка, не заполняя диск; Node сам пишет gzip из stdout. */
const realSpawn = childProcess.spawn;
const realStatfsSync = fs.statfsSync;
const realMkdirSync = fs.mkdirSync;
const realRenameSync = fs.renameSync;
let forcedBeforeRestoreFailure = null;
childProcess.spawn = function spawnWithIncompleteBeforeRestore(file, args, options) {
  const child = realSpawn(file, args, options);
  const createsArchive = Array.isArray(args) && args[0] === '-cf' && args[1] === '-';
  const mode = forcedBeforeRestoreFailure;
  if (!mode || !createsArchive) return child;

  const proxy = new EventEmitter();
  const stderr = new PassThrough();
  proxy.stderr = stderr;
  proxy.stdout = child.stdout;
  proxy.stdin = child.stdin;
  proxy.pid = child.pid;
  proxy.kill = (...killArgs) => child.kill(...killArgs);
  child.stderr.on('data', (chunk) => stderr.write(chunk));
  child.on('error', (error) => proxy.emit('error', error));
  child.on('exit', (code, signal) => {
    stderr.write(mode === 'enospc'
      ? 'tar: No space left on device\n'
      : 'tar: часть файлов не удалось прочитать\n');
    stderr.end();
    setImmediate(() => {
      const forcedCode = code === 0 ? 1 : code;
      proxy.emit('exit', forcedCode, signal);
      proxy.emit('close', forcedCode, signal);
    });
  });
  return proxy;
};

const backups = require('../lib/backups');
const manager = require('../lib/manager');

test.after(() => {
  childProcess.spawn = realSpawn;
  fs.statfsSync = realStatfsSync;
  fs.mkdirSync = realMkdirSync;
  fs.renameSync = realRenameSync;
  fs.rmSync(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function uniqueId(label) {
  return label + '-' + crypto.randomBytes(5).toString('hex');
}

async function fixture(label) {
  const id = uniqueId(label);
  const server = { id, name: label, type: 'paper', port: 25600 };
  const dir = path.join(dataRoot, 'servers', id);
  fs.mkdirSync(dir, { recursive: true });
  write(path.join(dir, 'server.properties'), 'server-port=25565\nmotd=Из бэкапа\n');
  write(path.join(dir, 'world', 'level.dat'), 'старый-мир');
  write(path.join(dir, 'only-in-backup.txt'), 'исходное содержимое');
  const source = await backups.createBackup(server, 'source');

  write(path.join(dir, 'server.properties'), 'server-port=25599\nmotd=Текущее состояние\n');
  write(path.join(dir, 'world', 'level.dat'), 'текущий-мир');
  fs.rmSync(path.join(dir, 'only-in-backup.txt'));
  write(path.join(dir, 'only-current.txt'), 'нельзя потерять при ошибке');
  return { id, server, dir, source };
}

function assertRestoreUnlocked(id) {
  assert.equal(manager.isRestoring(id), false, 'флаг restoring должен быть снят');
  manager.beginRestore(id);
  assert.equal(manager.isRestoring(id), true, 'после ошибки допустима повторная попытка');
  manager.endRestore(id, false);
}

function assertNoRestoreTemps(item) {
  const siblings = fs.readdirSync(path.dirname(item.dir));
  assert.equal(siblings.some((name) => name.startsWith('.' + item.id + '.controlgui-')), false,
    'staging/rollback не должны оставаться рядом с сервером');
  const backupDir = path.join(dataRoot, 'backups', item.id);
  assert.equal(fs.readdirSync(backupDir).some((name) => name.endsWith('.tmp')), false,
    'частичный архив не должен оставаться после ошибки');
}

test('успешное восстановление атомарно меняет каталог и снимает блокировку', async () => {
  const item = await fixture('restore-ok');
  await backups.restoreBackup(item.server, item.source.name);

  assert.equal(fs.readFileSync(path.join(item.dir, 'world', 'level.dat'), 'utf8'), 'старый-мир');
  assert.equal(fs.readFileSync(path.join(item.dir, 'only-in-backup.txt'), 'utf8'), 'исходное содержимое');
  assert.equal(fs.existsSync(path.join(item.dir, 'only-current.txt')), false);
  const restoredProperties = fs.readFileSync(path.join(item.dir, 'server.properties'), 'utf8');
  assert.match(restoredProperties, /(?:^|\n)server-port=25600(?:\n|$)/);
  assert.match(manager.getState(item.id).console.join('\n'), /Восстановлен бэкап:/);
  assertRestoreUnlocked(item.id);
  assertNoRestoreTemps(item);
  manager.dropState(item.id);
});

test('нехватка места обнаруживается до защитного бэкапа и всегда снимает блокировку', async () => {
  const item = await fixture('restore-no-space-preflight');
  const backupsBefore = backups.listBackups(item.id).map((entry) => entry.name).sort();
  fs.statfsSync = () => ({ bavail: 0n, bfree: 0n, bsize: 4096n, frsize: 4096n });
  let error;
  try {
    await backups.restoreBackup(item.server, item.source.name);
  } catch (caught) {
    error = caught;
  } finally {
    fs.statfsSync = realStatfsSync;
  }

  assert.ok(error);
  assert.equal(error.status, 507);
  assert.match(error.message, /недостаточно свободного места/i);
  assert.deepEqual(backups.listBackups(item.id).map((entry) => entry.name).sort(), backupsBefore,
    'при проваленном preflight защитный архив вообще не должен создаваться');
  assert.equal(fs.readFileSync(path.join(item.dir, 'world', 'level.dat'), 'utf8'), 'текущий-мир');
  assert.match(manager.getState(item.id).console.join('\n'), /Восстановление не выполнено/i);
  assertRestoreUnlocked(item.id);
  assertNoRestoreTemps(item);
  manager.dropState(item.id);
});

test('повреждённый выбранный архив не меняет сервер и объясняет отказ', async () => {
  const item = await fixture('restore-corrupted-source');
  const sourceFile = path.join(dataRoot, 'backups', item.id, item.source.name);
  const sourceSize = fs.statSync(sourceFile).size;
  fs.truncateSync(sourceFile, Math.max(1, Math.floor(sourceSize / 2)));
  let error;
  try {
    await backups.restoreBackup(item.server, item.source.name);
  } catch (caught) {
    error = caught;
  }

  assert.ok(error);
  assert.equal(error.status, 400);
  assert.match(error.message, /повреждён|недоступен/i);
  assert.equal(fs.readFileSync(path.join(item.dir, 'world', 'level.dat'), 'utf8'), 'текущий-мир');
  assert.equal(fs.readFileSync(path.join(item.dir, 'only-current.txt'), 'utf8'),
    'нельзя потерять при ошибке');
  assert.match(manager.getState(item.id).console.join('\n'), /Восстановление не выполнено/i);
  assertRestoreUnlocked(item.id);
  assertNoRestoreTemps(item);
  manager.dropState(item.id);
});

test('размер распакованного архива уточняется до создания защитной копии', async () => {
  const id = uniqueId('restore-unpacked-size');
  const server = { id, name: 'Большой архив', type: 'paper', port: 25601 };
  const dir = path.join(dataRoot, 'servers', id);
  fs.mkdirSync(dir, { recursive: true });
  write(path.join(dir, 'server.properties'), 'server-port=25565\n');
  write(path.join(dir, 'large-in-backup.bin'), Buffer.alloc(4 * 1024 * 1024, 0x61));
  const source = await backups.createBackup(server, 'source-large');
  fs.rmSync(path.join(dir, 'large-in-backup.bin'));
  write(path.join(dir, 'current.txt'), 'текущее состояние');
  const backupsBefore = backups.listBackups(id).map((entry) => entry.name).sort();

  // Сжатый архив легко прошёл бы быструю оценку, но 4 МБ tar-потока уже не
  // помещаются поверх обязательного запаса в смоделированные 513 МБ.
  const available = 513n * 1024n * 1024n;
  fs.statfsSync = () => ({ bavail: available, bfree: available, bsize: 1n, frsize: 1n });
  let error;
  try {
    await backups.restoreBackup(server, source.name);
  } catch (caught) {
    error = caught;
  } finally {
    fs.statfsSync = realStatfsSync;
  }

  assert.ok(error);
  assert.equal(error.status, 507);
  assert.deepEqual(backups.listBackups(id).map((entry) => entry.name).sort(), backupsBefore);
  assert.equal(fs.readFileSync(path.join(dir, 'current.txt'), 'utf8'), 'текущее состояние');
  assertRestoreUnlocked(id);
  assertNoRestoreTemps({ id, dir });
  manager.dropState(id);
});

test('полный защитный архив удаляется, если staging не удалось начать', async () => {
  const item = await fixture('restore-staging-enospc');
  const backupsBefore = backups.listBackups(item.id).map((entry) => entry.name).sort();
  fs.mkdirSync = function failOnlyRestoreStaging(target, options) {
    if (String(target).includes('.controlgui-staging-')) {
      const error = new Error('ENOSPC: No space left on device');
      error.code = 'ENOSPC';
      throw error;
    }
    return realMkdirSync(target, options);
  };
  let error;
  try {
    await backups.restoreBackup(item.server, item.source.name);
  } catch (caught) {
    error = caught;
  } finally {
    fs.mkdirSync = realMkdirSync;
  }

  assert.ok(error);
  assert.equal(error.status, 507);
  assert.deepEqual(backups.listBackups(item.id).map((entry) => entry.name).sort(), backupsBefore,
    'неиспользованный before-restore не должен занимать место после ошибки staging');
  assert.equal(fs.readFileSync(path.join(item.dir, 'world', 'level.dat'), 'utf8'), 'текущий-мир');
  assert.match(manager.getState(item.id).console.join('\n'), /защитный бэкап после ошибки удалён/i);
  assertRestoreUnlocked(item.id);
  assertNoRestoreTemps(item);
  manager.dropState(item.id);
});

test('после успешного rollback неиспользованный защитный архив удаляется', async () => {
  const item = await fixture('restore-promotion-failure');
  const backupsBefore = backups.listBackups(item.id).map((entry) => entry.name).sort();
  fs.renameSync = function failOnlyStagingPromotion(from, to) {
    if (String(from).includes('.controlgui-staging-') && path.resolve(String(to)) === path.resolve(item.dir)) {
      const error = new Error('Не удалось поставить staging на место сервера');
      error.code = 'EACCES';
      throw error;
    }
    return realRenameSync(from, to);
  };
  let error;
  try {
    await backups.restoreBackup(item.server, item.source.name);
  } catch (caught) {
    error = caught;
  } finally {
    fs.renameSync = realRenameSync;
  }

  assert.ok(error);
  assert.deepEqual(backups.listBackups(item.id).map((entry) => entry.name).sort(), backupsBefore);
  assert.equal(fs.readFileSync(path.join(item.dir, 'world', 'level.dat'), 'utf8'), 'текущий-мир');
  assertRestoreUnlocked(item.id);
  assertNoRestoreTemps(item);
  manager.dropState(item.id);
});

test('при неудачном rollback защитный архив сохраняется как страховка', async () => {
  const item = await fixture('restore-rollback-failure');
  const backupsBefore = backups.listBackups(item.id).map((entry) => entry.name).sort();
  fs.renameSync = function failPromotionAndRollback(from, to) {
    const source = String(from);
    if ((source.includes('.controlgui-staging-') || source.includes('.controlgui-rollback-')) &&
      path.resolve(String(to)) === path.resolve(item.dir)) {
      const error = new Error('Смоделированный отказ возврата каталога');
      error.code = 'EACCES';
      throw error;
    }
    return realRenameSync(from, to);
  };
  let error;
  try {
    await backups.restoreBackup(item.server, item.source.name);
  } catch (caught) {
    error = caught;
  } finally {
    fs.renameSync = realRenameSync;
  }

  assert.ok(error);
  assert.equal(manager.isRestoring(item.id), false);
  assert.equal(fs.existsSync(item.dir), false, 'смоделированный rollback действительно не вернул original');
  const siblings = fs.readdirSync(path.dirname(item.dir));
  const rollbackName = siblings.find((name) => name.startsWith('.' + item.id + '.controlgui-rollback-'));
  assert.ok(rollbackName, 'исходный каталог должен остаться в rollback');
  const backupsAfter = backups.listBackups(item.id).map((entry) => entry.name).sort();
  const protective = backupsAfter.filter((name) => !backupsBefore.includes(name));
  assert.equal(protective.length, 1, 'единственную страховочную копию нельзя удалять');
  assert.match(protective[0], /before-restore/);

  // Возвращаем тестовую фикстуру вручную только после проверки сохранности.
  realRenameSync(path.join(path.dirname(item.dir), rollbackName), item.dir);
  backups.deleteBackup(item.id, protective[0]);
  assert.equal(fs.readFileSync(path.join(item.dir, 'world', 'level.dat'), 'utf8'), 'текущий-мир');
  assertNoRestoreTemps(item);
  manager.dropState(item.id);
});

test('защитный бэкап со ссылкой не считается пригодным для отката', async (t) => {
  const item = await fixture('restore-symlink');
  try {
    fs.symlinkSync(path.join('world', 'level.dat'), path.join(item.dir, 'world-link'));
  } catch (e) {
    t.skip('ОС не разрешила создать тестовую символическую ссылку');
    manager.dropState(item.id);
    return;
  }
  const backupsBefore = backups.listBackups(item.id).map((entry) => entry.name).sort();
  let error;
  try {
    await backups.restoreBackup(item.server, item.source.name);
  } catch (caught) {
    error = caught;
  }

  assert.ok(error);
  assert.equal(error.status, 500);
  assert.match(error.message, /ссылк|защитн/i);
  assert.deepEqual(backups.listBackups(item.id).map((entry) => entry.name).sort(), backupsBefore);
  assert.equal(fs.readFileSync(path.join(item.dir, 'world', 'level.dat'), 'utf8'), 'текущий-мир');
  assertRestoreUnlocked(item.id);
  assertNoRestoreTemps(item);
  manager.dropState(item.id);
});

for (const scenario of [
  { mode: 'warning', title: 'частичный защитный бэкап' },
  { mode: 'enospc', title: 'ENOSPC во время защитного бэкапа' },
]) {
  test(scenario.title + ' останавливает restore, сохраняет сервер и снимает блокировку', async () => {
    const item = await fixture('restore-' + scenario.mode);
    const backupsBefore = backups.listBackups(item.id).map((entry) => entry.name).sort();
    forcedBeforeRestoreFailure = scenario.mode;
    let error;
    try {
      await backups.restoreBackup(item.server, item.source.name);
    } catch (caught) {
      error = caught;
    } finally {
      forcedBeforeRestoreFailure = null;
    }

    assert.ok(error, 'неполный обязательный снимок нельзя считать успехом');
    assert.ok(error.status === 500 || error.status === 507);
    assert.match(error.message, /защитн|полност|мест/i);
    assert.equal(fs.readFileSync(path.join(item.dir, 'world', 'level.dat'), 'utf8'), 'текущий-мир');
    assert.equal(fs.readFileSync(path.join(item.dir, 'only-current.txt'), 'utf8'),
      'нельзя потерять при ошибке');
    assert.equal(fs.existsSync(path.join(item.dir, 'only-in-backup.txt')), false);
    assert.deepEqual(backups.listBackups(item.id).map((entry) => entry.name).sort(), backupsBefore,
      'повреждённый before-restore не должен появляться среди бэкапов');
    assert.match(manager.getState(item.id).console.join('\n'), /Восстановление (?:не выполнено|отменено|прервано)/i,
      'после стартового сообщения консоль должна объяснить результат ошибки');
    assertRestoreUnlocked(item.id);
    assertNoRestoreTemps(item);
    manager.dropState(item.id);
  });
}
