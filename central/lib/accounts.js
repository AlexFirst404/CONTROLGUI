'use strict';
/* Аккаунты центрального сервера: регистрация (с одобрением админа), вход,
   сессии-куки, анти-брутфорс. Хэш — pbkdf2 (как в панели). Без зависимостей. */
const crypto = require('crypto');
const store = require('./store');

const COOKIE = 'cgr_sid';
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 дней
const sessions = new Map(); // token -> { username, expires }

function all() { return store.load('accounts.json', []); }
function saveAll(list) { store.save('accounts.json', list); }
function findRaw(username) {
  const u = String(username || '').toLowerCase();
  return all().find((a) => a.username.toLowerCase() === u) || null;
}

function hashPw(password, salt) {
  return crypto.pbkdf2Sync(String(password), salt, 120000, 32, 'sha256').toString('hex');
}

function publicUser(u) {
  return { username: u.username, role: u.role, approved: !!u.approved, createdAt: u.createdAt };
}

/* Логин: 1–32 символа, буквы/цифры/_/-. Пароль: минимум 6. */
function validName(n) { return /^[A-Za-z0-9_-]{1,32}$/.test(String(n || '')); }

/* Сидируем админа при старте, если админа ещё нет. Возвращает {created, password}. */
function ensureAdmin(username) {
  const list = all();
  if (list.some((a) => a.role === 'admin')) return { created: false };
  const password = crypto.randomBytes(9).toString('base64').replace(/[+/=]/g, '').slice(0, 12);
  const salt = crypto.randomBytes(16).toString('hex');
  list.push({
    username: username || 'admin',
    salt,
    hash: hashPw(password, salt),
    role: 'admin',
    approved: true,
    createdAt: new Date().toISOString(),
  });
  saveAll(list);
  return { created: true, username: username || 'admin', password };
}

/* Регистрация обычного пользователя — ждёт одобрения админа. */
function register(username, password) {
  if (!validName(username)) return { error: 'Ник: 1–32 символа (буквы, цифры, _ и -)' };
  if (String(password || '').length < 6) return { error: 'Пароль: минимум 6 символов' };
  const list = all();
  if (list.some((a) => a.username.toLowerCase() === String(username).toLowerCase())) {
    return { error: 'Такой ник уже занят' };
  }
  const salt = crypto.randomBytes(16).toString('hex');
  list.push({
    username, salt, hash: hashPw(password, salt),
    role: 'user', approved: false, createdAt: new Date().toISOString(),
  });
  saveAll(list);
  return { ok: true };
}

/* Проверка входа: ник+пароль и аккаунт одобрен. */
function verify(username, password) {
  const u = findRaw(username);
  if (!u) {
    // считаем фиктивный хэш — чтобы время ответа не выдавало существование ника
    crypto.pbkdf2Sync(String(password), 'cgr-dummy-salt', 120000, 32, 'sha256');
    return null;
  }
  const cand = Buffer.from(hashPw(password, u.salt));
  const stored = Buffer.from(u.hash);
  if (cand.length !== stored.length || !crypto.timingSafeEqual(cand, stored)) return null;
  if (!u.approved) return { pending: true };
  return publicUser(u);
}

function approve(username) {
  const list = all();
  const u = list.find((a) => a.username.toLowerCase() === String(username).toLowerCase());
  if (!u) return false;
  u.approved = true;
  saveAll(list);
  return true;
}
function remove(username) {
  const list = all().filter((a) => a.username.toLowerCase() !== String(username).toLowerCase() || a.role === 'admin');
  saveAll(list);
}
function pending() { return all().filter((a) => !a.approved).map(publicUser); }
function listUsers() { return all().map(publicUser); }
function isAdmin(user) { return !!(user && user.role === 'admin'); }

// ---- сессии ----
function createSession(username) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { username, expires: Date.now() + TTL_MS });
  return token;
}
function destroySession(token) { if (token) sessions.delete(token); }
function cookieFor(token) {
  return COOKIE + '=' + token + '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + Math.floor(TTL_MS / 1000);
}
function clearCookie() { return COOKIE + '=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0'; }
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
function userFromReq(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  const s = sessions.get(token);
  if (!s || Date.now() > s.expires) { sessions.delete(token); return null; }
  const u = findRaw(s.username);
  return u && u.approved ? publicUser(u) : null;
}

// ---- анти-брутфорс входа (5 попыток -> блок 5 минут на IP) ----
const MAX_FAILS = 5;
const LOCK_MS = 5 * 60 * 1000;
const attempts = new Map();
function lockMs(ip) { const a = attempts.get(ip); return a && a.lockedUntil > Date.now() ? a.lockedUntil - Date.now() : 0; }
function noteFail(ip) {
  const a = attempts.get(ip) || { fails: 0, lockedUntil: 0 };
  a.fails += 1;
  if (a.fails >= MAX_FAILS) { a.lockedUntil = Date.now() + LOCK_MS; a.fails = 0; }
  attempts.set(ip, a);
  return a;
}
function clearFails(ip) { attempts.delete(ip); }

module.exports = {
  COOKIE, ensureAdmin, register, verify, approve, remove, pending, listUsers, isAdmin,
  createSession, destroySession, cookieFor, clearCookie, parseCookies, userFromReq, validName,
  MAX_FAILS, lockMs, noteFail, clearFails,
};
