'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { ROOT, serverDir, DATA_ROOT, DATA_DIR, SERVERS_DIR, readLaunchMode, writeLaunchMode, readTrayMinimize, writeTrayMinimize } = require('./paths');
const store = require('./store');
const props = require('./properties');
const dl = require('./download');
const manager = require('./manager');
const nbt = require('./nbt');
const nbtedit = require('./nbtedit');
const snbt = require('./snbt');
const users = require('./users');
const backups = require('./backups');
const coreinfo = require('./coreinfo');
const modrinth = require('./modrinth');
const proxy = require('./proxy');
const javainstall = require('./javainstall');
const remoteaccess = require('./remoteaccess');
const remoteclient = require('./remoteclient');
const unzip = require('./unzip');
const zip = require('./zip');
const playerdata = require('./playerdata');
const updates = require('./updates');
const modassets = require('./modassets');
const VERSION = require('./version');
const zlib = require('zlib');

const TYPES = ['vanilla', 'paper', 'purpur', 'folia', 'mohist', 'forge', 'velocity', 'bungeecord', 'custom'];

/* Готовые пресеты команды запуска (переменные {{SERVER_MEMORY}} — Xmx в МБ,
   {{SERVER_JARFILE}} — имя jar). Пустая cmd = дефолтная сборка аргументов панелью. */
const LAUNCH_PRESETS = [
  { name: 'По умолчанию (панель сама подберёт флаги)', cmd: '' },
  { name: 'Aikar — оптимизация для Paper/Purpur (Java 17+, MC 1.18+)', cmd: 'java -Xms128M -Xmx{{SERVER_MEMORY}}M --add-modules=jdk.incubator.vector -XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200 -XX:+UnlockExperimentalVMOptions -XX:+DisableExplicitGC -XX:+AlwaysPreTouch -XX:G1HeapWastePercent=5 -XX:G1MixedGCCountTarget=4 -XX:InitiatingHeapOccupancyPercent=15 -XX:G1MixedGCLiveThresholdPercent=90 -XX:G1RSetUpdatingPauseTimePercent=5 -XX:SurvivorRatio=32 -XX:+PerfDisableSharedMem -XX:MaxTenuringThreshold=1 -Dusing.aikars.flags=https://mcflags.emc.gs -Daikars.new.flags=true -XX:G1NewSizePercent=30 -XX:G1MaxNewSizePercent=40 -XX:G1HeapRegionSize=8M -XX:G1ReservePercent=20 -DPaper.IgnoreJavaVersion=true -jar {{SERVER_JARFILE}}' },
  { name: 'Aikar классический (без Vector, Java 8+)', cmd: 'java -Xms128M -Xmx{{SERVER_MEMORY}}M -XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200 -XX:+UnlockExperimentalVMOptions -XX:+DisableExplicitGC -XX:+AlwaysPreTouch -XX:G1NewSizePercent=30 -XX:G1MaxNewSizePercent=40 -XX:G1HeapRegionSize=8M -XX:G1ReservePercent=20 -XX:G1HeapWastePercent=5 -XX:G1MixedGCCountTarget=4 -XX:InitiatingHeapOccupancyPercent=15 -XX:G1MixedGCLiveThresholdPercent=90 -XX:G1RSetUpdatingPauseTimePercent=5 -XX:SurvivorRatio=32 -XX:+PerfDisableSharedMem -XX:MaxTenuringThreshold=1 -Dusing.aikars.flags=https://mcflags.emc.gs -Daikars.new.flags=true -jar {{SERVER_JARFILE}}' },
  { name: 'Лёгкий (маленький сервер / слабое железо)', cmd: 'java -Xms128M -Xmx{{SERVER_MEMORY}}M -XX:+UseG1GC -XX:G1HeapRegionSize=4M -XX:+UnlockExperimentalVMOptions -XX:+ParallelRefProcEnabled -XX:+AlwaysPreTouch -XX:MaxInlineLevel=15 -jar {{SERVER_JARFILE}}' },
];
/* Список .jar в корне сервера (для выбора файла запуска). */
function listServerJars(serverId) {
  try {
    return fs.readdirSync(serverDir(serverId))
      .filter((f) => /\.jar$/i.test(f) && !/\.disabled$/i.test(f))
      .sort();
  } catch (e) { return []; }
}
const GAMEMODES = ['survival', 'creative', 'adventure', 'spectator'];
const DIFFICULTIES = ['peaceful', 'easy', 'normal', 'hard'];

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024 * 4) {
        reject(Object.assign(new Error('Слишком большое тело запроса'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(Object.assign(new Error('Некорректный JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

function writeFileAtomic(file, data) {
  const tmp = path.join(path.dirname(file), '.' + path.basename(file) + '.' + process.pid + '.' +
    crypto.randomBytes(6).toString('hex') + '.tmp');
  let mode = 0o600;
  try { mode = fs.statSync(file).mode & 0o777; } catch (e) { /* новый файл */ }
  try {
    fs.writeFileSync(tmp, data, { mode });
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch (removeError) { /* tmp мог не создаться */ }
    throw e;
  }
}

function validatedServerPort(serverId, value) {
  const raw = String(value == null ? '' : value).trim();
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(port) || port < 1024 || port > 65535) {
    throw fail(400, 'Порт сервера: целое число от 1024 до 65535');
  }
  const conflict = store.all().find((candidate) => candidate.id !== serverId && candidate.port === port);
  if (conflict) throw fail(409, 'Порт ' + port + ' уже занят сервером «' + conflict.name + '»');
  return port;
}

function isRootServerProperties(serverId, absolutePath) {
  return path.relative(path.join(serverDir(serverId), 'server.properties'), absolutePath) === '';
}

/* Файл и порт в реестре меняются как одна логическая операция. Если запись
   servers.json не удалась, возвращаем исходный server.properties. */
function saveServerProperties(server, content, registryPatch) {
  if (proxy.isProxyType(server.type)) {
    throw fail(400, 'У Velocity/BungeeCord нет server.properties — изменяйте их собственный конфиг во вкладке «Файлы»');
  }
  const file = path.join(serverDir(server.id), 'server.properties');
  const parsed = props.parse(content);
  const port = validatedServerPort(server.id,
    Object.prototype.hasOwnProperty.call(parsed, 'server-port') ? parsed['server-port'] : 25565);
  const linkedProxy = port !== server.port && store.all().find((candidate) =>
    proxy.isProxyType(candidate.type) && (candidate.proxyServers || []).some((item) => item.id === server.id));
  if (linkedProxy) {
    throw fail(409, 'Сначала отключите сервер от прокси «' + linkedProxy.name + '», затем измените порт и подключите снова');
  }
  const patch = Object.assign({}, registryPatch || {}, { port });
  const existed = fs.existsSync(file);
  const before = existed ? fs.readFileSync(file) : null;
  writeFileAtomic(file, content);
  try {
    return store.update(server.id, patch);
  } catch (e) {
    try {
      if (existed) writeFileAtomic(file, before);
      else fs.rmSync(file, { force: true });
    } catch (rollbackError) {
      e.message += '; не удалось вернуть исходный server.properties: ' + rollbackError.message;
    }
    throw e;
  }
}

/* Операции с прокси иногда меняют каталоги сразу нескольких серверов. Сначала
   проверяем весь набор, затем синхронно отмечаем его: restore либо уже виден нам,
   либо увидит activeMutations и не сможет начать посреди серии записей. */
function acquireServerMutations(servers, message) {
  const runtimes = [];
  const seen = new Set();
  for (const server of servers) {
    if (!server || seen.has(server.id)) continue;
    seen.add(server.id);
    const runtime = manager.getState(server.id);
    if (runtime.restoring) {
      throw fail(409, message || 'Нельзя изменить сервер: идёт восстановление бэкапа');
    }
    if (runtime.activeMutations > 0) {
      throw fail(409, 'Дождитесь завершения текущей операции с сервером');
    }
    runtimes.push(runtime);
  }
  for (const runtime of runtimes) runtime.activeMutations += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const runtime of runtimes) {
      runtime.activeMutations = Math.max(0, runtime.activeMutations - 1);
    }
  };
}

/* Проверка права текущего пользователя (req.cgUser ставит server.js). */
function requirePerm(req, key) {
  const u = req.cgUser;
  if (!users.hasPerm(u, key)) throw fail(403, 'Недостаточно прав для этого действия');
}
function requireAnyPerm(req, keys) {
  const u = req.cgUser;
  if (!keys.some((k) => users.hasPerm(u, k))) throw fail(403, 'Недостаточно прав для этого действия');
}
/* Проверка права на ДРУГОЙ сервер, чем целевой (напр. привязка к прокси меняет и прокси).
   Локально — полный доступ; удалённо — по правам пользователя ИМЕННО на этот сервер. */
function requirePermOn(req, key, serverId) {
  if (!req.cgRemote) return; // локальный владелец
  if (!users.canAccessServer(req.cgUser, serverId)) throw fail(403, 'Нет доступа к этому серверу');
  const p = req.cgRemoteUser ? users.permsForServer(req.cgRemoteUser, serverId) : {};
  if (!p.admin && !p[key]) throw fail(403, 'Недостаточно прав для этого сервера');
}
// запрос пришёл через HTTPS-листенер удалённого доступа (после пароля — полные права;
// флаг нужен только для операций, имеющих смысл лишь на локальной машине)
function isRemoteReq(req) { return !!(req && req.cgRemote); }
// маппинг действия модерации -> своё право (op/deop НЕ должны падать под players.ban)
const MODERATE_PERM = { kick: 'players.kick', op: 'players.op', deop: 'players.op', ban: 'players.ban', pardon: 'players.ban' };
const ANY_BACKUP = ['backups.create', 'backups.restore', 'backups.delete'];
const ANY_PLAYER_DETAILS = ['files.read', 'players.kick', 'players.ban', 'players.op', 'players.whitelist', 'players.delete'];

function itemAssetId(value) {
  const id = String(value || '').trim();
  if (!id || id.length > 256) throw fail(400, 'Некорректный ID предмета');
  const match = /^([a-z0-9_.-]+):([a-z0-9_.-]+(?:\/[a-z0-9_.-]+)*)$/.exec(id);
  if (!match || match[2].split('/').some((part) => part === '.' || part === '..')) {
    throw fail(400, 'Некорректный ID предмета');
  }
  return id;
}

function readBanned(serverId) {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(serverDir(serverId), 'banned-players.json'), 'utf8'));
    return Array.isArray(list) ? list.map((e) => e.name).filter(Boolean) : [];
  } catch (e) { return []; }
}

function readOps(serverId) {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(serverDir(serverId), 'ops.json'), 'utf8'));
    return Array.isArray(list) ? list.map((e) => e.name).filter(Boolean) : [];
  } catch (e) { return []; }
}

/* Рантайм-игроки + история панели + usercache сервера:
   список переживает рестарты панели и показывает всех заходивших */
function combinedPlayers(serverId, includeIps) {
  // Возвращаем копии: редактирование IP в представлении не должно затирать
  // runtime-историю менеджера для последующих запросов с большими правами.
  const live = manager.playersView(serverId).map((p) => Object.assign({}, p, {
    ip: includeIps ? (p.ip || null) : null,
  }));
  const norm = (x) => manager.stripAnsi(String(x)).toLowerCase();
  const seen = new Set(live.map((p) => norm(p.name)));
  const result = live.slice();
  const add = (name, uuid, ip, lastSeen) => {
    if (!name || seen.has(norm(name))) return;
    seen.add(norm(name));
    result.push({
      name, uuid: uuid || null, ip: includeIps ? (ip || null) : null, online: false,
      joinedAt: null, lastSeen: lastSeen || null, loginPos: null,
      advancements: 0, lastAdvancement: null,
    });
  };
  for (const h of manager.historyView(serverId)) {
    add(h.name, h.uuid, h.ips && h.ips[0], h.lastJoinAt);
  }
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(serverDir(serverId), 'usercache.json'), 'utf8')) || [];
    for (const e of cache) add(e.name, e.uuid, null, null);
  } catch (e) { /* нет файла */ }
  return result;
}

function viewPermissions(req, serverId) {
  if (!req || !req.cgUser) return {};
  if (!isRemoteReq(req)) return { admin: true };
  const raw = req.cgRemoteUser
    ? users.permsForServer(req.cgRemoteUser, serverId)
    : (req.cgUser.perms || {});
  const clean = users.sanitizePerms(raw);
  if (raw && raw.admin) clean.admin = true;
  return clean;
}

function permissionsAllowPlayerIps(permissions) {
  return !!(permissions && (permissions.admin || permissions['players.kick'] ||
    permissions['players.ban'] || permissions['players.delete']));
}

function serverView(server, req) {
  const s = manager.getState(server.id);
  const jarReady = manager.isLaunchReady(server);
  const permissions = viewPermissions(req, server.id);
  let status = s.status;
  if (s.restoring) {
    status = 'restoring';
  } else if (!s.proc && manager.orphanAlive(server.id)) {
    status = 'orphaned';
  } else if (s.download && s.download.phase !== 'done') {
    status = s.download.phase === 'error' ? 'error' : 'downloading';
  } else if (!jarReady && !s.proc) {
    status = 'no-jar';
  }
  return {
    id: server.id,
    name: server.name,
    type: server.type,
    version: server.version,
    port: server.port,
    memoryMb: server.memoryMb,
    cpuPercent: server.cpuPercent == null ? null : server.cpuPercent,
    javaPath: server.javaPath || '',
    plugins: modrinth.supportsPlugins(server.type),
    mods: modrinth.supportsMods(server.type),
    proxy: !!server.proxy,
    proxyServers: server.proxyServers || [],
    createdAt: server.createdAt,
    creatorUsername: server.creatorUsername || null,
    status,
    restoring: !!s.restoring,
    permissions,
    players: Array.from(s.players),
    playersInfo: combinedPlayers(server.id, permissionsAllowPlayerIps(permissions)),
    banned: readBanned(server.id),
    ops: readOps(server.id),
    download: s.download,
    jarReady,
    startedAt: s.startedAt,
    tps: s.tps != null && Date.now() - s.tpsAt < 30000 ? s.tps : null,
    tpsSupported: manager.supportsTps(server),
    hasIcon: iconMtime(server.id),
    inPlace: !!server.dir, // импортирован «на месте» (внешняя папка пользователя)
    path: req && !isRemoteReq(req) ? serverDir(server.id) : '', // безопасный default: без req абсолютный путь не раскрываем
  };
}

/* mtime иконки сервера (для кэш-бастинга в UI) либо 0, если иконки нет */
function iconMtime(serverId) {
  try { return Math.round(fs.statSync(path.join(serverDir(serverId), 'server-icon.png')).mtimeMs); }
  catch (e) { return 0; }
}

// ---- файловый менеджер: только внутри каталога сервера ----

function safePath(serverId, rel) {
  const base = path.resolve(serverDir(serverId));
  const clean = path.normalize(String(rel || '').replace(/^[/\\]+/, ''));
  if (clean.split(/[\\/]/).includes('..')) throw fail(400, 'Недопустимый путь');
  // Windows: относительный путь не может содержать ':' — это либо буква диска,
  // либо альтернативный поток NTFS (name::$DATA) в обход блок-листа. Запрещаем.
  if (process.platform === 'win32' && clean.indexOf(':') !== -1) throw fail(400, 'Недопустимый путь');
  const abs = path.resolve(base, clean);
  const lexicalRelative = path.relative(base, abs);
  if (lexicalRelative.startsWith('..') || path.isAbsolute(lexicalRelative)) throw fail(400, 'Недопустимый путь');

  // path.resolve защищает только от «..». fs всё равно прошёл бы через symlink/
  // junction наружу (особенно опасно для удалённого файлового API). Проверяем
  // каждый уже существующий компонент и канонический ближайший родитель.
  let baseReal;
  try { baseReal = fs.realpathSync.native(base); }
  catch (e) { throw fail(404, 'Папка сервера не найдена'); }
  let cursor = base;
  const parts = lexicalRelative ? lexicalRelative.split(path.sep).filter(Boolean) : [];
  for (const part of parts) {
    cursor = path.join(cursor, part);
    try {
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink()) throw fail(400, 'Ссылки и junction внутри папки сервера недоступны');
    } catch (e) {
      if (e && e.status) throw e;
      if (e && e.code === 'ENOENT') break;
      throw e;
    }
  }
  let existing = abs;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) throw fail(400, 'Недопустимый путь');
    existing = parent;
  }
  let existingReal;
  try { existingReal = fs.realpathSync.native(existing); }
  catch (e) { throw fail(400, 'Недопустимый путь'); }
  const realRelative = path.relative(baseReal, existingReal);
  if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) throw fail(400, 'Недопустимый путь');
  return abs;
}

/* Файловый менеджер тоже может заменить JAR в mods/. Сбрасываем индекс сразу,
   чтобы следующий открытый инвентарь не ждал периодической проверки mtime. */
function invalidateModAssetsForPath(serverId, absolutePath) {
  try {
    const modsDir = path.resolve(serverDir(serverId), 'mods');
    const target = path.resolve(absolutePath);
    const rel = path.relative(modsDir, target);
    if (rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep))) {
      modassets.invalidate(modsDir);
    }
  } catch (e) { /* кэш всё равно перепроверит каталог по mtime */ }
}

function listDir(serverId, rel) {
  const abs = safePath(serverId, rel);
  const items = fs.readdirSync(abs, { withFileTypes: true }).map((entry) => {
    let size = 0;
    let mtime = 0;
    try {
      const st = fs.statSync(path.join(abs, entry.name));
      size = st.size;
      mtime = st.mtimeMs;
    } catch (e) { /* файл исчез между readdir и stat */ }
    return { name: entry.name, dir: entry.isDirectory(), size, mtime };
  });
  items.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
  return items;
}

const MAX_EDIT_SIZE = 1024 * 1024;         // редактор: до 1 МБ
const MAX_UPLOAD_SIZE = 256 * 1024 * 1024; // загрузка: до 256 МБ

function readTextFile(serverId, rel) {
  const abs = safePath(serverId, rel);
  const st = fs.statSync(abs);
  if (st.isDirectory()) throw fail(400, 'Это папка');
  if (st.size > MAX_EDIT_SIZE) return { binary: true, size: st.size, reason: 'Файл больше 1 МБ' };
  const buf = fs.readFileSync(abs);
  if (buf.subarray(0, 8000).includes(0)) return { binary: true, size: st.size, reason: 'Двоичный файл' };
  return { content: buf.toString('utf8'), size: st.size };
}

function receiveUpload(req, serverId, rel) {
  const abs = safePath(serverId, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  return new Promise((resolve, reject) => {
    const tmp = path.join(path.dirname(abs), '.' + path.basename(abs) + '.upload-' + process.pid + '-' +
      crypto.randomBytes(6).toString('hex') + '.tmp');
    let size = 0;
    let failed = false;
    let finished = false;
    let settled = false;
    let mode = 0o600;
    try { mode = fs.statSync(abs).mode & 0o777; } catch (e) { /* новый файл */ }
    const out = fs.createWriteStream(tmp, { flags: 'wx', mode });
    const cleanupAndReject = (error) => {
      if (settled) return;
      settled = true;
      failed = true;
      try { out.destroy(); } catch (e) { /* поток уже закрыт */ }
      req.resume();
      fs.rm(tmp, { force: true }, () => reject(error));
    };
    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > MAX_UPLOAD_SIZE) return cleanupAndReject(fail(413, 'Файл слишком большой (макс. 256 МБ)'));
      if (!out.write(chunk)) req.pause();
    });
    req.on('end', () => { if (!failed) out.end(); });
    req.on('aborted', () => cleanupAndReject(fail(400, 'Загрузка прервана')));
    req.on('error', cleanupAndReject);
    out.on('drain', () => { if (!failed) req.resume(); });
    out.on('finish', () => { finished = true; });
    out.on('error', cleanupAndReject);
    out.on('close', () => {
      if (failed || settled) return;
      if (!finished) return cleanupAndReject(new Error('Не удалось полностью записать загружаемый файл'));
      try {
        fs.renameSync(tmp, abs);
        settled = true;
        resolve();
      } catch (e) {
        cleanupAndReject(e);
      }
    });
  });
}

// ---- подробности игрока: usercache + статистика мира + NBT-инвентарь ----

function levelName(serverId) {
  try {
    const text = fs.readFileSync(path.join(serverDir(serverId), 'server.properties'), 'utf8');
    return props.parse(text)['level-name'] || 'world';
  } catch (e) { return 'world'; }
}

function playerWorldDir(serverId) {
  // level-name редактируется пользователем и не может миновать общий path guard.
  return safePath(serverId, levelName(serverId));
}

function normalizePlayerUuid(value) {
  const uuid = String(value || '').trim().toLowerCase();
  if (/^[0-9a-f]{32}$/.test(uuid) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid)) {
    return uuid;
  }
  return null;
}

function findUuid(server, name) {
  // 1) рантайм (из лога)
  const live = manager.playersView(server.id).find((p) => p.name.toLowerCase() === name.toLowerCase());
  if (live && live.uuid) {
    const uuid = normalizePlayerUuid(live.uuid);
    if (uuid) return uuid;
  }
  // 2) usercache.json
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(serverDir(server.id), 'usercache.json'), 'utf8'));
    const hit = (cache || []).find((e) => e.name && e.name.toLowerCase() === name.toLowerCase());
    if (hit && hit.uuid) return normalizePlayerUuid(hit.uuid);
  } catch (e) { /* нет файла */ }
  return null;
}

function firstExisting(paths) {
  for (const p of paths) {
    try { if (fs.existsSync(p)) return p; } catch (e) { /* пропускаем */ }
  }
  return null;
}

// слоты экипировки (с новых версий броня хранится отдельно от Inventory)
const EQUIPMENT_SLOTS = { head: 103, chest: 102, legs: 101, feet: 100, offhand: -106 };

/* Текстовый компонент Minecraft (JSON-строка, массив или {text,extra,...})
   → простой текст. */
function componentText(v) {
  if (v == null) return '';
  if (typeof v === 'string') {
    const s = v.trim();
    if (s && (s[0] === '{' || s[0] === '[' || s[0] === '"')) {
      try { return componentText(JSON.parse(s)); } catch (e) { return s.replace(/^"|"$/g, ''); }
    }
    return s;
  }
  if (Array.isArray(v)) return v.map(componentText).join('');
  if (typeof v === 'object') {
    let out = v.text != null ? String(v.text) : (v.translate != null ? String(v.translate) : '');
    if (Array.isArray(v.extra)) out += v.extra.map(componentText).join('');
    return out;
  }
  return String(v);
}

function prettyMcId(id) {
  return String(id).replace(/^minecraft:/, '').replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/* Зачарования из разных форматов: components ({levels:{id:lvl}} или {id:lvl}),
   старый tag.Enchantments ([{id,lvl}]). */
function readEnchants(src, stored, out) {
  if (!src) return;
  const levels = (src.levels && typeof src.levels === 'object') ? src.levels : src;
  if (Array.isArray(levels)) {
    for (const e of levels) {
      if (e && e.id != null) out.push({ name: prettyMcId(e.id), level: e.lvl != null ? e.lvl : (e.level != null ? e.level : 1), stored });
    }
  } else if (levels && typeof levels === 'object') {
    for (const [k, v] of Object.entries(levels)) {
      if (k === 'levels') continue;
      out.push({ name: prettyMcId(k), level: typeof v === 'number' ? v : parseInt(v, 10) || 1, stored });
    }
  }
}

/* Атрибуты предмета (имя, зачарования, лор, повреждение) из tag/components. */
function itemAttrs(raw) {
  const tag = raw.tag || {};
  const comp = raw.components || {};
  const attrs = {};

  const nameSrc = comp['minecraft:custom_name'] != null ? comp['minecraft:custom_name'] : (tag.display && tag.display.Name);
  if (nameSrc != null) { const t = componentText(nameSrc).trim(); if (t) attrs.name = t; }

  const loreSrc = comp['minecraft:lore'] != null ? comp['minecraft:lore'] : (tag.display && tag.display.Lore);
  if (Array.isArray(loreSrc)) {
    const lore = loreSrc.map(componentText).map((s) => s.trim()).filter(Boolean);
    if (lore.length) attrs.lore = lore;
  }

  const ench = [];
  readEnchants(comp['minecraft:enchantments'] || tag.Enchantments || tag.ench, false, ench);
  readEnchants(comp['minecraft:stored_enchantments'] || tag.StoredEnchantments, true, ench);
  if (ench.length) attrs.enchants = ench;

  const dmg = comp['minecraft:damage'] != null ? comp['minecraft:damage'] : tag.Damage;
  if (dmg != null && Number(dmg) > 0) attrs.damage = Number(dmg);
  if (comp['minecraft:unbreakable'] != null || tag.Unbreakable) attrs.unbreakable = true;

  // сырые NBT-теги (компоненты 1.20.5+ или legacy tag) — для показа в подсказке
  const rawNbt = Object.keys(comp).length ? comp : (Object.keys(tag).length ? tag : null);
  if (rawNbt) {
    try {
      let s = JSON.stringify(rawNbt);
      if (s && s !== '{}') { if (s.length > 700) s = s.slice(0, 700) + '…'; attrs.nbt = s; }
    } catch (e) { /* несериализуемо — пропускаем */ }
  }

  return attrs;
}

function itemFromNbt(raw, slot) {
  const rawId = String(raw.id || '').trim();
  const resourceId = rawId.includes(':') ? rawId : ('minecraft:' + rawId);
  const components = raw.components && typeof raw.components === 'object' ? raw.components : {};
  const itemModel = typeof components['minecraft:item_model'] === 'string'
    ? components['minecraft:item_model'].trim() : '';
  const item = {
    slot: slot != null ? slot : (raw.Slot != null ? raw.Slot : -1),
    // `id` оставляем совместимым со старыми клиентами, а полные resource ID
    // нужны для модовых ассетов и компонента item_model в новых версиях.
    id: rawId.replace(/^minecraft:/, ''),
    resourceId,
    iconId: itemModel || resourceId,
    count: raw.count != null ? raw.count : (raw.Count != null ? raw.Count : 1),
  };
  return Object.assign(item, itemAttrs(raw));
}

function inventoryFromRoot(root) {
  const inventory = (root.Inventory || []).map((item) => itemFromNbt(item));
  const equipment = root.equipment || {};
  for (const [key, slot] of Object.entries(EQUIPMENT_SLOTS)) {
    const item = equipment[key];
    if (item && item.id && !inventory.some((it) => it.slot === slot)) {
      inventory.push(itemFromNbt(item, slot));
    }
  }
  return inventory;
}

// макс. здоровье из списка атрибутов (attributes/id/base — новые версии,
// Attributes/Name/Base — старые); без атрибута — ванильные 20
function maxHealthFromRoot(root) {
  const list = root.attributes || root.Attributes;
  if (Array.isArray(list)) {
    for (const a of list) {
      if (!a) continue;
      const id = a.id != null ? a.id : a.Name;
      if (id == null || !/max_?health/i.test(String(id))) continue;
      const base = a.base != null ? a.base : a.Base;
      if (base != null && isFinite(base)) return Math.round(base * 10) / 10;
    }
  }
  return 20;
}

function detailsFromRoot(root) {
  return {
    xpLevel: root.XpLevel != null ? root.XpLevel : null,
    health: root.Health != null ? Math.round(root.Health * 10) / 10 : null,
    maxHealth: maxHealthFromRoot(root),
    food: root.foodLevel != null ? root.foodLevel : null,
    pos: Array.isArray(root.Pos) ? root.Pos.map((v) => Math.round(v)) : null,
    dimension: root.Dimension != null ? String(root.Dimension).replace(/^minecraft:/, '') : null,
  };
}

async function playerDetails(server, name) {
  const uuid = findUuid(server, name);
  if (!uuid) throw fail(404, 'UUID игрока не найден — игрок ещё не заходил на сервер');
  const worldDir = playerWorldDir(server.id);
  const norm = (x) => manager.stripAnsi(String(x)).toLowerCase();
  const live = manager.playersView(server.id).find((p) => norm(p.name) === norm(name));
  const online = !!(live && live.online);

  // общее время игры из официальной статистики мира
  // (до MC 26 — world/stats, с MC 26 — world/players/stats)
  let playTimeTicks = null;
  let deaths = null;
  let playerKills = null;
  let mobKills = null;
  const statsPath = firstExisting([
    path.join(worldDir, 'stats', uuid + '.json'),
    path.join(worldDir, 'players', 'stats', uuid + '.json'),
  ]);
  try {
    const stats = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
    const custom = (stats.stats && stats.stats['minecraft:custom']) || {};
    playTimeTicks = custom['minecraft:play_time'];
    if (playTimeTicks == null) playTimeTicks = custom['minecraft:play_one_minute'];
    if (playTimeTicks == null && stats['stat.playOneMinute'] != null) playTimeTicks = stats['stat.playOneMinute'];
    const count = (value) => Number.isFinite(Number(value)) ? Math.max(0, Math.trunc(Number(value))) : 0;
    deaths = count(custom['minecraft:deaths'] != null ? custom['minecraft:deaths'] : stats['stat.deaths']);
    playerKills = count(custom['minecraft:player_kills'] != null ? custom['minecraft:player_kills'] : stats['stat.playerKills']);
    mobKills = count(custom['minecraft:mob_kills'] != null ? custom['minecraft:mob_kills'] : stats['stat.mobKills']);
  } catch (e) { /* статистики ещё нет */ }

  let inventory = null;
  let details = {};
  let lastPlayed = null;
  let realtime = false;

  // онлайн-игрок: живые данные через `data get entity` (без сохранения мира)
  if (online) {
    try {
      const raw = await manager.queryEntityData(server.id, manager.stripAnsi(live.name));
      if (raw) {
        const root = snbt.parse(raw);
        inventory = inventoryFromRoot(root);
        details = detailsFromRoot(root);
        lastPlayed = Date.now();
        realtime = true;
      }
    } catch (e) { /* парсинг не удался — ниже возьмём из сохранения */ }
  }

  // запасной путь: сохранение мира <world>/playerdata|players/data/<uuid>.dat
  if (!inventory) {
    try {
      const datPath = firstExisting([
        path.join(worldDir, 'playerdata', uuid + '.dat'),
        path.join(worldDir, 'players', 'data', uuid + '.dat'),
      ]);
      lastPlayed = fs.statSync(datPath).mtimeMs;
      const root = nbt.parse(fs.readFileSync(datPath));
      inventory = inventoryFromRoot(root);
      details = detailsFromRoot(root);
    } catch (e) { /* игрок без сохранения */ }
  }

  const history = manager.getHistory(server.id, name) || {};
  return Object.assign({
    name,
    uuid,
    online,
    realtime,
    sessionStartedAt: online ? live.joinedAt : null,
    playTimeTicks: playTimeTicks != null ? playTimeTicks : null,
    deaths,
    playerKills,
    mobKills,
    lastPlayed,
    firstJoinAt: history.firstJoinAt || null,
    lastJoinAt: history.lastJoinAt || null,
    ips: history.ips || [],
    inventory,
  }, details);
}

/* ── редактирование инвентаря и статов игрока ──────────────────────────── */

function mcVer(server) {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(server.version || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null;
}

function verAtLeast(v, maj, min, patch) {
  if (v[0] !== maj) return v[0] > maj;
  if (v[1] !== min) return v[1] > min;
  return v[2] >= (patch || 0);
}

function validEditSlot(s) {
  return Number.isInteger(s) && ((s >= 0 && s <= 35) || (s >= 100 && s <= 103) || s === -106);
}

// номер NBT-слота -> имя слота для команд /item и /replaceitem
function commandSlotRef(slot) {
  if (slot >= 0 && slot <= 8) return 'hotbar.' + slot;
  if (slot >= 9 && slot <= 35) return 'inventory.' + (slot - 9);
  if (slot === 100) return 'armor.feet';
  if (slot === 101) return 'armor.legs';
  if (slot === 102) return 'armor.chest';
  if (slot === 103) return 'armor.head';
  if (slot === -106) return 'weapon.offhand';
  return null;
}

async function playerEditOnline(server, live, op, arg) {
  const pname = manager.stripAnsi(live.name);
  // имя уходит в консольную команду — только безопасные символы
  if (!/^[A-Za-z0-9_.\-]{1,16}$/.test(pname)) throw fail(400, 'Имя игрока не подходит для команд — отредактируйте, когда игрок выйдет');
  const v = mcVer(server);
  const modernItem = !v || verAtLeast(v, 1, 17); // /item есть с 1.17; неизвестная версия — пробуем современный синтаксис
  if (op === 'stats') {
    const st = arg.stats;
    // сперва все проверки, потом команды — чтобы не применить статы частично
    if (st.food !== undefined) throw fail(409, 'Сытость можно менять только когда игрок оффлайн');
    if (st.maxHealth !== undefined && v && !verAtLeast(v, 1, 16)) throw fail(409, 'Макс. здоровье онлайн меняется только с MC 1.16 — либо когда игрок оффлайн');
    if (st.xpLevel !== undefined && v && !verAtLeast(v, 1, 13)) throw fail(409, 'Уровень опыта онлайн меняется только с MC 1.13 — либо когда игрок оффлайн');
    if (st.maxHealth !== undefined) {
      const attrId = !v || verAtLeast(v, 1, 21, 2) ? 'minecraft:max_health' : 'minecraft:generic.max_health';
      manager.sendCommand(server.id, 'attribute ' + pname + ' ' + attrId + ' base set ' + st.maxHealth);
    }
    if (st.xpLevel !== undefined) manager.sendCommand(server.id, 'xp set ' + pname + ' ' + st.xpLevel + ' levels');
    return { ok: true, via: 'command' };
  }
  if (op === 'delete') {
    const ref = commandSlotRef(arg.slot);
    if (modernItem) manager.sendCommand(server.id, 'item replace entity ' + pname + ' ' + ref + ' with minecraft:air');
    else if (v && verAtLeast(v, 1, 13)) manager.sendCommand(server.id, 'replaceitem entity ' + pname + ' ' + ref + ' minecraft:air');
    else throw fail(409, 'На этой версии удаление онлайн недоступно — выполните, когда игрок выйдет');
    return { ok: true, via: 'command' };
  }
  // перемещение: копируем предмет командой и очищаем исходный слот, поэтому
  // сперва сверяем актуальный инвентарь — иначе можно затереть чужой предмет
  if (!modernItem) throw fail(409, 'Перемещение онлайн доступно с MC 1.17 — либо когда игрок оффлайн');
  const raw = await manager.queryEntityData(server.id, pname);
  if (!raw) throw fail(409, 'Не удалось проверить инвентарь игрока — попробуйте ещё раз');
  const inv = inventoryFromRoot(snbt.parse(raw));
  if (!inv.some((it) => it.slot === arg.from)) throw fail(409, 'Исходный слот уже пуст');
  if (inv.some((it) => it.slot === arg.to)) throw fail(409, 'Слот занят: поменять предметы местами можно только когда игрок оффлайн');
  manager.sendCommand(server.id, 'item replace entity ' + pname + ' ' + commandSlotRef(arg.to) + ' from entity ' + pname + ' ' + commandSlotRef(arg.from));
  manager.sendCommand(server.id, 'item replace entity ' + pname + ' ' + commandSlotRef(arg.from) + ' with minecraft:air');
  return { ok: true, via: 'command' };
}

function playerEditOffline(server, name, op, arg) {
  const uuid = findUuid(server, name);
  if (!uuid) throw fail(404, 'UUID игрока не найден — игрок ещё не заходил на сервер');
  const worldDir = playerWorldDir(server.id);
  const datPath = firstExisting([
    path.join(worldDir, 'playerdata', uuid + '.dat'),
    path.join(worldDir, 'players', 'data', uuid + '.dat'),
  ]);
  if (!datPath) throw fail(404, 'Сохранение игрока не найдено');
  const parsed = nbtedit.readPlayerFile(datPath);
  try {
    if (op === 'move') nbtedit.moveSlot(parsed.root, arg.from, arg.to);
    else if (op === 'delete') nbtedit.deleteSlot(parsed.root, arg.slot);
    else nbtedit.setStats(parsed.root, arg.stats);
  } catch (e) { throw fail(400, e.message); }
  nbtedit.writePlayerFile(datPath, parsed);
  return { ok: true, via: 'file' };
}

async function playerEdit(server, body) {
  const name = String(body.name || '').trim();
  if (!name) throw fail(400, 'Не указано имя игрока');
  const op = String(body.op || '');
  const arg = {};
  if (op === 'move') {
    arg.from = Number(body.from); arg.to = Number(body.to);
    if (!validEditSlot(arg.from) || !validEditSlot(arg.to) || arg.from === arg.to) throw fail(400, 'Неверные слоты');
  } else if (op === 'delete') {
    arg.slot = Number(body.slot);
    if (!validEditSlot(arg.slot)) throw fail(400, 'Неверный слот');
  } else if (op === 'stats') {
    arg.stats = {};
    if (body.maxHealth !== undefined) {
      const x = Number(body.maxHealth);
      if (!isFinite(x) || x < 1 || x > 1024) throw fail(400, 'Макс. здоровье: число от 1 до 1024');
      arg.stats.maxHealth = Math.round(x * 2) / 2; // целые полусердца
    }
    if (body.food !== undefined) {
      const x = Number(body.food);
      if (!Number.isInteger(x) || x < 0 || x > 20) throw fail(400, 'Сытость: целое от 0 до 20');
      arg.stats.food = x;
    }
    if (body.xpLevel !== undefined) {
      const x = Number(body.xpLevel);
      if (!Number.isInteger(x) || x < 0 || x > 24791) throw fail(400, 'Уровень опыта: целое от 0 до 24791');
      arg.stats.xpLevel = x;
    }
    if (!Object.keys(arg.stats).length) throw fail(400, 'Нет изменений');
  } else throw fail(400, 'Недопустимое действие');

  const norm = (x) => manager.stripAnsi(String(x)).toLowerCase();
  const live = manager.playersView(server.id).find((p) => norm(p.name) === norm(name));
  if (live && live.online) return playerEditOnline(server, live, op, arg);
  return playerEditOffline(server, name, op, arg);
}

// ---- белый список ----

function offlineUuid(name) {
  const hash = crypto.createHash('md5').update('OfflinePlayer:' + name, 'utf8').digest();
  hash[6] = (hash[6] & 0x0f) | 0x30;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.toString('hex');
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
}

function readWhitelist(serverId) {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(serverDir(serverId), 'whitelist.json'), 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch (e) { return []; }
}

function serverProps(serverId) {
  try {
    return props.parse(fs.readFileSync(path.join(serverDir(serverId), 'server.properties'), 'utf8'));
  } catch (e) { return {}; }
}

/* UUID для ника: рантайм/usercache -> Mojang API (online-mode) -> offline-UUID */
async function resolveUuidForName(server, name) {
  let uuid = findUuid(server, name);
  if (uuid) return uuid;
  const onlineMode = serverProps(server.id)['online-mode'] !== 'false';
  if (!onlineMode) return offlineUuid(name);
  try {
    const profile = await dl.fetchJson('https://api.mojang.com/users/profiles/minecraft/' + encodeURIComponent(name));
    if (profile && profile.id) {
      const h = profile.id;
      return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
    }
  } catch (e) { /* профиль не найден */ }
  return null;
}

async function whitelistChange(server, action, name) {
  if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) throw fail(400, 'Ник: 1–16 символов (буквы, цифры, _)');
  const s = manager.getState(server.id);
  if (s.proc) {
    // на работающем сервере — штатной командой (сервер сам обновит файл)
    manager.sendCommand(server.id, 'whitelist ' + (action === 'remove' ? 'remove' : 'add') + ' ' + name);
    return { ok: true, via: 'command' };
  }
  const file = path.join(serverDir(server.id), 'whitelist.json');
  let entries = readWhitelist(server.id);
  if (action === 'remove') {
    entries = entries.filter((e) => String(e.name || '').toLowerCase() !== name.toLowerCase());
  } else if (!entries.some((e) => String(e.name || '').toLowerCase() === name.toLowerCase())) {
    const uuid = await resolveUuidForName(server, name);
    if (!uuid) throw fail(404, 'Игрок «' + name + '» не найден в Mojang. Запустите сервер и добавьте, когда игрок зайдёт.');
    entries.push({ uuid, name });
  }
  fs.writeFileSync(file, JSON.stringify(entries, null, 2));
  return { ok: true, via: 'file' };
}

// ---- модерация: кик / бан / разбан ----

function fmtBanDate(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
    pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + ' ' +
    sign + pad(Math.floor(abs / 60)) + pad(abs % 60);
}

async function moderate(server, action, name) {
  if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) throw fail(400, 'Ник: 1–16 символов (буквы, цифры, _)');
  const s = manager.getState(server.id);
  if (action === 'kick') {
    if (!s.proc) throw fail(409, 'Кик доступен только на работающем сервере');
    manager.sendCommand(server.id, 'kick ' + name);
    return { ok: true, via: 'command' };
  }
  if (action === 'op' || action === 'deop') {
    // на работающем сервере — командой; на остановленном — правим ops.json
    if (s.proc) {
      manager.sendCommand(server.id, (action === 'op' ? 'op ' : 'deop ') + name);
      return { ok: true, via: 'command' };
    }
    const file = path.join(serverDir(server.id), 'ops.json');
    let entries = [];
    try { entries = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* нет файла */ }
    if (!Array.isArray(entries)) entries = [];
    if (action === 'deop') {
      entries = entries.filter((e) => String(e.name || '').toLowerCase() !== name.toLowerCase());
    } else if (!entries.some((e) => String(e.name || '').toLowerCase() === name.toLowerCase())) {
      const uuid = await resolveUuidForName(server, name);
      if (!uuid) throw fail(404, 'UUID игрока «' + name + '» не найден');
      entries.push({ uuid, name, level: 4, bypassesPlayerLimit: false });
    }
    fs.writeFileSync(file, JSON.stringify(entries, null, 2));
    return { ok: true, via: 'file' };
  }
  if (action !== 'ban' && action !== 'pardon') throw fail(400, 'Неизвестное действие');
  if (s.proc) {
    manager.sendCommand(server.id, (action === 'ban' ? 'ban ' : 'pardon ') + name);
    return { ok: true, via: 'command' };
  }
  const file = path.join(serverDir(server.id), 'banned-players.json');
  let entries = [];
  try { entries = JSON.parse(fs.readFileSync(file, 'utf8')) || []; } catch (e) { /* нет файла */ }
  if (action === 'pardon') {
    entries = entries.filter((e) => String(e.name || '').toLowerCase() !== name.toLowerCase());
  } else if (!entries.some((e) => String(e.name || '').toLowerCase() === name.toLowerCase())) {
    const uuid = await resolveUuidForName(server, name);
    if (!uuid) throw fail(404, 'UUID игрока «' + name + '» не найден');
    entries.push({
      uuid, name,
      created: fmtBanDate(Date.now()),
      source: 'CONTROLGUI',
      expires: 'forever',
      reason: 'Banned by an operator.',
    });
  }
  fs.writeFileSync(file, JSON.stringify(entries, null, 2));
  return { ok: true, via: 'file' };
}

// ---- полное удаление данных игрока ----

function knownPlayerUuids(server, name) {
  const norm = (x) => manager.stripAnsi(String(x || '')).trim().toLowerCase();
  const values = new Map();
  const add = (value) => {
    const key = playerdata.uuidKey(value);
    if (key && !values.has(key)) values.set(key, String(value).trim().toLowerCase());
  };
  for (const player of manager.playersView(server.id)) {
    if (norm(player.name) === norm(name)) add(player.uuid);
  }
  for (const entry of manager.historyView(server.id)) {
    if (entry && norm(entry.name) === norm(name)) add(entry.uuid);
  }
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(serverDir(server.id), 'usercache.json'), 'utf8'));
    if (Array.isArray(cache)) {
      for (const entry of cache) if (entry && norm(entry.name) === norm(name)) add(entry.uuid);
    }
  } catch (e) { /* ошибка самого usercache попадёт в итог операции ниже */ }
  // В offline-mode UUID выводится из ника; добавляем его и при наличии online-UUID:
  // сервер за прокси мог менять online-mode, и старое сохранение тоже надо стереть.
  add(offlineUuid(name));
  return Array.from(values.values());
}

function partialFileError(scope, rel, error) {
  const code = error && error.code ? String(error.code) : '';
  let message = 'Ошибка файловой системы';
  if (scope === 'usercache' && error && (error.name === 'SyntaxError' || /неверный формат/i.test(error.message || ''))) {
    message = 'usercache.json повреждён или имеет неверный формат';
  } else if (code === 'EACCES' || code === 'EPERM') message = 'Нет доступа к файлу';
  else if (code === 'EBUSY') message = 'Файл занят другим процессом';
  else if (code) message += ' (' + code + ')';
  return { scope, path: rel, message, code: code || undefined };
}

function deletePlayerData(server, name) {
  const norm = (x) => manager.stripAnsi(String(x)).toLowerCase();
  const cleanName = manager.stripAnsi(String(name || '')).trim();
  if (!cleanName) throw fail(400, 'Не указано имя игрока');
  const runtime = manager.getState(server.id);
  const stoppedSafely = !runtime.proc && !runtime.orphanPid &&
    (runtime.status === 'stopped' || runtime.status === 'error') && !runtime.restoring;
  if (!stoppedSafely) {
    throw fail(409, 'Сначала полностью остановите сервер: работающая JVM может заново сохранить удалённые данные игрока');
  }
  const uuids = knownPlayerUuids(server, cleanName);
  const uuidKeys = new Set(uuids.map(playerdata.uuidKey).filter(Boolean));
  const live = manager.playersView(server.id).find((p) => p.online &&
    (norm(p.name) === norm(cleanName) || uuidKeys.has(playerdata.uuidKey(p.uuid))));
  if (live) throw fail(409, 'Игрок сейчас в сети — сначала кикните его');

  const dir = serverDir(server.id);
  let primaryWorld = null;
  const errors = [];
  try { primaryWorld = playerWorldDir(server.id); }
  catch (e) {
    errors.push({
      scope: 'scan', path: 'server.properties:level-name',
      message: 'Путь основного мира небезопасен; остальные миры всё равно проверены',
    });
  }
  const files = playerdata.removeUuidFiles(dir, primaryWorld, uuids, null,
    (rel) => safePath(server.id, rel));
  errors.push(...files.errors);
  let cacheRemoved = 0;
  let historyRemoved = 0;

  // Индексы с ником/UUID удаляем только после всех игровых файлов. При частичной
  // ошибке карточка останется в списке и пользователь сможет безопасно повторить
  // операцию, а не потеряет единственный способ обратиться к оставшемуся .dat.
  if (!errors.length) {
    // usercache пишем атомарно: обрыв процесса не должен превратить его в пустой JSON.
    try {
      const ucPath = path.join(dir, 'usercache.json');
      const cache = JSON.parse(fs.readFileSync(ucPath, 'utf8'));
      const filtered = playerdata.filterUserCache(cache, cleanName, uuids);
      cacheRemoved = filtered.removed;
      if (cacheRemoved) writeFileAtomic(ucPath, JSON.stringify(filtered.cache, null, 2));
    } catch (e) {
      if (!e || e.code !== 'ENOENT') errors.push(partialFileError('usercache', 'usercache.json', e));
    }
  }
  if (!errors.length) {
    try {
      const history = manager.removeHistory(server.id, cleanName, uuids);
      historyRemoved = history && history.removed || 0;
    } catch (e) {
      errors.push(partialFileError('history', 'panel-players.json', e));
    }
  }
  if (!errors.length) manager.forgetPlayer(server.id, cleanName, uuids);
  return {
    ok: errors.length === 0,
    partial: errors.length > 0,
    retainedForRetry: errors.length > 0,
    removed: { files: files.removed.length, usercache: cacheRemoved, history: historyRemoved },
    scanned: { directories: files.scannedDirs, worlds: files.worldDirs, storages: files.storageDirs },
    errors,
  };
}

// ---- загрузка/установка ядра ----

function startDownload(server) {
  const s = manager.getState(server.id);
  if (s.download && ['resolving', 'downloading', 'installing'].includes(s.download.phase)) return;
  s.download = { phase: 'resolving', progress: 0, doneBytes: 0, totalBytes: 0, error: null };
  (async () => {
    try {
      manager.pushLine(server.id, '[ПАНЕЛЬ] Ищу файлы ядра ' + server.type + ' ' + server.version + '...');
      const url = await dl.resolveServerUrl(server.type, server.version);
      s.download.phase = 'downloading';
      manager.pushLine(server.id, '[ПАНЕЛЬ] Скачиваю ' + url);
      const targetName = server.type === 'forge' ? 'installer.jar' : (server.jarFile || 'server.jar');
      await dl.downloadFile(url, path.join(serverDir(server.id), targetName), (done, total) => {
        s.download.doneBytes = done;
        s.download.totalBytes = total;
        s.download.progress = total ? done / total : 0;
      });
      if (server.type === 'forge') {
        s.download = { phase: 'installing', progress: 0 };
        const launch = await manager.installForge(server);
        store.update(server.id, { launch });
        manager.pushLine(server.id, '[ПАНЕЛЬ] Forge установлен (' + launch.target + '). Сервер готов к запуску.');
      } else {
        manager.pushLine(server.id, '[ПАНЕЛЬ] Файлы ядра скачаны. Сервер готов к запуску.');
      }
      s.download = { phase: 'done', progress: 1 };
    } catch (e) {
      s.download = { phase: 'error', progress: 0, error: e.message };
      manager.pushLine(server.id, '[ПАНЕЛЬ] Ошибка установки ядра: ' + e.message);
    }
  })();
}

function defaultProperties(opts) {
  return {
    'server-port': String(opts.port),
    motd: opts.motd,
    gamemode: opts.gamemode,
    difficulty: opts.difficulty,
    'max-players': String(opts.maxPlayers),
    'online-mode': String(opts.onlineMode),
    pvp: String(opts.pvp),
    'level-seed': opts.levelSeed || '',
    'level-name': 'world',
    'view-distance': '10',
    'spawn-protection': '16',
    'white-list': 'false',
    'enable-command-block': 'false',
  };
}

/* Локальный IPv4 хоста — чтобы игровые клиенты в той же сети могли скачать
   ресурспак, который раздаёт сама панель (localhost для них недоступен).
   Виртуальные адаптеры (WSL/Docker/Hyper-V/VM) исключаем, реальные LAN-диапазоны
   (192.168.* и 10.*) предпочитаем. */
function lanIp() {
  const ifs = os.networkInterfaces();
  const virt = /vethernet|virtualbox|vmware|hyper-v|docker|wsl|loopback|bluetooth|tailscale|zerotier|tap|tun/i;
  const cands = [];
  for (const name of Object.keys(ifs)) {
    for (const ni of ifs[name] || []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      cands.push({ name, addr: ni.address, virtual: virt.test(name) });
    }
  }
  const rank = (c) => {
    let r = c.virtual ? 0 : 100;          // реальные адаптеры важнее
    if (c.addr.startsWith('192.168.')) r += 30;
    else if (c.addr.startsWith('10.')) r += 20;
    else if (c.addr.startsWith('172.')) r += 5;
    return r;
  };
  cands.sort((a, b) => rank(b) - rank(a));
  return cands.length ? cands[0].addr : '127.0.0.1';
}
function packUrl(serverId) {
  const port = parseInt(process.env.PORT, 10) || 8400;
  return 'http://' + lanIp() + ':' + port + '/rp/' + serverId + '.zip';
}

/* Лимит CPU в процентах: 1..99 — ограничение; 100/пусто/мусор — без лимита (null). */
function sanitizeCpu(v) {
  const n = parseInt(v, 10);
  if (!(n >= 1 && n < 100)) return null;
  return n;
}

/* Автоопределение параметров импортируемой папки: имя, ядро, версия, launch-jar. */
async function detectServerImport(src) {
  const out = { name: 'Импортированный сервер', type: 'vanilla', version: '', jar: 'server.jar' };
  try { if (!src || !fs.existsSync(src) || !fs.statSync(src).isDirectory()) return out; } catch (e) { return out; }
  out.name = path.basename(String(src).replace(/[\\/]+$/, '')) || out.name;
  let entries = [];
  try { entries = fs.readdirSync(src); } catch (e) { return out; }
  const jars = entries.filter((f) => /\.jar$/i.test(f) && !/installer/i.test(f));
  out.jar = entries.find((f) => f.toLowerCase() === 'server.jar') || jars[0] || 'server.jar';
  const has = (p) => { try { return fs.existsSync(path.join(src, p)); } catch (e) { return false; } };
  const jn = String(out.jar).toLowerCase();
  // тип ядра по маркерам (форки Paper — раньше Paper). fabric/неизвестное -> vanilla (запускается как jar).
  if (/purpur/.test(jn) || has('libraries/org/purpurmc')) out.type = 'purpur';
  else if (/folia/.test(jn) || has('libraries/dev/folia')) out.type = 'folia';
  else if (/mohist/.test(jn) || has('libraries/com/mohistmc')) out.type = 'mohist';
  else if (/paper/.test(jn) || has('libraries/io/papermc') || has('config/paper-global.yml') || has('paper.yml')) out.type = 'paper';
  else if (/velocity/.test(jn) || has('velocity.toml')) out.type = 'velocity';
  else if (/(waterfall|bungee)/.test(jn)) out.type = 'bungeecord';
  else if (/forge/.test(jn) || has('libraries/net/minecraftforge') || has('libraries/net/neoforged') || has('user_jvm_args.txt')) out.type = 'forge';
  else out.type = 'vanilla';
  // версия: из jar (version.json/manifest), иначе из logs/latest.log
  try { const jp = path.join(src, out.jar); if (fs.existsSync(jp)) { const v = await coreinfo.detectVersion(jp); if (v) out.version = v; } } catch (e) { /* */ }
  if (!out.version) {
    try { const log = path.join(src, 'logs', 'latest.log'); if (fs.existsSync(log)) { const t = fs.readFileSync(log, 'utf8').slice(0, 30000); const m = t.match(/server version ([\w.\-]+)/i); if (m) out.version = m[1]; } } catch (e) { /* */ }
  }
  return out;
}

async function createServer(body, creator, req) {
  const name = String(body.name || '').replace(/[\x00-\x1f]/g, '').trim();
  if (!name || name.length > 40) throw fail(400, 'Имя сервера: от 1 до 40 символов');
  const type = TYPES.includes(body.type) ? body.type : 'vanilla';
  const custom = type === 'custom';
  const isProxy = proxy.isProxyType(type);
  // импорт существующего сервера: берём готовую папку, версию определим из jar/лога
  const isImport = !!body.import && !isProxy;
  if (!isProxy && !isImport && !body.eulaAccepted) throw fail(400, 'Нужно принять Minecraft EULA');
  // у кастомного/импортируемого ядра версия пока неизвестна — определится при старте
  const version = (custom || isImport) ? (String(body.version || '').trim() || '-') : String(body.version || '').trim();
  if (!custom && !isImport && !/^[\w.\-]+$/.test(version)) throw fail(400, 'Некорректная версия');
  const port = parseInt(body.port, 10);
  if (!(port >= 1024 && port <= 65535)) throw fail(400, 'Порт: число от 1024 до 65535');
  if (store.all().some((s) => s.port === port)) throw fail(400, 'Порт ' + port + ' уже занят другим сервером');
  const memoryMb = Math.min(32768, Math.max(512, parseInt(body.memoryMb, 10) || 2048));
  const maxPlayers = Math.min(1000, Math.max(1, parseInt(body.maxPlayers, 10) || 20));
  const cpuPercent = sanitizeCpu(body.cpuPercent);

  const opts = {
    port,
    motd: String(body.motd || name).replace(/[\r\n]/g, ' ').slice(0, 59),
    gamemode: GAMEMODES.includes(body.gamemode) ? body.gamemode : 'survival',
    difficulty: DIFFICULTIES.includes(body.difficulty) ? body.difficulty : 'normal',
    maxPlayers,
    onlineMode: body.onlineMode !== false,
    pvp: body.pvp !== false,
    levelSeed: String(body.levelSeed || '').replace(/[\r\n]/g, '').slice(0, 100),
  };

  const id = crypto.randomBytes(4).toString('hex');
  // импорт «на месте» (inplace): панель управляет существующей папкой напрямую, без копии
  const inPlace = isImport && body.importMode === 'inplace';
  const within = (candidate, parent) => {
    const relative = path.relative(parent, candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  };
  let importSource = null;
  if (isImport) {
    const importPath = String(body.importPath || '').trim();
    if (!importPath) throw fail(400, 'Укажите папку существующего сервера');
    importSource = path.resolve(importPath);
    let validSource = false;
    try { validSource = !!importSource && fs.statSync(importSource).isDirectory(); } catch (e) { /* путь исчез */ }
    if (!validSource) throw fail(400, 'Папка существующего сервера не найдена');
    try { importSource = fs.realpathSync.native(importSource); }
    catch (e) { throw fail(400, 'Не удалось канонизировать папку существующего сервера'); }
    if (inPlace) {
      const pathKey = (value) => {
        let canonical;
        try { canonical = fs.realpathSync.native(value); }
        catch (e) { canonical = path.resolve(value); }
        return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
      };
      const sourceKey = pathKey(importSource);
      const managed = store.all().find((existing) => pathKey(serverDir(existing.id)) === sourceKey);
      if (managed) {
        throw fail(409, 'Эта папка уже управляется сервером «' + managed.name + '»');
      }
    }
    if (inPlace) {
      const canonicalRoot = (value) => {
        try { return fs.realpathSync.native(value); } catch (e) { return path.resolve(value); }
      };
      const protectedRoots = [ROOT, DATA_ROOT, DATA_DIR, SERVERS_DIR].map(canonicalRoot);
      if (protectedRoots.some((root) => within(importSource, root) || within(root, importSource))) {
        throw fail(400, 'Нельзя импортировать «на месте» служебный каталог панели или его родителя');
      }
    }
  }
  let dir;
  if (inPlace) {
    dir = importSource;
  } else {
    dir = serverDir(id);
    fs.mkdirSync(dir, { recursive: true });
  }

  const inPlaceSnapshots = inPlace ? ['eula.txt', 'server.properties'].map((name) => {
    const file = path.join(dir, name);
    const exists = fs.existsSync(file);
    return { file, exists, data: exists ? fs.readFileSync(file) : null };
  }) : null;
  const cleanupUnregistered = (sourceError) => {
    if (inPlaceSnapshots) {
      let rollbackError = null;
      for (const snapshot of inPlaceSnapshots) {
        try {
          if (snapshot.exists) fs.writeFileSync(snapshot.file, snapshot.data);
          else fs.rmSync(snapshot.file, { force: true });
        } catch (e) { rollbackError = rollbackError || e; }
      }
      if (rollbackError) sourceError.message += '; не удалось полностью вернуть файлы import-in-place: ' + rollbackError.message;
      return;
    }
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
    catch (e) { sourceError.message += '; не удалось удалить каталог незарегистрированного сервера: ' + e.message; }
  };

  let importedJar = 'server.jar';
  let proxyServers = null;
  let proxySetupTransaction = null;
  if (isImport) {
    const src = importSource;
    try {
      if (!inPlace) {
      // Назначение лежит внутри SERVERS_DIR. Источник-родитель назначения заставил
      // бы рекурсивное копирование захватывать собственный незавершённый результат.
        if (within(dir, src) || within(src, dir)) {
          throw fail(400, 'Нельзя импортировать каталог, содержащий папку данных панели');
        }
        // АСИНХРОННОЕ копирование (на пуле libuv) — не блокирует event loop, панель не «зависает»
        // на больших мирах (раньше fs.cpSync морозил весь процесс на гигабайтных мирах).
        await fs.promises.cp(src, dir, { recursive: true });
      }
      // jar для запуска: явный выбор пользователя имеет приоритет; иначе авто (не installer)
      const chosenJar = path.basename(String(body.importJarFile || '').trim());
      if (chosenJar && /\.jar$/i.test(chosenJar) && fs.existsSync(path.join(dir, chosenJar))) {
        importedJar = chosenJar;
      } else if (!fs.existsSync(path.join(dir, importedJar))) {
        const jars = fs.readdirSync(dir).filter((f) => /\.jar$/i.test(f) && !/installer/i.test(f));
        importedJar = jars[0] || 'server.jar';
      }
      // Импорт обязан записать EULA и выбранный порт; частичный успех не регистрируем.
      fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n');
      const pf = path.join(dir, 'server.properties');
      const p = fs.existsSync(pf) ? props.parse(fs.readFileSync(pf, 'utf8')) : {};
      p['server-port'] = String(port);
      fs.writeFileSync(pf, props.stringify(p));
    } catch (e) {
      cleanupUnregistered(e);
      throw e;
    }
  } else if (isProxy) {
    // прокси: ни eula, ни server.properties — свой конфиг + привязка backend'ов
    const ids = Array.isArray(body.backends) ? body.backends.map(String) : [];
    const backends = store.all().filter((s) => ids.includes(s.id) && proxy.canBeBackend(s.type));
    const linkedIds = new Set(store.all().filter((candidate) => proxy.isProxyType(candidate.type))
      .flatMap((candidate) => (candidate.proxyServers || []).map((item) => item.id)));
    const alreadyLinked = backends.filter((backend) => linkedIds.has(backend.id));
    if (alreadyLinked.length) {
      const error = fail(409, 'Некоторые backend-серверы уже подключены к другому прокси. Сначала отвяжите их: ' +
        alreadyLinked.map((backend) => backend.name).join(', '));
      cleanupUnregistered(error);
      throw error;
    }
    let releaseBackends = null;
    try {
      releaseBackends = acquireServerMutations(backends,
        'Нельзя создать прокси: один из выбранных серверов восстанавливается из бэкапа');
      const setup = proxy.setupProxy({ id, type, port, name, motd: opts.motd, maxPlayers }, backends);
      proxyServers = setup.servers;
      proxySetupTransaction = setup.transaction;
    } catch (e) {
      // id ещё не зарегистрирован, поэтому этот каталог точно принадлежит
      // неудавшейся попытке создания, а не пользовательскому серверу.
      cleanupUnregistered(e);
      throw e;
    } finally {
      if (releaseBackends) releaseBackends();
    }
  } else {
    try {
      fs.writeFileSync(path.join(dir, 'eula.txt'),
        '#Принято пользователем через CONTROLGUI (https://aka.ms/MinecraftEULA)\neula=true\n');
      fs.writeFileSync(path.join(dir, 'server.properties'), props.stringify(defaultProperties(opts)));
    } catch (e) {
      cleanupUnregistered(e);
      throw e;
    }
  }

  const server = {
    id,
    name,
    type,
    version,
    port,
    memoryMb,
    cpuPercent,
    jarFile: isImport ? importedJar : 'server.jar',
    launch: (type === 'forge' && !isImport) ? null : { mode: 'jar', target: isImport ? importedJar : 'server.jar' },
    createdAt: new Date().toISOString(),
    creatorUsername: creator || null,
  };
  // импорт «на месте»: запоминаем внешнюю папку — serverDir(id) будет указывать на неё,
  // а при удалении сервера её НЕ трогаем (это папка пользователя).
  if (inPlace) server.dir = dir;
  if (isProxy) {
    server.proxy = true;
    server.proxyServers = proxyServers || [];
    // Эти значения нужны при каждой последующей перегенерации velocity.toml/config.yml.
    server.motd = opts.motd;
    server.maxPlayers = opts.maxPlayers;
  }
  try {
    // Копирование импорта отдаёт управление event loop: за это время другой create
    // мог занять выбранный порт. Повторная синхронная проверка закрывает гонку.
    if (store.all().some((existing) => existing.port === port)) {
      throw fail(409, 'Порт ' + port + ' уже занят другим сервером');
    }
    store.add(server);
    if (proxySetupTransaction) proxySetupTransaction.commit();
  } catch (e) {
    if (proxySetupTransaction) proxySetupTransaction.rollback(e);
    cleanupUnregistered(e);
    throw e;
  }
  // кастомное/импортированное ядро не качаем — jar уже на месте
  if (custom || isImport) return serverView(server, req);
  startDownload(server);
  return serverView(server, req);
}

/* Открыть НАТИВНЫЙ системный диалог выбора папки (Windows/macOS/Linux) и вернуть путь
   (или null, если отменили / диалог недоступен). Работает только в локальной панели. */
function pickFolder() {
  const { spawn } = require('child_process');
  const run = (cmd, args) => new Promise((resolve) => {
    let proc; let out = '';
    try { proc = spawn(cmd, args, { windowsHide: false }); }
    catch (e) { return resolve({ ok: false, path: '' }); }
    proc.stdout.on('data', (d) => { out += d; });
    proc.on('error', () => resolve({ ok: false, path: '' }));
    proc.on('close', () => resolve({ ok: true, path: out.trim() }));
  });
  if (process.platform === 'win32') {
    // FolderBrowserDialog поверх топ-мост окна, чтобы не прятался за приложением
    const ps = "Add-Type -AssemblyName System.Windows.Forms;"
      + "$o=New-Object System.Windows.Forms.Form;$o.TopMost=$true;$o.ShowInTaskbar=$false;$o.Opacity=0;$o.Show();"
      + "$f=New-Object System.Windows.Forms.FolderBrowserDialog;$f.Description='Выберите папку сервера';$f.ShowNewFolderButton=$false;"
      + "if($f.ShowDialog($o) -eq [System.Windows.Forms.DialogResult]::OK){[Console]::Out.Write($f.SelectedPath)};$o.Close()";
    return run('powershell', ['-NoProfile', '-STA', '-Command', ps]).then((r) => r.path || null);
  }
  if (process.platform === 'darwin') {
    return run('osascript', ['-e', 'POSIX path of (choose folder with prompt "Выберите папку сервера")']).then((r) => r.path || null);
  }
  // Linux: zenity, при отсутствии — kdialog
  return run('zenity', ['--file-selection', '--directory', '--title=Выберите папку сервера']).then((r) => {
    if (r.ok && r.path) return r.path;
    return run('kdialog', ['--getexistingdirectory', os.homedir() || '.']).then((k) => k.path || null);
  });
}

// файловый браузер для импорта существующего сервера (список папок)
function listDirs(p) {
  const isWin = process.platform === 'win32';
  // список дисков — только по явному запросу «::drives» (а не на каждом старте).
  // Пропускаем A:/B: (флоппи): fs.accessSync на них на Windows тормозит/висит.
  if (isWin && p === '::drives') {
    const drives = [];
    for (const c of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
      const d = c + ':\\';
      try { fs.accessSync(d); drives.push(d); } catch (e) { /* нет диска */ }
    }
    return { path: '::drives', parent: null, dirs: drives, jars: [], isServer: false };
  }
  // по умолчанию открываем домашнюю папку (один быстрый readdir), а не скан всех дисков
  if (!p) p = os.homedir() || (isWin ? 'C:\\' : '/');
  const abs = path.resolve(p);
  let entries;
  try { entries = fs.readdirSync(abs, { withFileTypes: true }); }
  catch (e) { throw fail(400, 'Нет доступа к папке: ' + abs); }
  const dirs = [];
  const jars = []; // .jar в папке — чтобы при импорте выбрать, какой запускать
  let isServer = false;
  for (const e of entries) {
    try {
      if (e.isDirectory()) { if (!e.name.startsWith('.')) dirs.push(e.name); }
      else if (e.isFile() && /\.jar$/i.test(e.name)) { jars.push(e.name); isServer = true; }
      else if (e.isFile() && (e.name === 'server.properties' || e.name === 'eula.txt')) isServer = true;
    } catch (x) { /* */ }
  }
  dirs.sort((a, b) => a.localeCompare(b));
  jars.sort((a, b) => a.localeCompare(b));
  // из корня диска «вверх» -> список дисков; иначе обычный родитель
  const isDriveRoot = isWin && /^[A-Za-z]:\\?$/.test(abs);
  const parent = isDriveRoot ? '::drives' : (path.dirname(abs) === abs ? null : path.dirname(abs));
  return { path: abs, parent, dirs, jars, isServer };
}

/* Безопасно добавить путь base/seg в список целей удаления: имя из jar не должно
   содержать разделителей или «..», и итог обязан остаться строго внутри base
   (защита от path traversal — иначе «name: ..» удалил бы каталог сервера). */
function addContentTarget(targets, base, seg) {
  if (!seg || /[\\/]/.test(seg) || seg.indexOf('..') >= 0 || seg === '.') return;
  const abs = path.resolve(base, seg);
  if (abs.startsWith(path.resolve(base) + path.sep)) targets.push(abs);
}

function directPluginFolder(base, name) {
  const seg = String(name || '').trim();
  if (!seg || seg === '.' || seg === '..' || seg.length > 160 || /[\\/\0\r\n:]/.test(seg)) return null;
  const root = path.resolve(base);
  const abs = path.resolve(root, seg);
  if (path.dirname(abs) !== root) return null;
  try {
    const st = fs.lstatSync(abs);
    // Симлинк удаляемого плагина мог указывать наружу: такие цели не трогаем вовсе.
    if (!st.isDirectory() || st.isSymbolicLink()) return null;
  } catch (e) { return null; }
  return abs;
}

function descriptorYamlName(text) {
  const m = String(text || '').match(/^name:\s*(?:"([^"]+)"|'([^']+)'|([^#\r\n]+))/im);
  return m ? String(m[1] || m[2] || m[3] || '').trim() : '';
}

/* У плагинов каталог данных — только прямой ребёнок plugins/. Сначала берём
   имя/id из стандартного дескриптора JAR, затем безопасный basename как fallback.
   Возвращаем максимум одну существующую обычную папку. */
async function pluginDataTarget(contentDir, jarName) {
  const jarPath = path.join(contentDir, jarName);
  const candidates = [];
  for (const entry of ['plugin.yml', 'paper-plugin.yml', 'bungee.yml']) {
    const text = await coreinfo.extractFromJar(jarPath, entry);
    const name = descriptorYamlName(text);
    if (name) { candidates.push(name); break; }
  }
  if (!candidates.length) {
    for (const entry of ['velocity-plugin.json', 'velocity.json']) {
      const text = await coreinfo.extractFromJar(jarPath, entry);
      if (!text) continue;
      try {
        const meta = JSON.parse(text);
        if (meta && meta.id) candidates.push(String(meta.id));
        if (meta && meta.name) candidates.push(String(meta.name));
      } catch (e) { /* повреждённый дескриптор — используем basename */ }
      if (candidates.length) break;
    }
  }
  candidates.push(String(jarName).replace(/\.disabled$/i, '').replace(/\.jar$/i, ''));
  for (const candidate of Array.from(new Set(candidates))) {
    const found = directPluginFolder(contentDir, candidate);
    if (found) return found;
  }
  return null;
}

/* Цели данных для явного удаления вместе с плагином либо прежнего удаления
   конфигов мода. Лучшее усилие: ничего не падает, если определить не удалось. */
async function contentConfigTargets(serverId, contentDir, isMod, jarName) {
  const jarPath = path.join(contentDir, jarName);
  const targets = [];
  try {
    if (!isMod) {
      const folder = await pluginDataTarget(contentDir, jarName);
      if (folder) targets.push(folder);
    } else {
      let id = null;
      const fj = await coreinfo.extractFromJar(jarPath, 'fabric.mod.json');
      if (fj) { try { id = JSON.parse(fj).id; } catch (e) { /* не json */ } }
      if (!id) {
        const mt = (await coreinfo.extractFromJar(jarPath, 'META-INF/mods.toml'))
          || (await coreinfo.extractFromJar(jarPath, 'META-INF/neoforge.mods.toml'));
        if (mt) { const m = mt.match(/modId\s*=\s*["']([^"']+)["']/i); if (m) id = m[1]; }
      }
      if (id && /^[\w.\-]+$/.test(id)) {
        const cfg = path.join(serverDir(serverId), 'config');
        for (const suf of ['.toml', '-server.toml', '-common.toml', '-client.toml', '']) {
          addContentTarget(targets, cfg, id + suf);
        }
      }
    }
  } catch (e) { /* лучшее усилие */ }
  return targets;
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const method = req.method;

  if (parts[1] === 'status' && method === 'GET') {
    const java = await manager.checkJava();
    const remote = isRemoteReq(req); // через интернет не светим путь данных и LAN-адреса хоста
    // внешний IP — best-effort, только локально (для адреса подключения друзей); не тормозим
    // ответ надолго: externalIp сам кэширует, но на первый вызов ждём с коротким лимитом
    let externalIp = null;
    if (!remote) {
      try { externalIp = await Promise.race([manager.externalIp(), new Promise((r) => setTimeout(() => r(null), 4500))]); }
      catch (e) { externalIp = null; }
    }
    return json(res, 200, {
      java,
      lanIps: remote ? [] : manager.lanAddresses(),
      externalIp,
      root: remote ? '' : DATA_ROOT,
      totalMemMb: manager.systemMemoryMb(),
      cores: manager.cpuCores(),
      cpuModel: remote ? null : manager.cpuModel(),
      platform: remote ? null : process.platform,
      launchMode: readLaunchMode(),
      app: 'CONTROLGUI ' + VERSION,
    });
  }

  // Обновление приложения запускает локальный установщик и потому никогда не
  // проксируется удалённому пользователю, даже если у него есть settings.edit.
  if (parts[1] === 'update') {
    if (isRemoteReq(req)) throw fail(403, 'Обновление приложения доступно только на этом компьютере');
    if (parts.length === 2 && method === 'GET') return json(res, 200, updates.status());
    requirePerm(req, 'settings.edit');
    if (parts[2] === 'check' && method === 'POST') {
      const body = await readBody(req);
      return json(res, 200, await updates.check(body.force !== false));
    }
    if (parts[2] === 'download' && method === 'POST') {
      updates.download().catch((error) => console.error('[ПАНЕЛЬ] Не удалось скачать обновление:', error.message));
      return json(res, 202, updates.status());
    }
    if (parts[2] === 'install' && method === 'POST') {
      const result = await updates.install();
      return json(res, result && result.scheduled ? 202 : 200, result);
    }
    if (parts[2] === 'dismiss' && method === 'POST') {
      const body = await readBody(req);
      return json(res, 200, updates.dismiss(body.version));
    }
    throw fail(405, 'Метод обновления не поддерживается');
  }

  // установка Java силами панели (скачивание Temurin), если её нет в системе
  if (parts[1] === 'java' && parts[2] === 'install' && method === 'POST') {
    requirePerm(req, 'server.create');
    const body = await readBody(req);
    return json(res, 202, javainstall.installJava(body.major));
  }
  if (parts[1] === 'java' && parts[2] === 'install' && method === 'GET') {
    return json(res, 200, javainstall.getState());
  }

  // файловый браузер (для импорта существующего сервера)
  if (parts[1] === 'browse' && method === 'GET') {
    requirePerm(req, 'server.create');
    return json(res, 200, listDirs(url.searchParams.get('path') || ''));
  }
  // нативный системный выбор папки (только локально — на удалённой машине смысла нет)
  if (parts[1] === 'pick-folder' && method === 'GET') {
    requirePerm(req, 'server.create');
    if (isRemoteReq(req)) throw fail(400, 'Системный проводник доступен только в локальной панели');
    return json(res, 200, { path: await pickFolder() });
  }
  // автоопределение параметров импортируемой папки (имя/ядро/версия/jar)
  if (parts[1] === 'import-detect' && method === 'GET') {
    requirePerm(req, 'server.create');
    return json(res, 200, await detectServerImport(url.searchParams.get('path') || ''));
  }

  // режим открытия (app|browser): читают лаунчеры (.exe / AppRun / .deb)
  if (parts[1] === 'launch-mode' && method === 'GET') {
    return json(res, 200, { mode: readLaunchMode() });
  }
  if (parts[1] === 'launch-mode' && method === 'POST') {
    requirePerm(req, 'settings.edit');
    const body = await readBody(req);
    try { return json(res, 200, { mode: writeLaunchMode(String(body.mode || '')) }); }
    catch (e) { throw fail(400, e.message); }
  }

  // Сворачивание в трей (Windows): десктоп-обёртка читает файл tray-minimize
  if (parts[1] === 'tray-minimize' && method === 'GET') {
    return json(res, 200, { enabled: readTrayMinimize() });
  }
  if (parts[1] === 'tray-minimize' && method === 'POST') {
    requirePerm(req, 'settings.edit');
    const body = await readBody(req);
    try { return json(res, 200, { enabled: writeTrayMinimize(!!body.enabled) }); }
    catch (e) { throw fail(400, e.message); }
  }

  // Текущий принципал. Удалённый пользователь не является глобальным админом:
  // его точные права приходят в server.permissions для каждого канонического id.
  if (parts[1] === 'auth' && parts[2] === 'me' && method === 'GET') {
    const principal = req.cgUser || null;
    const admin = !!(principal && (principal.admin || (principal.perms && principal.perms.admin)));
    return json(res, 200, {
      openMode: !!(principal && principal.openMode),
      remote: isRemoteReq(req),
      user: principal ? {
        username: principal.username,
        admin,
        perms: admin ? { admin: true } : users.sanitizePerms(principal.perms),
      } : null,
    });
  }

  // удалённый доступ: настройки и пользователи. Управляется ТОЛЬКО с локальной панели —
  // удалённый гость (даже с полными правами на серверы) не должен видеть список
  // пользователей и менять порт/сертификат, отрезая владельца.
  if (parts[1] === 'remote-access') {
    if (isRemoteReq(req)) throw fail(403, 'Удалённый доступ настраивается только с локальной панели');
    if (method === 'GET') {
      return json(res, 200, Object.assign(remoteaccess.status(), {
        permissions: users.PERMISSIONS, // группы прав для редактора
        presets: users.PRESETS,         // какие ключи включает каждый пресет
      }));
    }
    if (method === 'POST') {
      const body = await readBody(req);
      const act = String(body.action || '');
      let r;
      if (act === 'enable') r = remoteaccess.enable();
      else if (act === 'disable') r = remoteaccess.disable();
      else if (act === 'set-port') r = remoteaccess.setPort(body.port);
      else if (act === 'regen-cert') r = remoteaccess.regenerateCert();
      else if (act === 'user-save') r = remoteaccess.saveUser({ username: body.username, password: body.password, access: body.access });
      else if (act === 'user-remove') r = remoteaccess.removeUser(body.username);
      else throw fail(400, 'Неизвестное действие');
      if (r && r.error) throw fail(400, r.error);
      return json(res, 200, { ok: true, status: remoteaccess.status() });
    }
    throw fail(405, 'Метод не поддерживается');
  }

  // «Удалённые панели»: подключения к CONTROLGUI на других машинах. Только с локальной
  // панели — удалённый гость не должен видеть чужие подключения (и их пароли-прокси).
  if (parts[1] === 'remote-connections') {
    if (isRemoteReq(req)) throw fail(403, 'Подключения к удалённым панелям доступны только в локальной панели');
    if (method === 'GET') return json(res, 200, { connections: remoteclient.list() });
    if (method === 'POST') {
      const body = await readBody(req);
      const act = String(body.action || '');
      let r;
      if (act === 'probe') {
        r = await remoteclient.probe(body.host, body.port);
        if (r && r.error) throw fail(400, r.error);
        return json(res, 200, { ok: true, fingerprint: r.fingerprint }); // pem наружу не отдаём
      }
      if (act === 'save') r = await remoteclient.save(body);
      else if (act === 'remove') r = remoteclient.remove(body.id);
      else if (act === 'check') r = await remoteclient.check(body.id);
      else if (act === 'servers') r = await remoteclient.serversOf(body.id);
      else if (act === 'open') r = await remoteclient.open(body.id);
      else throw fail(400, 'Неизвестное действие');
      if (r && r.error) throw fail(400, r.error);
      return json(res, 200, r);
    }
    throw fail(405, 'Метод не поддерживается');
  }

  if (parts[1] === 'versions' && method === 'GET') {
    return json(res, 200, { versions: await dl.getVersions(parts[2]) });
  }

  if (parts[1] === 'servers' && parts.length === 2) {
    if (method === 'GET') {
      const visible = store.all().filter((s) => users.canAccessServer(req.cgUser, s.id));
      const list = visible.map((s) => serverView(s, req));
      return json(res, 200, { servers: list });
    }
    if (method === 'POST') {
      requirePerm(req, 'server.create');
      const body = await readBody(req);
      const releaseMaintenance = manager.beginGlobalMaintenance();
      try {
        return json(res, 201, await createServer(body, req.cgUser && req.cgUser.username, req));
      } finally {
        releaseMaintenance();
      }
    }
    throw fail(405, 'Метод не поддерживается');
  }

  if (parts[1] === 'servers' && parts.length >= 3) {
    const server = store.get(parts[2]);
    if (!server) throw fail(404, 'Сервер не найден');
    // доступ к этому серверу по списку пользователя
    if (!users.canAccessServer(req.cgUser, server.id)) throw fail(403, 'Нет доступа к этому серверу');
    // удалённо: права скоупим под КАНОНИЧЕСКИЙ id (server.id из store) — единый источник с
    // проверкой доступа выше. Так /api/servers/A/../B не даст права A операциям над B.
    if (req.cgRemoteUser) req.cgUser.perms = users.permsForServer(req.cgRemoteUser, server.id);
    const action = parts[3];
    // Restore меняет каталог целиком через staging/swap. Любая параллельная
    // мутация записала бы данные в старый каталог и потерялась после rename,
    // поэтому единый guard стоит до всех server-specific обработчиков.
    if (manager.isRestoring(server.id) && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      throw fail(409, 'Нельзя изменять сервер: идёт восстановление бэкапа');
    }
    const isMutation = !['GET', 'HEAD', 'OPTIONS'].includes(method);
    const isRestoreRequest = action === 'backup' && method === 'POST';
    const runtime = manager.getState(server.id);
    const downloadActive = runtime.download && !['done', 'error'].includes(runtime.download.phase);
    if (isMutation && action !== 'download' && downloadActive) {
      throw fail(409, 'Дождитесь завершения загрузки или установки ядра');
    }
    if (isMutation && !isRestoreRequest) {
      // Один писатель на сервер: иначе медленный upload/settings может дописать
      // устаревший конфиг уже после proxy-link/delete и рассинхронизировать реестр.
      if (runtime.activeMutations > 0) {
        throw fail(409, 'Дождитесь завершения текущей операции с сервером');
      }
      runtime.activeMutations += 1;
      let released = false;
      const releaseMutation = () => {
        if (released) return;
        released = true;
        runtime.activeMutations = Math.max(0, runtime.activeMutations - 1);
      };
      // Освобождаем по завершению самого async-handler, а не сокета: клиент мог
      // закрыть ответ, пока сервер ещё докачивает плагин и продолжает запись.
      req.cgReleaseMutation = releaseMutation;
    }

    if (!action) {
      if (method === 'GET') return json(res, 200, serverView(server, req));
      if (method === 'DELETE') {
        requirePerm(req, 'server.delete');
        const s = manager.getState(server.id);
        if (s.restoring) throw fail(409, 'Нельзя удалить сервер: идёт восстановление бэкапа');
        if (s.backupCreating) throw fail(409, 'Нельзя удалить сервер: идёт создание бэкапа');
        if (s.download && !['done', 'error'].includes(s.download.phase)) {
          throw fail(409, 'Нельзя удалить сервер: идёт загрузка или установка ядра');
        }
        if (s.javaInstalling || s.status === 'starting') {
          throw fail(409, 'Нельзя удалить сервер: идёт установка Java или запуск');
        }
        if (s.proc) throw fail(409, 'Сначала остановите сервер');
        if (manager.orphanAlive(server.id)) {
          throw fail(409, 'Процесс этого сервера ещё работает (PID ' + s.orphanPid + ') — нажмите «Убить процесс» на вкладке «Консоль», затем удаляйте.');
        }
        const linkedAsBackend = !proxy.isProxyType(server.type) && store.all().some((candidate) =>
          proxy.isProxyType(candidate.type) && (candidate.proxyServers || []).some((item) => item.id === server.id));
        if (linkedAsBackend) {
          throw fail(409, 'Сервер подключён к прокси. Сначала отвяжите его в настройках сервера, затем повторите удаление.');
        }
        const listedProxyBackends = proxy.isProxyType(server.type)
          ? (server.proxyServers || []).map((item) => store.get(item.id)).filter(Boolean)
          : [];
        // Старые версии допускали один backend в нескольких прокси. При удалении
        // одного из них не включаем online-mode, пока остаётся другая живая связь.
        const proxyBackends = listedProxyBackends.filter((backend) => !store.all().some((candidate) =>
          candidate.id !== server.id && proxy.isProxyType(candidate.type) &&
          (candidate.proxyServers || []).some((item) => item.id === backend.id)));
        for (const backend of proxyBackends) requirePermOn(req, 'settings.edit', backend.id);
        const releaseBackends = acquireServerMutations(proxyBackends,
          'Нельзя удалить прокси: один из его backend-серверов восстанавливается из бэкапа');
        let unbindTransaction = null;
        let stagedDirectory = null;
        const originalDirectory = server.dir ? null : serverDir(server.id);
        try {
          if (proxyBackends.length) unbindTransaction = proxy.unbindBackends(proxyBackends);
          // Сервер, импортированный «на месте» (server.dir) — это папка пользователя:
          // НЕ удаляем её содержимое, только снимаем регистрацию ниже. Обычный каталог
          // сначала атомарно уводим в соседнее временное имя: при сбое servers.json его
          // можно вернуть вместе с backend-конфигами, не оставляя «живую» пустую запись.
          if (originalDirectory && fs.existsSync(originalDirectory)) {
            const stagingCandidate = originalDirectory + '.delete-' + process.pid + '-' + crypto.randomBytes(6).toString('hex');
            try {
              fs.renameSync(originalDirectory, stagingCandidate);
              stagedDirectory = stagingCandidate;
            } catch (e) {
              if (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'ENOTEMPTY' || e.code === 'EACCES') {
                throw fail(409, 'Не удалось удалить: файлы заняты другим процессом. ' +
                  'Закройте папку сервера в проводнике/редакторах и убедитесь, что java-процесс завершён, затем повторите.');
              }
              throw e;
            }
          }
          store.remove(server.id);
          if (unbindTransaction) unbindTransaction.commit();
          manager.dropState(server.id);
          // После фиксации реестра сбой окончательной очистки оставляет только безопасный
          // каталог-мусор; запись сервера и доступность backend'ов уже согласованы.
          if (stagedDirectory) {
            try { fs.rmSync(stagedDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); }
            catch (cleanupError) {
              console.warn('[ПАНЕЛЬ] Не удалось окончательно удалить временный каталог сервера: ' + cleanupError.message);
            }
          }
        } catch (e) {
          let directoryRestored = !stagedDirectory;
          if (stagedDirectory) {
            try {
              fs.renameSync(stagedDirectory, originalDirectory);
              directoryRestored = true;
            } catch (rollbackError) {
              e.message += '; каталог сервера остался во временном имени ' + path.basename(stagedDirectory) +
                ': ' + rollbackError.message;
            }
          }
          // Не запираем backend'ы на loopback, если вернуть каталог прокси не удалось.
          if (unbindTransaction && directoryRestored) unbindTransaction.rollback(e);
          throw e;
        } finally {
          releaseBackends();
        }
        return json(res, 200, { ok: true });
      }
      throw fail(405, 'Метод не поддерживается');
    }

    // Подключение backend-сервера к прокси (Velocity/BungeeCord) из его настроек:
    // GET — список прокси и текущая привязка; POST — привязать/отвязать.
    if (action === 'proxy-link') {
      const findProxiesOf = (sid) => store.all().filter((p) => proxy.isProxyType(p.type)
        && (p.proxyServers || []).some((b) => b.id === sid));
      if (method === 'GET') {
        requirePerm(req, 'settings.edit');
        // удалённо показываем только те прокси, к которым у пользователя есть доступ
        // (иначе — перечисление серверов вне его скоупа)
        const proxies = store.all().filter((p) => proxy.isProxyType(p.type) && users.canAccessServer(req.cgUser, p.id))
          .map((p) => ({ id: p.id, name: p.name, type: p.type }));
        const cur = findProxiesOf(server.id)[0] || null;
        const curVisible = cur && users.canAccessServer(req.cgUser, cur.id);
        return json(res, 200, {
          canBackend: proxy.canBeBackend(server.type),
          proxies,
          attachedTo: curVisible ? cur.id : null,
          attachedName: curVisible ? cur.name : null,
          attachedRestricted: !!(cur && !curVisible),
        });
      }
      if (method === 'POST') {
        requirePerm(req, 'settings.edit');
        if (!proxy.canBeBackend(server.type)) throw fail(400, 'Это ядро нельзя подключить к прокси (нужен Paper/Purpur/Folia/Mohist).');
        const body = await readBody(req);
        const attach = body.action !== 'detach';
        const linked = findProxiesOf(server.id);
        const target = attach ? store.get(String(body.proxyId || '')) : null;
        if (attach) {
          if (!target || !proxy.isProxyType(target.type)) throw fail(400, 'Прокси-сервер не найден');
          // Заодно лечим legacy-состояние, где старые версии могли записать один
          // backend в несколько прокси: удаляем его из ВСЕХ прежних конфигов.
          const previous = linked.filter((item) => item.id !== target.id);
          const affected = [target].concat(previous);
          for (const item of affected) requirePermOn(req, 'settings.edit', item.id);
          const releaseProxies = acquireServerMutations(affected,
            'Нельзя изменить привязку: один из прокси восстанавливается из бэкапа');
          let transaction = null;
          try {
            transaction = proxy.beginConfigTransaction([server], affected);
            const updates = [];
            for (const item of previous) {
              const list = (item.proxyServers || []).filter((backend) => backend.id !== server.id);
              proxy.writeProxyConfig(item, list);
              updates.push({ id: item.id, patch: { proxyServers: list } });
            }
            let list = (target.proxyServers || []).slice();
            if (!list.some((b) => b.id === server.id)) {
              const used = new Set(list.map((b) => b.slug));
              list.push({ id: server.id, name: server.name, slug: proxy.slugify(server.name, used), port: server.port });
            }
            proxy.bindBackend(server);
            proxy.writeProxyConfig(target, list);
            updates.push({ id: target.id, patch: { proxyServers: list } });
            store.updateMany(updates);
            transaction.commit();
          } catch (e) {
            if (transaction) transaction.rollback(e);
            throw e;
          } finally {
            releaseProxies();
          }
          return json(res, 200, { ok: true, attachedTo: target.id, attachedName: target.name });
        }
        // detach
        if (linked.length) {
          for (const item of linked) requirePermOn(req, 'settings.edit', item.id);
          const releaseProxy = acquireServerMutations(linked,
            'Нельзя изменить привязку: прокси восстанавливается из бэкапа');
          let transaction = null;
          try {
            transaction = proxy.beginConfigTransaction([server], linked);
            const updates = [];
            for (const item of linked) {
              const list = (item.proxyServers || []).filter((backend) => backend.id !== server.id);
              proxy.writeProxyConfig(item, list);
              updates.push({ id: item.id, patch: { proxyServers: list } });
            }
            proxy.unbindBackend(server);
            store.updateMany(updates);
            transaction.commit();
          } catch (e) {
            if (transaction) transaction.rollback(e);
            throw e;
          } finally {
            releaseProxy();
          }
        }
        return json(res, 200, { ok: true, attachedTo: null });
      }
      throw fail(405, 'Метод не поддерживается');
    }

    if (action === 'console' && method === 'GET') {
      requirePerm(req, 'console.view');
      let lastAuthAt = 0;
      let lastAuthAllowed = true;
      const authorize = isRemoteReq(req) ? () => {
        // SSE живёт дольше обычного запроса. Переоцениваем саму сессию и права
        // максимум раз в секунду: частая консоль не должна читать JSON с диска
        // на каждой строке, а heartbeat всё равно закроет тихий поток.
        const now = Date.now();
        if (now - lastAuthAt < 1000) return lastAuthAllowed;
        lastAuthAt = now;
        const fresh = remoteaccess.sessionUserFromReq(req);
        lastAuthAllowed = !!(fresh && users.canAccessServer(fresh, server.id) &&
          users.hasPerm({ perms: users.permsForServer(fresh, server.id) }, 'console.view'));
        return lastAuthAllowed;
      } : null;
      return manager.attachConsole(server.id, res, authorize);
    }

    // ---- иконка сервера (server-icon.png, 64×64) ----
    if (action === 'icon') {
      const iconPath = path.join(serverDir(server.id), 'server-icon.png');
      if (method === 'GET') {
        if (!fs.existsSync(iconPath)) throw fail(404, 'Иконки нет');
        const stat = fs.statSync(iconPath);
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': stat.size, 'Cache-Control': 'no-cache' });
        return fs.createReadStream(iconPath).pipe(res);
      }
      if (method === 'PUT') {
        requirePerm(req, 'settings.edit');
        // тело — готовый PNG (клиент уже сжал до 64×64 на canvas)
        await receiveUpload(req, server.id, 'server-icon.png');
        manager.pushLine(server.id, '[ПАНЕЛЬ] Иконка сервера обновлена.');
        return json(res, 200, { ok: true });
      }
      if (method === 'DELETE') {
        requirePerm(req, 'settings.edit');
        try { fs.rmSync(iconPath, { force: true }); } catch (e) { /* нет файла */ }
        return json(res, 200, { ok: true });
      }
      throw fail(405, 'Метод не поддерживается');
    }

    // ---- загрузка кастомного ядра (jar) ----
    if (action === 'core' && method === 'PUT') {
      requirePerm(req, 'server.install');
      const s = manager.getState(server.id);
      if (s.proc) throw fail(409, 'Сначала остановите сервер');
      await receiveUpload(req, server.id, server.jarFile || 'server.jar');
      const ver = await coreinfo.detectVersion(path.join(serverDir(server.id), server.jarFile || 'server.jar'));
      store.update(server.id, { launch: { mode: 'jar', target: server.jarFile || 'server.jar' }, version: ver || server.version || '-' });
      manager.pushLine(server.id, '[ПАНЕЛЬ] Загружено своё ядро' + (ver ? ' (определена версия: ' + ver + ')' : ' (версию определить не удалось — будет «-»)'));
      return json(res, 200, serverView(store.get(server.id), req));
    }

    // ---- ресурспак (текстурпак): zip раздаётся панелью по /rp/<id>.zip,
    //      серверу прописывается resource-pack URL + sha1, клиенты качают сами ----
    if (action === 'resourcepack') {
      const zipPath = path.join(serverDir(server.id), 'resourcepack.zip');
      const propsFile = path.join(serverDir(server.id), 'server.properties');
      if (method === 'GET') {
        let info = { has: false, url: '', required: false };
        try {
          const st = fs.statSync(zipPath);
          let p = {};
          try { p = props.parse(fs.readFileSync(propsFile, 'utf8')); } catch (e) { /* нет файла */ }
          info = { has: true, size: st.size, url: p['resource-pack'] || '', required: p['require-resource-pack'] === 'true' };
        } catch (e) { /* пака нет */ }
        return json(res, 200, info);
      }
      if (method === 'PUT') {
        requirePerm(req, 'settings.edit');
        await receiveUpload(req, server.id, 'resourcepack.zip');
        // проверяем, что это ZIP (сигнатура PK..)
        let head = Buffer.alloc(0);
        try { const fd = fs.openSync(zipPath, 'r'); head = Buffer.alloc(4); fs.readSync(fd, head, 0, 4, 0); fs.closeSync(fd); } catch (e) { /* */ }
        if (!(head[0] === 0x50 && head[1] === 0x4b)) {
          try { fs.rmSync(zipPath, { force: true }); } catch (e) { /* */ }
          throw fail(400, 'Это не ZIP-архив. Загрузите .zip с текстурпаком (внутри pack.mcmeta и assets).');
        }
        const required = String(url.searchParams.get('required')) === 'true';
        const sha1 = crypto.createHash('sha1').update(fs.readFileSync(zipPath)).digest('hex');
        const packLink = packUrl(server.id);
        let p = {};
        try { p = props.parse(fs.readFileSync(propsFile, 'utf8')); } catch (e) { /* нет файла */ }
        p['resource-pack'] = packLink;
        p['resource-pack-sha1'] = sha1;
        p['require-resource-pack'] = required ? 'true' : 'false';
        fs.writeFileSync(propsFile, props.stringify(p));
        manager.pushLine(server.id, '[ПАНЕЛЬ] Текстурпак применён (' + packLink + '). Перезапустите сервер, чтобы он начал раздаваться игрокам.');
        return json(res, 200, { ok: true, url: packLink, sha1, required });
      }
      if (method === 'DELETE') {
        requirePerm(req, 'settings.edit');
        try { fs.rmSync(zipPath, { force: true }); } catch (e) { /* нет файла */ }
        let p = {};
        try { p = props.parse(fs.readFileSync(propsFile, 'utf8')); } catch (e) { /* нет файла */ }
        p['resource-pack'] = '';
        p['resource-pack-sha1'] = '';
        p['require-resource-pack'] = 'false';
        try { fs.writeFileSync(propsFile, props.stringify(p)); } catch (e) { /* */ }
        manager.pushLine(server.id, '[ПАНЕЛЬ] Текстурпак убран. Перезапустите сервер, чтобы изменения вступили в силу.');
        return json(res, 200, { ok: true });
      }
      throw fail(405, 'Метод не поддерживается');
    }

    // ---- плагины/моды (Modrinth): поиск, установка, список, вкл/выкл, удаление ----
    if (action === 'plugins' || action === 'mods') {
      const isMod = action === 'mods';
      const supported = isMod ? modrinth.supportsMods(server.type) : modrinth.supportsPlugins(server.type);
      if (!supported) throw fail(400, 'Это ядро не поддерживает ' + (isMod ? 'моды' : 'плагины'));
      const sub = parts[4];
      const contentDir = path.join(serverDir(server.id), isMod ? 'mods' : 'plugins');
      const loaders = isMod ? modrinth.modLoadersFor(server.type) : modrinth.loadersFor(server.type);
      const itemWord = isMod ? 'мод' : 'плагин';
      const validName = (n) => /^[A-Za-z0-9_.\-]+\.jar(\.disabled)?$/i.test(n);

      if (sub === 'project' && method === 'GET') {
        requirePerm(req, 'files.read');
        const pid = url.searchParams.get('id') || '';
        const det = await modrinth.projectDetails(pid);
        if (!det) throw fail(404, 'Проект не найден');
        return json(res, 200, det);
      }
      if (sub === 'search' && method === 'GET') {
        requirePerm(req, 'files.read');
        const result = await modrinth.search({
          query: url.searchParams.get('q') || '',
          projectType: isMod ? 'mod' : 'plugin',
          mcVersion: server.version,
          loaders,
          category: url.searchParams.get('category') || '',
          sort: url.searchParams.get('sort') || 'relevance',
          offset: url.searchParams.get('offset') || 0,
          limit: 20,
        });
        return json(res, 200, Object.assign({ mcVersion: server.version, loaders, provider: 'modrinth' }, result));
      }

      if (sub === 'install' && method === 'POST') {
        requirePerm(req, 'files.upload');
        const body = await readBody(req);
        if (!body.projectId) throw fail(400, 'Не указан ' + itemWord);
        const ver = await modrinth.resolveVersion(String(body.projectId), server.version, loaders);
        fs.mkdirSync(contentDir, { recursive: true });
        const safeName = String(ver.filename).replace(/[^A-Za-z0-9_.\-]/g, '_');
        await dl.downloadFile(ver.url, path.join(contentDir, safeName));
        manager.pushLine(server.id, '[ПАНЕЛЬ] Установлен ' + itemWord + ' ' + safeName + ' (' + ver.versionNumber + '). Перезапустите сервер, чтобы он загрузился.');
        // обязательные библиотеки-зависимости — докачиваем автоматически
        const depFiles = [];
        for (const d of (ver.dependencies || [])) {
          const dn = String(d.filename).replace(/[^A-Za-z0-9_.\-]/g, '_');
          if (fs.existsSync(path.join(contentDir, dn)) || fs.existsSync(path.join(contentDir, dn + '.disabled'))) continue;
          try {
            await dl.downloadFile(d.url, path.join(contentDir, dn));
            depFiles.push(dn);
            manager.pushLine(server.id, '[ПАНЕЛЬ] + зависимость ' + dn + ' (' + d.versionNumber + ')');
          } catch (e) {
            manager.pushLine(server.id, '[ПАНЕЛЬ] Не удалось скачать зависимость ' + dn + ': ' + e.message);
          }
        }
        if (isMod) modassets.invalidate(contentDir);
        return json(res, 200, { ok: true, file: safeName, version: ver.versionNumber, dependencies: depFiles });
      }

      // включить/выключить: переименование .jar <-> .jar.disabled
      if (sub === 'toggle' && method === 'POST') {
        requirePerm(req, 'files.write');
        const body = await readBody(req);
        const name = String(body.file || '');
        if (!validName(name)) throw fail(400, 'Некорректное имя файла');
        const src = path.join(contentDir, name);
        if (!fs.existsSync(src)) throw fail(404, 'Файл не найден');
        const disabling = /\.jar$/i.test(name);
        const dest = disabling ? src + '.disabled' : src.replace(/\.disabled$/i, '');
        if (fs.existsSync(dest)) throw fail(409, 'Файл с таким именем уже есть');
        fs.renameSync(src, dest);
        if (isMod) modassets.invalidate(contentDir);
        manager.pushLine(server.id, '[ПАНЕЛЬ] ' + (isMod ? 'Мод' : 'Плагин') + ' ' + name + (disabling ? ' выключен' : ' включён') + '. Перезапустите сервер, чтобы применить.');
        return json(res, 200, { ok: true, file: path.basename(dest), disabled: disabling });
      }

      if (!sub) {
        if (method === 'GET') {
          requirePerm(req, 'files.read');
          let installed = [];
          try {
            installed = fs.readdirSync(contentDir)
              .filter((f) => /\.jar(\.disabled)?$/i.test(f))
              .map((f) => {
                let size = 0; let mtime = 0;
                try { const st = fs.statSync(path.join(contentDir, f)); size = st.size; mtime = st.mtimeMs; } catch (e) { /* исчез */ }
                return { name: f, size, mtime, disabled: /\.disabled$/i.test(f) };
              }).sort((a, b) => a.name.localeCompare(b.name));
          } catch (e) { /* папки нет */ }
          const baseNames = installed.map((i) => i.name.replace(/\.disabled$/i, '').replace(/\.jar$/i, '').toLowerCase());
          return json(res, 200, { installed, baseNames, folder: isMod ? 'mods' : 'plugins' });
        }
        if (method === 'DELETE') {
          requirePerm(req, 'files.delete');
          const name = String(url.searchParams.get('file') || '');
          if (!validName(name)) throw fail(400, 'Некорректное имя файла');
          const jarPath = path.join(contentDir, name);
          let jarStat;
          try { jarStat = fs.lstatSync(jarPath); }
          catch (e) { throw fail(404, 'Файл ' + (isMod ? 'мода' : 'плагина') + ' не найден'); }
          if (!jarStat.isFile() || jarStat.isSymbolicLink()) {
            throw fail(400, 'Это не обычный файл ' + (isMod ? 'мода' : 'плагина'));
          }
          // У плагина данные удаляются только после явного подтверждения withData=true.
          // Поведение модов сохраняем прежним: их config-цели определяются автоматически.
          const withData = !isMod && url.searchParams.get('withData') === 'true';
          const extra = (isMod || withData)
            ? await contentConfigTargets(server.id, contentDir, isMod, name)
            : [];
          // Сначала обязательно удаляем сам JAR. Ошибку блокировки на Windows
          // нельзя выдавать за успех и затем отдельно стирать папку настроек.
          try { fs.rmSync(jarPath, { force: false }); }
          catch (e) {
            throw fail(409, 'Не удалось удалить файл ' + (isMod ? 'мода' : 'плагина') +
              ': он занят сервером или другой программой. Остановите сервер и повторите.');
          }
          let removedExtra = false;
          const removedFolders = [];
          const failedExtra = [];
          for (const t of extra) {
            try {
              if (fs.existsSync(t)) {
                const wasFolder = fs.lstatSync(t).isDirectory();
                fs.rmSync(t, { recursive: true, force: true });
                removedExtra = true;
                if (!isMod && wasFolder) removedFolders.push(path.basename(t));
              }
            } catch (e) { failedExtra.push(path.basename(t)); }
          }
          manager.pushLine(server.id, '[ПАНЕЛЬ] Удалён ' + itemWord + ' ' + name +
            (removedExtra ? ' вместе с его настройками' : '') +
            (failedExtra.length ? '; часть связанных данных удалить не удалось: ' + failedExtra.join(', ') : '') + '.');
          if (isMod) modassets.invalidate(contentDir);
          return json(res, 200, isMod
            ? { ok: true, failedFolders: failedExtra }
            : { ok: true, removedFolders, failedFolders: failedExtra });
        }
      }
      throw fail(405, 'Метод не поддерживается');
    }

    // ---- логи сервера ----
    if (action === 'logs' && parts[4] === 'search' && method === 'GET') {
      requirePerm(req, 'logs.view');
      const q = String(url.searchParams.get('q') || '').trim();
      if (q.length < 2) return json(res, 200, { matches: [], query: q, truncated: false });
      const ql = q.toLowerCase();
      const logsDir = path.join(serverDir(server.id), 'logs');
      const MAX = 500;
      const matches = [];
      let files = [];
      try { files = fs.readdirSync(logsDir).filter((f) => f.endsWith('.log') || f.endsWith('.log.gz')); } catch (e) { /* нет логов */ }
      files.sort((a, b) => { try { return fs.statSync(path.join(logsDir, b)).mtimeMs - fs.statSync(path.join(logsDir, a)).mtimeMs; } catch (e) { return 0; } });
      for (const f of files) {
        if (matches.length >= MAX) break;
        let buf;
        try { buf = fs.readFileSync(path.join(logsDir, f)); if (f.endsWith('.gz')) buf = zlib.gunzipSync(buf); } catch (e) { continue; }
        const lines = manager.stripAnsi(buf.toString('utf8')).split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().indexOf(ql) >= 0) {
            matches.push({ file: f, line: i + 1, text: lines[i].slice(0, 500) });
            if (matches.length >= MAX) break;
          }
        }
      }
      return json(res, 200, { matches, query: q, truncated: matches.length >= MAX });
    }

    if (action === 'logs' && method === 'GET') {
      requirePerm(req, 'logs.view');
      const logsDir = path.join(serverDir(server.id), 'logs');
      let files = [];
      try {
        files = fs.readdirSync(logsDir).filter((f) => f.endsWith('.log') || f.endsWith('.log.gz')).map((f) => {
          let size = 0; let mtime = 0;
          try { const st = fs.statSync(path.join(logsDir, f)); size = st.size; mtime = st.mtimeMs; } catch (e) { /* исчез */ }
          return { name: f, size, mtime, live: f === 'latest.log' };
        }).sort((a, b) => b.mtime - a.mtime);
      } catch (e) { /* нет каталога логов */ }
      return json(res, 200, { logs: files });
    }

    if (action === 'log' && method === 'GET') {
      requirePerm(req, 'logs.view');
      const lname = String(url.searchParams.get('name') || '').replace(/[^A-Za-z0-9_.\-]/g, '');
      if (!lname.endsWith('.log') && !lname.endsWith('.log.gz')) throw fail(400, 'Некорректное имя лога');
      const file = path.join(serverDir(server.id), 'logs', lname);
      if (!fs.existsSync(file)) throw fail(404, 'Лог не найден');
      const MAX = 5 * 1024 * 1024;
      let content = '';
      let truncated = false;
      try {
        let buf = fs.readFileSync(file);
        if (lname.endsWith('.gz')) buf = zlib.gunzipSync(buf);
        if (buf.length > MAX) { buf = buf.subarray(buf.length - MAX); truncated = true; }
        content = buf.toString('utf8');
      } catch (e) { throw fail(500, 'Не удалось прочитать лог: ' + e.message); }
      return json(res, 200, { name: lname, content: manager.stripAnsi(content), truncated });
    }

    // ---- бэкапы ----
    if (action === 'backups') {
      if (method === 'GET') {
        requireAnyPerm(req, ANY_BACKUP);
        return json(res, 200, { backups: backups.listBackups(server.id) });
      }
      if (method === 'POST') {
        requirePerm(req, 'backups.create');
        const body = await readBody(req);
        const runtime = manager.getState(server.id);
        if (runtime.restoring) throw fail(409, 'Нельзя создать бэкап: идёт восстановление другого бэкапа');
        if (runtime.backupCreating) throw fail(409, 'Создание бэкапа уже выполняется');
        runtime.backupCreating = true;
        try { return json(res, 200, await backups.createBackup(server, body.label)); }
        finally { runtime.backupCreating = false; }
      }
      throw fail(405, 'Метод не поддерживается');
    }

    if (action === 'backup') {
      const name = url.searchParams.get('name') || '';
      if (method === 'GET') {
        requireAnyPerm(req, ANY_BACKUP);
        if (manager.isRestoring(server.id)) throw fail(409, 'Нельзя скачать бэкап: идёт восстановление');
        // скачивание архива
        const file = backups.backupFilePath(server.id, name);
        const stat = fs.statSync(file);
        res.writeHead(200, {
          'Content-Type': 'application/gzip',
          'Content-Length': stat.size,
          'Content-Disposition': 'attachment; filename="' + name.replace(/[^A-Za-z0-9_.\-]/g, '_') + '"',
        });
        return fs.createReadStream(file).pipe(res);
      }
      if (method === 'DELETE') {
        requirePerm(req, 'backups.delete');
        if (manager.isRestoring(server.id)) throw fail(409, 'Нельзя удалить бэкап: идёт восстановление');
        backups.deleteBackup(server.id, name);
        return json(res, 200, { ok: true });
      }
      if (method === 'POST') {
        requirePerm(req, 'backups.restore');
        await backups.restoreBackup(server, name);
        modassets.invalidate(path.join(serverDir(server.id), 'mods'));
        return json(res, 200, { ok: true });
      }
      throw fail(405, 'Метод не поддерживается');
    }

    if (action === 'stats' && method === 'GET') {
      requirePerm(req, 'console.view');
      return json(res, 200, {
        cores: manager.cpuCores(),
        memLimitMb: server.memoryMb,
        points: manager.getStats(server.id),
      });
    }

    if (action === 'item-icon') {
      if (method !== 'GET' && method !== 'HEAD') throw fail(405, 'Метод не поддерживается');
      // Иконка раскрывает только тот же предмет, который пользователь уже видит
      // в инвентаре. Имя JAR/ZIP-записи браузер не задаёт — их выбирает индекс.
      requireAnyPerm(req, ANY_PLAYER_DETAILS);
      const itemId = itemAssetId(url.searchParams.get('item'));
      const icon = await modassets.resolveIcon(safePath(server.id, 'mods'), itemId);
      if (!icon || !Buffer.isBuffer(icon.buffer)) throw fail(404, 'Иконка модового предмета не найдена');
      const etag = /^W\/|^"/.test(String(icon.etag || ''))
        ? String(icon.etag) : ('"' + String(icon.etag || crypto.createHash('sha256').update(icon.buffer).digest('hex')) + '"');
      const cacheHeaders = {
        'Cache-Control': 'private, no-cache',
        ETag: etag,
        'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Resource-Policy': 'same-origin',
      };
      const requestTags = String(req.headers && req.headers['if-none-match'] || '').split(',').map((tag) => tag.trim());
      if (requestTags.includes(etag) || requestTags.includes('*')) {
        res.writeHead(304, cacheHeaders);
        return res.end();
      }
      res.writeHead(200, Object.assign(cacheHeaders, {
        'Content-Type': 'image/png',
        'Content-Length': icon.buffer.length,
      }));
      return res.end(method === 'HEAD' ? undefined : icon.buffer);
    }

    if (action === 'player') {
      const name = url.searchParams.get('name') || '';
      if (!name) throw fail(400, 'Не указано имя игрока');
      if (method === 'GET') {
        // данные игрока (инвентарь, статы, IP) — нужен хотя бы просмотр файлов или права игроков
        requireAnyPerm(req, ANY_PLAYER_DETAILS);
        const details = await playerDetails(server, name);
        // IP — персональные данные: удалённо скрываем, если нет прав модерации (кик/бан/удаление)
        if (isRemoteReq(req) && details && !permissionsAllowPlayerIps(viewPermissions(req, server.id))) details.ips = [];
        return json(res, 200, details);
      }
      if (method === 'DELETE') {
        requirePerm(req, 'players.delete');
        const result = deletePlayerData(server, name);
        return json(res, 200, result);
      }
      throw fail(405, 'Метод не поддерживается');
    }

    if (action === 'playeredit' && method === 'POST') {
      // правка инвентаря/статов = уровень доступа команд консоли
      requirePerm(req, 'console.command');
      const body = await readBody(req);
      return json(res, 200, await playerEdit(server, body));
    }

    if (action === 'moderate' && method === 'POST') {
      const body = await readBody(req);
      const act = String(body.action || '');
      if (!MODERATE_PERM[act]) throw fail(400, 'Недопустимое действие');
      requirePerm(req, MODERATE_PERM[act]); // op/deop -> players.op (а не players.ban)
      return json(res, 200, await moderate(server, act, String(body.name || '').trim()));
    }

    if (action === 'whitelist') {
      if (method === 'GET') {
        requireAnyPerm(req, ['console.view', 'players.whitelist']);
        return json(res, 200, {
          enabled: serverProps(server.id)['white-list'] === 'true',
          entries: readWhitelist(server.id).map((e) => e.name).filter(Boolean),
        });
      }
      if (method === 'POST') {
        requirePerm(req, 'players.whitelist');
        const body = await readBody(req);
        return json(res, 200, await whitelistChange(server, body.action, String(body.name || '').trim()));
      }
      throw fail(405, 'Метод не поддерживается');
    }

    if (action === 'properties') {
      const file = path.join(serverDir(server.id), 'server.properties');
      if (method === 'GET') {
        requirePerm(req, 'settings.edit'); // server.properties содержит rcon.password — не отдаём без прав настроек
        let properties = {};
        try { properties = props.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* файла ещё нет */ }
        return json(res, 200, {
          properties, name: server.name, memoryMb: server.memoryMb,
          proxy: proxy.isProxyType(server.type),
          cpuPercent: server.cpuPercent == null ? null : server.cpuPercent,
          javaPath: server.javaPath || '', javas: manager.listJavas(),
          // конфигурация запуска: какой jar, кастомная команда, готовые пресеты
          jarFile: server.jarFile || 'server.jar', jars: listServerJars(server.id),
          launchCmd: server.launchCmd || '', launchPresets: LAUNCH_PRESETS,
          forgeArgs: !!(server.launch && server.launch.mode === 'args'),
        });
      }
      if (method === 'PUT') {
        requirePerm(req, 'settings.edit');
        const body = await readBody(req);
        const isProxySettings = proxy.isProxyType(server.type);
        let propertiesContent = null;
        if (isProxySettings && body.rawContent !== undefined) {
          throw fail(400, 'У этого прокси нет server.properties');
        } else if (!isProxySettings && body.rawContent !== undefined) {
          if (typeof body.rawContent !== 'string') throw fail(400, 'Некорректное содержимое server.properties');
          if (Buffer.byteLength(body.rawContent, 'utf8') > MAX_EDIT_SIZE * 2) {
            throw fail(413, 'server.properties слишком большой');
          }
          propertiesContent = body.rawContent;
        } else if (!isProxySettings && body.properties && typeof body.properties === 'object') {
          const clean = {};
          for (const [key, value] of Object.entries(body.properties)) {
            const k = String(key).trim();
            if (!/^[\w.\-]+$/.test(k)) continue;
            clean[k] = String(value);
          }
          propertiesContent = props.stringify(clean);
        }
        const patch = {};
        if (body.name) patch.name = String(body.name).replace(/[\x00-\x1f]/g, '').trim().slice(0, 40);
        if (body.memoryMb) patch.memoryMb = Math.min(32768, Math.max(512, parseInt(body.memoryMb, 10) || server.memoryMb));
        if (body.cpuPercent !== undefined) patch.cpuPercent = sanitizeCpu(body.cpuPercent);
        if (body.javaPath !== undefined) patch.javaPath = String(body.javaPath || '').slice(0, 400);
        // выбор jar-файла запуска (валидируем имя и наличие; переводим в jar-режим)
        if (body.jarFile !== undefined) {
          const jf = String(body.jarFile || '').trim();
          if (jf && /^[A-Za-z0-9_.\- ]+\.jar$/i.test(jf) && fs.existsSync(path.join(serverDir(server.id), jf))) {
            patch.jarFile = jf;
            patch.launch = { mode: 'jar', target: jf }; // явный выбор jar перекрывает args-режим
          }
        }
        // кастомная команда запуска (пресеты Aikar и т.п.); пустая строка = вернуть дефолт
        if (body.launchCmd !== undefined) patch.launchCmd = String(body.launchCmd || '').slice(0, 4000);
        if (propertiesContent != null) saveServerProperties(server, propertiesContent, patch);
        else if (Object.keys(patch).length) store.update(server.id, patch);
        return json(res, 200, serverView(store.get(server.id), req));
      }
      throw fail(405, 'Метод не поддерживается');
    }

    // ---- файлы сервера ----
    if (action === 'files' && method === 'GET') {
      requirePerm(req, 'files.read');
      const rel = url.searchParams.get('path') || '';
      return json(res, 200, { path: rel, entries: listDir(server.id, rel) });
    }

    // скачать один файл на ПК (любого типа) — attachment
    if (action === 'file-download' && method === 'GET') {
      requirePerm(req, 'files.read');
      if (manager.isRestoring(server.id)) throw fail(409, 'Нельзя скачать файл: идёт восстановление бэкапа');
      const rel = url.searchParams.get('path') || '';
      const abs = safePath(server.id, rel);
      let stat;
      try { stat = fs.statSync(abs); } catch (e) { throw fail(404, 'Файл не найден'); }
      if (!stat.isFile()) throw fail(400, 'Это не файл');
      const name = path.basename(abs).replace(/[\r\n"]/g, '_');
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': stat.size,
        'Content-Disposition': 'attachment; filename*=UTF-8\'\'' + encodeURIComponent(name),
      });
      return fs.createReadStream(abs).pipe(res);
    }

    // скачать папку на ПК как ZIP (стримом, без временного файла)
    if (action === 'folder-download' && method === 'GET') {
      requirePerm(req, 'files.read');
      if (manager.isRestoring(server.id)) throw fail(409, 'Нельзя скачать папку: идёт восстановление бэкапа');
      const rel = url.searchParams.get('path') || '';
      const abs = safePath(server.id, rel);
      let stat;
      try { stat = fs.statSync(abs); } catch (e) { throw fail(404, 'Папка не найдена'); }
      if (!stat.isDirectory()) throw fail(400, 'Это не папка');
      const base = rel ? path.basename(abs) : (server.name || 'server');
      const zipName = base.replace(/[^A-Za-z0-9_.\-]+/g, '_') + '.zip';
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename*=UTF-8\'\'' + encodeURIComponent(base + '.zip'),
        'Cache-Control': 'no-store',
      });
      try { await zip.zipDirToStream(abs, res); }
      catch (e) { try { res.destroy(); } catch (e2) { /* */ } }
      return;
    }

    if (action === 'file') {
      const rel = url.searchParams.get('path') || '';
      if (method === 'GET') { requirePerm(req, 'files.read'); return json(res, 200, readTextFile(server.id, rel)); }
      if (method === 'PUT') {
        requirePerm(req, 'files.write');
        const body = await readBody(req);
        const target = String(body.path || rel);
        if (!target) throw fail(400, 'Не указан путь');
        if (typeof body.content !== 'string') throw fail(400, 'Нет содержимого');
        if (Buffer.byteLength(body.content, 'utf8') > MAX_EDIT_SIZE * 2) throw fail(413, 'Слишком большой файл для редактора');
        const targetPath = safePath(server.id, target);
        // прямая правка server.properties (режим «Файл» в настройках или редактор)
        // должна синхронизировать порт панели. Проверяем именно корневой файл,
        // чтобы config/server.properties не менял адрес всего сервера.
        const rootProperties = path.join(serverDir(server.id), 'server.properties');
        if (path.relative(rootProperties, targetPath) === '') saveServerProperties(server, body.content);
        else fs.writeFileSync(targetPath, body.content);
        invalidateModAssetsForPath(server.id, targetPath);
        return json(res, 200, { ok: true });
      }
      if (method === 'DELETE') {
        requirePerm(req, 'files.delete');
        if (!rel || rel === '.') throw fail(400, 'Нельзя удалить корень сервера');
        const targetPath = safePath(server.id, rel);
        if (isRootServerProperties(server.id, targetPath)) {
          throw fail(400, 'server.properties нельзя удалять — измените его во вкладке «Настройки»');
        }
        fs.rmSync(targetPath, { recursive: true, force: true });
        invalidateModAssetsForPath(server.id, targetPath);
        return json(res, 200, { ok: true });
      }
      throw fail(405, 'Метод не поддерживается');
    }

    if (action === 'file-upload' && method === 'PUT') {
      requirePerm(req, 'files.upload');
      const rel = url.searchParams.get('path') || '';
      if (!rel) throw fail(400, 'Не указан путь');
      if (isRootServerProperties(server.id, safePath(server.id, rel))) {
        throw fail(400, 'server.properties загружайте через редактор во вкладке «Настройки»');
      }
      await receiveUpload(req, server.id, rel);
      invalidateModAssetsForPath(server.id, safePath(server.id, rel));
      return json(res, 200, { ok: true });
    }

    if (action === 'files-create' && method === 'POST') {
      requirePerm(req, 'files.write');
      const body = await readBody(req);
      const rel = String(body.path || '');
      if (!rel) throw fail(400, 'Не указано имя');
      const abs = safePath(server.id, rel);
      if (isRootServerProperties(server.id, abs)) {
        throw fail(400, 'server.properties создаётся и изменяется во вкладке «Настройки»');
      }
      if (fs.existsSync(abs)) throw fail(409, 'Такой файл или папка уже есть');
      if (body.type === 'dir') fs.mkdirSync(abs, { recursive: true });
      else fs.writeFileSync(abs, '', { flag: 'wx' });
      invalidateModAssetsForPath(server.id, abs);
      return json(res, 200, { ok: true });
    }

    if (action === 'files-rename' && method === 'POST') {
      requirePerm(req, 'files.write');
      const body = await readBody(req);
      const from = String(body.from || '');
      const to = String(body.to || '');
      if (!from || !to) throw fail(400, 'Не указаны пути');
      const absFrom = safePath(server.id, from);
      const absTo = safePath(server.id, to);
      if (isRootServerProperties(server.id, absFrom) || isRootServerProperties(server.id, absTo)) {
        throw fail(400, 'server.properties нельзя переименовывать — измените его во вкладке «Настройки»');
      }
      if (fs.existsSync(absTo)) throw fail(409, 'Имя уже занято');
      fs.renameSync(absFrom, absTo);
      invalidateModAssetsForPath(server.id, absFrom);
      invalidateModAssetsForPath(server.id, absTo);
      return json(res, 200, { ok: true });
    }

    if (action === 'files-extract' && method === 'POST') {
      requirePerm(req, 'files.write');
      const body = await readBody(req);
      const rel = String(body.path || '');
      if (!rel) throw fail(400, 'Не указан архив');
      if (!/\.zip$/i.test(rel)) throw fail(400, 'Распаковка поддерживается только для .zip');
      const absArchive = safePath(server.id, rel);
      let st;
      try { st = fs.statSync(absArchive); }
      catch (e) { throw fail(404, 'Архив не найден'); }
      if (st.isDirectory()) throw fail(400, 'Это папка, а не архив');
      if (st.size > MAX_UPLOAD_SIZE) throw fail(413, 'Архив слишком большой (макс. 256 МБ)');

      // защита от zip-бомбы: лимиты числа файлов, объёма на запись и суммарного
      const MAX_ENTRIES = 20000;
      const MAX_TOTAL = 2 * 1024 * 1024 * 1024;   // 2 ГБ суммарно
      const MAX_ENTRY = 512 * 1024 * 1024;        // 512 МБ на одну запись

      const buf = fs.readFileSync(absArchive);
      let entries;
      // кап на число записей передаём в парсер — чтобы вредоносный ZIP64 cdCount
      // не построил миллионы объектов ещё до этой проверки
      try { entries = unzip.readEntries(buf, MAX_ENTRIES + 1); }
      catch (e) { throw fail(400, 'Не удалось прочитать архив: ' + e.message); }
      if (entries.length > MAX_ENTRIES) throw fail(400, 'Слишком много файлов в архиве (> ' + MAX_ENTRIES + ')');
      // ранний дешёвый отсев по заявленному размеру (для честных архивов);
      // РЕАЛЬНЫЙ объём всё равно считаем при распаковке — uncompSize подделывается
      let declared = 0;
      for (const e of entries) declared += (e.uncompSize || 0);
      if (declared > MAX_TOTAL) throw fail(400, 'Архив распакуется в слишком большой объём (> 2 ГБ)');

      // папка назначения — рядом с архивом, имя = имя архива без расширения (с уникализацией)
      const parentRel = path.dirname(rel);
      const parentPrefix = (parentRel && parentRel !== '.') ? parentRel.replace(/\\/g, '/') + '/' : '';
      const baseName = path.basename(rel).replace(/\.zip$/i, '');
      let folderName = baseName;
      let destRel = parentPrefix + folderName;
      let n = 2;
      while (fs.existsSync(safePath(server.id, destRel))) {
        folderName = baseName + ' (' + n + ')';
        destRel = parentPrefix + folderName;
        if (++n > 50) throw fail(409, 'Не удалось создать папку для распаковки');
      }
      fs.mkdirSync(safePath(server.id, destRel), { recursive: true });

      let written = 0;
      let skipped = 0;
      let tooLarge = 0;  // записи, отсечённые лимитом 512 МБ (могут быть и легитимными)
      let realTotal = 0; // реально распакованные байты (не заявленные)
      for (const entry of entries) {
        // некоторые архиваторы (Windows Compress-Archive) пишут '\' как разделитель —
        // приводим к '/', иначе на Linux путь станет одним файлом с бэкслешем в имени
        const name = String(entry.name || '').replace(/\\/g, '/');
        if (!name) continue;
        let outAbs;
        try { outAbs = safePath(server.id, destRel + '/' + name); } // ловит zip-slip (../)
        catch (e) { skipped++; continue; }
        if (name.endsWith('/')) { // запись-каталог
          try { fs.mkdirSync(outAbs, { recursive: true }); } catch (e) { /* уже есть */ }
          continue;
        }
        let data;
        try { data = unzip.entryData(buf, entry, MAX_ENTRY); }
        catch (e) { // битая/бомба/неподдерживаемая — пропускаем
          if (e && (e.code === 'ERR_BUFFER_TOO_LARGE' || /лимит распаковки/.test(e.message || ''))) tooLarge++;
          skipped++; continue;
        }
        realTotal += data.length;
        if (realTotal > MAX_TOTAL) { // подделанный uncompSize: реальный объём превысил лимит
          try { fs.rmSync(safePath(server.id, destRel), { recursive: true, force: true }); } catch (e) { /* */ }
          throw fail(400, 'Архив распаковывается в слишком большой объём (> 2 ГБ)');
        }
        try {
          fs.mkdirSync(path.dirname(outAbs), { recursive: true });
          fs.writeFileSync(outAbs, data);
          written++;
        } catch (e) { skipped++; }
      }
      return json(res, 200, { ok: true, folder: folderName, count: written, skipped: skipped, tooLarge: tooLarge });
    }

    if (method !== 'POST') throw fail(405, 'Метод не поддерживается');

    if (action === 'start') {
      requirePerm(req, 'server.start');
      // кастомное ядро без версии — пробуем определить из jar перед стартом
      if ((!server.version || server.version === '-') && manager.isLaunchReady(server)) {
        try {
          const ver = await coreinfo.detectVersion(manager.jarPath(server));
          if (ver) { store.update(server.id, { version: ver }); server.version = ver; }
        } catch (e) { /* не критично */ }
      }
      manager.start(server);
      return json(res, 200, serverView(store.get(server.id) || server, req));
    }
    if (action === 'stop') {
      requirePerm(req, 'server.stop');
      const s = manager.getState(server.id);
      if (!s.proc && manager.orphanAlive(server.id)) {
        throw fail(409, 'Консоль этого процесса недоступна (запущен до перезапуска панели) — используйте «Убить процесс».');
      }
      manager.stop(server.id);
      return json(res, 200, serverView(server, req));
    }
    if (action === 'kill') { requirePerm(req, 'server.kill'); manager.kill(server.id); return json(res, 200, serverView(server, req)); }
    if (action === 'restart') { requirePerm(req, 'server.stop'); manager.restart(server); return json(res, 200, serverView(server, req)); }
    if (action === 'download') {
      requirePerm(req, 'server.install');
      if (manager.isRestoring(server.id)) throw fail(409, 'Нельзя устанавливать ядро: идёт восстановление бэкапа');
      if (server.type === 'custom') throw fail(400, 'У своего ядра нет источника для скачивания — загрузите .jar вручную');
      const s = manager.getState(server.id);
      if (s.proc) throw fail(409, 'Сначала остановите сервер');
      startDownload(server);
      return json(res, 200, serverView(server, req));
    }
    if (action === 'command') {
      requirePerm(req, 'console.command');
      const body = await readBody(req);
      manager.sendCommand(server.id, String(body.command || ''));
      return json(res, 200, { ok: true });
    }
    throw fail(404, 'Неизвестное действие');
  }

  throw fail(404, 'Не найдено');
}

function handleApi(req, res) {
  handle(req, res).catch((err) => {
    const status = err.status || 500;
    if (status === 500) console.error('[API]', err);
    // Ошибки с .status несут user-facing текст (fail()) — отдаём как есть.
    // Непойманные (500) — сырые исключения: УДАЛЁННО обобщаем (сырой ENOENT/EACCES
    // раскрыл бы абсолютный путь данных, а его для remote специально скрывают);
    // ЛОКАЛЬНО отдаём текст — владельцу полезно видеть реальную причину.
    let msg;
    if (err.status) msg = err.message || 'Ошибка';
    else if (isRemoteReq(req)) msg = 'Внутренняя ошибка сервера';
    else msg = err.message || 'Внутренняя ошибка сервера';
    if (!res.headersSent) json(res, status, { error: msg });
    else res.end();
  }).finally(() => {
    if (typeof req.cgReleaseMutation === 'function') req.cgReleaseMutation();
  });
}

module.exports = { handleApi };
