'use strict';
/* Реверс-прокси полного удалённого управления: /r/<globalId>/<путь панели> -> туннель -> панель.
   Авторизация на центре (роль на сервер), денилист «тяжёлого/опасного», стриминг консоли. */
const servers = require('./servers');
const agents = require('./agents');

const RAW_LIMIT = 8 * 1024 * 1024; // тело проксируемого запроса (правка файлов и т.п.)

function readRaw(req) {
  return new Promise((resolve) => {
    const chunks = []; let size = 0; let done = false;
    const fin = () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } };
    req.on('data', (c) => { size += c.length; if (size <= RAW_LIMIT) chunks.push(c); else req.destroy(); });
    req.on('end', fin);
    req.on('close', fin);
    req.on('error', fin);
  });
}

// денилист «тяжёлого/опасного» — что НЕ проксируем удалённо (path без префикса /r/<gid>, без query)
function denied(method, base) {
  if (method === 'DELETE' && /^\/api\/servers\/[^/]+$/.test(base)) return 'удаление сервера';
  if (method === 'POST' && base === '/api/servers') return 'создание сервера';
  if (method === 'PUT' && /\/(file-upload|core)$/.test(base)) return 'загрузка больших файлов';
  if (method === 'GET' && /\/backup$/.test(base)) return 'скачивание бэкапа';
  return null;
}
// потоковые GET (text/event-stream): консоль
function isStream(method, base) { return method === 'GET' && /\/console$/.test(base); }

function pickReqHeaders(h) {
  const out = {};
  for (const k of ['content-type', 'accept']) if (h[k]) out[k] = h[k];
  return out;
}
function pickRespHeaders(h) {
  const out = {};
  for (const k of ['content-type', 'cache-control', 'content-disposition', 'last-modified', 'etag']) if (h && h[k]) out[k] = h[k];
  return out;
}

/* Возвращает true, если запрос обработан (это маршрут /r/...). json(res,code,obj) — из server.js. */
async function handle(req, res, urlPath, user, json) {
  const mm = urlPath.match(/^\/r\/([a-f0-9]+)(?:\/.*)?$/);
  if (!mm) return false;
  const gid = mm[1];
  const prefix = '/r/' + gid;
  const localPath = (req.url.slice(prefix.length) || '/') || '/'; // путь панели с query
  const base = localPath.split('?')[0];

  const s = servers.get(gid);
  if (!s || !servers.canView(user, s)) { json(res, 404, { error: 'Сервер не найден' }); return true; }
  if (!agents.isOnline(s.panelToken)) { json(res, 502, { error: 'Панель сейчас офлайн' }); return true; }
  const why = denied(req.method, base);
  if (why) { json(res, 403, { error: 'Недоступно удалённо: ' + why }); return true; }

  const perms = servers.permSet(user, s);
  const headers = pickReqHeaders(req.headers);

  if (isStream(req.method, base)) {
    const reqId = agents.openHttpStream(s.panelToken, { method: req.method, path: localPath, headers, perms, actor: user.username }, res);
    if (!reqId) { json(res, 502, { error: 'Не удалось открыть поток' }); return true; }
    req.on('close', () => agents.closeStream(reqId));
    return true;
  }

  const body = await readRaw(req);
  const out = await agents.dispatchHttp(s.panelToken, {
    method: req.method, path: localPath, headers, perms, actor: user.username,
    bodyB64: body && body.length ? body.toString('base64') : '',
  });
  const rh = pickRespHeaders(out.headers);
  if (!rh['content-type']) rh['content-type'] = 'application/json; charset=utf-8';
  res.writeHead(out.status || 502, rh);
  res.end(out.bodyB64 ? Buffer.from(out.bodyB64, 'base64') : '');
  return true;
}

module.exports = { handle };
