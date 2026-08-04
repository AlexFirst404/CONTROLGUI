'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { DATA_ROOT, serverDir } = require('./paths');
const manager = require('./manager');
const properties = require('./properties');
const proxy = require('./proxy');

/* Реальные бэкапы каталога сервера в .tar.gz через системный tar
   (bsdtar на Windows 10+/Linux). Архивы — в backups/<id>/. */

const BACKUPS_ROOT = path.join(DATA_ROOT, 'backups');

function backupsDir(serverId) {
  const dir = path.join(BACKUPS_ROOT, serverId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeName(name) {
  // только имя файла, без путей; добавляем .tar.gz
  const base = String(name || '').replace(/[^A-Za-z0-9_.\-]/g, '_').replace(/^_+|_+$/g, '');
  return base;
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    '_' + p(d.getHours()) + '-' + p(d.getMinutes()) + '-' + p(d.getSeconds());
}

function listBackups(serverId) {
  const dir = backupsDir(serverId);
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.tar.gz')); } catch (e) { /* пусто */ }
  return files.map((name) => {
    let size = 0; let mtime = 0;
    try { const st = fs.statSync(path.join(dir, name)); size = st.size; mtime = st.mtimeMs; } catch (e) { /* исчез */ }
    return { name, size, mtime };
  }).sort((a, b) => b.mtime - a.mtime);
}

/* tolerateWarnings: код 1 у tar — это предупреждения (файлы менялись/были
   заняты во время чтения у работающего сервера), архив при этом валиден.
   Считаем это успехом; код ≥2 — настоящая ошибка. */
// На Windows форсируем РОДНОЙ bsdtar из System32 — иначе в PATH может оказаться
// GNU/MSYS tar (Git for Windows), который трактует «D:\...» в пути архива как
// удалённый хост (host:path) и портит/не создаёт архив. bsdtar понимает диск-буквы.
function tarBin() {
  if (process.platform === 'win32') {
    const sys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    try { if (fs.existsSync(sys)) return sys; } catch (e) { /* */ }
  }
  return 'tar';
}
function runTar(args, label, tolerateWarnings) {
  return new Promise((resolve, reject) => {
    let proc;
    try { proc = spawn(tarBin(), args, { windowsHide: true }); }
    catch (e) { return reject(new Error('tar недоступен: ' + e.message)); }
    let err = '';
    proc.stderr.on('data', (d) => { if (err.length < 8192) err += d.toString(); });
    proc.on('error', (e) => reject(new Error((label || 'tar') + ': ' + e.message)));
    proc.on('exit', (code) => {
      if (code === 0 || (tolerateWarnings && code === 1)) resolve({ code, warned: code === 1 });
      else reject(new Error((label || 'tar') + ' завершился с кодом ' + code + (err ? ': ' + err.trim().slice(0, 300) : '')));
    });
  });
}

function backupError(status, message) {
  return Object.assign(new Error(message), { status });
}

/* Список архива читаем отдельным процессом с жёстким лимитом вывода: повреждённый
   или подменённый архив не должен занять всю память панели миллионами имён. */
function runTarCapture(args, label, maxOutput) {
  return new Promise((resolve, reject) => {
    let proc;
    try { proc = spawn(tarBin(), args, { windowsHide: true }); }
    catch (e) { return reject(new Error('tar недоступен: ' + e.message)); }
    let done = false;
    let out = '';
    let err = '';
    const finish = (error, value) => {
      if (done) return;
      done = true;
      if (error) reject(error); else resolve(value);
    };
    proc.stdout.on('data', (d) => {
      out += d.toString('utf8');
      if (Buffer.byteLength(out, 'utf8') > maxOutput) {
        try { proc.kill(); } catch (e) { /* процесс уже завершился */ }
        finish(backupError(400, 'В архиве слишком много записей'));
      }
    });
    proc.stderr.on('data', (d) => {
      if (err.length < 8192) err += d.toString('utf8');
    });
    proc.on('error', (e) => finish(new Error((label || 'tar') + ': ' + e.message)));
    // `close`, в отличие от `exit`, приходит после закрытия stdout/stderr: иначе на
    // больших списках последние имена могли не попасть в проверку архива.
    proc.on('close', (code) => {
      if (done) return;
      if (code === 0) finish(null, out);
      else finish(backupError(400, (label || 'tar') + ' завершилась с кодом ' + code +
        (err ? ': ' + err.trim().slice(0, 300) : '')));
    });
  });
}

function safeArchiveEntry(name) {
  let rel = String(name || '').replace(/\r$/, '').replace(/\\/g, '/');
  while (rel.startsWith('./')) rel = rel.slice(2);
  if (!rel || rel === '.') return true;
  if (rel.includes('\0') || rel.startsWith('/') || rel.startsWith('//') || /^[A-Za-z]:/.test(rel)) return false;
  return !rel.split('/').some((part) => part === '..');
}

/* До распаковки проверяем и имена, и типы записей. Бэкап CONTROLGUI содержит
   только обычные файлы/каталоги; ссылки и спецфайлы отвергаем, чтобы tar не мог
   вывести запись из staging-каталога через заранее созданную ссылку. */
async function validateBackupArchive(file) {
  const names = await runTarCapture(['-tzf', file], 'Проверка списка архива', 16 * 1024 * 1024);
  const entries = names.split('\n').filter((line) => line.replace(/\r$/, '') !== '');
  if (!entries.length) throw backupError(400, 'Бэкап пуст или повреждён');
  if (entries.length > 100000) throw backupError(400, 'В архиве слишком много записей');
  for (const name of entries) {
    if (!safeArchiveEntry(name)) throw backupError(400, 'В бэкапе найден небезопасный путь');
  }

  const verbose = await runTarCapture(['-tvzf', file], 'Проверка типов файлов архива', 32 * 1024 * 1024);
  for (const line of verbose.split('\n')) {
    const clean = line.trimStart();
    if (!clean) continue;
    const type = clean[0];
    if (type !== '-' && type !== 'd') {
      throw backupError(400, 'Бэкап содержит ссылки или специальные файлы и не может быть восстановлен');
    }
  }
}

function validateExtractedTree(root) {
  const stack = [root];
  let count = 0;
  while (stack.length) {
    const dir = stack.pop();
    for (const name of fs.readdirSync(dir)) {
      if (++count > 100000) throw backupError(400, 'В архиве слишком много файлов');
      const abs = path.join(dir, name);
      const st = fs.lstatSync(abs);
      if (st.isSymbolicLink() || (!st.isDirectory() && !st.isFile())) {
        throw backupError(400, 'Бэкап содержит ссылки или специальные файлы');
      }
      if (st.isDirectory()) stack.push(abs);
    }
  }
}

function siblingPath(dir, kind) {
  const suffix = process.pid + '-' + crypto.randomBytes(6).toString('hex');
  return path.join(path.dirname(dir), '.' + path.basename(dir) + '.controlgui-' + kind + '-' + suffix);
}

function removeTemp(target) {
  if (!target) return;
  try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  catch (e) { /* временный каталог не влияет на доступность восстановленного сервера */ }
}

/* Создать бэкап. Если сервер работает — сбрасываем мир командой save-all
   перед архивацией (best effort). Возвращает имя архива. */
async function createBackup(server, label) {
  const id = server.id;
  const dir = serverDir(id);
  if (!fs.existsSync(dir)) throw Object.assign(new Error('Каталог сервера не найден'), { status: 404 });

  const st = manager.getState(id);
  if (st.proc) {
    try {
      manager.sendCommand(id, 'save-all flush');
      manager.pushLine(id, '[ПАНЕЛЬ] Сохраняю мир перед бэкапом...');
      await new Promise((r) => setTimeout(r, 2500));
    } catch (e) { /* не критично */ }
  }

  const clean = safeName(label);
  const base = timestamp() + (clean ? '_' + clean : '');
  let name = base + '.tar.gz';
  let out = path.join(backupsDir(id), name);
  let copy = 2;
  // Защитный before-restore может создаваться в ту же секунду, что и выбранный
  // архив: никогда не перезаписываем существующий бэкап совпавшим timestamp.
  while (fs.existsSync(out)) {
    name = base + '_' + copy++ + '.tar.gz';
    out = path.join(backupsDir(id), name);
  }
  // tar пишет в скрытый уникальный tmp: список/скачивание никогда не увидят
  // частичный .tar.gz. Только проверенный непустой файл атомарно получает имя.
  const tmp = out + '.' + process.pid + '.' + crypto.randomBytes(5).toString('hex') + '.tmp';
  let result;
  let size = 0;
  try {
    // -C <serverDir> . — архивируем содержимое каталога сервера;
    // у работающего сервера терпим предупреждения (код 1) — архив валиден
    result = await runTar(['-czf', tmp, '-C', dir, '.'], 'Создание бэкапа', true);
    try { size = fs.statSync(tmp).size; } catch (e) { /* ошибка ниже будет понятнее */ }
    if (!size) throw backupError(500, 'Архив пуст — бэкап не создан');
    fs.renameSync(tmp, out);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch (removeError) { /* tmp не создан */ }
    throw e;
  }
  manager.pushLine(id, '[ПАНЕЛЬ] Бэкап создан: ' + name + (result.warned ? ' (часть файлов была занята сервером — пропущена)' : ''));
  return { name, size };
}

function deleteBackup(serverId, name) {
  const clean = safeName(name);
  if (!clean.endsWith('.tar.gz')) throw Object.assign(new Error('Некорректное имя бэкапа'), { status: 400 });
  const file = path.join(backupsDir(serverId), clean);
  if (!fs.existsSync(file)) throw Object.assign(new Error('Бэкап не найден'), { status: 404 });
  fs.rmSync(file, { force: true });
}

function backupFilePath(serverId, name) {
  const clean = safeName(name);
  if (!clean.endsWith('.tar.gz')) throw Object.assign(new Error('Некорректное имя бэкапа'), { status: 400 });
  const file = path.join(backupsDir(serverId), clean);
  if (!fs.existsSync(file)) throw Object.assign(new Error('Бэкап не найден'), { status: 404 });
  return file;
}

/* Восстановить бэкап: только на полностью простаивающем сервере. Архив сначала
   проверяется и распаковывается рядом, затем каталоги меняются через rename. */
async function restoreBackup(server, name) {
  const id = server.id;
  const dir = serverDir(id);
  let staging = null;
  let rollback = null;
  let successful = false;
  manager.beginRestore(id); // синхронный lock до первого await
  try {
    const file = backupFilePath(id, name);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      throw backupError(404, 'Каталог сервера не найден');
    }

    // Сначала убеждаемся, что источник читается и не содержит опасных путей/ссылок.
    await validateBackupArchive(file);

    // Защитный снимок обязателен: без него не начинаем даже staging-распаковку.
    try { await createBackup(server, 'before-restore'); }
    catch (e) {
      throw backupError(500, 'Не удалось создать защитный бэкап перед восстановлением: ' + e.message);
    }

    staging = siblingPath(dir, 'staging');
    rollback = siblingPath(dir, 'rollback');
    fs.mkdirSync(staging, { recursive: false });
    await runTar(['-xzf', file, '-C', staging], 'Восстановление');
    validateExtractedTree(staging);

    // Порт — часть реестра и связей с прокси. Старый бэкап не должен молча
    // вернуть занятый/устаревший server-port и рассинхронизировать карточку.
    if (!proxy.isProxyType(server.type)) {
      const propertiesFile = path.join(staging, 'server.properties');
      let restoredProperties = {};
      try { restoredProperties = properties.parse(fs.readFileSync(propertiesFile, 'utf8')); } catch (e) { /* файла могло не быть */ }
      restoredProperties['server-port'] = String(server.port);
      fs.writeFileSync(propertiesFile, properties.stringify(restoredProperties));
    }

    // Исходный каталог не трогаем до полной успешной распаковки. Две rename на
    // одном томе дают короткий swap; при второй ошибке немедленно возвращаем оригинал.
    fs.renameSync(dir, rollback);
    try {
      fs.renameSync(staging, dir);
      staging = null;
    } catch (e) {
      try { fs.renameSync(rollback, dir); rollback = null; }
      catch (rollbackError) {
        e.message += '; не удалось вернуть исходный каталог: ' + rollbackError.message;
      }
      throw e;
    }

    successful = true;
    manager.pushLine(id, '[ПАНЕЛЬ] Восстановлен бэкап: ' + safeName(name));
    try {
      fs.rmSync(rollback, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      rollback = null;
    } catch (e) {
      manager.pushLine(id, '[ПАНЕЛЬ] Восстановление завершено, но временную копию старого каталога удалить не удалось.');
    }
  } finally {
    removeTemp(staging);
    // Если swap оборвался между rename, исходный каталог должен вернуться на место.
    if (!successful && rollback && fs.existsSync(rollback) && !fs.existsSync(dir)) {
      try { fs.renameSync(rollback, dir); rollback = null; } catch (e) { /* ошибка уже будет видна вызывающему коду */ }
    }
    manager.endRestore(id, successful);
  }
}

module.exports = { listBackups, createBackup, deleteBackup, restoreBackup, backupFilePath };
