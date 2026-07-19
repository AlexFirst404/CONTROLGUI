'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { serverDir, DATA_ROOT, DATA_DIR, SERVERS_DIR, readLaunchMode, writeLaunchMode, readTrayMinimize, writeTrayMinimize } = require('./paths');
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
const unzip = require('./unzip');
const zlib = require('zlib');

const TYPES = ['vanilla', 'paper', 'purpur', 'folia', 'mohist', 'forge', 'velocity', 'bungeecord', 'custom'];
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
function isRemoteReq(req) { return !!req.cgRemote; }
// маппинг действия модерации -> своё право (op/deop НЕ должны падать под players.ban)
const MODERATE_PERM = { kick: 'players.kick', op: 'players.op', deop: 'players.op', ban: 'players.ban', pardon: 'players.ban' };
const ANY_BACKUP = ['backups.create', 'backups.restore', 'backups.delete'];

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
    cpuPercent: server.cpuPercent == null ? null : server.cpuPercent,
    javaPath: server.javaPath || '',
    plugins: modrinth.supportsPlugins(server.type),
    mods: modrinth.supportsMods(server.type),
    proxy: !!server.proxy,
    proxyServers: server.proxyServers || [],
    createdAt: server.createdAt,
    creatorUsername: server.creatorUsername || null,
    status,
    players: Array.from(s.players),
    playersInfo: combinedPlayers(server.id),
    banned: readBanned(server.id),
    ops: readOps(server.id),
    download: s.download,
    jarReady,
    startedAt: s.startedAt,
    hasIcon: iconMtime(server.id),
    inPlace: !!server.dir, // импортирован «на месте» (внешняя папка пользователя)
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
  // Windows: относительный путь не может содержать ':' — это либо буква диска,
  // либо альтернативный поток NTFS (name::$DATA) в обход блок-листа. Запрещаем.
  if (process.platform === 'win32' && clean.indexOf(':') !== -1) throw fail(400, 'Недопустимый путь');
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
  try { fs.mkdirSync(path.dirname(abs), { recursive: true }); } catch (e) { /* родитель создаём для plugins/mods на свежем сервере */ }
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
  const item = {
    slot: slot != null ? slot : (raw.Slot != null ? raw.Slot : -1),
    id: String(raw.id || '').replace(/^minecraft:/, ''),
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
  const worldDir = path.join(serverDir(server.id), levelName(server.id));
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

async function createServer(body, creator) {
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
  let dir;
  if (inPlace) {
    dir = path.resolve(String(body.importPath || ''));
  } else {
    dir = serverDir(id);
    fs.mkdirSync(dir, { recursive: true });
  }

  let importedJar = 'server.jar';
  let proxyServers = null;
  if (isImport) {
    const src = path.resolve(String(body.importPath || ''));
    if (!src || !fs.existsSync(src) || !fs.statSync(src).isDirectory()) {
      throw fail(400, 'Папка существующего сервера не найдена');
    }
    if (!inPlace) {
      if (src === path.resolve(dir)) throw fail(400, 'Нельзя импортировать сам каталог панели');
      // АСИНХРОННОЕ копирование (на пуле libuv) — не блокирует event loop, панель не «зависает»
      // на больших мирах (раньше fs.cpSync морозил весь процесс на гигабайтных мирах).
      await fs.promises.cp(src, dir, { recursive: true });
    } else {
      // «на месте»: запрещаем брать служебные каталоги панели (данные/серверы) как in-place
      const within = (a, b) => { const r = path.relative(b, a); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
      if (within(src, SERVERS_DIR) || within(src, DATA_DIR) || within(DATA_ROOT, src)) {
        throw fail(400, 'Нельзя импортировать «на месте» служебный каталог панели');
      }
    }
    // jar для запуска: явный выбор пользователя имеет приоритет; иначе авто (не installer)
    const chosenJar = path.basename(String(body.importJarFile || '').trim());
    if (chosenJar && /\.jar$/i.test(chosenJar) && fs.existsSync(path.join(dir, chosenJar))) {
      importedJar = chosenJar;
    } else if (!fs.existsSync(path.join(dir, importedJar))) {
      const jars = fs.readdirSync(dir).filter((f) => /\.jar$/i.test(f) && !/installer/i.test(f));
      importedJar = jars[0] || 'server.jar';
    }
    // принимаем EULA и выставляем порт панели в server.properties
    try { fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n'); } catch (e) { /* */ }
    try {
      const pf = path.join(dir, 'server.properties');
      const p = fs.existsSync(pf) ? props.parse(fs.readFileSync(pf, 'utf8')) : {};
      p['server-port'] = String(port);
      fs.writeFileSync(pf, props.stringify(p));
    } catch (e) { /* */ }
  } else if (isProxy) {
    // прокси: ни eula, ни server.properties — свой конфиг + привязка backend'ов
    const ids = Array.isArray(body.backends) ? body.backends.map(String) : [];
    const backends = store.all().filter((s) => ids.includes(s.id) && proxy.canBeBackend(s.type));
    proxyServers = proxy.setupProxy({ id, type, port, name, motd: opts.motd, maxPlayers }, backends).servers;
  } else {
    fs.writeFileSync(path.join(dir, 'eula.txt'),
      '#Принято пользователем через CONTROLGUI (https://aka.ms/MinecraftEULA)\neula=true\n');
    fs.writeFileSync(path.join(dir, 'server.properties'), props.stringify(defaultProperties(opts)));
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
  if (isProxy) { server.proxy = true; server.proxyServers = proxyServers || []; }
  store.add(server);
  // кастомное/импортированное ядро не качаем — jar уже на месте
  if (custom || isImport) return serverView(server);
  startDownload(server);
  return serverView(server);
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

/* Что удалять вместе с jar плагина/мода: его конфиг-директорию (плагин —
   plugins/<Name> из plugin.yml; мод — config/<id>* из fabric.mod.json/mods.toml).
   Лучшее усилие: ничего не падает, если определить не удалось. */
async function contentConfigTargets(serverId, contentDir, isMod, jarName) {
  const jarPath = path.join(contentDir, jarName);
  const targets = [];
  try {
    if (!isMod) {
      const yml = (await coreinfo.extractFromJar(jarPath, 'plugin.yml'))
        || (await coreinfo.extractFromJar(jarPath, 'paper-plugin.yml'));
      if (yml) {
        const m = yml.match(/^name:\s*["']?([^"'\r\n#]+)/im);
        if (m) {
          const nm = m[1].trim();
          if (/^[\w .\-]+$/.test(nm)) addContentTarget(targets, contentDir, nm);
        }
      }
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
    return json(res, 200, {
      java,
      lanIps: remote ? [] : manager.lanAddresses(),
      root: remote ? '' : DATA_ROOT,
      totalMemMb: manager.systemMemoryMb(),
      cores: manager.cpuCores(),
      launchMode: readLaunchMode(),
      app: 'CONTROLGUI 2.0.0',
    });
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

  // текущий пользователь (локально и после пароля удалёнки — полный доступ)
  if (parts[1] === 'auth' && parts[2] === 'me' && method === 'GET') {
    return json(res, 200, {
      openMode: true,
      remote: isRemoteReq(req),
      user: req.cgUser ? { username: req.cgUser.username, admin: true, perms: req.cgUser.perms } : null,
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

  if (parts[1] === 'versions' && method === 'GET') {
    return json(res, 200, { versions: await dl.getVersions(parts[2]) });
  }

  if (parts[1] === 'servers' && parts.length === 2) {
    if (method === 'GET') {
      const visible = store.all().filter((s) => users.canAccessServer(req.cgUser, s.id));
      const list = visible.map((s) => serverView(s));
      return json(res, 200, { servers: list });
    }
    if (method === 'POST') { requirePerm(req, 'server.create'); return json(res, 201, await createServer(await readBody(req), req.cgUser && req.cgUser.username)); }
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

    if (!action) {
      if (method === 'GET') return json(res, 200, serverView(server));
      if (method === 'DELETE') {
        requirePerm(req, 'server.delete');
        const s = manager.getState(server.id);
        if (s.proc) throw fail(409, 'Сначала остановите сервер');
        if (manager.orphanAlive(server.id)) {
          throw fail(409, 'Процесс этого сервера ещё работает (PID ' + s.orphanPid + ') — нажмите «Убить процесс» на вкладке «Консоль», затем удаляйте.');
        }
        // сервер, импортированный «на месте» (server.dir) — это папка пользователя:
        // НЕ удаляем её содержимое, только снимаем регистрацию ниже.
        if (!server.dir) {
          try {
            fs.rmSync(serverDir(server.id), { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
          } catch (e) {
            if (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'ENOTEMPTY') {
              throw fail(409, 'Не удалось удалить: файлы заняты другим процессом. ' +
                'Закройте папку сервера в проводнике/редакторах и убедитесь, что java-процесс завершён, затем повторите.');
            }
            throw e;
          }
        }
        manager.dropState(server.id);
        store.remove(server.id);
        return json(res, 200, { ok: true });
      }
      throw fail(405, 'Метод не поддерживается');
    }

    // Подключение backend-сервера к прокси (Velocity/BungeeCord) из его настроек:
    // GET — список прокси и текущая привязка; POST — привязать/отвязать.
    if (action === 'proxy-link') {
      const findProxyOf = (sid) => store.all().find((p) => proxy.isProxyType(p.type)
        && (p.proxyServers || []).some((b) => b.id === sid)) || null;
      if (method === 'GET') {
        requirePerm(req, 'settings.edit');
        // удалённо показываем только те прокси, к которым у пользователя есть доступ
        // (иначе — перечисление серверов вне его скоупа)
        const proxies = store.all().filter((p) => proxy.isProxyType(p.type) && users.canAccessServer(req.cgUser, p.id))
          .map((p) => ({ id: p.id, name: p.name, type: p.type }));
        const cur = findProxyOf(server.id);
        return json(res, 200, {
          canBackend: proxy.canBeBackend(server.type),
          proxies,
          attachedTo: cur ? cur.id : null,
          attachedName: cur ? cur.name : null,
        });
      }
      if (method === 'POST') {
        requirePerm(req, 'settings.edit');
        if (!proxy.canBeBackend(server.type)) throw fail(400, 'Это ядро нельзя подключить к прокси (нужен Paper/Purpur/Folia/Mohist).');
        const body = await readBody(req);
        const attach = body.action !== 'detach';
        const target = attach ? store.get(String(body.proxyId || '')) : findProxyOf(server.id);
        if (attach) {
          if (!target || !proxy.isProxyType(target.type)) throw fail(400, 'Прокси-сервер не найден');
          // привязка меняет КОНФИГ прокси — значит нужны права и на прокси, а не только на backend
          requirePermOn(req, 'settings.edit', target.id);
          // отвязать от прежнего прокси, если был привязан к другому
          const prev = findProxyOf(server.id);
          if (prev && prev.id !== target.id) {
            requirePermOn(req, 'settings.edit', prev.id); // правим и прежний прокси
            const pl = (prev.proxyServers || []).filter((b) => b.id !== server.id);
            proxy.writeProxyConfig(prev, pl); store.update(prev.id, { proxyServers: pl });
          }
          let list = (target.proxyServers || []).slice();
          if (!list.some((b) => b.id === server.id)) {
            const used = new Set(list.map((b) => b.slug));
            list.push({ id: server.id, name: server.name, slug: proxy.slugify(server.name, used), port: server.port });
          }
          proxy.bindBackend(server);
          proxy.writeProxyConfig(target, list);
          store.update(target.id, { proxyServers: list });
          return json(res, 200, { ok: true, attachedTo: target.id, attachedName: target.name });
        }
        // detach
        if (target) {
          requirePermOn(req, 'settings.edit', target.id); // правим конфиг прокси
          const list = (target.proxyServers || []).filter((b) => b.id !== server.id);
          proxy.unbindBackend(server);
          proxy.writeProxyConfig(target, list);
          store.update(target.id, { proxyServers: list });
        }
        return json(res, 200, { ok: true, attachedTo: null });
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
          // вместе с jar удаляем его конфиг-директорию/файлы (лучшее усилие)
          const extra = await contentConfigTargets(server.id, contentDir, isMod, name);
          try { fs.rmSync(path.join(contentDir, name), { recursive: true, force: true }); } catch (e) { /* нет файла */ }
          let removedExtra = false;
          for (const t of extra) {
            try { if (fs.existsSync(t)) { fs.rmSync(t, { recursive: true, force: true }); removedExtra = true; } } catch (e) { /* нет */ }
          }
          manager.pushLine(server.id, '[ПАНЕЛЬ] Удалён ' + itemWord + ' ' + name + (removedExtra ? ' вместе с его настройками' : '') + '.');
          return json(res, 200, { ok: true });
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
      requirePerm(req, 'console.view');
      return json(res, 200, {
        cores: manager.cpuCores(),
        memLimitMb: server.memoryMb,
        points: manager.getStats(server.id),
      });
    }

    if (action === 'player') {
      const name = url.searchParams.get('name') || '';
      if (!name) throw fail(400, 'Не указано имя игрока');
      if (method === 'GET') {
        // данные игрока (инвентарь, статы, IP) — нужен хотя бы просмотр файлов или права игроков
        requireAnyPerm(req, ['files.read', 'players.kick', 'players.ban', 'players.op', 'players.whitelist', 'players.delete']);
        const details = await playerDetails(server, name);
        // IP — персональные данные: удалённо скрываем, если нет прав модерации (кик/бан/удаление)
        if (isRemoteReq(req) && details && !['players.kick', 'players.ban', 'players.delete'].some((k) => users.hasPerm(req.cgUser, k))) details.ip = null;
        return json(res, 200, details);
      }
      if (method === 'DELETE') { requirePerm(req, 'players.delete'); return json(res, 200, deletePlayerData(server, name)); }
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
        return json(res, 200, { properties, name: server.name, memoryMb: server.memoryMb, cpuPercent: server.cpuPercent == null ? null : server.cpuPercent, javaPath: server.javaPath || '', javas: manager.listJavas() });
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
        if (body.cpuPercent !== undefined) patch.cpuPercent = sanitizeCpu(body.cpuPercent);
        if (body.javaPath !== undefined) patch.javaPath = String(body.javaPath || '').slice(0, 400);
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
        // прямая правка server.properties (режим «Файл» в настройках или редактор)
        // должна синхронизировать порт панели, иначе список покажет старый порт
        if (/(^|[\\/])server\.properties$/i.test(target)) {
          try {
            const p = props.parse(body.content);
            const newPort = parseInt(p['server-port'], 10);
            if (newPort >= 1 && newPort <= 65535 && newPort !== server.port) store.update(server.id, { port: newPort });
          } catch (e) { /* не критично */ }
        }
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

    if (action === 'files-extract' && method === 'POST') {
      requirePerm(req, 'files.write');
      const body = await readBody(req);
      const rel = String(body.path || '');
      if (!rel) throw fail(400, 'Не указан архив');
      if (!/\.(zip|jar)$/i.test(rel)) throw fail(400, 'Распаковка поддерживается только для .zip/.jar');
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
      const baseName = path.basename(rel).replace(/\.(zip|jar)$/i, '');
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
      if (server.type === 'custom') throw fail(400, 'У своего ядра нет источника для скачивания — загрузите .jar вручную');
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
  });
}

module.exports = { handleApi };
