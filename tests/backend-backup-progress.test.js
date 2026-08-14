'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const { EventEmitter } = require('events');
const { PassThrough, Writable } = require('stream');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'controlgui-backup-progress-'));
process.env.CONTROLGUI_DATA = root;
global.__controlguiSkipDataInit = true;
fs.mkdirSync(path.join(root, 'data'), { recursive: true });
fs.mkdirSync(path.join(root, 'servers', 'progress'), { recursive: true });
fs.writeFileSync(path.join(root, 'servers', 'progress', 'world.bin'), Buffer.alloc(512 * 1024, 0x5a));
fs.writeFileSync(path.join(root, 'data', 'servers.json'), JSON.stringify({
  servers: [{ id: 'progress', name: 'Прогресс', type: 'paper', version: '1.21.4', memoryMb: 1024, port: 25565 }],
}));

const realSpawn = childProcess.spawn;
const realCreateWriteStream = fs.createWriteStream;
let forceSpawnError = false;

function tarHeader(name, size, type) {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, 'utf8');
  const octal = (offset, length, value) => {
    block.write(value.toString(8).padStart(length - 1, '0') + '\0', offset, length, 'ascii');
  };
  octal(100, 8, 0o644);
  octal(108, 8, 0);
  octal(116, 8, 0);
  octal(124, 12, size);
  octal(136, 12, Math.floor(Date.now() / 1000));
  block.fill(0x20, 148, 156);
  block[156] = String(type || '0').charCodeAt(0);
  block.write('ustar\0', 257, 6, 'ascii');
  octal(148, 8, block.reduce((sum, byte) => sum + byte, 0));
  return block;
}

/* Медленный локальный tar-поток делает промежуточное состояние детерминированным:
   тест не зависит от скорости диска и при этом проверяет настоящий TAR-счётчик. */
childProcess.spawn = function spawnSlowTar(file, args, options) {
  if (!Array.isArray(args) || args[0] !== '-cf' || args[1] !== '-') {
    return realSpawn(file, args, options);
  }
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 12345;
  let closed = false;
  let timer = null;
  const finish = (code) => {
    if (closed) return;
    closed = true;
    if (timer) clearInterval(timer);
    child.stdout.end(Buffer.alloc(1024));
    child.stderr.end();
    setImmediate(() => child.emit('close', code));
  };
  child.kill = () => { finish(null); return true; };

  setImmediate(() => {
    if (closed) return;
    if (forceSpawnError) {
      const error = new Error('spawn tar ENOENT');
      error.code = 'ENOENT';
      child.emit('error', error);
      return;
    }
    const total = 512 * 1024;
    let sent = 0;
    // PAX — служебная запись: её payload не должен попадать в processedBytes.
    // Заголовок файла режем на части, как это делает реальный pipe произвольными чанками.
    const pax = Buffer.alloc(12345, 0x20);
    child.stdout.write(tarHeader('./PaxHeaders/world.bin', pax.length, 'x'));
    child.stdout.write(pax);
    child.stdout.write(Buffer.alloc((512 - (pax.length % 512)) % 512));
    const header = tarHeader('./world.bin', total);
    child.stdout.write(header.subarray(0, 137));
    child.stdout.write(header.subarray(137, 419));
    child.stdout.write(header.subarray(419));
    timer = setInterval(() => {
      if (closed) return;
      const size = Math.min(32 * 1024, total - sent);
      if (size > 0) {
        child.stdout.write(Buffer.alloc(size, 0x5a));
        sent += size;
      }
      if (sent === total) finish(0);
    }, 20);
  });
  return child;
};

const backups = require('../lib/backups');
const manager = require('../lib/manager');
const { handleApi } = require('../lib/api');
const server = { id: 'progress', name: 'Прогресс', type: 'paper', port: 25565 };

async function waitFor(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Не дождались промежуточного прогресса');
}

function apiGet(url, user) {
  return new Promise((resolve) => {
    const req = {
      method: 'GET', url, headers: {}, cgRemote: false,
      cgUser: user || { admin: false, perms: { 'backups.create': true } },
    };
    const result = { status: 0, body: null };
    const res = {
      headersSent: false,
      writeHead(status) { result.status = status; this.headersSent = true; },
      end(body) { result.body = body; resolve(result); },
    };
    handleApi(req, res);
  });
}

test('ручной бэкап публикует реальные байты, ETA и не допускает второй запуск', async () => {
  const creation = backups.createBackup(server, 'manual');
  assert.equal(manager.getState(server.id).backupCreating, true);
  const initial = backups.getCreationProgress(server.id);
  assert.ok(initial && ['preparing', 'scanning'].includes(initial.phase));
  assert.equal(initial.progress, null, 'до подсчёта объёма полоса должна быть неопределённой');
  await assert.rejects(backups.createBackup(server, 'racing'), (error) => {
    assert.equal(error.status, 409);
    return true;
  });

  const progress = await waitFor(() => {
    const value = backups.getCreationProgress(server.id);
    return value && value.phase === 'archiving' && value.processedBytes > 0 ? value : null;
  }, 2000);
  // Белый список API обязан пережить и будущие внутренние служебные поля.
  manager.getState(server.id).backupProgress.tmpPath = path.join(root, 'секретный.tmp');
  const safeProgress = backups.getCreationProgress(server.id);
  assert.equal(Object.prototype.hasOwnProperty.call(safeProgress, 'tmpPath'), false);
  assert.ok(progress.progress > 0 && progress.progress < 1);
  assert.equal(progress.totalBytes, 512 * 1024);
  assert.ok(progress.processedBytes < progress.totalBytes);
  assert.ok(progress.startedAt > 0);
  assert.ok(progress.etaSeconds == null ||
    (progress.etaSeconds >= 0 && progress.etaSeconds <= 6 * 60 * 60));
  assert.doesNotMatch(JSON.stringify(safeProgress), /controlgui-backup-progress|world\.bin|секретный/i);

  const response = await apiGet('/api/servers/progress/backups');
  assert.equal(response.status, 200);
  const body = JSON.parse(response.body);
  assert.ok(Array.isArray(body.backups));
  assert.deepEqual(body.creating, backups.getCreationProgress(server.id));
  const restricted = await apiGet('/api/servers/progress/backups', {
    admin: false, perms: { 'backups.delete': true },
  });
  assert.equal(JSON.parse(restricted.body).creating, null,
    'несжатый размер сервера не раскрывается без права создания');

  const result = await creation;
  assert.match(result.name, /_manual\.tar\.gz$/);
  assert.ok(result.size > 0);
  assert.equal(manager.getState(server.id).backupCreating, false);
  assert.equal(backups.getCreationProgress(server.id), null);
});

test('защитный снимок восстановления не выглядит ручным созданием', async () => {
  const creation = backups.createBackup(server, 'before-restore', { internal: true });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(manager.getState(server.id).backupCreating, false);
  assert.equal(backups.getCreationProgress(server.id), null);
  await creation;
});

test('ENOSPC выходного потока удаляет tmp и всегда снимает lock/прогресс', { timeout: 2000 }, async () => {
  fs.createWriteStream = function noSpaceOutput(target) {
    fs.writeFileSync(target, 'частичный архив');
    return new Writable({
      write(chunk, encoding, callback) {
        const error = new Error('ENOSPC: No space left on device');
        error.code = 'ENOSPC';
        callback(error);
      },
    });
  };
  let error;
  try {
    await backups.createBackup(server, 'enospc');
  } catch (caught) {
    error = caught;
  } finally {
    fs.createWriteStream = realCreateWriteStream;
  }
  assert.ok(error);
  assert.equal(error.status, 507);
  assert.equal(manager.getState(server.id).backupCreating, false);
  assert.equal(backups.getCreationProgress(server.id), null);
  const backupDir = path.join(root, 'backups', server.id);
  assert.equal(fs.readdirSync(backupDir).some((name) => name.endsWith('.tmp')), false);
});

test('ошибка spawn закрывает pipeline без зависания и очищает состояние', { timeout: 2000 }, async () => {
  forceSpawnError = true;
  let error;
  try {
    await backups.createBackup(server, 'spawn-error');
  } catch (caught) {
    error = caught;
  } finally {
    forceSpawnError = false;
  }
  assert.ok(error);
  assert.equal(error.status, 500);
  assert.equal(manager.getState(server.id).backupCreating, false);
  assert.equal(backups.getCreationProgress(server.id), null);
  const backupDir = path.join(root, 'backups', server.id);
  assert.equal(fs.readdirSync(backupDir).some((name) => name.endsWith('.tmp')), false);
});

test.after(() => {
  childProcess.spawn = realSpawn;
  fs.createWriteStream = realCreateWriteStream;
  manager.dropState(server.id);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
