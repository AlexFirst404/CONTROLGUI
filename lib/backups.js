'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { spawn } = require('child_process');
const { DATA_ROOT, serverDir } = require('./paths');
const manager = require('./manager');
const properties = require('./properties');
const proxy = require('./proxy');

/* Реальные бэкапы каталога сервера в .tar.gz через системный tar
   (bsdtar на Windows 10+/Linux). Архивы — в backups/<id>/. */

const BACKUPS_ROOT = path.join(DATA_ROOT, 'backups');
const TAR_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const RESTORE_RESERVE_BYTES = 512n * 1024n * 1024n;

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

/* Код 1 у tar неоднозначен: у работающего сервера это могут быть изменившиеся
   файлы, но Windows bsdtar тем же кодом сообщает и ENOSPC. Поэтому разрешение
   warning задаёт вызывающий код, а готовый архив после warning читается целиком. */
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
    catch (e) { return reject(backupError(500, 'Системный архиватор tar недоступен')); }
    let done = false;
    let timer = null;
    let killTimer = null;
    let forceTimer = null;
    let timedOutError = null;
    let err = '';
    const finish = (error, value) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (forceTimer) clearTimeout(forceTimer);
      if (error) reject(error); else resolve(value);
    };
    // Даже когда tar пишет архив в файл, отдельные реализации могут выводить
    // служебные строки в stdout. Канал обязательно читаем, чтобы дочерний процесс
    // не остановился навсегда на заполненном pipe-буфере.
    proc.stdout.resume();
    proc.stderr.on('data', (d) => { if (err.length < 8192) err += d.toString(); });
    proc.on('error', () => {
      if (!timedOutError) finish(backupError(500, (label || 'Операция с архивом') + ' не запустилась'));
    });
    // `close` приходит после закрытия stderr. На Windows bsdtar сообщает ENOSPC
    // кодом 1 — его нельзя путать с допустимым предупреждением работающего сервера.
    proc.on('close', (code) => {
      if (timedOutError) return finish(timedOutError);
      if (code === 0) return finish(null, { code, warned: false, stderr: err });
      if (tolerateWarnings && code === 1 && !isNoSpaceError(err)) {
        return finish(null, { code, warned: true, stderr: err });
      }
      finish(tarFailure(label, code, err));
    });
    // Фиксированный предел очень большой и не мешает нормальным архивам, но
    // гарантирует снятие restore-lock, если системный tar действительно завис.
    timer = setTimeout(() => {
      timedOutError = backupError(504, (label || 'Операция с архивом') + ' не отвечает более 6 часов');
      try { proc.kill(); } catch (e) { /* процесс уже завершился */ }
      // Promise завершаем только после `close`: иначе cleanup мог удалить tmp,
      // пока tar ещё пишет. Если SIGTERM не помог, эскалируем до SIGKILL.
      killTimer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch (e) { /* процесс уже завершился */ }
        forceTimer = setTimeout(() => finish(timedOutError), 5000);
        if (forceTimer.unref) forceTimer.unref();
      }, 30000);
      if (killTimer.unref) killTimer.unref();
    }, TAR_TIMEOUT_MS);
    if (timer.unref) timer.unref();
  });
}

function backupError(status, message) {
  return Object.assign(new Error(message), { status });
}

function isNoSpaceError(error) {
  const text = typeof error === 'string'
    ? error
    : [error && error.code, error && error.message].filter(Boolean).join(' ');
  return /ENOSPC|EDQUOT|no space left|not enough (?:free )?space|disk (?:is )?full|недостаточно (?:свободного )?места/i.test(text);
}

function tarFailure(label, code, stderr) {
  if (isNoSpaceError(stderr)) {
    return backupError(507, 'Недостаточно свободного места на диске для операции с бэкапом');
  }
  return backupError(500, (label || 'Операция с архивом') + ' не выполнена' +
    (code == null ? '' : ' (код tar: ' + code + ')'));
}

function normalizedBackupError(error, fallback) {
  if (isNoSpaceError(error)) {
    return backupError(507, 'Недостаточно свободного места на диске для операции с бэкапом');
  }
  if (error && error.status) return error;
  return backupError(500, fallback || 'Не удалось выполнить операцию с бэкапом');
}

function availableDiskBytes(target) {
  if (typeof fs.statfsSync !== 'function') return null;
  try {
    const stat = fs.statfsSync(target, { bigint: true });
    const blocks = stat.bavail == null ? stat.bfree : stat.bavail;
    const blockSize = stat.bsize || stat.frsize;
    return BigInt(blocks) * BigInt(blockSize);
  } catch (e) {
    // Node 18 до появления statfs или необычная файловая система: строгая
    // проверка результата tar всё равно не даст опубликовать обрезанный архив.
    return null;
  }
}

function humanBytes(bytes) {
  const value = Number(bytes);
  if (value < 1024) return value + ' Б';
  if (value < 1024 ** 2) return (value / 1024).toFixed(1) + ' КБ';
  if (value < 1024 ** 3) return (value / 1024 ** 2).toFixed(1) + ' МБ';
  return (value / 1024 ** 3).toFixed(2) + ' ГБ';
}

/* Сначала отсекаем явно невозможную операцию по сжатому размеру. Окончательная
   проверка выполняется после создания protective: тогда statfs уже учитывает
   его РЕАЛЬНЫЙ размер, а не неточную оценку сжатия текущего мира. */
function prepareRestoreCapacity(serverRoot, archiveFile) {
  const serverFree = availableDiskBytes(serverRoot);
  if (serverFree == null) return null;
  const archiveBytes = BigInt(fs.statSync(archiveFile).size);
  const required = archiveBytes + RESTORE_RESERVE_BYTES;
  if (serverFree < required) {
    throw backupError(507, 'Недостаточно свободного места для безопасного восстановления: доступно ' +
      humanBytes(serverFree) + ', ориентировочно требуется не менее ' + humanBytes(required) +
      '. Освободите место и повторите попытку.');
  }
  return { serverFree };
}

function measureUncompressedArchive(file, maxBytes) {
  return new Promise((resolve, reject) => {
    const input = fs.createReadStream(file);
    const gunzip = zlib.createGunzip();
    let total = 0n;
    let done = false;
    let timer = null;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (error) {
        input.destroy();
        gunzip.destroy();
        reject(error);
      } else {
        resolve(value);
      }
    };
    input.on('error', () => finish(backupError(400, 'Бэкап повреждён или недоступен')));
    gunzip.on('error', () => finish(backupError(400, 'Бэкап повреждён или недоступен')));
    gunzip.on('data', (chunk) => {
      total += BigInt(chunk.length);
      if (maxBytes != null && total > maxBytes) {
        finish(backupError(507, 'Распакованный бэкап больше доступного места на диске сервера'));
      }
    });
    gunzip.on('end', () => finish(null, total));
    input.pipe(gunzip);
    timer = setTimeout(() => {
      finish(backupError(504, 'Проверка распакованного размера бэкапа не отвечает более 6 часов'));
    }, TAR_TIMEOUT_MS);
    if (timer.unref) timer.unref();
  });
}

function ensureUnpackedCapacity(serverRoot, unpackedBytes) {
  if (unpackedBytes == null) return;
  const available = availableDiskBytes(serverRoot);
  if (available == null) return;
  const required = unpackedBytes + RESTORE_RESERVE_BYTES;
  if (available < required) {
    throw backupError(507, 'Недостаточно места на диске сервера для распаковки бэкапа: доступно ' +
      humanBytes(available) + ', требуется не менее ' + humanBytes(required) + '.');
  }
}

/* Список архива читаем отдельным процессом с жёстким лимитом вывода: повреждённый
   или подменённый архив не должен занять всю память панели миллионами имён. */
function runTarCapture(args, label, maxOutput) {
  return new Promise((resolve, reject) => {
    let proc;
    try { proc = spawn(tarBin(), args, { windowsHide: true }); }
    catch (e) { return reject(new Error('tar недоступен: ' + e.message)); }
    let done = false;
    let timer = null;
    let killTimer = null;
    let forceTimer = null;
    let pendingError = null;
    let out = '';
    let err = '';
    const finish = (error, value) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (forceTimer) clearTimeout(forceTimer);
      if (error) reject(error); else resolve(value);
    };
    proc.stdout.on('data', (d) => {
      if (pendingError) return;
      out += d.toString('utf8');
      if (Buffer.byteLength(out, 'utf8') > maxOutput) {
        pendingError = backupError(400, 'В архиве слишком много записей');
        try { proc.kill(); } catch (e) { /* процесс уже завершился */ }
      }
    });
    proc.stderr.on('data', (d) => {
      if (err.length < 8192) err += d.toString('utf8');
    });
    proc.on('error', (e) => {
      if (!pendingError) pendingError = new Error((label || 'tar') + ': ' + e.message);
    });
    // `close`, в отличие от `exit`, приходит после закрытия stdout/stderr: иначе на
    // больших списках последние имена могли не попасть в проверку архива.
    proc.on('close', (code) => {
      if (done) return;
      if (pendingError) return finish(pendingError);
      if (code === 0) finish(null, out);
      // stderr tar часто содержит абсолютный путь. Не отдаём его удалённому
      // пользователю и одновременно даём владельцу понятный диагноз архива.
      else finish(backupError(400, (label || 'Проверка архива') +
        ' не выполнена: бэкап повреждён или недоступен'));
    });
    timer = setTimeout(() => {
      pendingError = backupError(504, (label || 'Проверка архива') + ' не отвечает более 6 часов');
      try { proc.kill(); } catch (e) { /* процесс уже завершился */ }
      killTimer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch (e) { /* процесс уже завершился */ }
        forceTimer = setTimeout(() => finish(pendingError), 5000);
        if (forceTimer.unref) forceTimer.unref();
      }, 30000);
      if (killTimer.unref) killTimer.unref();
    }, TAR_TIMEOUT_MS);
    if (timer.unref) timer.unref();
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
async function validateBackupArchive(file, options) {
  options = options || {};
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
  const unpackedBytes = options.measure
    ? await measureUncompressedArchive(file, options.maxBytes)
    : null;
  return { unpackedBytes };
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
async function createBackup(server, label, options) {
  options = options || {};
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
    // Код 1 допустим только для обычного снимка реально работающего сервера.
    // Защитный before-restore обязан быть полным: иначе откат после swap невозможен.
    const tolerateWarnings = !!st.proc && !options.requireComplete;
    result = await runTar(['-czf', tmp, '-C', dir, '.'], 'Создание бэкапа', tolerateWarnings);
    try { size = fs.statSync(tmp).size; } catch (e) { /* ошибка ниже будет понятнее */ }
    if (!size) throw backupError(500, 'Архив пуст — бэкап не создан');
    // Код 0 сам по себе не доказывает, что gzip полностью читается после сбоя
    // накопителя. Для обязательного снимка и любого warning читаем архив до конца.
    if (options.requireComplete || result.warned) {
      manager.pushLine(id, '[ПАНЕЛЬ] Проверяю целостность созданного бэкапа...');
      await validateBackupArchive(tmp);
    }
    fs.renameSync(tmp, out);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch (removeError) { /* tmp не создан */ }
    throw normalizedBackupError(e, 'Не удалось создать бэкап');
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
  let protectiveFile = null;
  let originalAtDir = true;
  let successful = false;
  manager.beginRestore(id); // синхронный lock до первого await
  try {
    const file = backupFilePath(id, name);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      throw backupError(404, 'Каталог сервера не найден');
    }

    manager.pushLine(id, '[ПАНЕЛЬ] Проверяю свободное место для безопасного восстановления...');
    const capacity = await prepareRestoreCapacity(dir, file);
    manager.pushLine(id, '[ПАНЕЛЬ] Проверяю выбранный бэкап...');
    // Сначала убеждаемся, что источник читается и не содержит опасных путей/ссылок.
    const validation = await validateBackupArchive(file, {
      measure: true,
      maxBytes: capacity ? capacity.serverFree : null,
    });
    ensureUnpackedCapacity(dir, validation.unpackedBytes);

    // Защитный снимок обязателен: без него не начинаем даже staging-распаковку.
    manager.pushLine(id, '[ПАНЕЛЬ] Создаю полный защитный бэкап текущего состояния...');
    try {
      const protective = await createBackup(server, 'before-restore', { requireComplete: true });
      protectiveFile = path.join(backupsDir(id), protective.name);
    }
    catch (e) {
      const reason = normalizedBackupError(e, 'Не удалось создать защитный бэкап');
      throw backupError(reason.status === 507 ? 507 : 500,
        'Не удалось создать защитный бэкап перед восстановлением: ' + reason.message);
    }
    // На общем томе protective уже занял место. Проверяем остаток повторно по
    // точному распакованному объёму выбранного архива до создания staging.
    ensureUnpackedCapacity(dir, validation.unpackedBytes);

    staging = siblingPath(dir, 'staging');
    rollback = siblingPath(dir, 'rollback');
    fs.mkdirSync(staging, { recursive: false });
    manager.pushLine(id, '[ПАНЕЛЬ] Распаковываю выбранный бэкап во временный каталог...');
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
    originalAtDir = false;
    try {
      fs.renameSync(staging, dir);
      staging = null;
    } catch (e) {
      try {
        fs.renameSync(rollback, dir);
        rollback = null;
        originalAtDir = true;
      }
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
  } catch (e) {
    const error = normalizedBackupError(e, 'Не удалось восстановить бэкап');
    manager.pushLine(id, '[ПАНЕЛЬ] Восстановление не выполнено: ' + error.message);
    throw error;
  } finally {
    removeTemp(staging);
    // Если swap оборвался между rename, исходный каталог должен вернуться на место.
    if (!successful && rollback && fs.existsSync(rollback) && !fs.existsSync(dir)) {
      try {
        fs.renameSync(rollback, dir);
        rollback = null;
        originalAtDir = true;
      } catch (e) { /* ошибка уже будет видна вызывающему коду */ }
    }
    // Если исходный каталог гарантированно остался/вернулся на место, аварийный
    // before-restore больше не нужен. Иначе повторные попытки сами заполняли диск.
    if (!successful && protectiveFile && originalAtDir && fs.existsSync(dir)) {
      try {
        fs.rmSync(protectiveFile, { force: true });
        manager.pushLine(id, '[ПАНЕЛЬ] Неиспользованный защитный бэкап после ошибки удалён.');
      } catch (e) {
        manager.pushLine(id, '[ПАНЕЛЬ] Не удалось удалить защитный бэкап после ошибки — удалите его вручную.');
      }
    }
    manager.endRestore(id, successful);
  }
}

module.exports = { listBackups, createBackup, deleteBackup, restoreBackup, backupFilePath };
