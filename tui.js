#!/usr/bin/env node
'use strict';
/* TUI CONTROLGUI — текстовый интерфейс в терминале (чистый Node + ANSI, без зависимостей).
   Работает и с локальной панелью (http://127.0.0.1:8400), и с удалённой
   (https://ip:8433 — пароль + TOFU-пин самоподписанного серта).

   controlgui tui                       локальная панель
   controlgui tui https://1.2.3.4:8433  удалённая панель

   Список серверов: ↑/↓ — выбор, Enter — консоль, s — старт, x — стоп,
   r — рестарт, q — выход. Консоль: ввод команды + Enter, Esc — назад. */

const http = require('http');
const https = require('https');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

let DATA_DIR;
try { DATA_DIR = require('./lib/paths').DATA_DIR; }
catch (e) { DATA_DIR = path.join(require('os').homedir(), '.controlgui'); }
const PINS_FILE = path.join(DATA_DIR, 'tui-known-hosts.json');

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error('TUI требует интерактивного терминала (TTY).');
  process.exit(1);
}

const rawUrl = process.argv[2] || 'http://127.0.0.1:8400';
let BASE;
try { BASE = new URL(rawUrl); } catch (e) { console.error('Некорректный адрес: ' + rawUrl); process.exit(1); }
const SECURE = BASE.protocol === 'https:';
const HOST = BASE.hostname;
const PORT = parseInt(BASE.port, 10) || (SECURE ? 8433 : 8400);
const HOSTKEY = HOST + ':' + PORT;

let cookie = '';       // cg_remote=... после входа
let pinnedFp = null;   // ожидаемый отпечаток серта (TOFU)
let pinnedPem = null;  // сам серт — служит доверенным CA для строгой проверки цепочки

// ---------- ANSI ----------
const ESC = '\x1b[';
const w = (s) => process.stdout.write(s);
const altOn = () => w('\x1b[?1049h\x1b[?25l');
const altOff = () => w('\x1b[?1049l\x1b[?25h');
const clear = () => w(ESC + '2J' + ESC + 'H');
const at = (r, c) => ESC + r + ';' + c + 'H';
const C = { reset: ESC + '0m', dim: ESC + '2m', bold: ESC + '1m', green: ESC + '32m', bgreen: ESC + '92m', red: ESC + '91m', yellow: ESC + '93m', cyan: ESC + '96m', inv: ESC + '7m' };
function cols() { return process.stdout.columns || 80; }
function rows() { return process.stdout.rows || 24; }
function fit(s, n) { s = String(s); return s.length > n ? s.slice(0, Math.max(0, n - 1)) + '…' : s; }
function pad(s, n) { s = fit(s, n); return s + ' '.repeat(Math.max(0, n - s.length)); }
// строка консоли может содержать ANSI сервера — вырезаем управляющее, чтобы не ломать вёрстку
function strip(s) { return String(s).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/[\x00-\x08\x0b-\x1f]/g, ''); }

// ---------- пины сертов (TOFU): { "host:port": { fp, pem } } ----------
function loadPins() { try { return JSON.parse(fs.readFileSync(PINS_FILE, 'utf8')); } catch (e) { return {}; } }
function pinFor(key) {
  const v = loadPins()[key];
  if (!v) return null;
  return typeof v === 'string' ? { fp: v, pem: null } : v; // миграция старого формата (только fp)
}
function savePin(key, fp, pem) {
  const p = loadPins(); p[key] = { fp, pem };
  try { fs.mkdirSync(path.dirname(PINS_FILE), { recursive: true }); fs.writeFileSync(PINS_FILE, JSON.stringify(p, null, 2), { mode: 0o600 }); } catch (e) { /* */ }
}
function derToPem(raw) {
  return '-----BEGIN CERTIFICATE-----\n' + raw.toString('base64').replace(/(.{64})/g, '$1\n').trim() + '\n-----END CERTIFICATE-----\n';
}
// одноразовое probe-соединение: снять отпечаток и PEM серта
function probeCert() {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host: HOST, port: PORT, rejectUnauthorized: false, servername: HOST }, () => {
      const cert = sock.getPeerCertificate();
      sock.end();
      if (!cert || !cert.raw) return reject(new Error('Сервер не отдал сертификат'));
      resolve({ fp: crypto.createHash('sha256').update(cert.raw).digest('hex'), pem: derToPem(cert.raw) });
    });
    sock.on('error', reject);
    sock.setTimeout(7000, () => { sock.destroy(); reject(new Error('Таймаут соединения')); });
  });
}

// ---------- HTTP-клиент со строгим пиннингом ----------
function request(method, p, body, streaming) {
  return new Promise((resolve, reject) => {
    const lib = SECURE ? https : http;
    const opts = { host: HOST, port: PORT, path: p, method, headers: {} };
    if (cookie) opts.headers.Cookie = cookie;
    if (body) opts.headers['Content-Type'] = 'application/json';
    if (SECURE) {
      // Пиннинг: запиненный серт выступает доверенным CA (self-signed лист сходится
      // сам с собой), rejectUnauthorized:true рвёт соединение при ЛЮБОМ другом серте
      // ДО отправки заголовков — иначе MITM получил бы пароль/куку. checkServerIdentity
      // дополнительно сверяет отпечаток (а не только SAN-хост).
      if (pinnedPem) opts.ca = [pinnedPem];
      opts.rejectUnauthorized = true;
      // servername (SNI) не ставим: удалёнка обычно по IP, а SNI c IP запрещён Node;
      // хостнейм всё равно проверяем сами по отпечатку ниже, не по SAN
      opts.checkServerIdentity = (host, cert) => {
        const fp = crypto.createHash('sha256').update(cert.raw).digest('hex');
        return (pinnedFp && fp === pinnedFp) ? undefined : new Error('Отпечаток сертификата не совпал с запиненным');
      };
    }
    const r = lib.request(opts, (res) => {
      if (streaming) return resolve(res);
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        let j = {};
        try { j = JSON.parse(d || '{}'); } catch (e) { /* */ }
        resolve({ code: res.statusCode, headers: res.headers, json: j });
      });
      res.on('error', reject);
    });
    r.on('error', reject);
    if (!streaming) r.setTimeout(15000, () => { r.destroy(new Error('таймаут')); });
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

// ---------- простые вопросы в обычном режиме ----------
function ask(q, hidden) {
  return new Promise((resolve) => {
    process.stdout.write(q);
    const stdin = process.stdin;
    stdin.setRawMode(true); stdin.resume();
    let s = '';
    const onData = (ch) => {
      const c = String(ch); const code = c.charCodeAt(0);
      if (c === '\r' || c === '\n') { stdin.removeListener('data', onData); w('\n'); resolve(s); }
      else if (code === 3) { altOff(); process.exit(130); }
      else if (code === 8 || code === 127) { if (s.length) { s = s.slice(0, -1); w('\b \b'); } }
      else if (code >= 32) { s += c; w(hidden ? '*' : c); }
    };
    stdin.on('data', onData);
  });
}

// ---------- вход ----------
async function ensureAccess() {
  if (SECURE) {
    const known = pinFor(HOSTKEY);
    const cur = await probeCert();
    if (!known) {
      w('Первое подключение к ' + HOSTKEY + '.\n');
      w('Отпечаток сертификата (SHA-256):\n  ' + C.cyan + cur.fp + C.reset + '\n');
      w('Сверьте его с показанным в панели (Настройки → Удалённый доступ).\n');
      const a = await ask('Доверять этому серверу? [y/N]: ');
      if (a.trim().toLowerCase() !== 'y') { console.log('Отменено.'); process.exit(1); }
      savePin(HOSTKEY, cur.fp, cur.pem);
      pinnedFp = cur.fp; pinnedPem = cur.pem;
    } else if (known.fp !== cur.fp) {
      console.error(C.red + '\n!!! ОТПЕЧАТОК СЕРТИФИКАТА ИЗМЕНИЛСЯ !!!' + C.reset);
      console.error('Ожидался: ' + known.fp);
      console.error('Получен:  ' + cur.fp);
      console.error('Если вы сами перевыпускали серт (controlgui remote cert-reset) — удалите запись в\n' + PINS_FILE + ' и подключитесь заново. Иначе это может быть перехват трафика.');
      process.exit(1);
    } else {
      pinnedFp = known.fp;
      pinnedPem = known.pem || cur.pem; // старый формат без pem — берём из probe (fp уже сверен)
    }
  }
  // проверяем доступ; на https без сессии получим 401 → просим пароль
  let r = await request('GET', '/api/servers');
  if (r.code === 401) {
    for (let tryN = 0; tryN < 3; tryN++) {
      const pw = await ask('Пароль удалённого доступа: ', true);
      const lr = await request('POST', '/api/auth/login', { password: pw });
      if (lr.code === 200) {
        cookie = String((lr.headers['set-cookie'] || [])[0] || '').split(';')[0];
        r = await request('GET', '/api/servers');
        break;
      }
      console.log(C.red + ((lr.json && lr.json.error) || 'Неверный пароль') + C.reset);
      if (lr.code === 429) process.exit(1);
    }
  }
  if (r.code !== 200) { console.error('Нет доступа: HTTP ' + r.code + ' ' + ((r.json && r.json.error) || '')); process.exit(1); }
}

// ---------- состояние TUI ----------
let screen = 'list';       // list | console
let servers = [];
let sel = 0;
let viewTop = 0;           // прокрутка списка серверов
let msg = '';
let consoleLines = [];
let consoleInput = '';
let consoleRes = null;
let consoleId = null;
let statsLine = '';
let pollTimer = null;

const STATUS_RU = { running: 'работает', stopped: 'остановлен', starting: 'запускается', stopping: 'останавливается', error: 'ошибка', 'no-jar': 'нет ядра', downloading: 'скачивается', orphaned: 'осиротел' };
function stColor(st) {
  if (st === 'running') return C.bgreen;
  if (st === 'starting' || st === 'stopping' || st === 'downloading' || st === 'orphaned') return C.yellow;
  if (st === 'error' || st === 'no-jar') return C.red;
  return C.dim;
}

async function refreshServers() {
  try {
    const r = await request('GET', '/api/servers');
    if (r.code === 200) { servers = r.json.servers || []; if (sel >= servers.length) sel = Math.max(0, servers.length - 1); }
  } catch (e) { msg = 'Нет связи: ' + e.message; }
}
async function refreshStats() {
  if (screen !== 'console' || !consoleId) return;
  try {
    const r = await request('GET', '/api/servers/' + consoleId + '/stats');
    const pts = (r.json && r.json.points) || [];
    const last = pts[pts.length - 1];
    if (last) {
      statsLine = 'CPU ' + (last.cpu == null ? '—' : last.cpu.toFixed(0) + '%') +
        ' · RAM ' + (last.ramMb == null ? '—' : Math.round(last.ramMb) + ' МБ') +
        ' · игроков: ' + (last.players == null ? '—' : last.players);
    }
  } catch (e) { /* не критично */ }
}

// ---------- отрисовка ----------
function draw() {
  clear();
  const W = cols(); const H = rows();
  const title = ' CONTROLGUI TUI — ' + (SECURE ? 'https://' : 'http://') + HOST + ':' + PORT + ' ';
  w(at(1, 1) + C.inv + pad(title, W) + C.reset);
  if (screen === 'list') {
    w(at(2, 1) + C.dim + pad('  ' + pad('Сервер', 28) + pad('Ядро', 16) + pad('Статус', 16) + pad('Игроки', 8) + 'Порт', W) + C.reset);
    const listH = Math.max(1, H - 4);
    // прокрутка: держим sel в окне [viewTop, viewTop+listH)
    if (sel < viewTop) viewTop = sel;
    if (sel >= viewTop + listH) viewTop = sel - listH + 1;
    if (viewTop > Math.max(0, servers.length - listH)) viewTop = Math.max(0, servers.length - listH);
    const shown = servers.slice(viewTop, viewTop + listH);
    shown.forEach((s, i) => {
      const idx = viewTop + i;
      const line = '  ' + pad(s.name, 28) + pad((s.type || '') + ' ' + (s.version || ''), 16) +
        stColor(s.status) + pad(STATUS_RU[s.status] || s.status, 16) + C.reset +
        pad(String((s.players || []).length), 8) + s.port;
      if (idx === sel) w(at(3 + i, 1) + C.inv + pad(line, W) + C.reset);
      else w(at(3 + i, 1) + fit(line, W));
    });
    if (!servers.length) w(at(4, 3) + C.dim + 'Серверов нет. Создайте в веб-панели.' + C.reset);
    const more = servers.length > listH ? '  [' + (sel + 1) + '/' + servers.length + ']' : '';
    w(at(H - 1, 1) + C.dim + fit(' ↑/↓ выбор · Enter консоль · s старт · x стоп · r рестарт · q выход' + more, W) + C.reset);
  } else {
    const s = servers.find((x) => x.id === consoleId);
    w(at(2, 1) + C.dim + pad(' ' + (s ? s.name : '') + '  ' + (statsLine || ''), W) + C.reset);
    const listH = Math.max(1, H - 4);
    const lines = consoleLines.slice(-listH);
    lines.forEach((l, i) => w(at(3 + i, 1) + fit(strip(l), W)));
    w(at(H - 1, 1) + C.green + '> ' + C.reset + fit(consoleInput, W - 4) + '█');
    w(at(H, 1) + C.dim + fit(' Enter — отправить команду · Esc — назад к списку', W) + C.reset);
  }
  if (msg) { w(at(H, 1) + C.yellow + fit(' ' + msg, W - 1) + C.reset); }
}

// ---------- консоль (SSE) ----------
async function openConsole(id) {
  consoleId = id;
  consoleLines = [];
  consoleInput = '';
  statsLine = '';
  screen = 'console';
  try {
    const res = await request('GET', '/api/servers/' + id + '/console', null, true);
    if (res.statusCode !== 200) { res.resume(); res.destroy(); msg = 'Консоль недоступна: HTTP ' + res.statusCode; screen = 'list'; draw(); return; }
    consoleRes = res;
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const ev = buf.slice(0, idx); buf = buf.slice(idx + 2);
        for (const ln of ev.split('\n')) {
          if (ln.startsWith('data: ')) {
            try { consoleLines.push(JSON.parse(ln.slice(6))); } catch (e) { consoleLines.push(ln.slice(6)); }
          }
        }
        if (consoleLines.length > 2000) consoleLines = consoleLines.slice(-1500);
      }
      if (screen === 'console') draw();
    });
    res.on('error', () => { if (consoleRes === res) { consoleRes = null; if (screen === 'console') { msg = 'Поток консоли оборвался.'; screen = 'list'; draw(); } } });
    res.on('close', () => { if (consoleRes === res && screen === 'console') { msg = 'Поток консоли закрылся.'; draw(); } });
  } catch (e) { msg = 'Консоль: ' + e.message; screen = 'list'; draw(); }
  refreshStats();
  draw();
}
function closeConsole() {
  if (consoleRes) { try { consoleRes.destroy(); } catch (e) { /* */ } consoleRes = null; }
  consoleId = null;
  screen = 'list';
}

async function serverAction(act) {
  const s = servers[sel];
  if (!s) return;
  msg = (act === 'start' ? 'Запускаю' : act === 'stop' ? 'Останавливаю' : 'Перезапускаю') + ' «' + s.name + '»…';
  draw();
  try {
    const r = await request('POST', '/api/servers/' + s.id + '/' + act);
    msg = r.code === 200 ? 'Готово: ' + act + ' «' + s.name + '».' : ((r.json && r.json.error) || ('HTTP ' + r.code));
  } catch (e) { msg = e.message; }
  await refreshServers();
  draw();
}

async function sendCommand() {
  const cmd = consoleInput.trim();
  consoleInput = '';
  if (!cmd || !consoleId) return;
  try {
    const r = await request('POST', '/api/servers/' + consoleId + '/command', { command: cmd });
    if (r.code !== 200) msg = (r.json && r.json.error) || ('HTTP ' + r.code);
  } catch (e) { msg = e.message; }
  draw();
}

// ---------- ввод: разбор потока с ESC-последовательностями ----------
let inbuf = '';
let escTimer = null;
function feed(chunk) {
  inbuf += chunk;
  if (escTimer) { clearTimeout(escTimer); escTimer = null; }
  let moved = true;
  while (inbuf.length && moved) {
    moved = false;
    if (inbuf[0] === '\x1b') {
      const m = inbuf.match(/^\x1b(\[[0-9;]*[A-Za-z~]|O[A-Za-z])/);
      if (m) { handleSeq(m[0]); inbuf = inbuf.slice(m[0].length); moved = true; continue; }
      if (inbuf.length === 1) break;                 // одиночный ESC — ждём добора/таймаута
      if (inbuf[1] === '[' || inbuf[1] === 'O') break; // неполная последовательность — ждём
      handleKey('\x1b'); inbuf = inbuf.slice(1); moved = true; continue; // ESC+символ → трактуем как Esc
    }
    handleKey(inbuf[0]); inbuf = inbuf.slice(1); moved = true;
  }
  // «повис» одиночный ESC — по таймауту засчитываем как нажатие Esc
  if (inbuf === '\x1b') {
    escTimer = setTimeout(() => { if (inbuf === '\x1b') { inbuf = ''; handleKey('\x1b'); } }, 60);
  }
}
function handleSeq(seq) {
  msg = '';
  const up = seq === '\x1b[A' || seq === '\x1bOA';
  const down = seq === '\x1b[B' || seq === '\x1bOB';
  if (screen === 'list') {
    if (up) { sel = Math.max(0, sel - 1); draw(); }
    else if (down) { sel = Math.min(Math.max(0, servers.length - 1), sel + 1); draw(); }
  }
  // в консоли стрелки пока не используем (история команд — возможное расширение)
}
function handleKey(c) {
  const code = c.charCodeAt(0);
  if (code === 3) return quit(); // Ctrl+C везде
  msg = '';
  if (screen === 'list') {
    if (c === 'q') return quit();
    if (c === 'k') { sel = Math.max(0, sel - 1); return draw(); }
    if (c === 'j') { sel = Math.min(Math.max(0, servers.length - 1), sel + 1); return draw(); }
    if (c === '\r' || c === '\n') { const s = servers[sel]; if (s) openConsole(s.id); return; }
    if (c === 's') return void serverAction('start');
    if (c === 'x') return void serverAction('stop');
    if (c === 'r') return void serverAction('restart');
    return;
  }
  // консоль
  if (c === '\x1b') { closeConsole(); return draw(); }        // Esc — назад
  if (c === '\r' || c === '\n') return void sendCommand();
  if (code === 8 || code === 127) { consoleInput = consoleInput.slice(0, -1); return draw(); }
  if (code >= 32) { consoleInput += c; return draw(); }
}

let quitting = false;
function quit() {
  if (quitting) return;
  quitting = true;
  if (pollTimer) clearInterval(pollTimer);
  if (escTimer) clearTimeout(escTimer);
  closeConsole();
  try { process.stdin.setRawMode(false); } catch (e) { /* */ }
  altOff();
  process.exit(0);
}

// любая необработанная ошибка не должна оставить терминал в alt-screen без курсора
process.on('uncaughtException', (e) => { try { process.stdin.setRawMode(false); altOff(); } catch (_) { /* */ } console.error(e && e.stack || e); process.exit(1); });

// ---------- запуск ----------
(async () => {
  try {
    await ensureAccess();
  } catch (e) {
    console.error('Не удалось подключиться к ' + HOST + ':' + PORT + ' — ' + e.message);
    process.exit(1);
  }
  await refreshServers();
  altOn();
  draw();
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', feed);
  process.stdout.on('resize', draw);
  pollTimer = setInterval(async () => {
    if (screen === 'list') { await refreshServers(); draw(); }
    else await refreshStats();
  }, 2500);
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
})();
