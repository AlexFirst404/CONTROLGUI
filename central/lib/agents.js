'use strict';
/* Туннель «центр -> агент»: панель держит SSE-поток, центр шлёт команды событиями,
   панель выполняет и постит результат с reqId. Без WebSocket. */
const crypto = require('crypto');
const servers = require('./servers');

const streams = new Map();  // panelToken -> res (SSE)
const pending = new Map();  // reqId -> { resolve, timer, panelToken }
const CMD_TIMEOUT_MS = 15000;

function attach(panelToken, res) {
  // если уже был поток с этим токеном — закрываем старый
  const old = streams.get(panelToken);
  if (old && old !== res) { try { old.end(); } catch (e) { /* */ } }
  streams.set(panelToken, res);
  servers.setOnline(panelToken, true);
  // heartbeat, чтобы прокси/таймауты не рвали соединение
  const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch (e) { /* */ } }, 25000);
  res.on('close', () => {
    clearInterval(hb);
    if (streams.get(panelToken) === res) {
      streams.delete(panelToken);
      servers.setOnline(panelToken, false);
    }
    // отклоняем висящие команды этого агента
    for (const [reqId, p] of pending) {
      if (p.panelToken === panelToken) { clearTimeout(p.timer); pending.delete(reqId); p.resolve({ error: 'Сервер недоступен' }); }
    }
  });
}

function isOnline(panelToken) { return streams.has(panelToken); }

/* Послать команду агенту и дождаться результата. action — из белого списка. */
function dispatch(panelToken, action, params) {
  return new Promise((resolve) => {
    const res = streams.get(panelToken);
    if (!res) return resolve({ error: 'Сервер сейчас офлайн (панель не на связи)' });
    const reqId = crypto.randomBytes(8).toString('hex');
    const timer = setTimeout(() => {
      if (pending.has(reqId)) { pending.delete(reqId); resolve({ error: 'Таймаут — нет ответа от панели' }); }
    }, CMD_TIMEOUT_MS);
    pending.set(reqId, { resolve, timer, panelToken });
    try {
      res.write('data: ' + JSON.stringify({ reqId, action, params: params || {} }) + '\n\n');
    } catch (e) {
      clearTimeout(timer); pending.delete(reqId); resolve({ error: 'Не удалось отправить команду' });
    }
  });
}

/* Агент прислал результат. */
function result(reqId, payload) {
  const p = pending.get(reqId);
  if (!p) return false;
  clearTimeout(p.timer);
  pending.delete(reqId);
  p.resolve(payload || { ok: true });
  return true;
}

module.exports = { attach, isOnline, dispatch, result };
