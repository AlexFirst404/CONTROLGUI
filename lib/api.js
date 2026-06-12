'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { serverDir, ROOT } = require('./paths');
const store = require('./store');
const props = require('./properties');
const dl = require('./download');
const manager = require('./manager');
const nbt = require('./nbt');
const snbt = require('./snbt');
const users = require('./users');
const backups = require('./backups');
const coreinfo = require('./coreinfo');
const zlib = require('zlib');

const TYPES = ['vanilla', 'paper', 'purpur', 'folia', 'mohist', 'forge', 'custom'];
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

/* Проверка права текущего пользователя (req.cgUser ставит server.js). */
function requirePerm(req, key) {
  const u = req.cgUser;
  if (!users.hasPerm(u, key)) throw fail(403, 'Недостаточно прав для этого действия');
}
function requireAnyPerm(req, keys) {
  const u = req.cgUser;
  if (!keys.some((k) => users.hasPerm(u, k))) throw fail(403, 'Недостаточно прав для этого действия');
}
function requireAdmin(req) {
  if (!(req.cgUser && req.cgUser.perms && req.cgUser.perms.admin)) throw fail(403, 'Только для администратора');
}
const ANY_BACKUP = ['backups.create', 'backups.restore', 'backups.delete'];

function readBanned(serverId) {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(serverDir(serverId), 'banned-players.json'), 'utf8'));
    return Array.isArray(list) ? list.map((e) => e.name).filter(Boolean) : [];
  } catch (e) { return []; }
}

/* Рантайм-игроки + история панели + usercache сервера:
   список переживает рестарты панели и показывает всех заходивших */
function combinedPlayers(serverId) {
  const live = manager.playersView(serverId);
  const norm = (x) => manager.stripAnsi(String(x)).toLowerCase();
  const seen = new Set(live.map((p) => norm(p.name)));
  const result = live.slice();
  const add = (name, uuid, ip, lastSeen) => {
    if (!name || seen.has(norm(name))) return;
    seen.add(norm(name));
    result.push({
      name, uuid: uuid || null, ip: ip || null, online: false,
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

function serverView(server) {
  const s = manager.getState(server.id);
  const jarReady = manager.isLaunchReady(server);
  let status = s.status;
  if (!s.proc && manager.orphanAlive(server.id)) {
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
    createdAt: server.createdAt,
    status,
    players: Array.from(s.players),
    playersInfo: combinedPlayers(server.id),
    banned: readBanned(server.id),
    download: s.download,
    jarReady,
    startedAt: s.startedAt,
    hasIcon: iconMtime(server.id),
  };
}

/* mtime иконки сервера (для кэш-бастинга в UI) либо 0, если иконки нет */
function iconMtime(serverId) {
  try { return Math.round(fs.statSync(path.join(serverDir(serverId), 'server-icon.png')).mtimeMs); }
  catch (e) { return 0; }
}

// ---- файловый менеджер: только внутри каталога сервера ----

function safePath(serverId, rel) {
  const base = serverDir(serverId);
  const clean = path.normalize(String(rel || '').replace(/^[/\\]+/, ''));
  if (clean.split(/[\\/]/).includes('..')) throw fail(400, 'Недопустимый путь');
  const abs = path.join(base, clean);
  if (abs !== base && !abs.startsWith(base + path.sep)) throw fail(400, 'Недопустимый путь');
  return abs;
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
  return new Promise((resolve, reject) => {
    let size = 0;
    let failed = false;
    const out = fs.createWriteStream(abs);
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_UPLOAD_SIZE && !failed) {
        failed = true;
        out.destroy();
        req.destroy();
        fs.rm(abs, { force: true }, () => {});
        reject(fail(413, 'Файл слишком большой (макс. 256 МБ)'));
      }
    });
    out.on('finish', () => { if (!failed) resolve(); });
    out.on('error', (e) => { if (!failed) { failed = true; reject(e); } });
    req.on('error', (e) => { if (!failed) { failed = true; out.destroy(); reject(e); } });
    req.pipe(out);
  });
}

// ---- подробности игрока: usercache + статистика мира + NBT-инвентарь ----

function levelName(serverId) {
  try {
    const text = fs.readFileSync(path.join(serverDir(serverId), 'server.properties'), 'utf8');
    return props.parse(text)['level-name'] || 'world';
  } catch (e) { return 'world'; }
}

function findUuid(server, name) {
  // 1) рантайм (из лога)
  const live = manager.playersView(server.id).find((p) => p.name.toLowerCase() === name.toLowerCase());
  if (live && live.uuid) return live.uuid;
  // 2) usercache.json
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(serverDir(server.id), 'usercache.json'), 'utf8'));
    const hit = (cache || []).find((e) => e.name && e.name.toLowerCase() === name.toLowerCase());
    if (hit && hit.uuid) return hit.uuid;
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

function itemFromNbt(raw, slot) {
  return {
    slot: slot != null ? slot : (raw.Slot != null ? raw.Slot : -1),
    id: String(raw.id || '').replace(/^minecraft:/, ''),
    count: raw.count != null ? raw.count : (raw.Count != null ? raw.Count : 1),
  };
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

function detailsFromRoot(root) {
  return {
    xpLevel: root.XpLevel != null ? root.XpLevel : null,
    health: root.Health != null ? Math.round(root.Health * 10) / 10 : null,
    food: root.foodLevel != null ? root.foodLevel : null,
    pos: Array.isArray(root.Pos) ? root.Pos.map((v) => Math.round(v)) : null,
    dimension: root.Dimension != null ? String(root.Dimension).replace(/^minecraft:/, '') : null,
  };
}

async function playerDetails(server, name) {
  const uuid = findUuid(server, name);
  if (!uuid) throw fail(404, 'UUID игрока не найден — игрок ещё не заходил на сервер');
  const level = levelName(server.id);
  const dir = serverDir(server.id);
  const worldDir = path.join(dir, level);
  const norm = (x) => manager.stripAnsi(String(x)).toLowerCase();
  const live = manager.playersView(server.id).find((p) => norm(p.name) === norm(name));
  const online = !!(live && live.online);

  // общее время игры из официальной статистики мира
  // (до MC 26 — world/stats, с MC 26 — world/players/stats)
  let playTimeTicks = null;
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
    lastPlayed,
    firstJoinAt: history.firstJoinAt || null,
    lastJoinAt: history.lastJoinAt || null,
    ips: history.ips || [],
    inventory,
  }, details);
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

function deletePlayerData(server, name) {
  const norm = (x) => manager.stripAnsi(String(x)).toLowerCase();
  const live = manager.playersView(server.id).find((p) => norm(p.name) === norm(name));
  if (live && live.online) throw fail(409, 'Игрок сейчас в сети — сначала кикните его');

  const uuid = findUuid(server, name);
  const dir = serverDir(server.id);
  const worldDir = path.join(dir, levelName(server.id));
  if (uuid) {
    const targets = [];
    for (const base of [path.join(worldDir, 'playerdata'), path.join(worldDir, 'players', 'data')]) {
      targets.push(path.join(base, uuid + '.dat'), path.join(base, uuid + '.dat_old'));
    }
    for (const base of [path.join(worldDir, 'stats'), path.join(worldDir, 'players', 'stats')]) {
      targets.push(path.join(base, uuid + '.json'));
    }
    for (const base of [path.join(worldDir, 'advancements'), path.join(worldDir, 'players', 'advancements')]) {
      targets.push(path.join(base, uuid + '.json'));
    }
    for (const t of targets) {
      try { fs.rmSync(t, { force: true }); } catch (e) { /* нет файла */ }
    }
  }
  // usercache.json
  try {
    const ucPath = path.join(dir, 'usercache.json');
    const cache = JSON.parse(fs.readFileSync(ucPath, 'utf8')) || [];
    fs.writeFileSync(ucPath, JSON.stringify(cache.filter((e) => norm(e.name || '') !== norm(name))));
  } catch (e) { /* нет файла */ }
  manager.removeHistory(server.id, name);
  manager.forgetPlayer(server.id, name);
  return { ok: true };
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

async function createServer(body) {
  if (!body.eulaAccepted) throw fail(400, 'Нужно принять Minecraft EULA');
  const name = String(body.name || '').replace(/[\x00-\x1f]/g, '').trim();
  if (!name || name.length > 40) throw fail(400, 'Имя сервера: от 1 до 40 символов');
  const type = TYPES.includes(body.type) ? body.type : 'vanilla';
  const custom = type === 'custom';
  // у кастомного ядра версия пока неизвестна — определится при загрузке jar/старте
  const version = custom ? '-' : String(body.version || '').trim();
  if (!custom && !/^[\w.\-]+$/.test(version)) throw fail(400, 'Некорректная версия');
  const port = parseInt(body.port, 10);
  if (!(port >= 1024 && port <= 65535)) throw fail(400, 'Порт: число от 1024 до 65535');
  if (store.all().some((s) => s.port === port)) throw fail(400, 'Порт ' + port + ' уже занят другим сервером');
  const memoryMb = Math.min(32768, Math.max(512, parseInt(body.memoryMb, 10) || 2048));
  const maxPlayers = Math.min(1000, Math.max(1, parseInt(body.maxPlayers, 10) || 20));

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
  const dir = serverDir(id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'eula.txt'),
    '#Принято пользователем через CONTROLGUI (https://aka.ms/MinecraftEULA)\neula=true\n');
  fs.writeFileSync(path.join(dir, 'server.properties'), props.stringify(defaultProperties(opts)));

  const server = {
    id,
    name,
    type,
    version,
    port,
    memoryMb,
    jarFile: 'server.jar',
    launch: type === 'forge' ? null : { mode: 'jar', target: 'server.jar' },
    createdAt: new Date().toISOString(),
  };
  store.add(server);
  // кастомное ядро не качаем — jar загрузит пользователь отдельным запросом
  if (custom) return serverView(server);
  startDownload(server);
  return serverView(server);
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const method = req.method;

  if (parts[1] === 'status' && method === 'GET') {
    const java = await manager.checkJava();
    return json(res, 200, {
      java,
      lanIps: manager.lanAddresses(),
      root: ROOT,
      totalMemMb: manager.systemMemoryMb(),
      cores: manager.cpuCores(),
      app: 'CONTROLGUI 1.2',
    });
  }

  // текущий пользователь + список прав (для настройки UI)
  if (parts[1] === 'auth' && parts[2] === 'me' && method === 'GET') {
    return json(res, 200, {
      authRequired: users.anyUsers(),
      openMode: !users.anyUsers(),
      user: req.cgUser ? { username: req.cgUser.username, admin: !!(req.cgUser.perms && req.cgUser.perms.admin), perms: req.cgUser.perms, servers: req.cgUser.servers === undefined ? null : req.cgUser.servers } : null,
      permissions: users.PERMISSIONS,
    });
  }

  // управление пользователями (только админ)
  if (parts[1] === 'users') {
    if (parts.length === 2) {
      if (method === 'GET') { requireAdmin(req); return json(res, 200, { users: users.listUsers(), permissions: users.PERMISSIONS }); }
      if (method === 'POST') {
        const body = await readBody(req);
        // первого пользователя создаём только в открытом режиме (он станет админом)
        const firstEver = !users.anyUsers();
        if (!firstEver) requireAdmin(req);
        const created = users.createUser(body.username, body.password, body.perms, firstEver ? true : !!body.admin, body.servers);
        // первого сразу логиним, чтобы не выкинуло на страницу входа
        if (firstEver) {
          res.writeHead(201, {
            'Content-Type': 'application/json; charset=utf-8',
            'Set-Cookie': users.sessionCookie(users.createSession(created.username)),
          });
          return res.end(JSON.stringify({ user: created, loggedIn: true }));
        }
        return json(res, 201, { user: created });
      }
      throw fail(405, 'Метод не поддерживается');
    }
    requireAdmin(req);
    const uname = decodeURIComponent(parts[2]);
    if (method === 'PUT') {
      const body = await readBody(req);
      return json(res, 200, { user: users.updateUser(uname, { password: body.password, perms: body.perms, admin: body.admin, servers: body.servers }) });
    }
    if (method === 'DELETE') {
      if (req.cgUser && req.cgUser.username && req.cgUser.username.toLowerCase() === uname.toLowerCase()) {
        throw fail(400, 'Нельзя удалить самого себя');
      }
      users.deleteUser(uname);
      return json(res, 200, { ok: true });
    }
    throw fail(405, 'Метод не поддерживается');
  }

  if (parts[1] === 'versions' && method === 'GET') {
    return json(res, 200, { versions: await dl.getVersions(parts[2]) });
  }

  if (parts[1] === 'servers' && parts.length === 2) {
    if (method === 'GET') {
      const visible = store.all().filter((s) => users.canAccessServer(req.cgUser, s.id));
      return json(res, 200, { servers: visible.map(serverView) });
    }
    if (method === 'POST') { requirePerm(req, 'server.create'); return json(res, 201, await createServer(await readBody(req))); }
    throw fail(405, 'Метод не поддерживается');
  }

  if (parts[1] === 'servers' && parts.length >= 3) {
    const server = store.get(parts[2]);
    if (!server) throw fail(404, 'Сервер не найден');
    // доступ к этому серверу по списку пользователя
    if (!users.canAccessServer(req.cgUser, server.id)) throw fail(403, 'Нет доступа к этому серверу');
    const action = parts[3];

    if (!action) {
      if (method === 'GET') return json(res, 200, serverView(server));
      if (method === 'DELETE') {
        requirePerm(req, 'server.delete');
        const s = manager.getState(server.id);
        if (s.proc) throw fail(409, 'Сначала остановите сервер');
        if (manager.orphanAlive(server.id)) {
          throw fail(409, 'Процесс этого сервера ещё работает (PID ' + s.orphanPid + ') — нажмите «Убить процесс» на вкладке «Консоль», затем удаляйте.');
        }
        try {
          fs.rmSync(serverDir(server.id), { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
        } catch (e) {
          if (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'ENOTEMPTY') {
            throw fail(409, 'Не удалось удалить: файлы заняты другим процессом. ' +
              'Закройте папку сервера в проводнике/редакторах и убедитесь, что java-процесс завершён, затем повторите.');
          }
          throw e;
        }
        manager.dropState(server.id);
        store.remove(server.id);
        return json(res, 200, { ok: true });
      }
      throw fail(405, 'Метод не поддерживается');
    }

    if (action === 'console' && method === 'GET') {
      requirePerm(req, 'console.view');
      return manager.attachConsole(server.id, res);
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
      requirePerm(req, 'server.create');
      const s = manager.getState(server.id);
      if (s.proc) throw fail(409, 'Сначала остановите сервер');
      await receiveUpload(req, server.id, server.jarFile || 'server.jar');
      const ver = await coreinfo.detectVersion(path.join(serverDir(server.id), server.jarFile || 'server.jar'));
      store.update(server.id, { launch: { mode: 'jar', target: server.jarFile || 'server.jar' }, version: ver || server.version || '-' });
      manager.pushLine(server.id, '[ПАНЕЛЬ] Загружено своё ядро' + (ver ? ' (определена версия: ' + ver + ')' : ' (версию определить не удалось — будет «-»)'));
      return json(res, 200, serverView(store.get(server.id)));
    }

    // ---- логи сервера ----
    if (action === 'logs' && method === 'GET') {
      requirePerm(req, 'console.view');
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
      requirePerm(req, 'console.view');
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
        return json(res, 200, await backups.createBackup(server, body.label));
      }
      throw fail(405, 'Метод не поддерживается');
    }

    if (action === 'backup') {
      const name = url.searchParams.get('name') || '';
      if (method === 'GET') {
        requireAnyPerm(req, ANY_BACKUP);
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
      if (method === 'DELETE') { requirePerm(req, 'backups.delete'); backups.deleteBackup(server.id, name); return json(res, 200, { ok: true }); }
      if (method === 'POST') { requirePerm(req, 'backups.restore'); await backups.restoreBackup(server, name); return json(res, 200, { ok: true }); }
      throw fail(405, 'Метод не поддерживается');
    }

    if (action === 'stats' && method === 'GET') {
      return json(res, 200, {
        cores: manager.cpuCores(),
        memLimitMb: server.memoryMb,
        points: manager.getStats(server.id),
      });
    }

    if (action === 'player') {
      const name = url.searchParams.get('name') || '';
      if (!name) throw fail(400, 'Не указано имя игрока');
      if (method === 'GET') return json(res, 200, await playerDetails(server, name));
      if (method === 'DELETE') { requirePerm(req, 'players.delete'); return json(res, 200, deletePlayerData(server, name)); }
      throw fail(405, 'Метод не поддерживается');
    }

    if (action === 'moderate' && method === 'POST') {
      const body = await readBody(req);
      const act = String(body.action || '');
      requirePerm(req, act === 'kick' ? 'players.kick' : 'players.ban');
      return json(res, 200, await moderate(server, act, String(body.name || '').trim()));
    }

    if (action === 'whitelist') {
      if (method === 'GET') {
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
        let properties = {};
        try { properties = props.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* файла ещё нет */ }
        return json(res, 200, { properties, name: server.name, memoryMb: server.memoryMb });
      }
      if (method === 'PUT') {
        requirePerm(req, 'settings.edit');
        const body = await readBody(req);
        if (body.properties && typeof body.properties === 'object') {
          const clean = {};
          for (const [key, value] of Object.entries(body.properties)) {
            const k = String(key).trim();
            if (!/^[\w.\-]+$/.test(k)) continue;
            clean[k] = String(value);
          }
          fs.writeFileSync(file, props.stringify(clean));
          const newPort = parseInt(clean['server-port'], 10);
          if (newPort) store.update(server.id, { port: newPort });
        }
        const patch = {};
        if (body.name) patch.name = String(body.name).replace(/[\x00-\x1f]/g, '').trim().slice(0, 40);
        if (body.memoryMb) patch.memoryMb = Math.min(32768, Math.max(512, parseInt(body.memoryMb, 10) || server.memoryMb));
        if (Object.keys(patch).length) store.update(server.id, patch);
        return json(res, 200, serverView(store.get(server.id)));
      }
      throw fail(405, 'Метод не поддерживается');
    }

    // ---- файлы сервера ----
    if (action === 'files' && method === 'GET') {
      requirePerm(req, 'files.read');
      const rel = url.searchParams.get('path') || '';
      return json(res, 200, { path: rel, entries: listDir(server.id, rel) });
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
        fs.writeFileSync(safePath(server.id, target), body.content);
        return json(res, 200, { ok: true });
      }
      if (method === 'DELETE') {
        requirePerm(req, 'files.delete');
        if (!rel || rel === '.') throw fail(400, 'Нельзя удалить корень сервера');
        fs.rmSync(safePath(server.id, rel), { recursive: true, force: true });
        return json(res, 200, { ok: true });
      }
      throw fail(405, 'Метод не поддерживается');
    }

    if (action === 'file-upload' && method === 'PUT') {
      requirePerm(req, 'files.upload');
      const rel = url.searchParams.get('path') || '';
      if (!rel) throw fail(400, 'Не указан путь');
      await receiveUpload(req, server.id, rel);
      return json(res, 200, { ok: true });
    }

    if (action === 'files-create' && method === 'POST') {
      requirePerm(req, 'files.write');
      const body = await readBody(req);
      const rel = String(body.path || '');
      if (!rel) throw fail(400, 'Не указано имя');
      const abs = safePath(server.id, rel);
      if (fs.existsSync(abs)) throw fail(409, 'Такой файл или папка уже есть');
      if (body.type === 'dir') fs.mkdirSync(abs, { recursive: true });
      else fs.writeFileSync(abs, '', { flag: 'wx' });
      return json(res, 200, { ok: true });
    }

    if (action === 'files-rename' && method === 'POST') {
      requirePerm(req, 'files.write');
      const body = await readBody(req);
      const from = String(body.from || '');
      const to = String(body.to || '');
      if (!from || !to) throw fail(400, 'Не указаны пути');
      const absTo = safePath(server.id, to);
      if (fs.existsSync(absTo)) throw fail(409, 'Имя уже занято');
      fs.renameSync(safePath(server.id, from), absTo);
      return json(res, 200, { ok: true });
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
      return json(res, 200, serverView(store.get(server.id) || server));
    }
    if (action === 'stop') {
      requirePerm(req, 'server.stop');
      const s = manager.getState(server.id);
      if (!s.proc && manager.orphanAlive(server.id)) {
        throw fail(409, 'Консоль этого процесса недоступна (запущен до перезапуска панели) — используйте «Убить процесс».');
      }
      manager.stop(server.id);
      return json(res, 200, serverView(server));
    }
    if (action === 'kill') { requirePerm(req, 'server.kill'); manager.kill(server.id); return json(res, 200, serverView(server)); }
    if (action === 'restart') { requirePerm(req, 'server.stop'); manager.restart(server); return json(res, 200, serverView(server)); }
    if (action === 'download') {
      requirePerm(req, 'server.install');
      const s = manager.getState(server.id);
      if (s.proc) throw fail(409, 'Сначала остановите сервер');
      startDownload(server);
      return json(res, 200, serverView(server));
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
    if (!res.headersSent) json(res, status, { error: err.message || 'Внутренняя ошибка' });
    else res.end();
  });
}

module.exports = { handleApi };
