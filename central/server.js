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
const proxy = require('./lib/proxy');
const settings = require('./lib/settings');
const discord = require('./lib/discord');

const PORT = parseInt(process.env.PORT, 10) || 443;
const CERT = process.env.CGR_CERT || path.join(__dirname, 'cert', 'cert.pem');
const KEY = process.env.CGR_KEY || path.join(__dirname, 'cert', 'key.pem');
const PUB = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2',
};

function clientIp(req) {
  // Node слушает :443 напрямую, без доверенного реверс-прокси -> X-Forwarded-For
  // полностью подделывается клиентом, поэтому НЕ доверяем ему (иначе обход анти-брутфорса
  // ротацией заголовка и таргетированный лок-DoS чужого IP). Ключуемся на реальном пире.
  // нормализуем IPv4-mapped IPv6 (::ffff:1.2.3.4 -> 1.2.3.4) — и для отображения, и для ключей лимитов
  return String(req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
}
function readBody(req, limit) {
  return new Promise((resolve) => {
    let d = ''; let done = false;
    const fin = (v) => { if (!done) { done = true; resolve(v); } };
    // при превышении лимита req.destroy() даёт 'close'/'aborted' (НЕ 'end'/'error') —
    // без обработчика close промис висел бы вечно (зависший запрос).
    req.on('data', (c) => { d += c; if (d.length > (limit || 65536)) req.destroy(); });
    req.on('end', () => { try { fin(JSON.parse(d || '{}')); } catch (e) { fin({}); } });
    req.on('close', () => fin({}));
    req.on('error', () => fin({}));
  });
}
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// универсальный лимитер «N обращений на ключ за окно» с самоочисткой (без роста памяти)
function makeLimiter(windowMs, max) {
  const hits = new Map();
  const t = setInterval(() => { const now = Date.now(); for (const [k, r] of hits) if (now > r.resetAt) hits.delete(k); }, windowMs * 2);
  if (t.unref) t.unref();
  return (key) => {
    const now = Date.now();
    const r = hits.get(key);
    if (!r || now > r.resetAt) { hits.set(key, { count: 1, resetAt: now + windowMs }); return true; }
    r.count += 1;
    return r.count <= max;
  };
}
const agentRegLimit = makeLimiter(60 * 1000, 30); // /agent/register по IP
const apiRegLimit = makeLimiter(60 * 1000, 10);   // /api/register по IP
const linkLimit = makeLimiter(60 * 1000, 10);     // /api/link по аккаунту
const linkIpLimit = makeLimiter(60 * 1000, 15);   // /api/link по IP (анти-брутфорс кода)
const linkGlobalLimit = makeLimiter(60 * 1000, 120); // глобальный потолок попыток привязки
const renameLimit = makeLimiter(60 * 1000, 5);    // /api/account/rename по аккаунту
const resetLimit = makeLimiter(60 * 1000, 10);    // сброс пароля через Discord по IP
const MAX_ACCOUNTS = 5000;                         // потолок всех аккаунтов (анти-флуд при авто-одобрении)

// анти-брутфорс кода привязки: после серии неверных кодов — блок IP на 10 минут
// (авто-одобрение позволяет плодить аккаунты, поэтому ключуемся ещё и на IP, не только на нике)
const linkFails = new Map(); // ip -> { fails, lockedUntil, lastSeen }
function linkLocked(ip) { const a = linkFails.get(ip); return a && a.lockedUntil > Date.now() ? a.lockedUntil - Date.now() : 0; }
function noteLinkFail(ip) {
  const a = linkFails.get(ip) || { fails: 0, lockedUntil: 0 };
  a.fails += 1; a.lastSeen = Date.now();
  if (a.fails >= 10) { a.lockedUntil = Date.now() + 10 * 60 * 1000; a.fails = 0; }
  linkFails.set(ip, a);
}
function clearLinkFails(ip) { linkFails.delete(ip); }
const _linkSweep = setInterval(() => {
  const now = Date.now();
  for (const [ip, a] of linkFails) { if (a.lockedUntil <= now && (now - (a.lastSeen || 0)) > 10 * 60 * 1000) linkFails.delete(ip); }
}, 10 * 60 * 1000);
if (_linkSweep.unref) _linkSweep.unref();

// ---------------- агенты (локальные панели) ----------------
async function handleAgent(req, res, urlPath, url) {
  if (urlPath === '/agent/register' && req.method === 'POST') {
    if (!agentRegLimit(clientIp(req))) return json(res, 429, { error: 'too many' });
    const b = await readBody(req);
    if (!/^[a-f0-9]{32,64}$/i.test(String(b.panelToken || ''))) return json(res, 400, { error: 'bad token' });
    const { server, isNew } = servers.onRegister(b.panelToken, { name: b.name, type: b.type, version: b.version });
    return json(res, 200, { globalId: server.globalId, linkCode: server.linkCode || null, claimed: !!server.ownerAccount, name: server.name });
  }
  if (urlPath === '/agent/regen-code' && req.method === 'POST') {
    const b = await readBody(req);
    if (!/^[a-f0-9]{32,64}$/i.test(String(b.panelToken || ''))) return json(res, 400, { error: 'bad token' });
    const r = servers.regenerateCode(b.panelToken);
    return json(res, r.error ? 400 : 200, r);
  }
  if (urlPath === '/agent/stream' && req.method === 'GET') {
    // секрет — в заголовке Authorization (не в query, чтобы не утекал в логи); query — fallback
    const auth = String(req.headers.authorization || '');
    const token = (auth.startsWith('Bearer ') ? auth.slice(7) : '') || url.searchParams.get('token') || '';
    const s = servers.byToken(token);
    if (!s) { res.writeHead(401); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': ok\n\n');
    agents.attach(token, res);
    return;
  }
  if (urlPath === '/agent/result' && req.method === 'POST') {
    const b = await readBody(req, 12 * 1024 * 1024); // ответ панели (base64 раздувает) — потолок выше тела 8МБ
    if (!servers.byToken(b.token)) return json(res, 401, { error: 'bad token' });
    agents.result(String(b.token), String(b.reqId || ''), b.result); // token-привязка результата
    return json(res, 200, { ok: true });
  }
  if (urlPath === '/agent/chunk' && req.method === 'POST') {
    const b = await readBody(req, 4 * 1024 * 1024);
    if (!servers.byToken(b.token)) return json(res, 401, { error: 'bad token' });
    agents.chunk(String(b.token), String(b.reqId || ''), b);
    return json(res, 200, { ok: true });
  }
  if (urlPath === '/agent/deregister' && req.method === 'POST') {
    const b = await readBody(req);
    if (!servers.byToken(b.token)) return json(res, 401, { error: 'bad token' });
    servers.removeByToken(b.token); // панель удалила сервер -> убираем запись (не «призрак»)
    return json(res, 200, { ok: true });
  }
  if (urlPath === '/agent/status' && req.method === 'POST') {
    const b = await readBody(req);
    const s = servers.byToken(b.token);
    if (!s) return json(res, 401, { error: 'bad token' });
    servers.updateStatus(b.token, { status: b.status, online: b.online, name: b.name, type: b.type, version: b.version });
    // отдаём агенту актуальное состояние привязки, чтобы панель показала «привязан» без рестарта
    return json(res, 200, { ok: true, claimed: !!s.ownerAccount, linkCode: s.linkCode || null });
  }
  return false;
}

// ---------------- аутентификация ----------------
async function handleAuth(req, res, urlPath) {
  if (urlPath === '/api/register' && req.method === 'POST') {
    if (!apiRegLimit(clientIp(req))) return json(res, 429, { error: 'Слишком много регистраций. Подождите минуту.' });
    if (accounts.count() >= MAX_ACCOUNTS) return json(res, 429, { error: 'Достигнут лимит аккаунтов на сервере.' });
    const b = await readBody(req);
    const r = accounts.register(b.username, b.password);
    if (r.error) return json(res, 400, r);
    // авто-одобрение (v1.4): сразу логиним — «просто логин и пароль» работает с первого запуска
    const u = accounts.verify(b.username, b.password);
    if (!u || u.pending) return json(res, 200, { ok: true }); // на всякий случай — деградация
    accounts.setDevice(u.username, b.device, clientIp(req)); // железо/IP для админ-панели
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': accounts.cookieFor(accounts.createSession(u.username)) });
    return res.end(JSON.stringify({ ok: true, user: u }));
  }
  if (urlPath === '/api/login' && req.method === 'POST') {
    const ip = clientIp(req);
    const locked = accounts.lockMs(ip);
    if (locked > 0) return json(res, 429, { error: 'Слишком много попыток. Подождите ' + Math.ceil(locked / 60000) + ' мин.' });
    const b = await readBody(req);
    const u = accounts.verify(b.username, b.password);
    if (u && !u.pending) {
      accounts.clearFails(ip);
      accounts.setDevice(u.username, b.device, ip); // железо/IP для админ-панели
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': accounts.cookieFor(accounts.createSession(u.username)) });
      return res.end(JSON.stringify({ ok: true, user: u }));
    }
    if (u && u.pending) { accounts.noteFail(ip); return json(res, 403, { error: 'Аккаунт ждёт одобрения администратором' }); }
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

const PAGE_CSS = 'body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;'
  + 'background:#1a1a1a;color:#e6e6e6;font-family:system-ui,Segoe UI,sans-serif;text-align:center}'
  + '.c{max-width:420px;padding:28px}h1{color:#80da5b;font-size:20px;margin:0 0 10px}'
  + 'p{color:#bdbdbd;line-height:1.5}';
function htmlPage(res, code, title, msg) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>' + title + '</title>'
    + '<style>' + PAGE_CSS + '</style></head><body><div class="c"><h1>' + title + '</h1><p>'
    + msg + '</p></div></body></html>');
}
/* Страница callback implicit-grant: достаёт access_token из #fragment и шлёт на /finish.
   /finish сам решает, привязка это или сброс пароля (по kind в state). Для сброса
   показываем форму нового пароля и шлём её на /reset-complete. */
function discordCallbackPage(res) {
  const css = PAGE_CSS + '.f{margin-top:14px}.f input{width:100%;box-sizing:border-box;padding:10px;border:1px solid #454545;'
    + 'background:#101010;color:#e6e6e6;font-size:15px;border-radius:6px}.f button{margin-top:10px;width:100%;padding:10px;'
    + 'background:#52a535;border:0;color:#fff;font-size:15px;border-radius:6px;cursor:pointer}.e{color:#ff8a7a;font-size:13px;margin-top:8px}';
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Discord</title><style>' + css
    + '</style></head><body><div class="c" id="box"><h1>Discord…</h1><p>Секунду…</p></div><script>'
    + '(function(){var box=document.getElementById("box");'
    + 'function show(t,m){box.innerHTML="<h1>"+t+"</h1><p>"+m+"</p>";}'
    + 'var p=new URLSearchParams((location.hash||"").replace(/^#/,""));'
    + 'var at=p.get("access_token"),st=p.get("state"),err=p.get("error");'
    + 'try{history.replaceState(null,"",location.pathname);}catch(e){}'
    + 'if(err){show("Не получилось","Discord вернул ошибку: "+err);return;}'
    + 'if(!at){show("Не получилось","Не получили токен от Discord. Повторите из приложения/сайта.");return;}'
    + 'function resetForm(username,token){box.innerHTML="<h1>Новый пароль</h1><p>Аккаунт <b>"+username+"</b>. Задайте новый пароль.</p>"'
    + '+"<div class=f><input id=np type=password placeholder=\\"Новый пароль (мин. 6)\\" autocomplete=new-password><button id=sb>Сменить пароль</button><div class=e id=er></div></div>";'
    + 'document.getElementById("sb").onclick=function(){var pw=document.getElementById("np").value;var er=document.getElementById("er");'
    + 'if((pw||"").length<6){er.textContent="Минимум 6 символов.";return;}er.textContent="";'
    + 'fetch("/api/account/discord/reset-complete",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({resetToken:token,password:pw})})'
    + '.then(function(r){return r.json();}).then(function(d){if(d&&d.ok){show("Пароль изменён","Готово! Войдите с новым паролем. <a style=\\"color:#80da5b\\" href=/>На сайт</a>.");}else{er.textContent=(d&&d.error)||"Ошибка.";}})'
    + '.catch(function(){er.textContent="Ошибка сети.";});};}'
    + 'fetch("/api/account/discord/finish",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({state:st,access_token:at})})'
    + '.then(function(r){return r.json();}).then(function(d){'
    + 'if(d&&d.ok&&d.reset){resetForm(d.username||"",d.resetToken);return;}'
    + 'if(d&&d.ok){show("Discord привязан","Аккаунт <b>"+(d.name||"")+"</b> привязан. Закройте это окно и вернитесь в приложение.");return;}'
    + 'show("Не получилось",(d&&d.error)||"Ошибка.");})'
    + '.catch(function(){show("Ошибка сети","Не удалось связаться с сервером.");});})();</script></body></html>');
}

// ---------------- Discord OAuth (публично: state/lt вместо cookie-сессии) ----------------
async function handleDiscordOAuth(req, res, urlPath, url) {
  // старт: ?lt=<link-token из десктопа> ИЛИ cookie-сессия (с сайта)
  if (urlPath === '/api/account/discord/start' && req.method === 'GET') {
    if (!discord.enabled()) return htmlPage(res, 503, 'Discord не настроен', 'Администратор ещё не подключил Discord-приложение. Попробуйте позже.');
    const lt = url.searchParams.get('lt') || '';
    let username = null;
    if (lt) { const v = discord.takeLinkToken(lt); if (v) username = v.username; }
    if (!username) { const u = accounts.userFromReq(req); if (u) username = u.username; }
    if (!username) return htmlPage(res, 401, 'Нужен вход', 'Ссылка устарела. Откройте привязку Discord заново из приложения.');
    const state = discord.makeState(username);
    res.writeHead(302, { Location: discord.authorizeUrl(state) });
    return res.end();
  }
  // старт сброса пароля через Discord (публично, без входа): личность подтвердит Discord,
  // аккаунт найдём по привязанному Discord-ID.
  if (urlPath === '/api/account/discord/reset-start' && req.method === 'GET') {
    if (!resetLimit(clientIp(req))) return htmlPage(res, 429, 'Слишком часто', 'Подождите минуту и попробуйте снова.');
    if (!discord.enabled()) return htmlPage(res, 503, 'Discord не настроен', 'Администратор ещё не подключил Discord-приложение. Попробуйте позже.');
    const state = discord.makeState(null, 'reset');
    res.writeHead(302, { Location: discord.authorizeUrl(state) });
    return res.end();
  }
  // callback от Discord (implicit): токен в #fragment — отдаём страницу с JS, которая шлёт его на /finish
  if (urlPath === '/api/account/discord/callback' && req.method === 'GET') {
    return discordCallbackPage(res);
  }
  // приём токена со страницы callback: валидируем у Discord. Для kind=reset находим аккаунт
  // по Discord-ID и выдаём одноразовый токен сброса; иначе — привязываем (публично, state защищает).
  if (urlPath === '/api/account/discord/finish' && req.method === 'POST') {
    const b = await readBody(req, 16 * 1024);
    const v = discord.takeState(String(b.state || ''));
    if (!v) return json(res, 400, { error: 'Ссылка устарела. Повторите из приложения/сайта.' });
    const prof = await discord.fetchUser(String(b.access_token || ''));
    if (prof.error) return json(res, 502, { error: prof.error });
    if (v.kind === 'reset') {
      const u = accounts.byDiscordId(prof.id);
      if (!u) return json(res, 404, { error: 'К этому Discord не привязан ни один аккаунт CONTROLGUI.' });
      return json(res, 200, { ok: true, reset: true, username: u.username, resetToken: accounts.makeResetToken(u.username) });
    }
    const r = accounts.setDiscord(v.username, prof);
    if (r.error) return json(res, 409, { error: r.error });
    return json(res, 200, { ok: true, name: prof.name });
  }
  // завершение сброса: одноразовый токен + новый пароль
  if (urlPath === '/api/account/discord/reset-complete' && req.method === 'POST') {
    if (!resetLimit(clientIp(req))) return json(res, 429, { error: 'Слишком часто. Подождите минуту.' });
    const b = await readBody(req, 16 * 1024);
    const v = accounts.takeResetToken(String(b.resetToken || ''));
    if (!v) return json(res, 400, { error: 'Ссылка сброса устарела. Начните заново.' });
    const r = accounts.setPassword(v.username, String(b.password || ''));
    if (r.error) return json(res, 400, r);
    return json(res, 200, { ok: true, username: r.username });
  }
  return false;
}

// ---------------- API пользователя/админа (нужна сессия) ----------------
const avatarBackfillTried = new Set(); // discord-id -> уже пытались дотянуть аватар (не дёргаем повторно)
async function handleApi(req, res, urlPath, url, user) {
  if (urlPath === '/api/me') {
    // бэкофилл аватара Discord для старых привязок без него (через bot-токен, один раз на id)
    if (user && user.discord && user.discord.id && !user.discord.avatar
        && discord.botEnabled() && !avatarBackfillTried.has(user.discord.id)) {
      avatarBackfillTried.add(user.discord.id);
      try {
        const av = await discord.fetchAvatarById(user.discord.id);
        if (av) { const r = accounts.setDiscordAvatar(user.username, av); if (r.user) user = r.user; }
      } catch (e) { /* не вышло — покажем без аватара */ }
    }
    return json(res, 200, { user, discordEnabled: discord.enabled() });
  }
  if (urlPath === '/api/servers' && req.method === 'GET') return json(res, 200, { servers: servers.forUser(user) });
  // список одобренных ников — ТОЛЬКО админу (владельцы выдают доступ по нику, без утечки списка)
  if (urlPath === '/api/accounts' && req.method === 'GET') return json(res, 200, { users: accounts.isAdmin(user) ? accounts.approvedNames() : [] });

  if (urlPath === '/api/link' && req.method === 'POST') {
    const ip = clientIp(req);
    const locked = linkLocked(ip);
    if (locked > 0) return json(res, 429, { error: 'Слишком много неверных кодов. Подождите ' + Math.ceil(locked / 60000) + ' мин.' });
    if (!linkLimit(String(user.username).toLowerCase()) || !linkIpLimit(ip) || !linkGlobalLimit('global')) {
      return json(res, 429, { error: 'Слишком много попыток привязки. Подождите минуту.' });
    }
    const b = await readBody(req);
    const r = servers.claimByCode(b.code, user.username);
    if (r.error) { noteLinkFail(ip); return json(res, 400, r); }
    clearLinkFails(ip);
    return json(res, 200, { ok: true, server: servers.publicServer(r.server, user) });
  }

  // --- профиль аккаунта: смена ника, привязка Discord ---
  if (urlPath === '/api/account/rename' && req.method === 'POST') {
    if (!renameLimit(String(user.username).toLowerCase())) return json(res, 429, { error: 'Слишком часто. Подождите минуту.' });
    const b = await readBody(req);
    const r = accounts.rename(user.username, b.newName);
    if (r.error) return json(res, 400, r);
    servers.renameAccount(user.username, b.newName); // каскад ownerAccount/access
    return json(res, 200, { ok: true, user: r.user });
  }
  if (urlPath === '/api/account/device' && req.method === 'POST') {
    const b = await readBody(req);
    accounts.setDevice(user.username, b.device, clientIp(req));
    return json(res, 200, { ok: true });
  }
  if (urlPath === '/api/account/password' && req.method === 'POST') {
    if (!renameLimit(String(user.username).toLowerCase())) return json(res, 429, { error: 'Слишком часто. Подождите минуту.' });
    const b = await readBody(req);
    const r = accounts.changePassword(user.username, b.current, b.next);
    return json(res, r.error ? 400 : 200, r);
  }
  if (urlPath === '/api/account/discord/link-init' && req.method === 'POST') {
    if (!discord.enabled()) return json(res, 503, { error: 'Discord ещё не настроен администратором' });
    const lt = discord.makeLinkToken(user.username);
    const e = settings.endpoint();
    const host = e.host + (e.port && e.port !== 443 ? ':' + e.port : '');
    return json(res, 200, { ok: true, url: 'https://' + host + '/api/account/discord/start?lt=' + lt });
  }
  if (urlPath === '/api/account/discord/unlink' && req.method === 'POST') {
    const r = accounts.setDiscord(user.username, null);
    return json(res, r.error ? 400 : 200, r.error ? r : { ok: true, user: r.user });
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
    // нельзя назначать несуществующему нику (висячий ACL дал бы доступ при будущей регистрации)
    if (!accounts.exists(b.username)) return json(res, 400, { error: 'Пользователь не найден' });
    const r = servers.assign(m[1], b.username, b.perms);
    return json(res, r.error ? 400 : 200, r);
  }

  // --- админ ---
  if (urlPath.startsWith('/api/admin/')) {
    if (!accounts.isAdmin(user)) return json(res, 403, { error: 'Только админ' });
    if (urlPath === '/api/admin/users') return json(res, 200, { users: accounts.listUsers(), pending: accounts.pending() });
    if (urlPath === '/api/admin/user-info' && req.method === 'GET') return json(res, 200, { info: accounts.adminInfo(url.searchParams.get('username') || '') });
    if (urlPath === '/api/admin/servers') return json(res, 200, { servers: servers.all().map((s) => servers.publicServer(s, user)) });
    if (urlPath === '/api/admin/approve' && req.method === 'POST') { const b = await readBody(req); accounts.approve(b.username); return json(res, 200, { ok: true }); }
    if (urlPath === '/api/admin/reject' && req.method === 'POST') { const b = await readBody(req); accounts.remove(b.username); return json(res, 200, { ok: true }); }
    if (urlPath === '/api/admin/remove-server' && req.method === 'POST') { const b = await readBody(req); servers.remove(b.globalId); return json(res, 200, { ok: true }); }
    if (urlPath === '/api/admin/endpoint' && req.method === 'GET') return json(res, 200, { endpoint: settings.endpoint() });
    if (urlPath === '/api/admin/endpoint' && req.method === 'POST') {
      const b = await readBody(req);
      const r = settings.setEndpoint(b.host, b.port);
      return json(res, r.error ? 400 : 200, r);
    }
  }
  return json(res, 404, { error: 'Не найдено' });
}

function serveStatic(req, res, urlPath) {
  let p = urlPath === '/' ? '/index.html' : urlPath;
  if (p === '/admin') p = '/admin.html';
  if (p === '/manage') p = '/manage.html'; // страница полного удалённого управления (UI панели 1:1)
  const file = path.normalize(path.join(PUB, p));
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { return htmlPage(res, 404, 'Страница не найдена', 'Такой страницы нет. <a href="/" style="color:#80da5b">Назад на главную</a>.'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

async function handle(req, res) {
  try {
    // new URL ВНУТРИ try: на таргетах вроде `GET //` конструктор кидает — иначе
    // это unhandledRejection и падение процесса (неаутентиф. remote-DoS одним запросом).
    const url = new URL(req.url, 'https://localhost');
    const urlPath = url.pathname;
    if (urlPath.startsWith('/agent/')) { const r = await handleAgent(req, res, urlPath, url); if (r !== false) return; res.writeHead(404); return res.end(); }
    // публичный адрес центра — клиенты узнают его и мигрируют на новый IP/host
    if (urlPath === '/api/endpoint' && req.method === 'GET') return json(res, 200, settings.endpoint());
    if (urlPath.startsWith('/api/account/discord/')) { const r = await handleDiscordOAuth(req, res, urlPath, url); if (r !== false) return; }
    if (await handleAuth(req, res, urlPath) !== false) return;
    // полное удалённое управление: /r/<globalId>/<путь панели> -> туннель (нужна сессия)
    if (urlPath.startsWith('/r/')) {
      const user = accounts.userFromReq(req);
      if (!user) return json(res, 401, { error: 'Нужен вход', login: true });
      if (await proxy.handle(req, res, urlPath, user, json)) return;
      return json(res, 404, { error: 'Не найдено' });
    }
    if (urlPath.startsWith('/api/')) {
      const user = accounts.userFromReq(req);
      if (!user) return json(res, 401, { error: 'Нужен вход', login: true });
      return await handleApi(req, res, urlPath, url, user); // await — чтобы throw попал в catch
    }
    return serveStatic(req, res, urlPath);
  } catch (e) {
    try { json(res, 500, { error: 'Ошибка сервера' }); } catch (e2) { /* ответ мог уже уйти */ }
  }
}

// online выводим из живого набора SSE-стримов; на старте гасим устаревший online
servers.setLiveChecker(agents.isOnline);
try { servers.resetAllOnline(); } catch (e) { /* */ }

// последняя страховка от падения процесса (root remote-управление должно жить)
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e && e.message));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e && e.message));

// сид админа
const seed = accounts.ensureAdmin(process.env.CGR_ADMIN || 'admin');
if (seed.created) {
  // пароль НЕ печатаем в stdout (попадает в journald) — только в файл 0600
  const credPath = path.join(require('./lib/store').DATA, 'ADMIN-CREDENTIALS.txt');
  try { fs.writeFileSync(credPath, 'login: ' + seed.username + '\npassword: ' + seed.password + '\n', { mode: 0o600 }); } catch (e) { /* */ }
  console.log('  >>> Создан админ «' + seed.username + '». Пароль: ' + credPath + ' (chmod 600)');
}

const server = https.createServer({ cert: fs.readFileSync(CERT), key: fs.readFileSync(KEY) }, handle);
server.listen(PORT, () => console.log('CONTROLGUI Remote слушает https://0.0.0.0:' + PORT));

// 80 -> 443 редирект. Хост берём из env (а не из клиентского Host — open-redirect).
const PUBHOST = process.env.CGR_PUBLIC_HOST || '';
if (PORT === 443) {
  http.createServer((req, res) => {
    const host = PUBHOST || (req.headers.host || '').split(':')[0];
    res.writeHead(301, { Location: 'https://' + host + req.url });
    res.end();
  }).listen(80, () => {});
}
