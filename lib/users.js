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

// все права (admin = всё). Порядок = порядок в UI.
const PERMISSIONS = [
  { key: 'console.view', label: 'Просмотр консоли' },
  { key: 'console.command', label: 'Ввод команд в консоль' },
  { key: 'server.power', label: 'Запуск / остановка / перезапуск' },
  { key: 'server.create', label: 'Создание серверов' },
  { key: 'server.delete', label: 'Удаление серверов' },
  { key: 'settings.edit', label: 'Изменение настроек' },
  { key: 'files.read', label: 'Просмотр файлов' },
  { key: 'files.write', label: 'Изменение файлов' },
  { key: 'players.manage', label: 'Управление игроками (кик/бан/whitelist)' },
  { key: 'backups.manage', label: 'Бэкапы (создание/восстановление)' },
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

function publicUser(u) {
  return { username: u.username, admin: !!u.perms.admin, perms: u.perms, createdAt: u.createdAt };
}

function findRaw(username) {
  const lc = String(username || '').toLowerCase();
  return load().find((u) => u.username.toLowerCase() === lc);
}

function countAdmins(list) {
  return list.filter((u) => u.perms && u.perms.admin).length;
}

function createUser(username, password, perms, asAdmin) {
  username = String(username || '').trim();
  if (!/^[A-Za-z0-9_.\-]{2,24}$/.test(username)) throw fail(400, 'Логин: 2–24 символа (буквы, цифры, _ . -)');
  if (String(password || '').length < 4) throw fail(400, 'Пароль: минимум 4 символа');
  if (findRaw(username)) throw fail(409, 'Пользователь с таким логином уже есть');
  const list = load();
  const salt = crypto.randomBytes(16).toString('hex');
  const user = {
    username, salt, hash: hashPw(password, salt),
    perms: sanitizePerms(perms, asAdmin),
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
  sessionCookie, clearCookie, COOKIE, parseCookies,
};
