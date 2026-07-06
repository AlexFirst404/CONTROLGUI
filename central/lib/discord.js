'use strict';
/* Discord OAuth2 (scope=identify), без npm — https напрямую.
   IMPLICIT grant (response_type=token): нужен только DISCORD_CLIENT_ID (публичный) —
   client secret НЕ требуется (у нас есть только bot-токен). Токен возвращается в
   #fragment браузеру, callback-страница шлёт его на /finish, сервер валидирует его
   через GET /users/@me (личность подтверждает сам Discord). redirect_uri регистрируется
   в дашборде приложения вручную. redirect_uri выводится из settings.endpoint. */
const https = require('https');
const crypto = require('crypto');
const settings = require('./settings');

function cfg() {
  return { clientId: process.env.DISCORD_CLIENT_ID || '', botToken: process.env.DISCORD_BOT_TOKEN || '' };
}
function enabled() { return !!cfg().clientId; }
function botEnabled() { return !!cfg().botToken; }

function redirectUri() {
  const e = settings.endpoint();
  const host = e.host + (e.port && e.port !== 443 ? ':' + e.port : '');
  return 'https://' + host + '/api/account/discord/callback';
}
function authorizeUrl(state) {
  const c = cfg();
  const p = new URLSearchParams({
    client_id: c.clientId, redirect_uri: redirectUri(),
    response_type: 'token', scope: 'identify', state, prompt: 'consent',
  });
  return 'https://discord.com/api/oauth2/authorize?' + p.toString();
}

// --- одноразовые токены: state (CSRF+привязка ника) и link-token (старт без cookie-сессии, для десктопа) ---
const TTL = 10 * 60 * 1000;
const states = new Map();
const linkTokens = new Map();
function makeState(username, kind, extra) { const s = crypto.randomBytes(16).toString('hex'); states.set(s, Object.assign({ username, kind: kind || 'link', expires: Date.now() + TTL }, extra || {})); return s; }
function takeState(s) { const v = states.get(s); if (!v) return null; states.delete(s); return Date.now() > v.expires ? null : v; }
function makeLinkToken(username) { const t = crypto.randomBytes(24).toString('hex'); linkTokens.set(t, { username, expires: Date.now() + TTL }); return t; }
function takeLinkToken(t) { const v = linkTokens.get(t); if (!v) return null; linkTokens.delete(t); return Date.now() > v.expires ? null : v; }
const _t = setInterval(() => { const now = Date.now(); for (const [k, v] of states) if (now > v.expires) states.delete(k); for (const [k, v] of linkTokens) if (now > v.expires) linkTokens.delete(k); }, 5 * 60 * 1000);
if (_t.unref) _t.unref();

function getJson(host, p, token) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host, path: p, method: 'GET', headers: { Authorization: 'Bearer ' + token } },
      (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(d || '{}') }); } catch (e) { resolve({ status: res.statusCode, json: {} }); } }); });
    req.on('error', reject); req.setTimeout(10000, () => req.destroy(new Error('timeout'))); req.end();
  });
}

/* access_token (из implicit-фрагмента) -> профиль. Личность подтверждает сам Discord. {id, name} или {error}. */
async function fetchUser(accessToken) {
  if (!/^[A-Za-z0-9._-]{8,256}$/.test(String(accessToken || ''))) return { error: 'Некорректный токен' };
  // КРИТИЧНО: сначала подтверждаем, что токен выпущен ИМЕННО нашим приложением.
  // GET /users/@me отдаёт профиль для ЛЮБОГО валидного identify-токена (в т.ч.
  // выпущенного чужим OAuth-приложением) — без этой проверки чужой токен = захват
  // аккаунта/сброс пароля. GET /oauth2/@me возвращает application.id токена; сверяем.
  let auth;
  try { auth = await getJson('discord.com', '/api/oauth2/@me', accessToken); } catch (e) { return { error: 'Discord недоступен' }; }
  if (auth.status !== 200 || !auth.json.application || String(auth.json.application.id) !== String(cfg().clientId)) {
    return { error: 'Токен выпущен не для этого приложения' };
  }
  if (auth.json.expires && Date.parse(auth.json.expires) <= Date.now()) return { error: 'Токен истёк' };
  let me;
  try { me = await getJson('discord.com', '/api/users/@me', accessToken); } catch (e) { return { error: 'Discord недоступен' }; }
  if (me.status !== 200 || !me.json.id) return { error: 'Discord: не удалось получить профиль' };
  const name = me.json.username + (me.json.discriminator && me.json.discriminator !== '0' ? '#' + me.json.discriminator : '');
  let avatar = null;
  if (me.json.avatar) {
    const ext = String(me.json.avatar).startsWith('a_') ? 'gif' : 'png';
    avatar = 'https://cdn.discordapp.com/avatars/' + me.json.id + '/' + me.json.avatar + '.' + ext + '?size=128';
  }
  return { id: String(me.json.id), name, avatar };
}

/* Аватар пользователя по его Discord-ID через bot-токен (бэкофилл для старых привязок,
   где аватар не сохранился). Возвращает URL или null. Бот должен «видеть» пользователя
   (общий сервер) — иначе Discord вернёт 404/403, и мы просто отдаём null. */
function avatarUrlFrom(id, hash) {
  if (!hash) return null;
  const ext = String(hash).startsWith('a_') ? 'gif' : 'png';
  return 'https://cdn.discordapp.com/avatars/' + id + '/' + hash + '.' + ext + '?size=128';
}
async function fetchAvatarById(userId) {
  const token = cfg().botToken;
  if (!token || !/^\d{5,32}$/.test(String(userId || ''))) return null;
  let r;
  try {
    r = await new Promise((resolve, reject) => {
      const req = https.request({ host: 'discord.com', path: '/api/v10/users/' + userId, method: 'GET',
        headers: { Authorization: 'Bot ' + token, 'User-Agent': 'CONTROLGUI-Remote (avatar backfill)' } },
        (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(d || '{}') }); } catch (e) { resolve({ status: res.statusCode, json: {} }); } }); });
      req.on('error', reject); req.setTimeout(10000, () => req.destroy(new Error('timeout'))); req.end();
    });
  } catch (e) { return null; }
  if (r.status !== 200 || !r.json.id) return null;
  return avatarUrlFrom(String(r.json.id), r.json.avatar);
}

module.exports = { enabled, botEnabled, authorizeUrl, redirectUri, makeState, takeState, makeLinkToken, takeLinkToken, fetchUser, fetchAvatarById };
