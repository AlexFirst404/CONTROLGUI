'use strict';
/* Реестр удалённых серверов на центральном сервере.
   Сервер идентифицируется panelToken (секрет агента) + globalId (публичный id). */
const crypto = require('crypto');
const store = require('./store');

// действия MVP, которые можно делегировать назначенному пользователю
const ACTIONS = ['start', 'stop', 'restart'];

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
  const out = {
    globalId: s.globalId, name: s.name, type: s.type || null, version: s.version || null,
    status: s.status || 'offline', online: !!s.online, lastSeen: s.lastSeen || null,
    owner: s.ownerAccount || null, claimed: !!s.ownerAccount,
    access: (s.access || []).map((a) => ({ username: a.username, perms: a.perms })),
  };
  if (viewer) out.role = roleFor(viewer, s); // owner | assigned | admin | null
  return out;
}

function roleFor(user, s) {
  if (user.role === 'admin') return 'admin';
  if (s.ownerAccount && s.ownerAccount.toLowerCase() === user.username.toLowerCase()) return 'owner';
  const a = (s.access || []).find((x) => x.username.toLowerCase() === user.username.toLowerCase());
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
      name: String(meta.name || 'Сервер').slice(0, 60),
      type: meta.type || null, version: meta.version || null,
      ownerAccount: null, access: [], linkCode: genCode(),
      status: 'offline', online: false, lastSeen: Date.now(),
      createdAt: new Date().toISOString(),
    };
    list.push(s);
    isNew = true;
  } else {
    if (meta.name) s.name = String(meta.name).slice(0, 60);
    if (meta.type) s.type = meta.type;
    if (meta.version) s.version = meta.version;
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
  if (fields.status) s.status = fields.status;
  if (fields.name) s.name = String(fields.name).slice(0, 60);
  if (fields.type) s.type = fields.type;
  if (fields.version) s.version = fields.version;
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

/* Назначение доступа пользователю с правами (perms — подмножество ACTIONS). */
function assign(globalId, username, perms) {
  const list = all();
  const s = list.find((x) => x.globalId === globalId);
  if (!s) return { error: 'Сервер не найден' };
  const clean = (Array.isArray(perms) ? perms : []).filter((p) => ACTIONS.includes(p));
  s.access = (s.access || []).filter((a) => a.username.toLowerCase() !== username.toLowerCase());
  s.access.push({ username, perms: clean });
  saveAll(list);
  return { ok: true };
}
function unassign(globalId, username) {
  const list = all();
  const s = list.find((x) => x.globalId === globalId);
  if (!s) return { error: 'Сервер не найден' };
  s.access = (s.access || []).filter((a) => a.username.toLowerCase() !== username.toLowerCase());
  saveAll(list);
  return { ok: true };
}
function remove(globalId) {
  saveAll(all().filter((s) => s.globalId !== globalId));
}

/* Видимые пользователю серверы. */
function forUser(user) {
  const list = all();
  if (user.role === 'admin') return list.map((s) => publicServer(s, user));
  const me = user.username.toLowerCase();
  return list
    .filter((s) => (s.ownerAccount && s.ownerAccount.toLowerCase() === me)
      || (s.access || []).some((a) => a.username.toLowerCase() === me))
    .map((s) => publicServer(s, user));
}

/* Может ли пользователь выполнить действие над сервером. */
function canDo(user, s, action) {
  const role = roleFor(user, s);
  if (role === 'admin' || role === 'owner') return true; // владелец в MVP может всё
  if (role === 'assigned') {
    const a = (s.access || []).find((x) => x.username.toLowerCase() === user.username.toLowerCase());
    return !!(a && a.perms.includes(action));
  }
  return false;
}
function canView(user, s) { return roleFor(user, s) != null; }

module.exports = {
  ACTIONS, all, get, byToken, publicServer, roleFor,
  onRegister, updateStatus, setOnline, claimByCode, assign, unassign, remove, forUser, canDo, canView,
};
