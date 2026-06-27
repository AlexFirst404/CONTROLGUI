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
const RECONNECT_MIN_MS = 5000;
const RECONNECT_MAX_MS = 60000;
const STATUS_PUSH_MS = 20000;
const SSE_IDLE_MS = 60000;        // watchdog: нет данных (вкл. heartbeat ': hb') дольше -> рвём и реконнектим
const MAX_SSE_BUF = 64 * 1024;    // защита от безразделительного потока

// Самоподписанный серт центра, вшитый в панель -> валидируем pinned-CA + точный отпечаток.
let CA = null;
let PIN_FP = null;
try {
  CA = fs.readFileSync(path.join(__dirname, 'central-cert.pem'));
  PIN_FP = fingerprintOf(CA);
} catch (e) { /* нет файла — режим разработки */ }
// Небезопасное соединение только по явному флагу (локальный тест против иного серта).
const INSECURE = process.env.CGR_INSECURE === '1';

function fingerprintOf(pem) {
  try {
    const b64 = String(pem).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
    return crypto.createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex');
  } catch (e) { return null; }
}

const tunnels = new Map(); // serverId -> { closed, res, req, idleTimer, reconnectTimer }
const backoff = new Map(); // serverId -> ms (экспоненциальный backoff реконнекта)
const epochs = new Map();  // serverId -> номер (защита от lost-update enable/disable через await)

function bumpEpoch(id) { const e = (epochs.get(id) || 0) + 1; epochs.set(id, e); return e; }
function epochOf(id) { return epochs.get(id) || 0; }
function remoteOf(serverId) { const s = store.get(serverId); return (s && s.remote) || null; }
function isTunnelLive(serverId) { const t = tunnels.get(serverId); return !!(t && t.res); }

function applyTls(opts) {
  if (!opts.secure) return;
  if (INSECURE) { opts.rejectUnauthorized = false; return; } // ТОЛЬКО для локального теста
  if (CA) {
    opts.ca = CA;
    opts.rejectUnauthorized = true;
    if (PIN_FP) {
      // пин по ТОЧНОМУ серту: переживает любые расхождения CN/SAN, ловит подмену
      opts.checkServerIdentity = (host, cert) => {
        const fp = cert && cert.fingerprint256 ? cert.fingerprint256.replace(/:/g, '').toLowerCase() : '';
        return fp === PIN_FP ? undefined : new Error('Серт центрального сервера не совпал с закреплённым');
      };
    }
  }
  // ни CA, ни INSECURE -> системные CA (самоподписанный отвалится — это сигнал неверной сборки)
}

function centralOpts(pathName, method, dataLen) {
  const u = new URL(CENTRAL);
  const secure = u.protocol === 'https:';
  const opts = { hostname: u.hostname, port: u.port || (secure ? 443 : 80), path: pathName, method, headers: {}, secure };
  if (dataLen != null) {
    opts.headers['Content-Type'] = 'application/json';
    opts.headers['Content-Length'] = dataLen;
  }
  applyTls(opts);
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

/* Включить удалённое управление: получить globalId + код привязки, открыть туннель. */
async function enable(serverId) {
  const s = store.get(serverId);
  if (!s) throw new Error('Сервер не найден');
  // идемпотентность: уже включён и туннель жив — вернуть текущее без повторной регистрации
  if (s.remote && s.remote.enabled && isTunnelLive(serverId)) {
    return { globalId: s.remote.globalId, linkCode: s.remote.linkCode || null, claimed: !!s.remote.claimed };
  }
  const myEpoch = bumpEpoch(serverId);
  const remote = Object.assign({}, s.remote);
  if (!remote.panelToken) {
    remote.panelToken = crypto.randomBytes(32).toString('hex');
    store.update(serverId, { remote }); // фиксируем токен ДО await — анти-гонка двойного включения
  }
  const r = await request('/agent/register', 'POST', { panelToken: remote.panelToken, name: s.name, type: s.type, version: s.version });
  if (epochOf(serverId) !== myEpoch) throw new Error('Операция отменена (повторное переключение)');
  if (r.status !== 200) throw new Error('Центральный сервер недоступен (' + r.status + ')');
  const fresh = store.get(serverId) || s;
  const merged = Object.assign({}, fresh.remote, {
    enabled: true, panelToken: remote.panelToken, globalId: r.body.globalId, central: CENTRAL,
    claimed: !!r.body.claimed,
    linkCode: r.body.linkCode || (r.body.claimed ? null : ((fresh.remote && fresh.remote.linkCode) || null)),
  });
  store.update(serverId, { remote: merged });
  resetBackoff(serverId);
  connect(serverId);
  return { globalId: merged.globalId, linkCode: merged.linkCode, claimed: merged.claimed };
}

/* Выключить: закрыть туннель, пометить офлайн. panelToken сохраняем (повторное включение -> тот же сервер). */
function disable(serverId) {
  const s = store.get(serverId);
  if (!s) return;
  bumpEpoch(serverId); // отменяет любой enable() в полёте
  const remote = Object.assign({}, s.remote, { enabled: false });
  store.update(serverId, { remote });
  closeTunnel(serverId);
}

/* Полностью отвязать сервер от центра (при удалении сервера в панели): закрыть туннель,
   удалить запись на центре, стереть remote-настройки. Иначе на центре остаётся «призрак». */
function deregister(serverId) {
  const remote = remoteOf(serverId);
  bumpEpoch(serverId);
  closeTunnel(serverId);
  if (remote && remote.panelToken) {
    request('/agent/deregister', 'POST', { token: remote.panelToken }).catch(() => {});
  }
  const s = store.get(serverId);
  if (s) store.update(serverId, { remote: { enabled: false } });
}

// полностью снять туннель (для disable): снять слушатели, разрушить, забыть
function closeTunnel(serverId) {
  const t = tunnels.get(serverId);
  if (t) { t.closed = true; teardown(t); tunnels.delete(serverId); }
  backoff.delete(serverId);
}
// снять текущее соединение, не трогая enabled/таймер reconnect/запись tunnels
function teardown(t) {
  if (!t) return;
  clearTimeout(t.reconnectTimer); clearTimeout(t.idleTimer);
  if (t.res) { try { t.res.removeAllListeners(); t.res.destroy(); } catch (e) { /* */ } t.res = null; }
  if (t.req) { try { t.req.removeAllListeners(); t.req.destroy(); } catch (e) { /* */ } t.req = null; }
}

function resetBackoff(serverId) { backoff.set(serverId, RECONNECT_MIN_MS); }
function scheduleReconnect(serverId) {
  const remote = remoteOf(serverId);
  if (!remote || !remote.enabled) return;
  let t = tunnels.get(serverId);
  if (!t) { t = { closed: false }; tunnels.set(serverId, t); }
  if (t.closed) return;
  // соединение мертво -> сразу гасим res (online=false), чистим idle-watchdog
  clearTimeout(t.idleTimer);
  if (t.res) { try { t.res.removeAllListeners(); t.res.destroy(); } catch (e) { /* */ } t.res = null; }
  const cur = backoff.get(serverId) || RECONNECT_MIN_MS;
  backoff.set(serverId, Math.min(cur * 2, RECONNECT_MAX_MS));
  const delay = cur + Math.floor(cur * 0.3 * Math.random()); // jitter, чтобы панели не били синхронно
  clearTimeout(t.reconnectTimer);
  t.reconnectTimer = setTimeout(() => connect(serverId), delay);
}

function armIdle(t) {
  clearTimeout(t.idleTimer);
  t.idleTimer = setTimeout(() => { try { t.res && t.res.destroy(); } catch (e) { /* */ } }, SSE_IDLE_MS);
}

/* Открыть SSE-поток к центру: GET /agent/stream и слушать команды. */
function connect(serverId) {
  const remote = remoteOf(serverId);
  if (!remote || !remote.enabled || !remote.panelToken) return;
  const prev = tunnels.get(serverId);
  if (prev) teardown(prev); // снять старое соединение, сохранив намерение
  const o = centralOpts('/agent/stream', 'GET');
  o.headers.Accept = 'text/event-stream';
  o.headers.Authorization = 'Bearer ' + remote.panelToken; // секрет в заголовке, не в query
  const mod = o.secure ? https : http;
  const t = { closed: false, res: null, req: null, idleTimer: null, reconnectTimer: null };
  tunnels.set(serverId, t);
  // реконнект планируем ТОЛЬКО если этот t всё ещё актуальный (иначе старый сокет дёргал бы живой туннель)
  const onDrop = () => { if (tunnels.get(serverId) === t) scheduleReconnect(serverId); };
  const req = mod.request(o, (res) => {
    if (res.statusCode !== 200) { res.destroy(); onDrop(); return; } // 4xx (отозван токен) -> backoff, enabled НЕ снимаем
    t.res = res;
    resetBackoff(serverId);
    armIdle(t);
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (c) => {
      armIdle(t); // любые данные (включая ': hb') освежают watchdog
      buf += c;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) { const evt = buf.slice(0, i); buf = buf.slice(i + 2); handleEvent(serverId, evt); }
      if (buf.length > MAX_SSE_BUF) { buf = ''; try { res.destroy(); } catch (e) { /* */ } }
    });
    res.on('end', onDrop);
    res.on('close', onDrop);
    res.on('error', onDrop);
    pushStatus(serverId); // сразу отдать текущий статус
  });
  t.req = req;
  req.on('error', onDrop);
  req.end();
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

/* ВЫПОЛНЕНИЕ — строго белый список. Корректно обрабатывает осиротевшие (adopted) серверы. */
async function execAction(serverId, action) {
  if (!WHITELIST.includes(action)) return { error: 'Недопустимое действие' };
  const s = store.get(serverId);
  if (!s) return { error: 'Сервер не найден' };
  const st = manager.getState(serverId);
  const orphan = !st.proc && manager.orphanAlive && manager.orphanAlive(serverId);
  try {
    if (action === 'status') return { ok: true, status: statusOf(serverId) };
    if (action === 'start') { await manager.start(s); return { ok: true, status: statusOf(serverId) }; }
    if (action === 'stop') {
      if (orphan) { manager.kill(serverId); return { ok: true, status: 'stopping' }; } // orphan нельзя stop'ом — только kill
      manager.stop(serverId);
      return { ok: true, status: statusOf(serverId) };
    }
    if (action === 'restart') {
      if (orphan) return { error: 'Сервер запущен до перезапуска панели — остановите и запустите его заново' };
      manager.restart(s);
      return { ok: true, status: statusOf(serverId) };
    }
  } catch (e) {
    return { error: e.message || 'Ошибка выполнения' };
  }
  return { error: 'Неизвестно' };
}

function statusOf(serverId) {
  const st = manager.getState(serverId);
  // adopted-orphan: getState даёт 'stopped', но процесс реально жив -> 'running'
  if ((!st || st.status === 'stopped' || !st.status) && manager.orphanAlive && manager.orphanAlive(serverId)) return 'running';
  return st ? st.status : 'stopped';
}

function mergeClaim(serverId, body) {
  const s = store.get(serverId);
  if (!s || !s.remote || !s.remote.enabled) return;
  const claimed = !!body.claimed;
  const linkCode = claimed ? null : (body.linkCode || s.remote.linkCode || null);
  if (!!s.remote.claimed === claimed && (s.remote.linkCode || null) === linkCode) return; // без изменений
  store.update(serverId, { remote: Object.assign({}, s.remote, { claimed, linkCode }) });
}

function pushStatus(serverId) {
  const s = store.get(serverId);
  const remote = s && s.remote;
  if (!remote || !remote.enabled) return;
  request('/agent/status', 'POST', {
    token: remote.panelToken, status: statusOf(serverId), online: isTunnelLive(serverId),
    name: s.name, type: s.type, version: s.version,
  }).then((r) => { if (r && r.status === 200 && r.body) mergeClaim(serverId, r.body); }).catch(() => {});
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
    online: isTunnelLive(serverId),
  };
}

/* На старте панели — переподключить все включённые серверы + периодический статус. */
let statusTimer = null;
function initAll() {
  for (const s of store.all()) {
    if (s.remote && s.remote.enabled) { resetBackoff(s.id); connect(s.id); }
  }
  if (!statusTimer) {
    statusTimer = setInterval(() => {
      for (const s of store.all()) if (s.remote && s.remote.enabled) pushStatus(s.id);
    }, STATUS_PUSH_MS);
    if (statusTimer.unref) statusTimer.unref();
  }
}

module.exports = { enable, disable, deregister, info, initAll, connect, statusOf, CENTRAL };
