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
  // String(...) — устойчивость к уже отравленному стору (нестроковый username)
  return all().find((a) => String(a.username).toLowerCase() === u) || null;
}
function exists(username) { return !!findRaw(username); }

function hashPw(password, salt) {
  return crypto.pbkdf2Sync(String(password), salt, 120000, 32, 'sha256').toString('hex');
}

function publicUser(u) {
  return {
    username: u.username, role: u.role, approved: !!u.approved, createdAt: u.createdAt,
    discord: u.discord ? { id: u.discord.id, name: u.discord.name, avatar: u.discord.avatar || null } : null,
  };
}

/* Смена пароля по текущему паролю. */
function changePassword(username, currentPw, newPw) {
  if (String(newPw || '').length < 6) return { error: 'Новый пароль: минимум 6 символов' };
  const list = all();
  const u = list.find((a) => String(a.username).toLowerCase() === String(username).toLowerCase());
  if (!u) return { error: 'Аккаунт не найден' };
  const cand = Buffer.from(hashPw(currentPw, u.salt));
  const stored = Buffer.from(u.hash);
  if (cand.length !== stored.length || !crypto.timingSafeEqual(cand, stored)) return { error: 'Текущий пароль неверный' };
  const salt = crypto.randomBytes(16).toString('hex');
  u.salt = salt; u.hash = hashPw(newPw, salt);
  saveAll(list);
  return { ok: true };
}

/* Логин: СТРОКА 1–32 символа, буквы/цифры/_/-. typeof-проверка обязательна —
   иначе ['bob']/123 проходят String()-coerce в regex и сохраняются сырыми,
   роняя .toLowerCase() во всех обходах аккаунтов (персистентный DoS). */
function validName(n) { return typeof n === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(n); }

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

/* Регистрация обычного пользователя — АВТО-ОДОБРЕНИЕ (v1.4): аккаунт нужен с первого
   запуска десктопа, поэтому «просто логин и пароль» работает сразу. Это безопасно:
   свежий аккаунт не видит ни одного сервера, пока админ не выдаст доступ. */
function register(username, password) {
  if (!validName(username)) return { error: 'Ник: 1–32 символа (буквы, цифры, _ и -)' };
  if (String(password || '').length < 6) return { error: 'Пароль: минимум 6 символов' };
  const list = all();
  if (list.some((a) => String(a.username).toLowerCase() === username.toLowerCase())) {
    return { error: 'Такой ник уже занят' };
  }
  const salt = crypto.randomBytes(16).toString('hex');
  list.push({
    username, salt, hash: hashPw(password, salt),
    role: 'user', approved: true, createdAt: new Date().toISOString(),
  });
  saveAll(list);
  return { ok: true };
}
function count() { return all().length; }

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

function clipStr(v, max) { return String(v == null ? '' : v).replace(/[\x00-\x1f]/g, '').slice(0, max || 80); }
/* Сохранить инфо об устройстве и внешний IP (для админ-панели — бан по железу). */
function setDevice(username, device, ip) {
  const list = all();
  const u = list.find((a) => String(a.username).toLowerCase() === String(username).toLowerCase());
  if (!u) return;
  const cleanIp = ip ? clipStr(String(ip).replace(/^::ffff:/, ''), 64) : (u.lastIp || null);
  let dev = u.device || null;
  if (device && typeof device === 'object') {
    dev = {
      hwid: clipStr(device.hwid, 64), mac: clipStr(device.mac, 32), os: clipStr(device.os, 20), osRelease: clipStr(device.osRelease, 40),
      cpu: clipStr(device.cpu, 90), cores: parseInt(device.cores, 10) || 0,
      ramGb: (typeof device.ramGb === 'number' && isFinite(device.ramGb)) ? device.ramGb : 0,
      sysUser: clipStr(device.sysUser, 64), hostname: clipStr(device.hostname, 64),
    };
    u.device = dev;
  }
  if (cleanIp) u.lastIp = cleanIp;
  const now = new Date().toISOString();
  u.lastSeen = now;
  // история устройств/IP: одна запись на уникальную пару (hwid + IP); повтор — обновляем время и счётчик
  const hist = Array.isArray(u.history) ? u.history : [];
  const hwid = (dev && dev.hwid) || null;
  const key = (hwid || '?') + '|' + (cleanIp || '?');
  const ex = hist.find((h) => ((h.hwid || '?') + '|' + (h.ip || '?')) === key);
  if (ex) { ex.lastAt = now; ex.count = (ex.count || 1) + 1; if (dev) { ex.os = dev.os; ex.hostname = dev.hostname; ex.sysUser = dev.sysUser; ex.cpu = dev.cpu; ex.ramGb = dev.ramGb; } }
  else {
    hist.unshift({ hwid, ip: cleanIp || null, os: dev ? dev.os : null, hostname: dev ? dev.hostname : null,
      sysUser: dev ? dev.sysUser : null, cpu: dev ? dev.cpu : null, ramGb: dev ? dev.ramGb : null,
      firstAt: now, lastAt: now, count: 1 });
    if (hist.length > 20) hist.length = 20;
  }
  u.history = hist;
  saveAll(list);
}
/* Полная инфо для админа (Discord + железо + IP + дата). */
function adminInfo(username) {
  const u = findRaw(username);
  if (!u) return null;
  return {
    username: u.username, role: u.role, approved: !!u.approved, createdAt: u.createdAt,
    lastSeen: u.lastSeen || null, lastIp: u.lastIp || null, device: u.device || null,
    history: Array.isArray(u.history) ? u.history : [],
    discord: u.discord ? { id: u.discord.id, name: u.discord.name, avatar: u.discord.avatar || null } : null,
  };
}

function approve(username) {
  const list = all();
  const u = list.find((a) => String(a.username).toLowerCase() === String(username).toLowerCase());
  if (!u) return false;
  u.approved = true;
  saveAll(list);
  return true;
}
function remove(username) {
  const list = all().filter((a) => String(a.username).toLowerCase() !== String(username).toLowerCase() || a.role === 'admin');
  saveAll(list);
}

/* Переименование своего аккаунта. Каскад в серверах (ownerAccount/access) делает вызывающий
   через servers.renameAccount. Активные сессии переносятся на новый ник, чтобы вход не отвалился. */
function rename(oldName, newName) {
  if (!validName(newName)) return { error: 'Ник: 1–32 символа (буквы, цифры, _ и -)' };
  const list = all();
  const u = list.find((a) => String(a.username).toLowerCase() === String(oldName).toLowerCase());
  if (!u) return { error: 'Аккаунт не найден' };
  const same = String(newName).toLowerCase() === String(oldName).toLowerCase();
  if (!same && list.some((a) => String(a.username).toLowerCase() === String(newName).toLowerCase())) {
    return { error: 'Такой ник уже занят' };
  }
  u.username = newName;
  saveAll(list);
  for (const s of sessions.values()) {
    if (String(s.username).toLowerCase() === String(oldName).toLowerCase()) s.username = newName;
  }
  return { ok: true, user: publicUser(u) };
}

/* Привязка/отвязка Discord. discord=null -> отвязать. Один Discord = один аккаунт. */
function setDiscord(username, discord) {
  const list = all();
  const u = list.find((a) => String(a.username).toLowerCase() === String(username).toLowerCase());
  if (!u) return { error: 'Аккаунт не найден' };
  if (discord) {
    const id = String(discord.id);
    const taken = list.find((a) => a.discord && String(a.discord.id) === id
      && String(a.username).toLowerCase() !== String(username).toLowerCase());
    if (taken) return { error: 'Этот Discord уже привязан к другому аккаунту' };
    u.discord = { id, name: String(discord.name || ''), avatar: discord.avatar || null, linkedAt: new Date().toISOString() };
  } else {
    delete u.discord;
  }
  saveAll(list);
  return { ok: true, user: publicUser(u) };
}
/* Найти аккаунт по привязанному Discord-ID (для сброса пароля через Discord). */
function byDiscordId(id) {
  const did = String(id || '');
  if (!did) return null;
  return all().find((a) => a.discord && String(a.discord.id) === did) || null;
}

// ---- сброс пароля через Discord (одноразовый токен после подтверждения личности) ----
const resetTokens = new Map(); // token -> { username, expires }
function makeResetToken(username) {
  const t = crypto.randomBytes(24).toString('hex');
  resetTokens.set(t, { username, expires: Date.now() + 10 * 60 * 1000 });
  return t;
}
function takeResetToken(t) {
  const v = resetTokens.get(String(t || ''));
  if (!v) return null;
  resetTokens.delete(String(t));
  return Date.now() > v.expires ? null : v;
}
/* Назначить новый пароль без знания текущего (после подтверждения через Discord). */
function setPassword(username, newPw) {
  if (String(newPw || '').length < 6) return { error: 'Пароль: минимум 6 символов' };
  const list = all();
  const u = list.find((a) => String(a.username).toLowerCase() === String(username).toLowerCase());
  if (!u) return { error: 'Аккаунт не найден' };
  const salt = crypto.randomBytes(16).toString('hex');
  u.salt = salt; u.hash = hashPw(newPw, salt);
  saveAll(list);
  return { ok: true, username: u.username };
}

function pending() { return all().filter((a) => !a.approved).map(publicUser); }
function listUsers() { return all().map(publicUser); }
// одобренные ники (для выбора при выдаче доступа) — без админов
function approvedNames() { return all().filter((a) => a.approved && a.role !== 'admin').map((a) => a.username); }
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
  a.lastSeen = Date.now();
  if (a.fails >= MAX_FAILS) { a.lockedUntil = Date.now() + LOCK_MS; a.fails = 0; }
  attempts.set(ip, a);
  return a;
}
function clearFails(ip) { attempts.delete(ip); }

// периодический свип карт в памяти: истёкшие сессии и старые записи попыток.
// Без свипа карты растут неограниченно (особенно attempts при спуфинге ключа).
function sweep() {
  const now = Date.now();
  for (const [t, s] of sessions) if (now > s.expires) sessions.delete(t);
  for (const [ip, a] of attempts) {
    const idle = now - (a.lastSeen || 0);
    if (a.lockedUntil <= now && idle > LOCK_MS) attempts.delete(ip); // не активна и не залочена
  }
  for (const [t, v] of resetTokens) if (now > v.expires) resetTokens.delete(t);
}
const _sweepTimer = setInterval(sweep, 10 * 60 * 1000);
if (_sweepTimer.unref) _sweepTimer.unref();

module.exports = {
  COOKIE, ensureAdmin, register, verify, approve, remove, rename, setDiscord, changePassword, setDevice, adminInfo, count,
  byDiscordId, makeResetToken, takeResetToken, setPassword,
  pending, listUsers, approvedNames, isAdmin, exists,
  createSession, destroySession, cookieFor, clearCookie, parseCookies, userFromReq, validName,
  MAX_FAILS, lockMs, noteFail, clearFails,
};
