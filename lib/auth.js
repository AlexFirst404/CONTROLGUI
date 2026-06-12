'use strict';
const crypto = require('crypto');

/* Парольная защита панели через cookie-сессию (страница логина — на самом
   сайте, не браузерный диалог). Включается переменной CONTROLGUI_PASSWORD;
   без неё панель открыта (локальный режим на Windows). */

const PASSWORD = process.env.CONTROLGUI_PASSWORD || '';
const COOKIE = 'cg_session';
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // неделя

const sessions = new Map(); // token -> expiresAt

function enabled() {
  return PASSWORD.length > 0;
}

function verifyPassword(input) {
  const a = Buffer.from(String(input));
  const b = Buffer.from(PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createSession() {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, Date.now() + TTL_MS);
  return token;
}

function destroySession(token) {
  if (token) sessions.delete(token);
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isAuthed(req) {
  if (!enabled()) return true;
  const token = parseCookies(req)[COOKIE];
  if (!token) return false;
  const expires = sessions.get(token);
  if (!expires) return false;
  if (Date.now() > expires) { sessions.delete(token); return false; }
  return true;
}

function sessionCookie(token) {
  // HttpOnly — токен недоступен из JS; Lax — не уходит при кросс-сайт-запросах
  return COOKIE + '=' + token + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=' + Math.floor(TTL_MS / 1000);
}

function clearCookie() {
  return COOKIE + '=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0';
}

module.exports = {
  enabled, verifyPassword, createSession, destroySession,
  isAuthed, parseCookies, sessionCookie, clearCookie, COOKIE,
};
