'use strict';
/* Discord OAuth2 (scope=identify), без npm — https напрямую.
   Включается, когда заданы DISCORD_CLIENT_ID и DISCORD_CLIENT_SECRET (env на VPS).
   redirect_uri выводится из текущего эндпоинта центра (settings.endpoint). */
const https = require('https');
const crypto = require('crypto');
const settings = require('./settings');

function cfg() {
  return { clientId: process.env.DISCORD_CLIENT_ID || '', clientSecret: process.env.DISCORD_CLIENT_SECRET || '' };
}
function enabled() { const c = cfg(); return !!(c.clientId && c.clientSecret); }

function redirectUri() {
  const e = settings.endpoint();
  const host = e.host + (e.port && e.port !== 443 ? ':' + e.port : '');
  return 'https://' + host + '/api/account/discord/callback';
}
function authorizeUrl(state) {
  const c = cfg();
  const p = new URLSearchParams({
    client_id: c.clientId, redirect_uri: redirectUri(),
    response_type: 'code', scope: 'identify', state, prompt: 'consent',
  });
  return 'https://discord.com/api/oauth2/authorize?' + p.toString();
}

// --- одноразовые токены: state (CSRF+привязка ника) и link-token (старт без cookie-сессии, для десктопа) ---
const TTL = 10 * 60 * 1000;
const states = new Map();
const linkTokens = new Map();
function makeState(username) { const s = crypto.randomBytes(16).toString('hex'); states.set(s, { username, expires: Date.now() + TTL }); return s; }
function takeState(s) { const v = states.get(s); if (!v) return null; states.delete(s); return Date.now() > v.expires ? null : v; }
function makeLinkToken(username) { const t = crypto.randomBytes(24).toString('hex'); linkTokens.set(t, { username, expires: Date.now() + TTL }); return t; }
function takeLinkToken(t) { const v = linkTokens.get(t); if (!v) return null; linkTokens.delete(t); return Date.now() > v.expires ? null : v; }
const _t = setInterval(() => { const now = Date.now(); for (const [k, v] of states) if (now > v.expires) states.delete(k); for (const [k, v] of linkTokens) if (now > v.expires) linkTokens.delete(k); }, 5 * 60 * 1000);
if (_t.unref) _t.unref();

function postForm(host, p, form) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(form).toString();
    const req = https.request({ host, path: p, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } },
      (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(d || '{}') }); } catch (e) { resolve({ status: res.statusCode, json: {} }); } }); });
    req.on('error', reject); req.write(body); req.end();
  });
}
function getJson(host, p, token) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host, path: p, method: 'GET', headers: { Authorization: 'Bearer ' + token } },
      (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(d || '{}') }); } catch (e) { resolve({ status: res.statusCode, json: {} }); } }); });
    req.on('error', reject); req.end();
  });
}

/* code -> токен -> профиль. {id, name} или {error}. */
async function exchange(code) {
  const c = cfg();
  const tok = await postForm('discord.com', '/api/oauth2/token', {
    client_id: c.clientId, client_secret: c.clientSecret, grant_type: 'authorization_code', code, redirect_uri: redirectUri(),
  });
  if (tok.status !== 200 || !tok.json.access_token) return { error: 'Discord: не удалось получить токен' };
  const me = await getJson('discord.com', '/api/users/@me', tok.json.access_token);
  if (me.status !== 200 || !me.json.id) return { error: 'Discord: не удалось получить профиль' };
  const name = me.json.username + (me.json.discriminator && me.json.discriminator !== '0' ? '#' + me.json.discriminator : '');
  return { id: String(me.json.id), name };
}

module.exports = { enabled, authorizeUrl, redirectUri, makeState, takeState, makeLinkToken, takeLinkToken, exchange };
