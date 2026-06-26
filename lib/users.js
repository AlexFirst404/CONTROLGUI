'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./paths');

/* Пользователи панели с правами. Пока пользователей нет — панель открыта
   (локальный режим, полный доступ). Как только создан первый пользователь —
   нужен вход, и действия ограничиваются правами. Сессии — cookie. */

const FILE = path.join(DATA_DIR, 'users.json');
const COOKIE = 'cg_user';
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const sessions = new Map(); // token -> { username, expires }

// все права (admin = всё). group — категория для UI. Порядок = порядок в UI.
const PERMISSIONS = [
  { key: 'console.view', group: 'Консоль', label: 'Просмотр консоли' },
  { key: 'console.command', group: 'Консоль', label: 'Ввод команд' },

  { key: 'logs.view', group: 'Логи', label: 'Просмотр и чтение логов' },

  { key: 'server.start', group: 'Управление сервером', label: 'Запуск' },
  { key: 'server.stop', group: 'Управление сервером', label: 'Остановка и перезапуск' },
  { key: 'server.kill', group: 'Управление сервером', label: 'Принудительное завершение' },
  { key: 'server.install', group: 'Управление сервером', label: 'Установка / переустановка ядра' },
  { key: 'server.create', group: 'Управление сервером', label: 'Создание серверов' },
  { key: 'server.delete', group: 'Управление сервером', label: 'Удаление серверов' },

  { key: 'settings.edit', group: 'Настройки', label: 'Изменение server.properties и памяти' },

  { key: 'files.read', group: 'Файлы', label: 'Просмотр и чтение файлов' },
  { key: 'files.write', group: 'Файлы', label: 'Изменение и создание файлов' },
  { key: 'files.upload', group: 'Файлы', label: 'Загрузка файлов' },
  { key: 'files.delete', group: 'Файлы', label: 'Удаление файлов и папок' },

  { key: 'players.kick', group: 'Игроки', label: 'Кик игроков' },
  { key: 'players.ban', group: 'Игроки', label: 'Бан и разбан' },
  { key: 'players.op', group: 'Игроки', label: 'Выдача OP (оператора)' },
  { key: 'players.whitelist', group: 'Игроки', label: 'Белый список' },
  { key: 'players.delete', group: 'Игроки', label: 'Удаление данных игрока' },

  { key: 'backups.create', group: 'Бэкапы', label: 'Создание бэкапов' },
  { key: 'backups.restore', group: 'Бэкапы', label: 'Восстановление из бэкапа' },
  { key: 'backups.delete', group: 'Бэкапы', label: 'Удаление бэкапов' },
];
const PERM_KEYS = PERMISSIONS.map((p) => p.key);

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

function load() {
  try { const a = JSON.parse(fs.readFileSync(FILE, 'utf8')); return Array.isArray(a) ? a : []; }
  catch (e) { return []; }
}
function save(list) { fs.writeFileSync(FILE, JSON.stringify(list, null, 2)); }

function anyUsers() { return load().length > 0; }

function hashPw(password, salt) {
  return crypto.pbkdf2Sync(String(password), salt, 120000, 32, 'sha256').toString('hex');
}

function sanitizePerms(perms, asAdmin) {
  if (asAdmin) return { admin: true };
  const out = {};
  for (const key of PERM_KEYS) out[key] = !!(perms && perms[key]);
  return out;
}

/* Доступ к серверам: null/undefined — все серверы; массив id — только эти. */
function sanitizeServers(servers) {
  if (servers == null || servers === 'all') return null;
  if (!Array.isArray(servers)) return null;
  return servers.map((x) => String(x)).filter(Boolean);
}

function publicUser(u) {
  return {
    username: u.username, admin: !!u.perms.admin, perms: u.perms,
    servers: u.servers === undefined ? null : u.servers, createdAt: u.createdAt,
  };
}

/* true — пользователю доступен этот сервер (admin или нет ограничения). */
function canAccessServer(user, serverId) {
  if (!user) return false;
  if (user.perms && user.perms.admin) return true;
  const srv = user.servers;
  if (srv == null) return true; // все серверы
  return srv.indexOf(String(serverId)) >= 0;
}

function findRaw(username) {
  const lc = String(username || '').toLowerCase();
  return load().find((u) => u.username.toLowerCase() === lc);
}

function countAdmins(list) {
  return list.filter((u) => u.perms && u.perms.admin).length;
}

function createUser(username, password, perms, asAdmin, servers) {
  username = String(username || '').trim();
  if (!/^[A-Za-z0-9_.\-]{2,24}$/.test(username)) throw fail(400, 'Логин: 2–24 символа (буквы, цифры, _ . -)');
  if (String(password || '').length < 4) throw fail(400, 'Пароль: минимум 4 символа');
  if (findRaw(username)) throw fail(409, 'Пользователь с таким логином уже есть');
  const list = load();
  const salt = crypto.randomBytes(16).toString('hex');
  const user = {
    username, salt, hash: hashPw(password, salt),
    perms: sanitizePerms(perms, asAdmin),
    servers: sanitizeServers(servers),
    createdAt: new Date().toISOString(),
  };
  list.push(user);
  save(list);
  return publicUser(user);
}

function updateUser(username, patch) {
  const list = load();
  const u = list.find((x) => x.username.toLowerCase() === String(username).toLowerCase());
  if (!u) throw fail(404, 'Пользователь не найден');
  if (patch.password) {
    if (String(patch.password).length < 4) throw fail(400, 'Пароль: минимум 4 символа');
    u.salt = crypto.randomBytes(16).toString('hex');
    u.hash = hashPw(patch.password, u.salt);
  }
  if (patch.perms || patch.admin != null) {
    const wasAdmin = u.perms.admin;
    const next = sanitizePerms(patch.perms, patch.admin);
    // нельзя снять последнего админа
    if (wasAdmin && !next.admin && countAdmins(list) <= 1) {
      throw fail(400, 'Это единственный администратор — нельзя снять права админа');
    }
    u.perms = next;
  }
  if (patch.servers !== undefined) u.servers = sanitizeServers(patch.servers);
  save(list);
  return publicUser(u);
}

function deleteUser(username) {
  const list = load();
  const u = list.find((x) => x.username.toLowerCase() === String(username).toLowerCase());
  if (!u) throw fail(404, 'Пользователь не найден');
  if (u.perms.admin && countAdmins(list) <= 1) throw fail(400, 'Нельзя удалить единственного администратора');
  save(list.filter((x) => x !== u));
}

function listUsers() {
  return load().map(publicUser);
}

function verify(username, password) {
  const u = findRaw(username);
  if (!u) return null;
  const candidate = Buffer.from(hashPw(password, u.salt));
  const stored = Buffer.from(u.hash);
  if (candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored)) return publicUser(u);
  return null;
}

// ---- сессии (cookie) ----

function createSession(username) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { username, expires: Date.now() + TTL_MS });
  return token;
}
function destroySession(token) { if (token) sessions.delete(token); }

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionFromReq(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expires) { sessions.delete(token); return null; }
  const u = findRaw(s.username);
  return u ? publicUser(u) : null;
}

/* Текущий пользователь запроса. В открытом режиме (нет пользователей) —
   синтетический админ с полным доступом. */
function currentUser(req) {
  if (!anyUsers()) return { username: null, openMode: true, admin: true, perms: { admin: true } };
  return sessionFromReq(req);
}

function hasPerm(user, key) {
  return !!(user && user.perms && (user.perms.admin || user.perms[key]));
}

function sessionCookie(token) {
  return COOKIE + '=' + token + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=' + Math.floor(TTL_MS / 1000);
}
function clearCookie() {
  return COOKIE + '=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0';
}

module.exports = {
  PERMISSIONS, PERM_KEYS, anyUsers, createUser, updateUser, deleteUser, listUsers,
  verify, createSession, destroySession, sessionFromReq, currentUser, hasPerm,
  canAccessServer, sessionCookie, clearCookie, COOKIE, parseCookies,
};
