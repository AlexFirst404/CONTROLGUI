'use strict';
/* Туннель «центр -> агент»: панель держит SSE-поток, центр шлёт команды/проксируемые
   HTTP-запросы событиями, панель выполняет и постит результат (или чанки) с reqId. Без WebSocket. */
const crypto = require('crypto');
const servers = require('./servers');

const streams = new Map();      // panelToken -> res (SSE к панели)
const pending = new Map();      // reqId -> { resolve, timer, panelToken, res } (команда/не-потоковый http)
const httpStreams = new Map();  // reqId -> { browserRes, panelToken, headSent } (потоковый ответ браузеру)
const CMD_TIMEOUT_MS = 15000;

function send(panelToken, obj) {
  const res = streams.get(panelToken);
  if (!res) return false;
  try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); return true; } catch (e) { return false; }
}

function attach(panelToken, res) {
  const old = streams.get(panelToken);
  if (old && old !== res) { try { old.end(); } catch (e) { /* */ } }
  streams.set(panelToken, res);
  servers.setOnline(panelToken, true);
  const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch (e) { /* */ } }, 25000);
  res.on('close', () => {
    clearInterval(hb);
    if (streams.get(panelToken) === res) {
      streams.delete(panelToken);
      servers.setOnline(panelToken, false);
    }
    // реджектим висящие команды ИМЕННО этого стрима
    for (const [reqId, p] of pending) {
      if (p.res === res) { clearTimeout(p.timer); pending.delete(reqId); p.resolve({ error: 'Сервер недоступен' }); }
    }
    // и закрываем потоковые ответы этого агента (браузер получит обрыв)
    for (const [reqId, s] of httpStreams) {
      if (s.panelToken === panelToken) { try { s.browserRes.end(); } catch (e) { /* */ } httpStreams.delete(reqId); }
    }
  });
}

function isOnline(panelToken) { return streams.has(panelToken); }

/* Послать команду агенту (белый список start/stop/restart) и дождаться результата. */
function dispatch(panelToken, action, params) {
  return new Promise((resolve) => {
    const res = streams.get(panelToken);
    if (!res) return resolve({ error: 'Сервер сейчас офлайн (панель не на связи)' });
    const reqId = crypto.randomBytes(8).toString('hex');
    const timer = setTimeout(() => { if (pending.has(reqId)) { pending.delete(reqId); resolve({ error: 'Таймаут — нет ответа от панели' }); } }, CMD_TIMEOUT_MS);
    pending.set(reqId, { resolve, timer, panelToken, res });
    if (!send(panelToken, { reqId, action, params: params || {} })) { clearTimeout(timer); pending.delete(reqId); resolve({ error: 'Не удалось отправить команду' }); }
  });
}

/* Проксировать НЕ-потоковый HTTP-запрос -> Promise<{status, headers, bodyB64}>. */
function dispatchHttp(panelToken, reqObj) {
  return new Promise((resolve) => {
    const res = streams.get(panelToken);
    if (!res) return resolve({ status: 502, headers: {}, bodyB64: '', offline: true });
    const reqId = crypto.randomBytes(8).toString('hex');
    const timer = setTimeout(() => { if (pending.has(reqId)) { pending.delete(reqId); resolve({ status: 504, headers: {}, bodyB64: '' }); } }, CMD_TIMEOUT_MS);
    pending.set(reqId, { resolve, timer, panelToken, res });
    if (!send(panelToken, Object.assign({ reqId, kind: 'http' }, reqObj))) { clearTimeout(timer); pending.delete(reqId); resolve({ status: 502, headers: {}, bodyB64: '' }); }
  });
}

/* Проксировать ПОТОКОВЫЙ запрос (консоль SSE, лог): чанки ретранслируются в browserRes. Возвращает reqId. */
function openHttpStream(panelToken, reqObj, browserRes) {
  if (!streams.has(panelToken)) return null;
  const reqId = crypto.randomBytes(8).toString('hex');
  httpStreams.set(reqId, { browserRes, panelToken, headSent: false });
  if (!send(panelToken, Object.assign({ reqId, kind: 'http', stream: true }, reqObj))) { httpStreams.delete(reqId); return null; }
  return reqId;
}

/* Агент прислал результат не-потокового запроса (или команды). token обязан совпасть. */
function result(token, reqId, payload) {
  const p = pending.get(reqId);
  if (!p || p.panelToken !== token) return false;
  clearTimeout(p.timer);
  pending.delete(reqId);
  p.resolve(payload || { ok: true });
  return true;
}

function safeHeaders(h) {
  const out = {};
  for (const k of ['content-type', 'cache-control', 'content-disposition', 'last-modified', 'etag']) if (h && h[k]) out[k] = h[k];
  return out;
}

/* Агент прислал чанк потокового ответа. */
function chunk(token, reqId, msg) {
  const s = httpStreams.get(reqId);
  if (!s || s.panelToken !== token) return false;
  const res = s.browserRes;
  try {
    if (msg.head && !s.headSent) { s.headSent = true; res.writeHead(msg.head.status || 200, safeHeaders(msg.head.headers)); }
    if (msg.dataB64) res.write(Buffer.from(msg.dataB64, 'base64'));
    if (msg.done) { try { res.end(); } catch (e) { /* */ } httpStreams.delete(reqId); }
  } catch (e) { httpStreams.delete(reqId); }
  return true;
}

/* Браузер закрыл потоковый ответ -> сказать панели закрыть loopback, убрать запись. */
function closeStream(reqId) {
  const s = httpStreams.get(reqId);
  if (!s) return;
  httpStreams.delete(reqId);
  send(s.panelToken, { reqId, kind: 'stream-close' });
}

module.exports = { attach, isOnline, dispatch, dispatchHttp, openHttpStream, result, chunk, closeStream };
