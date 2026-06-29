'use strict';
/* Клиент центрального сервера для ДЕСКТОП-панели: вход в аккаунт CONTROLGUI Remote, привязка
   сервера по коду, список удалённых серверов и ПРОЗРАЧНЫЙ прокси управления (центр /r/<gid>/*).
   Десктоп-панель = тонкий стрим-прокси: req.pipe -> центр -> cres.pipe (консоль/файлы/загрузки). */
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { URL } = require('url');
const { DATA_DIR } = require('./paths');

/* Базовая инфо об устройстве для админ-панели (бан по железу среди друзей).
   HWID = sha256 от отсортированных внешних MAC-адресов. Без углублённого сбора. */
/* Выбрать НАСТОЯЩИЙ физический MAC: пропустить internal/нулевые и ВИРТУАЛЬНЫЕ адаптеры
   (VMware/VirtualBox/Hyper-V/Docker/WSL/Tailscale/Radmin/VPN — по OUI-префиксу, имени
   адаптера и locally-administered-биту), предпочесть адаптер с маршрутизируемым IPv4. */
function pickPhysicalMac(ifs) {
  const VIRT_NAME = /(virtual|vmware|virtualbox|hyper-?v|vethernet|tailscale|radmin|hamachi|zerotier|nordlynx|wireguard|openvpn|docker|veth|vboxnet|vmnet|wsl|loopback|bluetooth|\bvpn\b|\btap\b|\btun\b|virbr|vnet|utun|llw|awdl|bridge|\bppp\b)/i;
  const VIRT_OUI = ['005056', '000c29', '000569', '080027', '00155d', '0242', '00163e', '525400', '0003ff', '000f4b'];
  const cands = [];
  for (const name of Object.keys(ifs)) {
    let mac = null; let routableV4 = false;
    for (const ni of (ifs[name] || [])) {
      if (!ni || ni.internal) continue;
      if (ni.mac && ni.mac !== '00:00:00:00:00:00') mac = ni.mac.toLowerCase();
      const v4 = ni.family === 'IPv4' || ni.family === 4;
      if (v4 && ni.address && !/^(127\.|169\.254\.)/.test(ni.address)) routableV4 = true;
    }
    if (!mac) continue;
    const hex = mac.replace(/[^0-9a-f]/g, '');
    const localBit = (parseInt(hex[1] || '0', 16) & 0x2) === 0x2; // locally-administered — обычно виртуальный
    const virt = VIRT_NAME.test(name) || VIRT_OUI.some((p) => hex.startsWith(p)) || localBit;
    cands.push({ mac, virt, routableV4 });
  }
  if (!cands.length) return null;
  cands.sort((a, b) => ((!b.virt) - (!a.virt)) || (b.routableV4 - a.routableV4)); // физический+IPv4 первым
  return cands[0].mac;
}

function deviceInfo() {
  try {
    const macs = [];
    const ifs = os.networkInterfaces();
    for (const k of Object.keys(ifs)) for (const ni of (ifs[k] || [])) {
      if (ni && ni.mac && ni.mac !== '00:00:00:00:00:00' && !ni.internal) macs.push(ni.mac.toLowerCase());
    }
    const hwid = macs.length ? crypto.createHash('sha256').update(macs.sort().join(',')).digest('hex').slice(0, 32) : null;
    const physMac = pickPhysicalMac(ifs);
    const cpus = os.cpus() || [];
    const plat = os.platform();
    let osName;
    if (plat === 'win32') {
      // os.release() = "10.0.26200"; build >= 22000 -> это Windows 11
      const build = parseInt((os.release().split('.')[2] || '0'), 10);
      osName = build >= 22000 ? 'Windows 11' : 'Windows 10';
    } else if (plat === 'darwin') osName = 'macOS';
    else if (plat === 'linux') osName = 'Linux';
    else osName = plat;
    let sysUser = '';
    try { sysUser = os.userInfo().username; } catch (e) { /* */ }
    return {
      hwid, mac: physMac || macs[0] || null, os: osName, osRelease: os.release(),
      cpu: cpus[0] ? String(cpus[0].model).trim() : '', cores: cpus.length,
      ramGb: Math.round(os.totalmem() / (1024 * 1024 * 1024) * 10) / 10,
      sysUser, hostname: os.hostname(),
    };
  } catch (e) { return null; }
}

const DEFAULT_CENTRAL = process.env.CGR_CENTRAL || 'https://89.125.169.61';
const ACCOUNT_FILE = path.join(DATA_DIR, 'central-account.json');
const INSECURE = process.env.CGR_INSECURE === '1';

/* Текущий адрес центра: переопределение из аккаунта (admin сменил IP — клиент мигрировал),
   иначе вшитый дефолт. Серт пинуется по отпечатку, так что новый host с тем же сертом работает. */
function currentCentral() {
  const acc = loadAccount();
  if (acc && acc.endpoint && acc.endpoint.host) {
    const port = acc.endpoint.port && acc.endpoint.port !== 443 ? ':' + acc.endpoint.port : '';
    return 'https://' + acc.endpoint.host + port;
  }
  return DEFAULT_CENTRAL;
}

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
  const u = new URL(currentCentral()); const secure = u.protocol === 'https:';
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
  const prev = loadAccount(); const keepEp = prev && prev.endpoint ? prev.endpoint : null;
  saveAccount(false);
  let r;
  try { r = await cReq('/api/login', 'POST', { username, password, device: deviceInfo() }); } catch (e) { if (keepEp) saveAccount({ endpoint: keepEp }); return { error: 'Центральный сервер недоступен' }; }
  if (r.status !== 200) { if (keepEp) saveAccount({ endpoint: keepEp }); return { error: (r.body && r.body.error) || ('Ошибка входа (' + r.status + ')') }; }
  const setc = (r.headers['set-cookie'] || [''])[0].split(';')[0];
  saveAccount({ username: (r.body.user && r.body.user.username) || String(username), cookie: setc, endpoint: keepEp });
  refreshEndpoint().catch(() => {});
  return { ok: true, username: account.username };
}
async function register(username, password) {
  const prev = loadAccount(); const keepEp = prev && prev.endpoint ? prev.endpoint : null;
  let r;
  try { r = await cReq('/api/register', 'POST', { username, password, device: deviceInfo() }); } catch (e) { return { error: 'Центральный сервер недоступен' }; }
  if (r.status !== 200) return { error: (r.body && r.body.error) || 'Ошибка регистрации' };
  const setc = (r.headers['set-cookie'] || [''])[0].split(';')[0];
  if (setc) { saveAccount({ username: (r.body.user && r.body.user.username) || String(username), cookie: setc, endpoint: keepEp }); refreshEndpoint().catch(() => {}); return { ok: true, username: account.username }; }
  // деградация (центр не залогинил) — пробуем обычный вход
  return login(username, password);
}
function logout() { const acc = loadAccount(); if (acc && acc.cookie) cReq('/api/logout', 'POST').catch(() => {}); const keepEp = acc && acc.endpoint ? acc.endpoint : null; saveAccount(keepEp ? { endpoint: keepEp } : false); localIdCache.clear(); return { ok: true }; }
function state() { const acc = loadAccount(); return { loggedIn: !!(acc && acc.cookie), username: acc ? acc.username : null, central: currentCentral(), endpoint: (acc && acc.endpoint) || null }; }

/* Узнать актуальный адрес центра и мигрировать на него (admin мог сменить IP/домен). */
async function refreshEndpoint() {
  let r;
  try { r = await cReq('/api/endpoint', 'GET'); } catch (e) { return; }
  if (r.status !== 200 || !r.body || !r.body.host) return;
  const acc = loadAccount(); if (!acc) return;
  const ep = { host: String(r.body.host), port: parseInt(r.body.port, 10) || 443 };
  if (!acc.endpoint || acc.endpoint.host !== ep.host || acc.endpoint.port !== ep.port) { acc.endpoint = ep; saveAccount(acc); }
}

/* Профиль текущего аккаунта + проверка сессии онлайн (для гейта/синка). */
async function me() {
  const acc = loadAccount();
  if (!acc || !acc.cookie) return { loggedIn: false };
  let r;
  try { r = await cReq('/api/me', 'GET'); } catch (e) { return { loggedIn: true, offline: true, username: acc.username, endpoint: acc.endpoint || null }; }
  if (r.status === 200 && r.body && r.body.user) {
    if (r.body.user.username && r.body.user.username !== acc.username) { acc.username = r.body.user.username; saveAccount(acc); }
    refreshEndpoint().catch(() => {});
    cReq('/api/account/device', 'POST', { device: deviceInfo() }).catch(() => {}); // обновляем железо/IP для админ-панели
    return { loggedIn: true, online: true, user: r.body.user, discordEnabled: !!r.body.discordEnabled, endpoint: acc.endpoint || null };
  }
  if (r.status === 401) return { loggedIn: false, expired: true };
  return { loggedIn: true, offline: true, username: acc.username, endpoint: acc.endpoint || null };
}

async function rename(newName) {
  try { const r = await cReq('/api/account/rename', 'POST', { newName }); if (r.status !== 200) return { error: (r.body && r.body.error) || 'Ошибка смены ника' }; const acc = loadAccount(); if (acc && r.body.user) { acc.username = r.body.user.username; saveAccount(acc); } return { ok: true, user: r.body.user }; }
  catch (e) { return { error: 'Центральный сервер недоступен' }; }
}
async function changePassword(current, next) {
  try { const r = await cReq('/api/account/password', 'POST', { current, next }); if (r.status !== 200) return { error: (r.body && r.body.error) || 'Ошибка смены пароля' }; return { ok: true }; }
  catch (e) { return { error: 'Центральный сервер недоступен' }; }
}
async function discordLinkInit() {
  try { const r = await cReq('/api/account/discord/link-init', 'POST'); if (r.status !== 200) return { error: (r.body && r.body.error) || 'Discord недоступен' }; return { ok: true, url: r.body.url }; }
  catch (e) { return { error: 'Центральный сервер недоступен' }; }
}
/* Вход через Discord без пароля: начать (получить url + loginToken для опроса). */
async function discordLoginInit() {
  try { const r = await cReq('/api/account/discord/login-init', 'POST'); if (r.status !== 200) return { error: (r.body && r.body.error) || 'Discord недоступен' }; return { ok: true, url: r.body.url, loginToken: r.body.loginToken }; }
  catch (e) { return { error: 'Центральный сервер недоступен' }; }
}
/* Опрос статуса входа через Discord: когда подтверждён — сохраняем cookie сессии. */
async function discordLoginPoll(loginToken) {
  let r;
  try { r = await cReq('/api/account/discord/login-poll', 'POST', { loginToken: String(loginToken || '') }); }
  catch (e) { return { error: 'Центральный сервер недоступен' }; }
  if (r.status !== 200) return { error: (r.body && r.body.error) || 'Ошибка входа' };
  if (r.body && r.body.ok && r.body.cookie) {
    const acc = loadAccount(); const keepEp = acc && acc.endpoint ? acc.endpoint : null;
    saveAccount({ username: r.body.username, cookie: String(r.body.cookie).split(';')[0], endpoint: keepEp });
    refreshEndpoint().catch(() => {});
    return { ok: true, username: r.body.username };
  }
  return { pending: true };
}
async function discordUnlink() {
  try { const r = await cReq('/api/account/discord/unlink', 'POST'); if (r.status !== 200) return { error: (r.body && r.body.error) || 'Ошибка' }; return { ok: true, user: r.body.user }; }
  catch (e) { return { error: 'Центральный сервер недоступен' }; }
}
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
  const u = new URL(currentCentral()); const secure = u.protocol === 'https:';
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

module.exports = {
  login, register, logout, state, me, rename, changePassword, discordLinkInit, discordUnlink, refreshEndpoint,
  discordLoginInit, discordLoginPoll,
  linkByCode, listRemote, gidForLocal, isRemoteId, proxy, currentCentral, CENTRAL: DEFAULT_CENTRAL,
};
