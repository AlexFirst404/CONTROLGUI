'use strict';
const fs = require('fs');
const path = require('path');

const SKIP_SCAN_DIRS = new Set([
  '.git', 'libraries', 'versions', 'logs', 'crash-reports', 'cache', 'caches',
  'downloads', 'backups', 'plugins', 'mods', 'config', 'defaultconfigs', 'kubejs',
]);
const MAX_SCANNED_DIRS = 2000;
const MAX_WORLD_DEPTH = 3;

function uuidKey(value) {
  const raw = String(value || '').trim().toLowerCase();
  const compact = raw.replace(/-/g, '');
  return /^[0-9a-f]{32}$/.test(compact) ? compact : null;
}

function safeErrorMessage(error) {
  const code = error && error.code ? String(error.code) : '';
  if (code === 'EACCES' || code === 'EPERM') return 'Нет доступа к файлу или папке';
  if (code === 'EBUSY') return 'Файл занят другим процессом';
  if (code === 'EROFS') return 'Файловая система доступна только для чтения';
  if (code === 'ENOSPC') return 'На диске нет свободного места';
  return code ? 'Ошибка файловой системы (' + code + ')' : 'Ошибка файловой системы';
}

function relativeLabel(root, target) {
  const rel = path.relative(root, target);
  return (rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : path.basename(target))
    .split(path.sep).join('/');
}

function addError(result, scope, root, target, error, message) {
  result.errors.push({
    scope,
    path: relativeLabel(root, target),
    message: message || safeErrorMessage(error),
    code: error && error.code ? String(error.code) : undefined,
  });
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/* Миры с произвольным именем распознаём только по level.dat/uid.dat. Это не даёт
   принять plugins/<плагин>/stats за ванильную статистику игрока. Явный level-name
   и его Bukkit-соседи добавляем даже до первого запуска, когда level.dat ещё нет. */
function findWorldRoots(serverRoot, primaryWorld, io, result) {
  const root = io.realpathSync.native ? io.realpathSync.native(serverRoot) : io.realpathSync(serverRoot);
  const found = new Map();
  const explicit = [];
  if (primaryWorld) {
    const primary = path.resolve(primaryWorld);
    if (isInside(root, primary)) {
      explicit.push(primary, primary + '_nether', primary + '_the_end');
    } else {
      addError(result, 'scan', root, primary, null, 'level-name выходит за пределы папки сервера');
    }
  }
  const addWorld = (candidate, required) => {
    let stat;
    try { stat = io.lstatSync(candidate); }
    catch (e) {
      if (required && (!e || e.code !== 'ENOENT')) addError(result, 'scan', root, candidate, e);
      return false;
    }
    if (stat.isSymbolicLink()) {
      if (required) addError(result, 'scan', root, candidate, null,
        'Папка мира является ссылкой или junction и безопасно пропущена');
      return false;
    }
    if (!stat.isDirectory()) return false;
    let real;
    try { real = io.realpathSync.native ? io.realpathSync.native(candidate) : io.realpathSync(candidate); }
    catch (e) { if (required) addError(result, 'scan', root, candidate, e); return false; }
    if (!isInside(root, real)) {
      if (required) addError(result, 'scan', root, candidate, null, 'Папка мира выходит за пределы сервера');
      return false;
    }
    found.set(real, real);
    return true;
  };
  for (const candidate of explicit) addWorld(candidate, candidate === explicit[0]);

  const queue = [{ dir: root, depth: 0 }];
  let scanned = 0;
  while (queue.length) {
    const item = queue.shift();
    const current = item.dir;
    if (++scanned > MAX_SCANNED_DIRS) {
      addError(result, 'scan', root, current, null,
        'Проверено слишком много папок; часть нестандартно вложенных миров могла остаться');
      break;
    }
    let entries;
    try { entries = io.readdirSync(current, { withFileTypes: true }); }
    catch (e) { addError(result, 'scan', root, current, e); continue; }
    const marker = entries.some((entry) => entry && !entry.isDirectory() &&
      ['level.dat', 'level.dat_old', 'uid.dat'].includes(String(entry.name || '').toLowerCase()));
    if (marker) {
      addWorld(current, false);
      if (current !== root) continue; // region/datapacks мира не содержат другие world-root
    }
    if (item.depth >= MAX_WORLD_DEPTH) continue;
    for (const entry of entries) {
      if (!entry || !entry.name || entry.name === '.' || entry.name === '..') continue;
      const target = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (!entry.isDirectory()) continue;
      if (!SKIP_SCAN_DIRS.has(entry.name.toLowerCase())) queue.push({ dir: target, depth: item.depth + 1 });
    }
  }
  result.scannedDirs = scanned;
  return { root, found: Array.from(found.values()) };
}

function findStorageDirs(worlds, io, result) {
  const layouts = [
    ['playerdata', 'dat'], ['stats', 'json'], ['advancements', 'json'],
    [path.join('players', 'data'), 'dat'],
    [path.join('players', 'stats'), 'json'],
    [path.join('players', 'advancements'), 'json'],
  ];
  const found = [];
  for (const world of worlds.found) {
    for (const [rel, kind] of layouts) {
      const target = path.join(world, rel);
      let stat;
      try { stat = io.lstatSync(target); }
      catch (e) {
        if (e && e.code === 'ENOENT') continue;
        addError(result, 'scan', worlds.root, target, e);
        continue;
      }
      if (stat.isSymbolicLink()) {
        addError(result, 'scan', worlds.root, target, null,
          'Хранилище игрока является ссылкой или junction и безопасно пропущено');
      } else if (stat.isDirectory()) {
        found.push({ dir: target, kind });
      }
    }
  }
  return { root: worlds.root, found };
}

function uuidFromFile(name, kind) {
  const lower = String(name || '').toLowerCase();
  let base = null;
  if (kind === 'dat') {
    if (lower.endsWith('.dat_old')) base = lower.slice(0, -8);
    else if (lower.endsWith('.dat')) base = lower.slice(0, -4);
  } else if (kind === 'json' && lower.endsWith('.json')) {
    base = lower.slice(0, -5);
  }
  return base == null ? null : uuidKey(base);
}

function removeUuidFiles(serverRoot, primaryWorld, uuids, ioOverride, resolveTarget) {
  const io = ioOverride || fs;
  const keys = new Set((uuids || []).map(uuidKey).filter(Boolean));
  const result = { removed: [], errors: [], scannedDirs: 0, worldDirs: 0, storageDirs: 0 };
  if (!keys.size) return result;

  let scan;
  try {
    const worlds = findWorldRoots(serverRoot, primaryWorld, io, result);
    result.worldDirs = worlds.found.length;
    scan = findStorageDirs(worlds, io, result);
  }
  catch (e) {
    addError(result, 'scan', path.resolve(serverRoot), serverRoot, e);
    return result;
  }
  result.storageDirs = scan.found.length;

  for (const storage of scan.found) {
    let entries;
    try { entries = io.readdirSync(storage.dir, { withFileTypes: true }); }
    catch (e) { addError(result, 'scan', scan.root, storage.dir, e); continue; }
    for (const entry of entries) {
      const key = uuidFromFile(entry.name, storage.kind);
      if (!key || !keys.has(key)) continue;
      const target = path.join(storage.dir, entry.name);
      if (entry.isDirectory()) {
        addError(result, 'file', scan.root, target, null,
          'Ожидался файл данных игрока, но найдена папка');
        continue;
      }
      let unlinkTarget = target;
      if (typeof resolveTarget === 'function') {
        const rel = path.relative(scan.root, target);
        try {
          // Финальная проверка выполняется непосредственно перед unlink: каталог мира
          // мог быть заменён на symlink/junction уже после безопасного сканирования.
          unlinkTarget = resolveTarget(rel.split(path.sep).join('/'));
        } catch (e) {
          addError(result, 'file', scan.root, target, e, 'Путь к данным игрока перестал быть безопасным');
          continue;
        }
      }
      try {
        // unlink удаляет саму ссылку, если UUID-файл оказался symlink, и не трогает её цель.
        io.unlinkSync(unlinkTarget);
        result.removed.push(relativeLabel(scan.root, target));
      } catch (e) {
        if (!e || e.code !== 'ENOENT') addError(result, 'file', scan.root, target, e);
      }
    }
  }
  return result;
}

function filterUserCache(cache, name, uuids) {
  if (!Array.isArray(cache)) throw new Error('usercache.json имеет неверный формат');
  const normName = String(name || '').trim().toLowerCase();
  const keys = new Set((uuids || []).map(uuidKey).filter(Boolean));
  const kept = [];
  let removed = 0;
  for (const entry of cache) {
    const sameName = entry && String(entry.name || '').trim().toLowerCase() === normName;
    const key = entry && uuidKey(entry.uuid);
    if (sameName || (key && keys.has(key))) removed++;
    else kept.push(entry);
  }
  return { cache: kept, removed };
}

module.exports = { uuidKey, removeUuidFiles, filterUserCache };
