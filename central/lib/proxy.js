'use strict';
/* Реверс-прокси полного удалённого управления: /r/<globalId>/<путь панели> -> туннель -> панель.
   Авторизация на центре (роль на сервер), денилист «тяжёлого/опасного», стриминг консоли. */
const servers = require('./servers');
const agents = require('./agents');

const RAW_LIMIT = 50 * 1024 * 1024; // тело проксируемого запроса (правка файлов + загрузка до 50МБ)

function readRaw(req) {
  return new Promise((resolve) => {
    const chunks = []; let size = 0; let over = false; let done = false;
    const fin = () => { if (!done) { done = true; resolve({ buf: Buffer.concat(chunks), over }); } };
    req.on('data', (c) => { size += c.length; if (size <= RAW_LIMIT) chunks.push(c); else { over = true; req.destroy(); } });
    req.on('end', fin); req.on('close', fin); req.on('error', fin);
  });
}

// сегменты пути как в роутере панели (api.js: split('/').filter(Boolean)) — устойчиво к слешам/кодированию
function segsOf(base) {
  let p = base; try { p = decodeURIComponent(base); } catch (e) { /* */ }
  return p.split('/').filter(Boolean);
}

/* Что НЕ проксируем удалённо. Матчим по СЕГМЕНТАМ (не подстрокой с `$`) — нет обхода завершающим
   слешом/лишним сегментом. Глобальные не-серверные эндпоинты тоже режем (утечка путей/IP, java). */
function denied(method, base) {
  const s = segsOf(base);
  if (s[0] !== 'api') return 'недоступно удалённо';
  if (s[1] !== 'servers') {
    // нужны UI и безопасны (status — редактируется на панели: без root/lanIps)
    if (s[1] === 'auth' || s[1] === 'versions' || s[1] === 'launch-mode' || s[1] === 'status') return null;
    if (s[1] === 'java' && method === 'GET') return null; // опрос состояния установки Java
    return 'этот эндпоинт недоступен удалённо'; // users/browse/java-install(POST)/...
  }
  if (s.length === 2) return method === 'POST' ? 'создание сервера' : null;       // /api/servers
  if (s.length === 3) return method === 'DELETE' ? 'удаление сервера' : null;      // /api/servers/<id>
  const action = s[3];                                                            // /api/servers/<id>/<action>
  if (method === 'PUT' && (action === 'core' || action === 'resourcepack')) return 'загрузка ядра/текстурпака'; // file-upload (до 50МБ) разрешён
  if (method === 'GET' && action === 'backup') return 'скачивание бэкапа';
  return null;
}
// потоковые GET (text/event-stream): консоль
function isStream(method, base) {
  const s = segsOf(base);
  return method === 'GET' && s[0] === 'api' && s[1] === 'servers' && s[3] === 'console';
}

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
  // владелец «выключил» удалёнку — для всех, кроме админа, сервер недоступен (выглядит офлайн)
  if (s.ownerHidden && servers.roleFor(user, s) !== 'admin') { json(res, 502, { error: 'Панель сейчас офлайн' }); return true; }
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

  const { buf, over } = await readRaw(req);
  if (over) { json(res, 413, { error: 'Тело запроса слишком большое для удалённого доступа' }); return true; }
  const out = await agents.dispatchHttp(s.panelToken, {
    method: req.method, path: localPath, headers, perms, actor: user.username,
    bodyB64: buf && buf.length ? buf.toString('base64') : '',
  });
  const rh = pickRespHeaders(out.headers);
  if (!rh['content-type']) rh['content-type'] = 'application/json; charset=utf-8';
  res.writeHead(out.status || 502, rh);
  res.end(out.bodyB64 ? Buffer.from(out.bodyB64, 'base64') : '');
  return true;
}

module.exports = { handle };
