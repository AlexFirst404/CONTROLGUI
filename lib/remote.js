'use strict';
/* Клиент удалённого управления (агент локальной панели).
   Держит исходящий SSE-туннель к центральному серверу (за NAT, без проброса портов),
   слушает команды из БЕЛОГО СПИСКА и постит результаты. Без npm-зависимостей. */
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const store = require('./store');
const manager = require('./manager');

// Адрес центрального сервера зашит в сборку. Можно переопределить для теста.
const CENTRAL = process.env.CGR_CENTRAL || 'https://89.125.169.61';
// Только эти действия панель примет из туннеля. Никакого произвольного кода.
const WHITELIST = ['start', 'stop', 'restart', 'status'];
const RECONNECT_MS = 5000;
const STATUS_PUSH_MS = 20000;

// Самоподписанный серт центра, вшитый в панель -> валидируем pinned-CA (без MITM-дыры).
let CA = null;
try { CA = fs.readFileSync(path.join(__dirname, 'central-cert.pem')); } catch (e) { /* нет файла — режим разработки */ }
// Разрешить небезопасное соединение только если явно попросили (локальный тест).
const INSECURE = process.env.CGR_INSECURE === '1';

const tunnels = new Map(); // serverId -> { res, reconnectTimer, closed }

function centralOpts(pathName, method, dataLen) {
  const u = new URL(CENTRAL);
  const secure = u.protocol === 'https:';
  const opts = {
    hostname: u.hostname,
    port: u.port || (secure ? 443 : 80),
    path: pathName,
    method,
    headers: {},
    secure,
  };
  if (dataLen != null) {
    opts.headers['Content-Type'] = 'application/json';
    opts.headers['Content-Length'] = dataLen;
  }
  if (secure) {
    if (CA) opts.ca = CA;
    else if (INSECURE) opts.rejectUnauthorized = false;
  }
  return opts;
}

function request(pathName, method, body) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const o = centralOpts(pathName, method, data ? Buffer.byteLength(data) : null);
    const mod = o.secure ? https : http;
    const req = mod.request(o, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => { let j = {}; try { j = JSON.parse(d || '{}'); } catch (e) { /* */ } resolve({ status: res.statusCode, body: j }); });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
    if (data) req.write(data);
    req.end();
  });
}

function remoteOf(serverId) {
  const s = store.get(serverId);
  return (s && s.remote) || null;
}

/* Включить удалённое управление: получить globalId + код привязки, открыть туннель. */
async function enable(serverId) {
  const s = store.get(serverId);
  if (!s) throw new Error('Сервер не найден');
  const remote = Object.assign({}, s.remote);
  if (!remote.panelToken) remote.panelToken = crypto.randomBytes(32).toString('hex');
  const r = await request('/agent/register', 'POST', {
    panelToken: remote.panelToken, name: s.name, type: s.type, version: s.version,
  });
  if (r.status !== 200) throw new Error('Центральный сервер недоступен (' + r.status + ')');
  remote.enabled = true;
  remote.globalId = r.body.globalId;
  remote.central = CENTRAL;
  remote.claimed = !!r.body.claimed;
  // linkCode приходит только пока сервер не привязан к аккаунту
  remote.linkCode = r.body.linkCode || (remote.claimed ? null : remote.linkCode) || null;
  store.update(serverId, { remote });
  connect(serverId);
  return { globalId: remote.globalId, linkCode: remote.linkCode, claimed: remote.claimed };
}

/* Выключить: закрыть туннель, пометить офлайн. panelToken сохраняем (повторное включение -> тот же сервер). */
function disable(serverId) {
  const s = store.get(serverId);
  if (!s) return;
  const remote = Object.assign({}, s.remote, { enabled: false });
  store.update(serverId, { remote });
  closeTunnel(serverId);
}

function closeTunnel(serverId) {
  const t = tunnels.get(serverId);
  if (t) {
    t.closed = true;
    clearTimeout(t.reconnectTimer);
    try { t.res && t.res.destroy(); } catch (e) { /* */ }
    try { t.req && t.req.destroy(); } catch (e) { /* */ }
    tunnels.delete(serverId);
  }
}

function scheduleReconnect(serverId) {
  const remote = remoteOf(serverId);
  if (!remote || !remote.enabled) return;
  let t = tunnels.get(serverId);
  if (!t) { t = {}; tunnels.set(serverId, t); }
  if (t.closed) return;
  clearTimeout(t.reconnectTimer);
  t.reconnectTimer = setTimeout(() => connect(serverId), RECONNECT_MS);
}

/* Открыть SSE-поток к центру: GET /agent/stream?token=… и слушать команды. */
function connect(serverId) {
  const remote = remoteOf(serverId);
  if (!remote || !remote.enabled || !remote.panelToken) return;
  closeTunnelKeep(serverId); // снять старое соединение, но не флаг enabled
  const o = centralOpts('/agent/stream?token=' + remote.panelToken, 'GET');
  o.headers.Accept = 'text/event-stream';
  const mod = o.secure ? https : http;
  const t = { closed: false };
  tunnels.set(serverId, t);
  const req = mod.request(o, (res) => {
    if (res.statusCode !== 200) { res.destroy(); scheduleReconnect(serverId); return; }
    t.res = res;
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const evt = buf.slice(0, i); buf = buf.slice(i + 2);
        handleEvent(serverId, evt);
      }
    });
    res.on('end', () => scheduleReconnect(serverId));
    res.on('close', () => scheduleReconnect(serverId));
    res.on('error', () => scheduleReconnect(serverId));
    pushStatus(serverId); // сразу отдать текущий статус
  });
  t.req = req;
  req.on('error', () => scheduleReconnect(serverId));
  req.end();
}

// закрыть текущее соединение, не трогая enabled и таймер reconnect
function closeTunnelKeep(serverId) {
  const t = tunnels.get(serverId);
  if (t) { try { t.res && t.res.destroy(); } catch (e) { /* */ } try { t.req && t.req.destroy(); } catch (e) { /* */ } clearTimeout(t.reconnectTimer); }
}

async function handleEvent(serverId, evt) {
  const line = evt.split('\n').find((l) => l.startsWith('data:'));
  if (!line) return; // ': hb' и ': ok' — комментарии, игнор
  let cmd;
  try { cmd = JSON.parse(line.slice(5).trim()); } catch (e) { return; }
  if (!cmd || !cmd.reqId || !cmd.action) return;
  const result = await execAction(serverId, String(cmd.action));
  const remote = remoteOf(serverId);
  if (!remote) return;
  request('/agent/result', 'POST', { token: remote.panelToken, reqId: cmd.reqId, result }).catch(() => {});
}

/* ВЫПОЛНЕНИЕ — строго белый список. */
async function execAction(serverId, action) {
  if (!WHITELIST.includes(action)) return { error: 'Недопустимое действие' };
  const s = store.get(serverId);
  if (!s) return { error: 'Сервер не найден' };
  try {
    if (action === 'status') return { ok: true, status: statusOf(serverId) };
    if (action === 'start') { await manager.start(s); return { ok: true, status: statusOf(serverId) }; }
    if (action === 'stop') { manager.stop(serverId); return { ok: true, status: statusOf(serverId) }; }
    if (action === 'restart') { manager.restart(s); return { ok: true, status: statusOf(serverId) }; }
  } catch (e) {
    return { error: e.message || 'Ошибка выполнения' };
  }
  return { error: 'Неизвестно' };
}

function statusOf(serverId) {
  const st = manager.getState(serverId);
  return st ? st.status : 'stopped';
}

function pushStatus(serverId) {
  const s = store.get(serverId);
  const remote = s && s.remote;
  if (!remote || !remote.enabled) return;
  request('/agent/status', 'POST', {
    token: remote.panelToken, status: statusOf(serverId), online: true,
    name: s.name, type: s.type, version: s.version,
  }).catch(() => {});
}

/* Состояние для UI настроек. */
function info(serverId) {
  const remote = remoteOf(serverId) || {};
  return {
    enabled: !!remote.enabled,
    globalId: remote.globalId || null,
    linkCode: remote.enabled && !remote.claimed ? (remote.linkCode || null) : null,
    claimed: !!remote.claimed,
    central: CENTRAL,
    online: tunnels.has(serverId) && !!(tunnels.get(serverId) || {}).res,
  };
}

/* На старте панели — переподключить все включённые серверы + периодический статус. */
let statusTimer = null;
function initAll() {
  for (const s of store.all()) {
    if (s.remote && s.remote.enabled) connect(s.id);
  }
  if (!statusTimer) {
    statusTimer = setInterval(() => {
      for (const s of store.all()) if (s.remote && s.remote.enabled) pushStatus(s.id);
    }, STATUS_PUSH_MS);
    if (statusTimer.unref) statusTimer.unref();
  }
}

module.exports = { enable, disable, info, initAll, connect, statusOf, CENTRAL };
