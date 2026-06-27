'use strict';
/* CONTROLGUI Remote — центральный сервер (control plane).
   HTTPS (самоподписанный серт), без npm-зависимостей. */
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const accounts = require('./lib/accounts');
const servers = require('./lib/servers');
const agents = require('./lib/agents');

const PORT = parseInt(process.env.PORT, 10) || 443;
const CERT = process.env.CGR_CERT || path.join(__dirname, 'cert', 'cert.pem');
const KEY = process.env.CGR_KEY || path.join(__dirname, 'cert', 'key.pem');
const PUB = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
};

function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || req.socket.remoteAddress || 'unknown';
}
function readBody(req, limit) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > (limit || 65536)) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch (e) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// ---------------- агенты (локальные панели) ----------------
async function handleAgent(req, res, urlPath, url) {
  if (urlPath === '/agent/register' && req.method === 'POST') {
    const b = await readBody(req);
    if (!/^[a-f0-9]{32,64}$/i.test(String(b.panelToken || ''))) return json(res, 400, { error: 'bad token' });
    const { server, isNew } = servers.onRegister(b.panelToken, { name: b.name, type: b.type, version: b.version });
    return json(res, 200, { globalId: server.globalId, linkCode: server.linkCode || null, claimed: !!server.ownerAccount, name: server.name });
  }
  if (urlPath === '/agent/stream' && req.method === 'GET') {
    const token = url.searchParams.get('token') || '';
    const s = servers.byToken(token);
    if (!s) { res.writeHead(401); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': ok\n\n');
    agents.attach(token, res);
    return;
  }
  if (urlPath === '/agent/result' && req.method === 'POST') {
    const b = await readBody(req, 256 * 1024);
    if (!servers.byToken(b.token)) return json(res, 401, { error: 'bad token' });
    agents.result(String(b.reqId || ''), b.result);
    return json(res, 200, { ok: true });
  }
  if (urlPath === '/agent/status' && req.method === 'POST') {
    const b = await readBody(req);
    const s = servers.byToken(b.token);
    if (!s) return json(res, 401, { error: 'bad token' });
    servers.updateStatus(b.token, { status: b.status, online: b.online, name: b.name, type: b.type, version: b.version });
    return json(res, 200, { ok: true });
  }
  return false;
}

// ---------------- аутентификация ----------------
async function handleAuth(req, res, urlPath) {
  if (urlPath === '/api/register' && req.method === 'POST') {
    const b = await readBody(req);
    const r = accounts.register(b.username, b.password);
    if (r.error) return json(res, 400, r);
    return json(res, 200, { ok: true, pending: true });
  }
  if (urlPath === '/api/login' && req.method === 'POST') {
    const ip = clientIp(req);
    const locked = accounts.lockMs(ip);
    if (locked > 0) return json(res, 429, { error: 'Слишком много попыток. Подождите ' + Math.ceil(locked / 60000) + ' мин.' });
    const b = await readBody(req);
    const u = accounts.verify(b.username, b.password);
    if (u && !u.pending) {
      accounts.clearFails(ip);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': accounts.cookieFor(accounts.createSession(u.username)) });
      return res.end(JSON.stringify({ ok: true, user: u }));
    }
    if (u && u.pending) return json(res, 403, { error: 'Аккаунт ждёт одобрения администратором' });
    const a = accounts.noteFail(ip);
    if (accounts.lockMs(ip) > 0) return json(res, 429, { error: 'Слишком много неверных попыток. Блок на 5 минут.' });
    return json(res, 401, { error: 'Неверный ник или пароль. Осталось попыток: ' + (accounts.MAX_FAILS - a.fails) });
  }
  if (urlPath === '/api/logout' && req.method === 'POST') {
    accounts.destroySession(accounts.parseCookies(req)[accounts.COOKIE]);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': accounts.clearCookie() });
    return res.end(JSON.stringify({ ok: true }));
  }
  return false;
}

// ---------------- API пользователя/админа (нужна сессия) ----------------
async function handleApi(req, res, urlPath, url, user) {
  if (urlPath === '/api/me') return json(res, 200, { user });
  if (urlPath === '/api/servers' && req.method === 'GET') return json(res, 200, { servers: servers.forUser(user) });

  if (urlPath === '/api/link' && req.method === 'POST') {
    const b = await readBody(req);
    const r = servers.claimByCode(b.code, user.username);
    if (r.error) return json(res, 400, r);
    return json(res, 200, { ok: true, server: servers.publicServer(r.server, user) });
  }

  // действие над сервером: /api/servers/<id>/action
  let m = urlPath.match(/^\/api\/servers\/([a-f0-9]+)\/action$/);
  if (m && req.method === 'POST') {
    const s = servers.get(m[1]);
    if (!s || !servers.canView(user, s)) return json(res, 404, { error: 'Сервер не найден' });
    const b = await readBody(req);
    const action = String(b.action || '');
    if (!servers.ACTIONS.includes(action)) return json(res, 400, { error: 'Недопустимое действие' });
    if (!servers.canDo(user, s, action)) return json(res, 403, { error: 'Нет прав на это действие' });
    const out = await agents.dispatch(s.panelToken, action, {});
    return json(res, out && out.error ? 409 : 200, out || { ok: true });
  }

  // владелец/админ: выдать доступ к серверу
  m = urlPath.match(/^\/api\/servers\/([a-f0-9]+)\/assign$/);
  if (m && req.method === 'POST') {
    const s = servers.get(m[1]);
    if (!s) return json(res, 404, { error: 'Сервер не найден' });
    const role = servers.roleFor(user, s);
    if (role !== 'admin' && role !== 'owner') return json(res, 403, { error: 'Только владелец или админ' });
    const b = await readBody(req);
    if (!accounts.validName(b.username)) return json(res, 400, { error: 'Некорректный ник' });
    if (b.remove) { servers.unassign(m[1], b.username); return json(res, 200, { ok: true }); }
    const r = servers.assign(m[1], b.username, b.perms);
    return json(res, r.error ? 400 : 200, r);
  }

  // --- админ ---
  if (urlPath.startsWith('/api/admin/')) {
    if (!accounts.isAdmin(user)) return json(res, 403, { error: 'Только админ' });
    if (urlPath === '/api/admin/users') return json(res, 200, { users: accounts.listUsers(), pending: accounts.pending() });
    if (urlPath === '/api/admin/servers') return json(res, 200, { servers: servers.all().map((s) => servers.publicServer(s, user)) });
    if (urlPath === '/api/admin/approve' && req.method === 'POST') { const b = await readBody(req); accounts.approve(b.username); return json(res, 200, { ok: true }); }
    if (urlPath === '/api/admin/reject' && req.method === 'POST') { const b = await readBody(req); accounts.remove(b.username); return json(res, 200, { ok: true }); }
    if (urlPath === '/api/admin/remove-server' && req.method === 'POST') { const b = await readBody(req); servers.remove(b.globalId); return json(res, 200, { ok: true }); }
  }
  return json(res, 404, { error: 'Не найдено' });
}

function serveStatic(req, res, urlPath) {
  let p = urlPath === '/' ? '/index.html' : urlPath;
  if (p === '/admin') p = '/admin.html';
  const file = path.normalize(path.join(PUB, p));
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

async function handle(req, res) {
  const url = new URL(req.url, 'https://localhost');
  const urlPath = url.pathname;
  try {
    if (urlPath.startsWith('/agent/')) { const r = await handleAgent(req, res, urlPath, url); if (r !== false) return; res.writeHead(404); return res.end(); }
    if (await handleAuth(req, res, urlPath) !== false) return;
    if (urlPath.startsWith('/api/')) {
      const user = accounts.userFromReq(req);
      if (!user) return json(res, 401, { error: 'Нужен вход', login: true });
      return handleApi(req, res, urlPath, url, user);
    }
    return serveStatic(req, res, urlPath);
  } catch (e) {
    json(res, 500, { error: 'Ошибка сервера' });
  }
}

// сид админа
const seed = accounts.ensureAdmin(process.env.CGR_ADMIN || 'admin');
if (seed.created) {
  console.log('  >>> Создан админ: логин=' + seed.username + '  пароль=' + seed.password);
  try { fs.writeFileSync(path.join(require('./lib/store').DATA, 'ADMIN-CREDENTIALS.txt'), 'login: ' + seed.username + '\npassword: ' + seed.password + '\n'); } catch (e) { /* */ }
}

const server = https.createServer({ cert: fs.readFileSync(CERT), key: fs.readFileSync(KEY) }, handle);
server.listen(PORT, () => console.log('CONTROLGUI Remote слушает https://0.0.0.0:' + PORT));

// 80 -> 443 редирект (необязательно)
if (PORT === 443) {
  http.createServer((req, res) => { res.writeHead(301, { Location: 'https://' + (req.headers.host || '').split(':')[0] + req.url }); res.end(); }).listen(80, () => {});
}
