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
// Кадр SSE несёт проксируемый запрос целиком (вкл. bodyB64 загрузки файла до 50МБ -> ~67МБ base64).
// Центр доверенный (пиннинг серта), поэтому потолок высокий — но конечный, чтобы не копить бесконечно.
const MAX_SSE_BUF = 72 * 1024 * 1024;

// Самоподписанный серт центра. ВШИТ прямо в код строкой — чтобы пиннинг работал ВСЕГДА,
// даже если файл central-cert.pem не попал в сборку (installer/.NET мог скопировать
// только *.js, не *.pem). Файл central-cert.pem, если есть рядом, имеет приоритет
// (удобно при пере-деплое центра — заменил файл, не трогая код).
const EMBEDDED_CERT = [
  '-----BEGIN CERTIFICATE-----',
  'MIIDIjCCAgqgAwIBAgIUAQLbMeNPUsZEXEUmi0J71LsTRU8wDQYJKoZIhvcNAQEL',
  'BQAwGDEWMBQGA1UEAwwNODkuMTI1LjE2OS42MTAeFw0yNjA2MjcxMjA2MDVaFw0z',
  'NjA2MjQxMjA2MDVaMBgxFjAUBgNVBAMMDTg5LjEyNS4xNjkuNjEwggEiMA0GCSqG',
  'SIb3DQEBAQUAA4IBDwAwggEKAoIBAQCIedHtTPpn4MHFhvxh3P52HlZjg2m7mTpJ',
  '3zsZ8XuPFsQ25GkG37cOzxMghOytKBwvv0VtYsfVlVJnMujwy6pnlgqjNHoyo6q7',
  'rvWkfrbvLY21nHpuweOOWfsoLJK8/MyMsFwpJgYNKgvngtmq1A2uYVI4g/IMBL3D',
  's546pT3io1AXZ4UFSSBwKV3Nb8UqZmZmWSiT42xthd+DyYs1ghf4Rui47usvfHyr',
  'FDUSoJ1H6kqV3gTmGve0C1PtZUQqxEGsoUUegr3nPaGDXXZEXGXL+3l0jUCpS/zv',
  '/XwvZJcIqblqlvSdUgz8WXOZEc1Y8SA37rxrjcm+H+xiaew/8+P7AgMBAAGjZDBi',
  'MB0GA1UdDgQWBBS9HTlCx/97C6xYDhpF3sULPwDQfTAfBgNVHSMEGDAWgBS9HTlC',
  'x/97C6xYDhpF3sULPwDQfTAPBgNVHRMBAf8EBTADAQH/MA8GA1UdEQQIMAaHBFl9',
  'qT0wDQYJKoZIhvcNAQELBQADggEBABG93YE8Ajr2X8IUtLw+al9ziHj+A8y/r40U',
  'gNZ7RsH036vNJg11gpBhgVlrOEMQZk4/3O6KP6l0GwUbvEzcCDKQu71secO1HcOC',
  'BUEDjDecgIZtXoegHIzhyN3+/Ji0txpN0CuMZv+3Kpj4PVVSbtE+BI38oZDy6Dl5',
  'rn9PRzEKfT5a1oobMm5AeFpN4B5YMnZaT7FjphvjmwgjLpMJB+l6o5FE9p0/Fna+',
  'O/i9yaklje32+yYEgmSztldqC4dqS91FTjFRklvUo1IDHUoCPNHPN2dKpJDKf9ZI',
  'P2o0UjJQMFepe46xFioBnoirGNqrTNsfAno/L05GT43nzHet3tA=',
  '-----END CERTIFICATE-----', '',
].join('\n');
let CA = Buffer.from(EMBEDDED_CERT, 'utf8');
try { CA = fs.readFileSync(path.join(__dirname, 'central-cert.pem')); } catch (e) { /* нет файла — берём вшитый */ }
let PIN_FP = fingerprintOf(CA);
// Небезопасное соединение только по явному флагу (локальный тест против иного серта).
const INSECURE = process.env.CGR_INSECURE === '1';

// ---- внутренний прокси полного удалённого управления (loopback к собственной панели) ----
const PANEL_PORT = parseInt(process.env.PORT, 10) || 8400;
const INTERNAL_SECRET = crypto.randomBytes(24).toString('hex'); // per-process, знает только этот модуль
const INTERNAL_HDR = 'x-cg-internal';
const PROXY_BODY_LIMIT = 8 * 1024 * 1024; // не-потоковое тело (правка файлов и т.п.)
const loopbackStreams = new Map(); // reqId -> loopback ClientRequest (для stream-close)
// allowlist прав удалённого управления — панель НЕ доверяет центру слепо (defense-in-depth):
// никогда не принимаем 'admin' и панель-уровневые ключи, только серверные права.
const REMOTE_PERM_ALLOW = new Set([
  'console.view', 'console.command', 'logs.view',
  'server.start', 'server.stop', 'server.kill', 'server.install',
  'settings.edit', 'files.read', 'files.write', 'files.upload', 'files.delete',
  'players.kick', 'players.ban', 'players.op', 'players.whitelist', 'players.delete',
  'backups.create', 'backups.restore', 'backups.delete',
]);

function isLoopback(addr) {
  addr = String(addr || '');
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}
function secretOk(got) {
  const a = Buffer.from(String(got || ''));
  const b = Buffer.from(INTERNAL_SECRET);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
/* Принципал проксированного запроса: ТОЛЬКО с 127.0.0.1 + валидный внутренний секрет.
   Доступ жёстко ограничен ОДНИМ сервером и правами из allowlist. admin=false. remote=true —
   чтобы api.js мог дополнительно резать опасное для удалёнки (запись исполняемых файлов и т.п.). */
function internalUserFor(req) {
  if (!isLoopback(req.socket && req.socket.remoteAddress)) return null;
  // настоящий loopback от lib/remote.js не несёт X-Forwarded-For; его наличие = запрос пришёл
  // через реверс-прокси (внешний) — такому внутренний принципал не выдаём.
  if (req.headers['x-forwarded-for'] || req.headers['forwarded']) return null;
  if (!secretOk(req.headers[INTERNAL_HDR])) return null;
  const perms = {};
  try { for (const k of JSON.parse(req.headers['x-cg-perms'] || '[]')) if (REMOTE_PERM_ALLOW.has(String(k))) perms[String(k)] = true; } catch (e) { /* */ }
  const sid = String(req.headers['x-cg-server'] || '');
  return { username: String(req.headers['x-cg-actor'] || 'remote'), admin: false, remote: true, perms, servers: sid ? [sid] : [] };
}

function pickRespHeaders(h) {
  const out = {};
  for (const k of ['content-type', 'content-length', 'cache-control', 'content-disposition', 'last-modified', 'etag']) if (h[k]) out[k] = h[k];
  return out;
}
function loopbackOpts(serverId, cmd) {
  return {
    host: '127.0.0.1', port: PANEL_PORT, method: cmd.method || 'GET', path: cmd.path || '/',
    headers: Object.assign({}, cmd.headers || {}, {
      [INTERNAL_HDR]: INTERNAL_SECRET,
      'x-cg-perms': JSON.stringify(cmd.perms || []),
      'x-cg-server': serverId,
      'x-cg-actor': cmd.actor || 'remote',
    }),
  };
}
function postResult(token, reqId, result) { request('/agent/result', 'POST', { token, reqId, result }).catch(() => {}); }
function postChunk(token, reqId, msg) { return request('/agent/chunk', 'POST', Object.assign({ token, reqId }, msg)).catch(() => {}); }

const PROXY_TIMEOUT_MS = 60000; // долгие операции (бэкап/установка) — выше 15-сек дефолта

/* Выполнить проксированный HTTP-запрос против собственной панели и вернуть ответ в туннель. */
function handleProxyHttp(serverId, cmd) {
  const remote = remoteOf(serverId);
  if (!remote) return;
  const token = remote.panelToken;
  const o = loopbackOpts(serverId, cmd);
  if (cmd.stream) {
    const lr = http.request(o, (resp) => {
      // КОАЛЕСЦЕНЦИЯ + порядок + backpressure: данные копим и шлём пачками (история консоли
      // приходит всплеском мелких событий — иначе на сайте она «рисуется построчно»). Флашим по
      // размеру (32КБ) или таймеру (40мс). Порядок держим цепочкой промисов, паузим loopback до доставки.
      let chain = postChunk(token, cmd.reqId, { head: { status: resp.statusCode, headers: pickRespHeaders(resp.headers) } });
      let buf = []; let bufSize = 0; let flushTimer = null;
      const flush = () => {
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
        if (!buf.length) return;
        const data = Buffer.concat(buf); buf = []; bufSize = 0;
        resp.pause();
        chain = chain.then(() => postChunk(token, cmd.reqId, { dataB64: data.toString('base64') })).then(() => resp.resume());
      };
      resp.on('data', (d) => {
        buf.push(d); bufSize += d.length;
        if (bufSize >= 32 * 1024) flush();
        else if (!flushTimer) flushTimer = setTimeout(flush, 40);
      });
      resp.on('end', () => { flush(); chain.then(() => postChunk(token, cmd.reqId, { done: true })); loopbackStreams.delete(cmd.reqId); });
      resp.on('error', () => { flush(); chain.then(() => postChunk(token, cmd.reqId, { done: true })); loopbackStreams.delete(cmd.reqId); });
    });
    lr.on('error', () => { postChunk(token, cmd.reqId, { head: { status: 502, headers: {} }, done: true }); loopbackStreams.delete(cmd.reqId); });
    loopbackStreams.set(cmd.reqId, lr);
    if (cmd.bodyB64) lr.write(Buffer.from(cmd.bodyB64, 'base64'));
    lr.end();
  } else {
    const lr = http.request(o, (resp) => {
      const chunks = []; let size = 0; let over = false;
      resp.on('data', (d) => { size += d.length; if (size <= PROXY_BODY_LIMIT) chunks.push(d); else over = true; });
      resp.on('end', () => {
        if (over) return postResult(token, cmd.reqId, { status: 413, headers: { 'content-type': 'application/json' }, bodyB64: Buffer.from(JSON.stringify({ error: 'Ответ слишком большой для удалённого доступа' })).toString('base64') });
        const body = Buffer.concat(chunks);
        postResult(token, cmd.reqId, { status: resp.statusCode, headers: pickRespHeaders(resp.headers), bodyB64: body.toString('base64') });
      });
      resp.on('error', () => postResult(token, cmd.reqId, { status: 502, headers: {}, bodyB64: '' }));
    });
    lr.on('error', (e) => postResult(token, cmd.reqId, { status: 502, headers: { 'content-type': 'application/json' }, bodyB64: Buffer.from(JSON.stringify({ error: 'Панель недоступна: ' + e.message })).toString('base64') }));
    lr.setTimeout(PROXY_TIMEOUT_MS, () => lr.destroy(new Error('loopback timeout')));
    if (cmd.bodyB64) lr.write(Buffer.from(cmd.bodyB64, 'base64'));
    lr.end();
  }
}
function closeLoopbackStream(reqId) {
  const lr = loopbackStreams.get(reqId);
  if (lr) { try { lr.destroy(); } catch (e) { /* */ } loopbackStreams.delete(reqId); }
}

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

/* Переиздать код привязки (для ещё не привязанного сервера). Старый код перестаёт работать. */
async function regenerate(serverId) {
  const s = store.get(serverId);
  if (!s) throw new Error('Сервер не найден');
  if (!s.remote || !s.remote.enabled || !s.remote.panelToken) throw new Error('Удалённое управление не включено');
  if (s.remote.claimed) throw new Error('Сервер уже привязан — код не нужен');
  const r = await request('/agent/regen-code', 'POST', { panelToken: s.remote.panelToken });
  if (r.status !== 200 || !r.body || !r.body.linkCode) {
    throw new Error((r.body && r.body.error) || ('Центральный сервер недоступен (' + r.status + ')'));
  }
  const fresh = store.get(serverId) || s;
  const merged = Object.assign({}, fresh.remote, { linkCode: r.body.linkCode, claimed: false });
  store.update(serverId, { remote: merged });
  return { linkCode: merged.linkCode, claimed: false };
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
  if (!cmd || !cmd.reqId) return;
  if (cmd.kind === 'http') return handleProxyHttp(serverId, cmd);          // полное удалённое управление
  if (cmd.kind === 'stream-close') return closeLoopbackStream(cmd.reqId);  // браузер закрыл поток
  if (!cmd.action) return;
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
    name: s.name, type: s.type, version: s.version, ownerHidden: !!remote.ownerHidden,
  }).then((r) => { if (r && r.status === 200 && r.body) mergeClaim(serverId, r.body); }).catch(() => {});
}

/* Состояние для UI настроек. Для владельца «скрытый» сервер выглядит выключенным
   (галочка снята), хотя туннель на деле жив и админ имеет доступ. */
function info(serverId) {
  const remote = remoteOf(serverId) || {};
  const ownerOn = !!remote.enabled && !remote.ownerHidden;
  return {
    enabled: ownerOn,
    globalId: remote.globalId || null,
    linkCode: ownerOn && !remote.claimed ? (remote.linkCode || null) : null,
    claimed: !!remote.claimed,
    central: CENTRAL,
    online: ownerOn && isTunnelLive(serverId),
  };
}

/* «Мягкое» выключение владельцем: туннель остаётся (админ всегда имеет доступ),
   но для владельца/назначенных сервер становится офлайн. hidden=false — снова показать. */
function ownerHide(serverId, hidden) {
  const s = store.get(serverId);
  if (!s) return;
  const remote = Object.assign({}, s.remote, { ownerHidden: !!hidden });
  store.update(serverId, { remote });
  // сразу пушим статус на центр, чтобы видимость сменилась без ожидания таймера
  if (remote.enabled) pushStatus(serverId);
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

module.exports = { enable, disable, ownerHide, regenerate, deregister, info, initAll, connect, statusOf, CENTRAL, internalUserFor };
