'use strict';
/* Клиент центрального сервера для ДЕСКТОП-панели: вход в аккаунт CONTROLGUI Remote, привязка
   сервера по коду, список удалённых серверов и ПРОЗРАЧНЫЙ прокси управления (центр /r/<gid>/*).
   Десктоп-панель = тонкий стрим-прокси: req.pipe -> центр -> cres.pipe (консоль/файлы/загрузки). */
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const { DATA_DIR } = require('./paths');

const CENTRAL = process.env.CGR_CENTRAL || 'https://89.125.169.61';
const ACCOUNT_FILE = path.join(DATA_DIR, 'central-account.json');
const INSECURE = process.env.CGR_INSECURE === '1';

let CA = null; let PIN_FP = null;
try { CA = fs.readFileSync(path.join(__dirname, 'central-cert.pem')); PIN_FP = fpOf(CA); } catch (e) { /* dev */ }
function fpOf(pem) { try { const b64 = String(pem).replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''); return crypto.createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex'); } catch (e) { return null; } }

let account = null; // null=не читали; false=нет; {username,cookie}
function loadAccount() {
  if (account !== null) return account;
  try { account = JSON.parse(fs.readFileSync(ACCOUNT_FILE, 'utf8')); } catch (e) { account = false; }
  return account;
}
function saveAccount(a) {
  account = a;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (a) fs.writeFileSync(ACCOUNT_FILE, JSON.stringify(a), { mode: 0o600 });
    else { try { fs.unlinkSync(ACCOUNT_FILE); } catch (e) { /* */ } }
  } catch (e) { /* */ }
}

function applyTls(o) {
  if (!o.secure) return;
  if (INSECURE) { o.rejectUnauthorized = false; return; }
  if (CA) {
    o.ca = CA; o.rejectUnauthorized = true;
    if (PIN_FP) o.checkServerIdentity = (h, c) => { const fp = c && c.fingerprint256 ? c.fingerprint256.replace(/:/g, '').toLowerCase() : ''; return fp === PIN_FP ? undefined : new Error('Серт центра не совпал с пином'); };
  }
}
function opts(pathName, method, dataLen, withCookie) {
  const u = new URL(CENTRAL); const secure = u.protocol === 'https:';
  const o = { hostname: u.hostname, port: u.port || (secure ? 443 : 80), path: pathName, method, headers: {}, secure };
  if (dataLen != null) { o.headers['Content-Type'] = 'application/json'; o.headers['Content-Length'] = dataLen; }
  const acc = loadAccount();
  if (withCookie && acc && acc.cookie) o.headers.Cookie = acc.cookie;
  applyTls(o);
  return o;
}
function cReq(pathName, method, body) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const o = opts(pathName, method, data ? Buffer.byteLength(data) : null, true);
    const mod = o.secure ? https : http;
    const req = mod.request(o, (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => { let j = {}; try { j = JSON.parse(d || '{}'); } catch (e) { /* */ } resolve({ status: res.statusCode, headers: res.headers, body: j }); }); });
    req.on('error', reject); req.setTimeout(15000, () => req.destroy(new Error('timeout')));
    if (data) req.write(data); req.end();
  });
}

async function login(username, password) {
  saveAccount(false);
  let r;
  try { r = await cReq('/api/login', 'POST', { username, password }); } catch (e) { return { error: 'Центральный сервер недоступен' }; }
  if (r.status !== 200) return { error: (r.body && r.body.error) || ('Ошибка входа (' + r.status + ')') };
  const setc = (r.headers['set-cookie'] || [''])[0].split(';')[0];
  saveAccount({ username: (r.body.user && r.body.user.username) || String(username), cookie: setc });
  return { ok: true, username: account.username };
}
async function register(username, password) {
  try { const r = await cReq('/api/register', 'POST', { username, password }); if (r.status !== 200) return { error: (r.body && r.body.error) || 'Ошибка регистрации' }; return { ok: true, pending: true }; }
  catch (e) { return { error: 'Центральный сервер недоступен' }; }
}
function logout() { const acc = loadAccount(); if (acc && acc.cookie) cReq('/api/logout', 'POST').catch(() => {}); saveAccount(false); localIdCache.clear(); return { ok: true }; }
function state() { const acc = loadAccount(); return { loggedIn: !!(acc && acc.cookie), username: acc ? acc.username : null, central: CENTRAL }; }
async function linkByCode(code) {
  try { const r = await cReq('/api/link', 'POST', { code }); if (r.status === 401) return { error: 'Нужен вход в аккаунт центра' }; if (r.status !== 200) return { error: (r.body && r.body.error) || 'Ошибка привязки' }; return { ok: true }; }
  catch (e) { return { error: 'Центральный сервер недоступен' }; }
}

const localIdCache = new Map(); // gid -> remoteLocalId
let listCache = { at: 0, data: [] }; // короткий кеш (опрос /api/servers частый — не дёргаем центр каждые 2.5с)
/* Список удалённых серверов пользователя (с резолвом локального id на удалённой панели). */
async function listRemote() {
  const acc = loadAccount();
  if (!acc || !acc.cookie) return [];
  if (Date.now() - listCache.at < 4000) return listCache.data;
  let r;
  try { r = await cReq('/api/servers', 'GET'); } catch (e) { return []; }
  if (r.status !== 200) return [];
  const servers = (r.body && r.body.servers) || [];
  const out = [];
  for (const s of servers) {
    let lid = localIdCache.get(s.globalId);
    if (!lid && s.online) {
      try { const pr = await cReq('/r/' + s.globalId + '/api/servers', 'GET'); const list = (pr.body && pr.body.servers) || []; if (list[0] && list[0].id) { lid = list[0].id; localIdCache.set(s.globalId, lid); } } catch (e) { /* */ }
    }
    out.push(Object.assign({}, s, { remoteLocalId: lid || null }));
  }
  listCache = { at: Date.now(), data: out };
  return out;
}
function gidForLocal(localId) { for (const [gid, lid] of localIdCache) if (lid === localId) return gid; return null; }
function isRemoteId(localId) { return gidForLocal(localId) != null; }

function pickFwd(h) { const out = {}; for (const k of ['content-type', 'accept', 'cache-control', 'content-disposition', 'last-modified', 'etag']) if (h[k]) out[k] = h[k]; return out; }
/* Прозрачный стрим-прокси запроса десктоп-браузера -> центр /r/<gid><req.url> -> ретрансляция. */
function proxy(req, res, gid) {
  const u = new URL(CENTRAL); const secure = u.protocol === 'https:';
  const acc = loadAccount();
  const o = { hostname: u.hostname, port: u.port || (secure ? 443 : 80), path: '/r/' + gid + req.url, method: req.method,
    headers: Object.assign(pickFwd(req.headers), acc && acc.cookie ? { Cookie: acc.cookie } : {}), secure };
  applyTls(o);
  const mod = secure ? https : http;
  const pr = mod.request(o, (cres) => { try { res.writeHead(cres.statusCode, pickFwd(cres.headers)); } catch (e) { /* */ } cres.pipe(res); });
  pr.on('error', () => { try { res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'Центральный сервер недоступен' })); } catch (e) { /* */ } });
  req.on('aborted', () => { try { pr.destroy(); } catch (e) { /* */ } });
  req.pipe(pr);
}

module.exports = { login, register, logout, state, linkByCode, listRemote, gidForLocal, isRemoteId, proxy, CENTRAL };
