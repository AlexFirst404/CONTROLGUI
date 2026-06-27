'use strict';
/* Реестр удалённых серверов на центральном сервере.
   Сервер идентифицируется panelToken (секрет агента) + globalId (публичный id). */
const crypto = require('crypto');
const store = require('./store');

// действия простого диспетча (кнопки в списке серверов)
const ACTIONS = ['start', 'stop', 'restart'];
// права полного удалённого управления (подмножество прав панели; БЕЗ create/delete/admin)
const REMOTE_PERMS = [
  'console.view', 'console.command', 'logs.view',
  'server.start', 'server.stop', 'server.kill', 'server.install',
  'settings.edit',
  'files.read', 'files.write', 'files.upload', 'files.delete',
  'players.kick', 'players.ban', 'players.op', 'players.whitelist', 'players.delete',
  'backups.create', 'backups.restore', 'backups.delete',
];
// маппинг простого действия -> требуемое право панели (для legacy кнопок)
const ACTION_PERM = { start: 'server.start', stop: 'server.stop', restart: 'server.stop' };
// нормализация поля от агента: строка, обрез, без управляющих символов
function clip(v, max) { return String(v == null ? '' : v).replace(/[\x00-\x1f\x7f]/g, '').slice(0, max || 40); }

// online выводим из ЖИВОГО набора SSE-стримов, а не из персистентного булеана
// (иначе после рестарта центра / жёсткого краша панели статус «online» вечен).
// Чекер инжектится из server.js, чтобы не было циклического require (servers<->agents).
let liveChecker = null;
function setLiveChecker(fn) { liveChecker = fn; }
function isLive(s) { return liveChecker ? !!liveChecker(s.panelToken) : !!s.online; }

function all() { return store.load('servers.json', []); }
function saveAll(list) { store.save('servers.json', list); }
function get(globalId) { return all().find((s) => s.globalId === globalId) || null; }
function genCode() {
  // короткий читаемый код (без похожих символов)
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 8; i++) c += abc[crypto.randomBytes(1)[0] % abc.length];
  return c.slice(0, 4) + '-' + c.slice(4);
}

function publicServer(s, viewer) {
  const role = viewer ? roleFor(viewer, s) : null;
  const out = {
    globalId: s.globalId, name: s.name, type: s.type || null, version: s.version || null,
    status: s.status || 'offline', online: isLive(s), lastSeen: s.lastSeen || null,
    owner: s.ownerAccount || null, claimed: !!s.ownerAccount,
  };
  // полный список доступа (ACL) видят только владелец и админ — не утекаем его назначенным
  if (role === 'owner' || role === 'admin') {
    out.access = (s.access || []).map((a) => ({ username: a.username, perms: a.perms }));
  }
  if (viewer) out.role = role; // owner | assigned | admin | null
  return out;
}

function roleFor(user, s) {
  if (user.role === 'admin') return 'admin';
  if (s.ownerAccount && String(s.ownerAccount).toLowerCase() === String(user.username).toLowerCase()) return 'owner';
  const a = (s.access || []).find((x) => String(x.username).toLowerCase() === String(user.username).toLowerCase());
  return a ? 'assigned' : null;
}

/* Регистрация агента: найти по panelToken или создать. Возвращает {server, isNew}. */
function onRegister(panelToken, meta) {
  const list = all();
  let s = list.find((x) => x.panelToken === panelToken);
  let isNew = false;
  if (!s) {
    s = {
      globalId: crypto.randomBytes(6).toString('hex'),
      panelToken,
      name: clip(meta.name || 'Сервер', 60) || 'Сервер',
      type: clip(meta.type, 40) || null, version: clip(meta.version, 40) || null,
      ownerAccount: null, access: [], linkCode: genCode(),
      status: 'offline', online: false, lastSeen: Date.now(),
      createdAt: new Date().toISOString(),
    };
    list.push(s);
    isNew = true;
  } else {
    if (meta.name) s.name = clip(meta.name, 60);
    if (meta.type) s.type = clip(meta.type, 40);
    if (meta.version) s.version = clip(meta.version, 40);
    s.lastSeen = Date.now();
  }
  saveAll(list);
  return { server: s, isNew };
}

function byToken(panelToken) { return all().find((s) => s.panelToken === panelToken) || null; }

function updateStatus(panelToken, fields) {
  const list = all();
  const s = list.find((x) => x.panelToken === panelToken);
  if (!s) return null;
  if (fields.status) s.status = clip(fields.status, 20);
  if (fields.name) s.name = clip(fields.name, 60);
  if (fields.type) s.type = clip(fields.type, 40);
  if (fields.version) s.version = clip(fields.version, 40);
  s.online = fields.online !== undefined ? !!fields.online : s.online;
  s.lastSeen = Date.now();
  saveAll(list);
  return s;
}

function setOnline(panelToken, online) {
  const list = all();
  const s = list.find((x) => x.panelToken === panelToken);
  if (!s) return;
  s.online = !!online;
  s.lastSeen = Date.now();
  if (!online) s.status = 'offline';
  saveAll(list);
}

/* Привязка по коду -> владелец. */
function claimByCode(code, username) {
  const list = all();
  const s = list.find((x) => x.linkCode && x.linkCode.toUpperCase() === String(code || '').toUpperCase().trim());
  if (!s) return { error: 'Код не найден или уже использован' };
  if (s.ownerAccount) return { error: 'Сервер уже привязан' };
  s.ownerAccount = username;
  delete s.linkCode;
  saveAll(list);
  return { ok: true, server: s };
}

/* Назначение доступа пользователю с правами (perms — подмножество REMOTE_PERMS). */
function assign(globalId, username, perms) {
  const list = all();
  const s = list.find((x) => x.globalId === globalId);
  if (!s) return { error: 'Сервер не найден' };
  const clean = (Array.isArray(perms) ? perms : []).filter((p) => REMOTE_PERMS.includes(p));
  s.access = (s.access || []).filter((a) => String(a.username).toLowerCase() !== String(username).toLowerCase());
  s.access.push({ username: String(username), perms: clean });
  saveAll(list);
  return { ok: true };
}
function unassign(globalId, username) {
  const list = all();
  const s = list.find((x) => x.globalId === globalId);
  if (!s) return { error: 'Сервер не найден' };
  s.access = (s.access || []).filter((a) => String(a.username).toLowerCase() !== String(username).toLowerCase());
  saveAll(list);
  return { ok: true };
}
function remove(globalId) {
  saveAll(all().filter((s) => s.globalId !== globalId));
}

/* Каскад при переименовании аккаунта: ownerAccount и access[].username -> новый ник. */
function renameAccount(oldName, newName) {
  const list = all();
  let changed = false;
  const lo = String(oldName).toLowerCase();
  for (const s of list) {
    if (s.ownerAccount && String(s.ownerAccount).toLowerCase() === lo) { s.ownerAccount = newName; changed = true; }
    for (const a of (s.access || [])) {
      if (String(a.username).toLowerCase() === lo) { a.username = newName; changed = true; }
    }
  }
  if (changed) saveAll(list);
  return changed;
}
function removeByToken(panelToken) {
  const before = all();
  const after = before.filter((s) => s.panelToken !== panelToken);
  if (after.length !== before.length) { saveAll(after); return true; }
  return false;
}

/* Видимые пользователю серверы. */
function forUser(user) {
  const list = all();
  if (user.role === 'admin') return list.map((s) => publicServer(s, user));
  const me = user.username.toLowerCase();
  return list
    .filter((s) => (s.ownerAccount && String(s.ownerAccount).toLowerCase() === me)
      || (s.access || []).some((a) => String(a.username).toLowerCase() === me))
    .map((s) => publicServer(s, user));
}

/* Может ли пользователь выполнить простое действие (start/stop/restart) над сервером. */
function canDo(user, s, action) {
  const role = roleFor(user, s);
  if (role === 'admin' || role === 'owner') return true;
  if (role === 'assigned') {
    const a = (s.access || []).find((x) => String(x.username).toLowerCase() === String(user.username).toLowerCase());
    const have = a && Array.isArray(a.perms) ? a.perms : [];
    return have.includes(ACTION_PERM[action]) || have.includes(action); // + back-compat
  }
  return false;
}
function canView(user, s) { return roleFor(user, s) != null; }

/* Набор прав панели для проксирования: владелец/админ — все REMOTE_PERMS; назначенный — его подмножество. */
function permSet(user, s) {
  const role = roleFor(user, s);
  if (role === 'admin' || role === 'owner') return REMOTE_PERMS.slice();
  if (role === 'assigned') {
    const a = (s.access || []).find((x) => String(x.username).toLowerCase() === String(user.username).toLowerCase());
    return (a && Array.isArray(a.perms) ? a.perms : []).filter((p) => REMOTE_PERMS.includes(p));
  }
  return [];
}

// при старте центра сбрасываем online=false у всех — поднимутся заново по SSE
function resetAllOnline() {
  const list = all();
  let changed = false;
  for (const s of list) if (s.online) { s.online = false; s.status = 'offline'; changed = true; }
  if (changed) saveAll(list);
}

module.exports = {
  ACTIONS, REMOTE_PERMS, all, get, byToken, publicServer, roleFor,
  onRegister, updateStatus, setOnline, claimByCode, assign, unassign, remove, renameAccount, forUser, canDo, canView, permSet,
  setLiveChecker, resetAllOnline, removeByToken,
};
