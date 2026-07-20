'use strict';
/* «Удалённые панели»: подключения к CONTROLGUI на других машинах прямо из приложения.
   Для каждого подключения (адрес + порт + логин + пароль + запиненный серт) панель
   поднимает локальный прокси на 127.0.0.1:<эфемерный порт> и прозрачно пересылает
   запросы на https://host:port удалённой панели. Пиннинг как в TUI/CLI: запиненный
   PEM выступает доверенным CA (self-signed сходится сам с собой) + сверка SHA-256
   отпечатка в checkServerIdentity. Автовход: прокси сам логинится (cg_remote держит
   в памяти и подставляет в каждый запрос) — браузеру кука не выдаётся вовсе.
   Управление подключениями — только с локальной машины (гейт в api.js) и сам прокси
   слушает строго 127.0.0.1.

   Конфиг data/remote-connections.json:
     { connections: [ { id, name, host, port, username, password, fingerprint, pem, addedAt } ] } */
const http = require('http');
const https = require('https');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./paths');

const FILE = path.join(DATA_DIR, 'remote-connections.json');
const MAX_CONN = 20;
const PROBE_TIMEOUT = 8000;
// адрес локальной панели — для кнопки «← Мои серверы» на проксируемых страницах
const LOCAL_PORT = parseInt(process.env.PORT, 10) || 8400;
const LOCAL_URL = 'http://127.0.0.1:' + LOCAL_PORT + '/';

// ---------- конфиг ----------
function loadCfg() {
  let c;
  try { c = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { c = {}; }
  if (!c || typeof c !== 'object') c = {};
  if (!Array.isArray(c.connections)) c.connections = [];
  return c;
}
function saveCfg(cfg) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // уникальный tmp на процесс — одновременная запись из CLI и панели не затирает друг друга
  const tmp = FILE + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 }); // хранит пароли — только владелец
  fs.renameSync(tmp, FILE);
}
function getConn(id) { return loadCfg().connections.find((c) => c.id === String(id)) || null; }

// ---------- валидация ----------
function validHost(h) {
  if (typeof h !== 'string') return false;
  // DNS-имя/IPv4 или голый IPv6 (двоеточия); без пробелов, слэшей и прочего
  return /^[A-Za-z0-9.\-]{1,253}$/.test(h) || /^[0-9a-fA-F:]{2,45}$/.test(h);
}
function validPort(p) {
  const n = parseInt(p, 10);
  return (n >= 1 && n <= 65535) ? n : 0;
}

// ---------- сертификаты ----------
function fpOfRaw(raw) { return crypto.createHash('sha256').update(raw).digest('hex'); }
function derToPem(raw) {
  return '-----BEGIN CERTIFICATE-----\n' + raw.toString('base64').replace(/(.{64})/g, '$1\n').trim() + '\n-----END CERTIFICATE-----\n';
}
/* Одноразовое соединение: снять отпечаток и PEM серта удалённой панели.
   ВНИМАНИЕ: pem из результата наружу (в браузер) не отдаём — только fingerprint. */
function probe(host, port) {
  return new Promise((resolve) => {
    if (!validHost(host)) return resolve({ error: 'Некорректный адрес' });
    const p = validPort(port);
    if (!p) return resolve({ error: 'Порт: число 1–65535' });
    let done = false;
    const fin = (r) => { if (!done) { done = true; resolve(r); } };
    let sock;
    try {
      sock = tls.connect({ host, port: p, rejectUnauthorized: false }, () => {
        const cert = sock.getPeerCertificate();
        sock.destroy();
        if (!cert || !cert.raw) return fin({ error: 'Сервер не отдал сертификат' });
        fin({ ok: true, fingerprint: fpOfRaw(cert.raw), pem: derToPem(cert.raw) });
      });
    } catch (e) { return fin({ error: 'Не удалось подключиться: ' + e.message }); }
    sock.setTimeout(PROBE_TIMEOUT, () => { sock.destroy(); fin({ error: 'Не отвечает (таймаут). Проверьте адрес и порт.' }); });
    sock.on('error', (e) => fin({ error: 'Не удалось подключиться: ' + (e.code || e.message) }));
  });
}

// ---------- CRUD подключений ----------
function newId() { return 'rc_' + crypto.randomBytes(5).toString('hex'); }
/* Публичный список — без паролей и PEM. */
function list() {
  return loadCfg().connections.map((c) => ({
    id: c.id, name: c.name, host: c.host, port: c.port, username: c.username, fingerprint: c.fingerprint,
  }));
}
/* Добавить/обновить. fingerprint — тот, что пользователь сверил глазами по «Проверить»:
   при сохранении пробим ещё раз и пиним только если серт ВСЁ ЕЩЁ тот же (TOCTOU). */
async function save(input) {
  const cfg = loadCfg();
  const editing = input.id ? cfg.connections.find((c) => c.id === String(input.id)) : null;
  if (input.id && !editing) return { error: 'Подключение не найдено' };
  const host = String(input.host || '').trim();
  const port = validPort(input.port);
  const username = String(input.username || '').trim();
  const name = String(input.name || '').trim().slice(0, 40) || (host + ':' + port);
  if (!validHost(host)) return { error: 'Некорректный адрес' };
  if (!port) return { error: 'Порт: число 1–65535' };
  if (!/^[A-Za-z0-9_.\-]{1,32}$/.test(username)) return { error: 'Логин: 1–32 символа (буквы, цифры, _ . -)' };
  if (!editing && !String(input.password || '')) return { error: 'Введите пароль' };
  if (!editing && cfg.connections.length >= MAX_CONN) return { error: 'Достигнут лимит подключений (' + MAX_CONN + ')' };
  const wantFp = String(input.fingerprint || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(wantFp)) return { error: 'Сначала нажмите «Проверить» и сверьте отпечаток сертификата' };
  const pr = await probe(host, port);
  if (pr.error) return pr;
  if (pr.fingerprint !== wantFp) return { error: 'Сертификат удалённой панели изменился — нажмите «Проверить» заново и сверьте новый отпечаток' };
  const conn = editing || { id: newId(), addedAt: Date.now() };
  conn.name = name;
  conn.host = host;
  conn.port = port;
  conn.username = username;
  if (input.password) conn.password = String(input.password);
  conn.fingerprint = pr.fingerprint;
  conn.pem = pr.pem;
  if (!editing) cfg.connections.push(conn);
  saveCfg(cfg);
  stopProxy(conn.id); // новые креды/пин применятся при следующем открытии
  return { ok: true, id: conn.id };
}
function remove(id) {
  const cfg = loadCfg();
  const before = cfg.connections.length;
  cfg.connections = cfg.connections.filter((c) => c.id !== String(id));
  if (cfg.connections.length === before) return { error: 'Подключение не найдено' };
  saveCfg(cfg);
  stopProxy(String(id));
  return { ok: true };
}
/* Лёгкая проверка статуса для карточки: TLS-доступность + совпадение пина.
   БЕЗ попытки входа — авточек с неверным паролем иначе заблокировал бы учётку (анти-брутфорс). */
async function check(id) {
  const conn = getConn(id);
  if (!conn) return { error: 'Подключение не найдено' };
  const pr = await probe(conn.host, conn.port);
  if (pr.error) return { ok: true, id: conn.id, online: false, reason: pr.error };
  if (pr.fingerprint !== conn.fingerprint) return { ok: true, id: conn.id, online: true, certChanged: true };
  return { ok: true, id: conn.id, online: true };
}

// ---------- клиент удалённой панели (пиннинг + автовход) ----------
function agentFor(conn) {
  return new https.Agent({
    keepAlive: true,
    maxSockets: 16,
    // Пиннинг: запиненный серт — доверенный CA, rejectUnauthorized рвёт соединение при
    // ЛЮБОМ другом серте ДО отправки заголовков (иначе MITM получил бы пароль/куку).
    ca: [conn.pem],
    rejectUnauthorized: true,
    // SNI с IP запрещён Node — servername не ставим; хост сверяем сами по отпечатку, не по SAN
    checkServerIdentity: (h, cert) => (cert && cert.raw && fpOfRaw(cert.raw) === conn.fingerprint)
      ? undefined
      : new Error('Отпечаток сертификата не совпал с запиненным'),
  });
}
/* Небольшой запрос к удалённой панели с полным чтением ответа (для логина). */
function upstreamJson(conn, agent, method, upath, headers, body) {
  return new Promise((resolve, reject) => {
    // единая точка сеттла: res.destroy() БЕЗ ошибки не эмитит ни 'end', ни 'error'
    // (только 'aborted'/'close') — без этого промис завис бы навсегда и заклинил релогин
    let settled = false;
    const ok = (v) => { if (!settled) { settled = true; resolve(v); } };
    const bad = (e) => { if (!settled) { settled = true; reject(e); } };
    const r = https.request({ host: conn.host, port: conn.port, method, path: upath, headers, agent }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > 256 * 1024) { res.destroy(); bad(new Error('Ответ удалённой панели слишком большой')); return; }
        chunks.push(c);
      });
      res.on('end', () => ok({ code: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', bad);
      res.on('close', () => bad(new Error('Соединение закрыто раньше времени'))); // страховка, если не было end/error
    });
    r.setTimeout(15000, () => r.destroy(new Error('таймаут')));
    r.on('error', bad);
    if (body) r.write(body);
    r.end();
  });
}
/* Вход на удалённой панели: возвращает строку куки 'cg_remote=...'. */
async function login(conn, agent) {
  const body = Buffer.from(JSON.stringify({ username: conn.username, password: conn.password }));
  let r;
  try {
    r = await upstreamJson(conn, agent, 'POST', '/api/auth/login',
      { 'Content-Type': 'application/json', 'Content-Length': body.length }, body);
  } catch (e) {
    const why = (e.code || '') + ' ' + (e.message || '');
    if (/CERT|ALTNAME|SELF_SIGNED|VERIF|отпечаток/i.test(why)) {
      throw new Error('Сертификат удалённой панели не совпадает с запиненным — откройте «Изменить», нажмите «Проверить» и сверьте новый отпечаток');
    }
    throw new Error('Нет связи с удалённой панелью: ' + (e.code || e.message));
  }
  if (r.code === 200) {
    for (const c of [].concat(r.headers['set-cookie'] || [])) {
      const m = /^cg_remote=([^;]+)/.exec(c);
      if (m) return 'cg_remote=' + m[1];
    }
    throw new Error('Удалённая панель не выдала сессию');
  }
  let msg = 'Вход не удался (HTTP ' + r.code + ')';
  try { const d = JSON.parse(r.body.toString('utf8')); if (d && d.error) msg = d.error; } catch (e) { /* не JSON */ }
  if (r.code === 404) msg = 'Это не удалённый доступ CONTROLGUI (или панель очень старой версии)';
  throw new Error(msg);
}

// ---------- локальный прокси ----------
const proxies = new Map(); // id -> { conn, agent, cookie, srv, port, relogin }
const opening = new Map(); // id -> Promise — дедуп параллельных open (двойной клик и т.п.)

function sameConnParams(a, b) {
  return a.host === b.host && a.port === b.port && a.fingerprint === b.fingerprint &&
    a.username === b.username && a.password === b.password;
}

/* Открыть подключение: логин + подъём прокси (или переиспользование живого).
   Возвращает { url } для перехода окна. */
function open(id) {
  const conn = getConn(id);
  if (!conn) return Promise.resolve({ error: 'Подключение не найдено' });
  const existing = proxies.get(conn.id);
  if (existing && existing.srv && existing.srv.listening && sameConnParams(existing.conn, conn)) {
    existing.conn = conn; // подхватываем правку имени без пересоздания
    return Promise.resolve({ ok: true, url: 'http://127.0.0.1:' + existing.port + '/' });
  }
  // дедуп: пока идут логин+listen, второй open того же id ждёт тот же промис —
  // иначе гонка плодила бы осиротевшие авторизованные прокси, недостижимые для stopProxy
  if (opening.has(conn.id)) return opening.get(conn.id);
  const p = doOpen(conn).finally(() => { opening.delete(conn.id); });
  opening.set(conn.id, p);
  return p;
}
async function doOpen(conn) {
  if (proxies.has(conn.id)) stopProxy(conn.id); // параметры сменились — старый прокси долой
  const agent = agentFor(conn);
  let cookie;
  try { cookie = await login(conn, agent); } // ошибки входа показываем ДО перехода в окно
  catch (e) { agent.destroy(); return { error: e.message }; }
  const st = { conn, agent, cookie, srv: null, port: 0, relogin: null };
  const srv = http.createServer((req, res) => {
    proxyRequest(st, req, res).catch((e) => {
      try {
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Ошибка прокси: ' + e.message }));
      } catch (e2) { /* сокет уже закрыт */ }
    });
  });
  srv.requestTimeout = 0;        // SSE-консоль и большие загрузки живут долго
  srv.headersTimeout = 30 * 1000;
  st.srv = srv;
  try {
    await new Promise((resolve, reject) => {
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', resolve); // строго loopback
    });
  } catch (e) { agent.destroy(); return { error: 'Не удалось поднять локальный прокси: ' + e.message }; }
  srv.on('error', (e) => { console.error('[удалённые панели] прокси:', e.message); stopProxy(conn.id); });
  st.port = srv.address().port;
  proxies.set(conn.id, st);
  return { ok: true, url: 'http://127.0.0.1:' + st.port + '/' };
}
function stopProxy(id) {
  const st = proxies.get(id);
  if (!st) return;
  proxies.delete(id);
  try { if (st.srv && typeof st.srv.closeAllConnections === 'function') st.srv.closeAllConnections(); } catch (e) { /* */ }
  try { if (st.srv) st.srv.close(); } catch (e) { /* */ }
  try { st.agent.destroy(); } catch (e) { /* */ }
}
function stopAll() { for (const id of Array.from(proxies.keys())) stopProxy(id); }

/* Один релогин на все одновременные 401 (иначе N параллельных запросов = N входов). */
function ensureLogin(st) {
  if (!st.relogin) {
    st.relogin = login(st.conn, st.agent).then(
      (c) => { st.cookie = c; st.relogin = null; return c; },
      (e) => { st.relogin = null; throw e; }
    );
  }
  return st.relogin;
}

const HOP_HEADERS = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'cookie',
  // origin/referer браузера указывают на origin прокси (127.0.0.1:<эфемерный>) —
  // не пробрасываем, иначе Origin-гард удалённой панели отвергнет проксируемый запрос
  // как кросс-оригинный (а заодно не светим порт прокси удалённой стороне)
  'origin', 'referer'];
function isLoopbackAddr(a) { return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'; }

function readRawBody(req, maxLen) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxLen + 1024) { req.destroy(); reject(new Error('Тело больше заявленного')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function proxyRequest(st, req, res) {
  // защита от DNS-rebinding: чужой Host (сайт злоумышленника, зарезолвленный в 127.0.0.1)
  // получил бы наши ответы в СВОЁМ origin — пускаем только явные локальные хосты
  const hostHdr = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  const ra = (req.socket && req.socket.remoteAddress) || '';
  if (!isLoopbackAddr(ra) || (hostHdr !== '127.0.0.1' && hostHdr !== 'localhost' && hostHdr !== '[::1]')) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('403: прокси удалённой панели доступен только локально');
  }
  const urlPath = (req.url || '/').split('?')[0];
  // «Выйти» на удалённой панели: не форвардим (автовход тут же вернул бы сессию),
  // а страницу /login подменяем возвратом в локальную панель — это и есть «выход»
  if (urlPath === '/api/auth/logout' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: true }));
  }
  if (urlPath === '/login' || urlPath === '/login.html') {
    res.writeHead(302, { Location: LOCAL_URL });
    return res.end();
  }
  const inject = req.method === 'GET' && (urlPath === '/' || urlPath === '/index.html');
  // мелкое тело (включая пустое) буферизуем — такой запрос можно повторить после релогина.
  // Большое (загрузка мира/ядра) и chunked — потоком, повтор невозможен: поток одноразовый,
  // а retryable для chunked дал бы повтор с ПУСТЫМ телом (источник уже прочитан).
  const len = parseInt(req.headers['content-length'] || '0', 10) || 0;
  const hasBody = !(req.method === 'GET' || req.method === 'HEAD');
  let bodyBuf = null;
  if (hasBody && !req.headers['transfer-encoding'] && len <= 1024 * 1024) {
    bodyBuf = len > 0 ? await readRawBody(req, len) : Buffer.alloc(0);
  }
  const retryable = !hasBody || bodyBuf !== null; // chunked/большое → bodyBuf===null → без повтора
  await forward(st, req, res, bodyBuf, inject, retryable);
}

function upstreamHeaders(st, req, inject) {
  const h = {};
  for (const k of Object.keys(req.headers)) {
    if (!HOP_HEADERS.includes(k)) h[k] = req.headers[k];
  }
  h.host = st.conn.host + ':' + st.conn.port;
  h.cookie = st.cookie; // сессия живёт только в памяти прокси — браузеру не выдаётся
  if (inject) h['accept-encoding'] = 'identity'; // будем дописывать кнопку «назад» — нужен несжатый HTML
  return h;
}

function forward(st, req, res, bodyBuf, inject, mayRetry) {
  return new Promise((resolve) => {
    const preq = https.request({
      host: st.conn.host, port: st.conn.port,
      method: req.method, path: req.url,
      headers: upstreamHeaders(st, req, inject),
      agent: st.agent,
    }, async (pres) => {
      // сессия на той стороне умерла (рестарт/чистка) → релогин и один повтор
      const needLogin = pres.statusCode === 401 ||
        (pres.statusCode === 302 && String(pres.headers.location || '') === '/login');
      if (needLogin && mayRetry) {
        pres.resume(); // дочитать, вернуть сокет агенту
        try { await ensureLogin(st); } catch (e) { sendLoginError(req, res, e); return resolve(); }
        return resolve(await forward(st, req, res, bodyBuf, inject, false));
      }
      const headers = {};
      for (const k of Object.keys(pres.headers)) {
        // set-cookie не пропускаем: сессию удалённой панели держит прокси, не браузер
        if (!HOP_HEADERS.includes(k) && k !== 'set-cookie') headers[k] = pres.headers[k];
      }
      const isHtml = /text\/html/.test(String(pres.headers['content-type'] || ''));
      if (inject && pres.statusCode === 200 && isHtml) {
        // буферизуем HTML главной, чтобы дописать кнопку. Лимит — защита от враждебной
        // панели, которая иначе бесконечным потоком выест память и уронит процесс (с ним
        // и управление Minecraft-серверами). Наша страница — сотни КБ; кап с запасом.
        const MAX_HTML = 8 * 1024 * 1024;
        const chunks = [];
        let size = 0;
        let streaming = false; // превышен лимит → отдаём как есть, без инъекции
        pres.on('data', (c) => {
          if (streaming) return;
          size += c.length;
          if (size > MAX_HTML) {
            streaming = true;
            const h2 = Object.assign({}, headers);
            delete h2['content-length']; // длину не знаем — chunked
            delete h2['content-encoding'];
            res.writeHead(pres.statusCode, h2);
            for (const ch of chunks) res.write(ch);
            res.write(c);
            pres.pipe(res); // остаток потоком; res.end сделает pipe
            return;
          }
          chunks.push(c);
        });
        pres.on('end', () => {
          if (streaming) { resolve(); return; } // res завершит pipe
          const buf = Buffer.from(injectBackButton(Buffer.concat(chunks).toString('utf8')), 'utf8');
          delete headers['content-encoding'];
          headers['content-length'] = buf.length;
          res.writeHead(pres.statusCode, headers);
          res.end(req.method === 'HEAD' ? undefined : buf);
          resolve();
        });
        pres.on('error', () => { try { res.destroy(); } catch (e) { /* */ } resolve(); });
        return;
      }
      res.writeHead(pres.statusCode, headers);
      pres.pipe(res); // потоково: SSE-консоль, скачивание бэкапов — без буферизации
      pres.on('end', resolve);
      pres.on('error', () => { try { res.destroy(); } catch (e) { /* */ } resolve(); });
    });
    preq.on('error', (e) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Удалённая панель недоступна: ' + (e.code || e.message) }));
      } else { try { res.destroy(); } catch (e2) { /* */ } }
      resolve();
    });
    // браузер оборвал соединение (закрыли SSE-консоль) — рвём и восходящее
    res.on('close', () => { if (!res.writableEnded) preq.destroy(); });
    if (bodyBuf) preq.end(bodyBuf);
    else if (req.method === 'GET' || req.method === 'HEAD') preq.end();
    else req.pipe(preq); // большое тело — потоком
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
/* Плавающая кнопка возврата в локальную панель — дописывается в HTML удалённой
   панели на лету, поэтому работает с любой её версией. Стили только инлайн. */
function injectBackButton(html) {
  const btn = '<a href="' + LOCAL_URL + '" id="cg-remote-back" title="Вернуться к моим серверам"' +
    ' style="position:fixed;left:16px;bottom:16px;z-index:2147483000;display:inline-flex;align-items:center;gap:7px;' +
    'padding:9px 14px;background:#151b10;color:#d7e4c8;border:2px solid #4a5d38;box-shadow:0 3px 0 rgba(0,0,0,.5);' +
    'font:600 13px \'Pixelify Sans\',system-ui,sans-serif;text-decoration:none;opacity:.92">&#8592; Мои серверы</a>';
  return html.includes('</body>') ? html.replace('</body>', btn + '\n</body>') : html + btn;
}
function sendLoginError(req, res, e) {
  const msg = 'Вход на удалённую панель не удался: ' + e.message;
  if (String(req.url || '').startsWith('/api/')) {
    res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: msg }));
  }
  res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><html lang="ru"><meta charset="utf-8"><title>CONTROLGUI</title>' +
    '<body style="margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#10150c;color:#d7e4c8;font:15px \'Pixelify Sans\',system-ui,sans-serif">' +
    '<div style="max-width:520px;padding:28px;border:2px solid #4a5d38;background:#151b10;text-align:center">' +
    '<div style="font-size:19px;margin-bottom:10px">Не удалось подключиться</div>' +
    '<div style="opacity:.85;margin-bottom:18px">' + escapeHtml(msg) + '<br>Проверьте логин и пароль в настройках подключения.</div>' +
    '<a href="' + LOCAL_URL + '" style="color:#9edb70">&#8592; Мои серверы</a></div></body></html>');
}

module.exports = { FILE, list, probe, save, remove, check, open, stopProxy, stopAll };
