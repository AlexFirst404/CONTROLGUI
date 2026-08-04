#!/usr/bin/env node
'use strict';
/* CLI панели CONTROLGUI: запуск/демон/статус, управление удалённым доступом,
   TUI и клиент-режим GUI. Без зависимостей. Работает на Windows/Linux/macOS,
   на Linux-сервере — без GUI-пакетов.

   controlgui serve                 панель в текущем терминале (Ctrl+C — стоп)
   controlgui start|stop|status     панель фоном (pid-файл в данных)
   controlgui server create|list    серверы Minecraft прямо из терминала (без веб-панели)
   controlgui remote setup          мастер настройки удалённого доступа (по шагам)
   controlgui remote ...            удалённый доступ (show/enable/disable/user/port)
   controlgui service install       systemd-сервис (Linux, от root)
   controlgui tui [url]             текстовый интерфейс (локально или по https)
   controlgui connect <url>|--local клиент-режим GUI-обёрток */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = __dirname;
// Установка systemd лишь пишет unit-файл: пользовательские каталоги должен
// впервые создать уже сам сервис под User=..., а не root-процесс через sudo.
if (process.argv[2] === 'service') global.__controlguiSkipDataInit = true;
const { DATA_DIR } = require('./lib/paths');
delete global.__controlguiSkipDataInit;
const PID_FILE = path.join(DATA_DIR, 'panel.pid');
const REMOTE_URL_FILE = path.join(DATA_DIR, 'remote-connect');
const PORT = parseInt(process.env.PORT, 10) || 8400;

function out(s) { process.stdout.write(s + '\n'); }
function die(s) { process.stderr.write(s + '\n'); process.exit(1); }

// ---------- ASCII-баннер ----------
function banner() {
  const tty = process.stdout.isTTY;
  const g = tty ? '\x1b[38;5;40m' : '';
  const g2 = tty ? '\x1b[38;5;114m' : '';
  const dim = tty ? '\x1b[2m' : '';
  const rst = tty ? '\x1b[0m' : '';
  const art = String.raw`  ____ ___  _   _ _____ ____   ___  _     ____ _   _ ___
 / ___/ _ \| \ | |_   _|  _ \ / _ \| |   / ___| | | |_ _|
| |  | | | |  \| | | | | |_) | | | | |   | |  _| | | || |
| |__| |_| | |\  | | | |  _ <| |_| | |___| |_| | |_| || |
 \____\___/|_| \_| |_| |_| \_\\___/|_____|\____|\___/|___|`;
  out('');
  out(g + art + rst);
  out(g2 + '     Панель Minecraft-серверов · Minecraft server panel' + rst);
  out(dim + '     https://github.com/AlexFirst404/CONTROLGUI' + rst);
  out('');
}

// ---------- ввод строки / да-нет (видимый ввод) ----------
// Намеренно НЕ readline: он буферизует stdin «под себя», и следующий за ним
// askHidden (сырой режим) уже не увидел бы остаток ввода — мастер зависал бы
// при подаче ответов из пайпа. Оба промпта читают один общий буфер.
// Возвращает строку, либо null при EOF (ввод закрыт) — вызывающий обязан это
// обработать, иначе цикл «спрашивай, пока не введёт» станет бесконечным.
function askLine(prompt, def) {
  process.stdout.write(prompt);
  return readLineNonTty().then((s) => (s == null ? null : (String(s).trim() || def || '')));
}
function abortNoInput() { die('\nВвод прерван (нет данных на входе). Запустите мастер в интерактивном терминале: controlgui remote setup'); }
async function askYesNo(prompt, defYes) {
  const raw = await askLine(prompt + (defYes ? ' [Д/н]: ' : ' [д/Н]: '), '');
  if (raw == null) abortNoInput();
  const a = String(raw).toLowerCase();
  if (!a) return !!defYes;
  return a === 'y' || a === 'yes' || a === 'д' || a === 'да';
}

// ---------- пароль без эха ----------
let stdinBuf = '';        // остаток буфера stdin между чтениями строк (не-TTY)
let stdinEnded = false;
// Возвращает строку, либо null — если ввод кончился (EOF: Ctrl+D, </dev/null, пустой
// пайп). null обязателен: без него цикл «спрашивай, пока не ответит» крутился бы вечно.
function readLineNonTty() {
  return new Promise((resolve) => {
    const take = () => {
      const nl = stdinBuf.indexOf('\n');
      if (nl !== -1) { const line = stdinBuf.slice(0, nl); stdinBuf = stdinBuf.slice(nl + 1); return resolve(line.replace(/\r$/, '')); }
      if (stdinEnded) {
        if (!stdinBuf) return resolve(null);
        const line = stdinBuf; stdinBuf = ''; return resolve(line.replace(/\r$/, ''));
      }
      return false;
    };
    if (take() !== false) return;
    const stdin = process.stdin;
    stdin.resume();
    const onData = (c) => { stdinBuf += c; if (take() !== false) { stdin.removeListener('data', onData); stdin.removeListener('end', onEnd); } };
    const onEnd = () => { stdinEnded = true; stdin.removeListener('data', onData); take(); };
    stdin.on('data', onData);
    stdin.on('end', onEnd);
  });
}
function askHidden(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    if (!stdin.isTTY) { // пайп/скрипт — читаем ОДНУ строку (не до EOF, иначе второй промпт зависнет)
      readLineNonTty().then((s) => { try { stdin.pause(); } catch (e) { /* */ } resolve(s == null ? null : s.trim()); });
      return;
    }
    stdin.setRawMode(true);
    stdin.resume();
    let pw = '';
    // Разбираем чанк ПОСИМВОЛЬНО: при вставке пароля из буфера обмена весь он
    // приходит одним куском вместе с переводом строки — проверка «первый символ ==
    // \n» его бы не заметила и \n уехал бы В ПАРОЛЬ (вход потом не работал бы).
    const onData = (ch) => {
      const s = String(ch);
      for (let i = 0; i < s.length; i++) {
        const c = s[i];
        const code = c.charCodeAt(0);
        if (c === '\r' || c === '\n') {
          stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onData);
          process.stdout.write('\n');
          return resolve(pw);
        }
        if (code === 3) { // Ctrl+C
          stdin.setRawMode(false); process.stdout.write('\n'); process.exit(130);
        } else if (code === 4) { // Ctrl+D — конец ввода
          stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onData);
          process.stdout.write('\n');
          return resolve(pw || null);
        } else if (code === 8 || code === 127) { // backspace / delete
          if (pw.length) { pw = pw.slice(0, -1); process.stdout.write('\b \b'); }
        } else if (code >= 32) {
          pw += c;
          process.stdout.write('*');
        }
      }
    };
    stdin.on('data', onData);
  });
}

// ---------- панель фоном ----------
function panelPid() {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8'), 10);
    if (!pid) return 0;
    process.kill(pid, 0); // существует?
    return pid;
  } catch (e) { return 0; }
}
function panelListening(cb) {
  const http = require('http');
  const r = http.get({ host: '127.0.0.1', port: PORT, path: '/api/status', timeout: 2500 }, (res) => {
    let d = '';
    res.on('data', (c) => { d += c; });
    res.on('end', () => { try { cb(JSON.parse(d)); } catch (e) { cb(null); } });
  });
  r.on('error', () => cb(null));
  r.on('timeout', () => { r.destroy(); cb(null); });
}

function cmdServe() {
  // exec-подобный запуск в текущем процессе — сигналы/логи как у node server.js
  require(path.join(ROOT, 'server.js'));
}
function cmdStart() {
  panelListening((st) => {
    if (st) return out('Панель уже работает на порту ' + PORT + '.');
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const log = fs.openSync(path.join(DATA_DIR, 'panel.log'), 'a');
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      detached: true, stdio: ['ignore', log, log],
      env: Object.assign({}, process.env),
      windowsHide: true,
    });
    fs.writeFileSync(PID_FILE, String(child.pid));
    child.unref();
    // подтверждаем, что панель реально поднялась (порт мог быть занят чужим процессом)
    let tries = 0;
    const poll = () => panelListening((up) => {
      if (up) { out('Панель запущена фоном (PID ' + child.pid + '). Локально: http://localhost:' + PORT); out('Лог: ' + path.join(DATA_DIR, 'panel.log')); return; }
      if (++tries > 20) { out('Панель запущена (PID ' + child.pid + '), но не ответила на порту ' + PORT + ' за 5 с. Смотрите ' + path.join(DATA_DIR, 'panel.log')); return; }
      setTimeout(poll, 250);
    });
    setTimeout(poll, 300);
  });
}
// Штатная остановка всегда идёт через API: pid-файл может устареть, а Windows
// переиспользует PID, поэтому автоматический kill рискует завершить чужой процесс.
function cmdStop() {
  const http = require('http');
  let finished = false;
  const unavailable = () => {
    if (finished) return;
    finished = true;
    process.exitCode = 1;
    const pid = panelPid();
    out(pid
      ? 'Панель не ответила по HTTP. Процесс по pid-файлу не завершён: сначала проверьте его вручную (PID ' + pid + ').'
      : 'Панель не запущена или не отвечает по HTTP.');
  };
  const r = http.request({ host: '127.0.0.1', port: PORT, path: '/api/quit', method: 'POST',
    headers: { 'x-cg-local': '1', 'x-cg-stop-servers': '1' }, timeout: 4000 }, (res) => {
    let body = '';
    res.on('data', (chunk) => { if (body.length < 4096) body += chunk.toString('utf8'); });
    res.on('end', () => {
      if (finished) return;
      finished = true;
      if (res.statusCode === 200) {
        try { fs.rmSync(PID_FILE, { force: true }); } catch (e) { /* */ }
        out('Панель штатно завершается (запущенные Minecraft-серверы останавливаются, миры сохраняются).');
        return;
      }
      let message = '';
      try { message = JSON.parse(body).error || ''; } catch (e) { /* не-JSON ответ чужого процесса */ }
      // Ответивший процесс жив и сам объяснил отказ. Особенно важно не посылать
      // Windows SIGTERM во время restore: там это жёсткий TerminateProcess.
      process.exitCode = 1;
      out('Панель не остановлена: ' + (message || ('HTTP ' + res.statusCode)) + '.');
    });
  });
  r.on('error', unavailable);
  r.on('timeout', () => { unavailable(); r.destroy(); });
  r.end();
}
function cmdStatus() {
  const pid = panelPid();
  panelListening((st) => {
    if (st) {
      out('Панель РАБОТАЕТ' + (pid ? ' (PID ' + pid + ', фоном)' : ' (в другом процессе)') + ' — ' + (st.app || ''));
      out('Локально:  http://localhost:' + PORT);
    } else {
      out('Панель НЕ отвечает на порту ' + PORT + (pid ? ' (процесс PID ' + pid + ' жив — стартует?)' : '.'));
    }
    const ra = require('./lib/remoteaccess');
    const s = ra.status();
    out('Удалённый доступ: ' + (s.enabled ? 'ВКЛЮЧЁН (HTTPS-порт ' + s.port + ')' : 'выключен')
      + ' · пользователей: ' + s.userCount);
    if (s.enabled && s.lanIps.length) out('  В сети: https://' + s.lanIps[0] + ':' + s.port);
    if (s.fingerprint) out('  Отпечаток серта (SHA-256): ' + s.fingerprint);
    process.exit(0);
  });
}

// ---------- удалённый доступ ----------
async function cmdRemote(args) {
  const ra = require('./lib/remoteaccess');
  const perms = require('./lib/users');
  const sub = args[0] || 'show';
  if (sub === 'setup' || sub === 'wizard') return await remoteSetup(ra, perms);
  if (sub === 'show') {
    const s = ra.status();
    out('включён: ' + (s.enabled ? 'да' : 'нет') + ' · порт: ' + s.port + ' · пользователей: ' + s.userCount);
    if (s.fingerprint) out('отпечаток серта: ' + s.fingerprint);
    if (s.lanIps.length) out('адреса в сети: ' + s.lanIps.map((ip) => 'https://' + ip + ':' + s.port).join('  '));
    for (const u of s.users) {
      const keys = Object.keys(u.access || {});
      out('  · ' + u.username + ' → ' + (keys.indexOf('*') >= 0 ? 'все серверы' : 'серверов: ' + keys.length));
    }
    out('Тонкая настройка прав по серверам — в панели (Настройки → Удалённый доступ).');
    return;
  }
  if (sub === 'user') {
    const op = args[1] || 'list';
    if (op === 'list') {
      const s = ra.status();
      if (!s.users.length) { out('Пользователей нет. Добавьте: controlgui remote user add <ник>'); return; }
      for (const u of s.users) {
        const keys = Object.keys(u.access || {});
        out(u.username + ' → ' + (keys.indexOf('*') >= 0 ? 'все серверы (полный доступ по умолчанию)' : 'серверов: ' + keys.length));
      }
      return;
    }
    if (op === 'add') {
      const name = args[2];
      if (!ra.validName(name)) die('Ник: 1–32 символа (буквы, цифры, _ . -). Пример: controlgui remote user add friend');
      const pw = await askHidden('Пароль для «' + name + '» (мин. 6): ');
      const pw2 = await askHidden('Повторите пароль: ');
      if (pw == null || pw2 == null) abortNoInput();
      if (pw !== pw2) die('Пароли не совпадают.');
      // из CLI по умолчанию — полный доступ ко всем серверам; сузить можно в панели
      const r = ra.saveUser({ username: name, password: pw, access: { '*': perms.presetPerms('full') } });
      if (r.error) die(r.error);
      out('Пользователь «' + name + '» создан (полный доступ ко всем серверам).');
      out('Ограничить серверы/права — в панели: Настройки → Удалённый доступ.');
      return;
    }
    if (op === 'rm' || op === 'remove' || op === 'delete') {
      const r = ra.removeUser(args[2]);
      if (r.error) die(r.error);
      out('Пользователь «' + args[2] + '» удалён.');
      return;
    }
    die('Доступно: remote user list | add <ник> | rm <ник>');
  }
  if (sub === 'port') {
    const r = ra.setPort(args[1]);
    if (r.error) die(r.error);
    out('Порт удалённого доступа: ' + r.port + '. Пробросьте его на роутере.');
    return;
  }
  if (sub === 'enable') {
    const r = ra.enable();
    if (r.error) die(r.error + ' (controlgui remote user add <ник>)');
    const s = ra.status();
    out('Удалённый доступ включён (HTTPS-порт ' + s.port + ').');
    if (s.lanIps.length) out('В сети: https://' + s.lanIps[0] + ':' + s.port);
    return;
  }
  if (sub === 'disable') { ra.disable(); out('Удалённый доступ выключен.'); return; }
  if (sub === 'cert-reset') {
    const r = ra.regenerateCert();
    out('Сертификат перевыпущен. Новый отпечаток: ' + r.fingerprint);
    out('Клиенты покажут предупреждение о новом сертификате — это ожидаемо.');
    return;
  }
  die('Неизвестная подкоманда remote. Доступно: setup, show, user (list/add/rm), enable, disable, port <порт>, cert-reset');
}

// Пошаговый мастер настройки удалённого доступа прямо в терминале: создать
// пользователя → выбрать порт → включить HTTPS → показать отпечаток и адреса.
// Работает и на «голом» Linux-сервере без графики. Конфиг перечитывается
// запущенной панелью на лету (fs.watchFile), поэтому доступ включается без рестарта.
async function remoteSetup(ra, perms) {
  banner();
  out('Настройка удалённого доступа (HTTPS) — по шагам.');
  const s0 = ra.status();
  out('Сейчас: ' + (s0.enabled ? 'включён' : 'выключен') + ' · порт ' + s0.port + ' · пользователей ' + s0.userCount);
  out('');

  const makeUser = async () => {
    let name;
    for (;;) {
      const raw = await askLine('  Логин (1–32: буквы, цифры, _ . -): ', '');
      if (raw == null) abortNoInput();
      name = String(raw).trim();
      if (ra.validName(name)) break;
      out('  Неверный логин. Пример: admin');
    }
    let pw;
    for (;;) {
      pw = await askHidden('  Пароль (мин. 6): ');
      if (pw == null) abortNoInput();
      if (pw.length < 6) { out('  Слишком короткий (мин. 6 символов).'); continue; }
      const pw2 = await askHidden('  Повторите пароль: ');
      if (pw2 == null) abortNoInput();
      if (pw !== pw2) { out('  Пароли не совпадают, попробуйте снова.'); continue; }
      break;
    }
    const r = ra.saveUser({ username: name, password: pw, access: { '*': perms.presetPerms('full') } });
    if (r.error) { out('  Ошибка: ' + r.error); return false; }
    out('  ✓ Пользователь «' + name + '» создан (полный доступ; сузить права по серверам — в панели).');
    return true;
  };

  if (!s0.userCount) {
    out('Шаг 1. Создайте пользователя для входа с других устройств.');
    if (!(await makeUser())) die('Не удалось создать пользователя.');
  } else {
    out('Шаг 1. Пользователи уже есть (' + s0.userCount + ').');
    if (await askYesNo('  Добавить ещё одного пользователя?', false)) await makeUser();
  }
  out('');

  out('Шаг 2. Порт HTTPS (по умолчанию 8433; на роутере/фаерволе пробросьте TCP-порт).');
  const portRaw = await askLine('  Порт [' + s0.port + ']: ', String(s0.port));
  const portAns = String(portRaw == null ? s0.port : portRaw).trim();
  if (portAns && portAns !== String(s0.port)) {
    const pr = ra.setPort(portAns);
    if (pr.error) out('  Порт не изменён: ' + pr.error);
    else out('  ✓ Порт: ' + pr.port);
  }
  out('');

  out('Шаг 3. Включаю удалённый доступ…');
  const er = ra.enable();
  if (er.error) die('Не удалось включить: ' + er.error);
  let s = ra.status();
  // Сертификат обычно создаётся при старте HTTPS-листенера — но в CLI листенер не
  // поднимается, и отпечаток было бы нечего показать. Если серта ещё нет, выпускаем
  // его прямо сейчас (существующий НЕ трогаем — иначе сломали бы доверие клиентов).
  if (!s.fingerprint) {
    try { ra.regenerateCert(); s = ra.status(); } catch (e) { out('  Не удалось выпустить сертификат: ' + e.message); }
  }
  out('  ✓ Удалённый доступ ВКЛЮЧЁН (HTTPS-порт ' + s.port + ').');
  out('');
  if (s.lanIps && s.lanIps.length) {
    out('Адреса в локальной сети:');
    for (const ip of s.lanIps) out('  https://' + ip + ':' + s.port);
    out('');
  }
  out('Отпечаток сертификата (SHA-256) — сверьте его при первом подключении клиента:');
  out('  ' + (s.fingerprint || '—'));
  out('');
  out('Подключение: приложение CONTROLGUI → «Удалённая панель…» → адрес выше + логин/пароль.');
  out('Либо из терминала другого хоста: controlgui tui https://<адрес>:' + s.port);
  out('Если панель запущена — доступ поднимется за ~2 сек (конфиг перечитывается на лету).');
  // В CLI-процессе листенер не поднимается (remoteaccess.sync() без init() ничего не
  // делает) — мы только пишем конфиг, а HTTPS поднимет сама панель, увидев изменения
  // файла. Выходим явно, чтобы не ждать возможных «хвостов» stdin после промптов.
  process.exit(0);
}

// ---------- серверы из терминала (без веб-панели) ----------
/* Все операции идут ЧЕРЕЗ HTTP-API локальной панели, а не через lib/store напрямую:
   store кеширует реестр в памяти, поэтому прямая запись в servers.json мимо живой
   панели была бы ею не видна и затёрлась бы при её следующем сохранении. Если панель
   не запущена — поднимаем её фоном, чтобы писатель всегда был один. */
function apiCall(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const http = require('http');
    const data = body == null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: pathname, method: method, timeout: 120000,
      headers: Object.assign({ 'x-cg-local': '1' }, data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
    }, (res) => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        let parsed = {};
        try { parsed = d ? JSON.parse(d) : {}; } catch (e) { /* не JSON */ }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(parsed);
        reject(new Error(parsed.error || ('панель ответила HTTP ' + res.statusCode)));
      });
    });
    req.on('error', (e) => reject(new Error('нет связи с панелью: ' + e.message)));
    req.on('timeout', () => { req.destroy(); reject(new Error('панель не ответила вовремя')); });
    if (data) req.write(data);
    req.end();
  });
}
function panelUp() { return new Promise((resolve) => panelListening((st) => resolve(!!st))); }
async function ensurePanel() {
  if (await panelUp()) return;
  out('Панель не запущена — поднимаю фоном…');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const log = fs.openSync(path.join(DATA_DIR, 'panel.log'), 'a');
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    detached: true, stdio: ['ignore', log, log], env: Object.assign({}, process.env), windowsHide: true,
  });
  try { fs.writeFileSync(PID_FILE, String(child.pid)); } catch (e) { /* */ }
  child.unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await panelUp()) { out('Панель поднялась (PID ' + child.pid + ').'); return; }
  }
  die('Панель не ответила на порту ' + PORT + ' за 10 с. Смотрите ' + path.join(DATA_DIR, 'panel.log'));
}
function parseFlags(args) {
  const flags = {}; const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.slice(0, 2) === '--') {
      const eq = a.indexOf('=');
      if (eq > 0) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const key = a.slice(2);
      const next = args[i + 1];
      if (next != null && next.slice(0, 1) !== '-') { flags[key] = next; i++; } else flags[key] = true;
    } else rest.push(a);
  }
  return { flags, rest };
}
const TYPE_INFO = [
  ['paper', 'Paper — быстрый Bukkit/Spigot-совместимый (плагины), рекомендуется'],
  ['vanilla', 'Vanilla — официальное ядро Mojang, без плагинов'],
  ['purpur', 'Purpur — форк Paper с доп. настройками'],
  ['folia', 'Folia — Paper с многопоточностью регионов'],
  ['forge', 'Forge — моды (Forge)'],
  ['mohist', 'Mohist — моды Forge + плагины Bukkit'],
  ['velocity', 'Velocity — прокси (объединяет серверы)'],
  ['bungeecord', 'BungeeCord — прокси (классический)'],
];
function fmtStatus(s) {
  const map = { running: 'работает', stopped: 'остановлен', downloading: 'скачивается', error: 'ошибка', 'no-jar': 'нет ядра', orphaned: 'потерян' };
  return map[s] || s || '—';
}
function findServer(list, key) {
  const k = String(key || '').toLowerCase();
  return list.find((s) => s.id.toLowerCase() === k) ||
    list.find((s) => String(s.name || '').toLowerCase() === k) || null;
}
async function serverList() {
  const data = await apiCall('GET', '/api/servers');
  return data.servers || [];
}
async function printServers() {
  const list = await serverList();
  if (!list.length) { out('Серверов нет. Создать: controlgui server create'); return; }
  out('ID        ИМЯ                  ТИП         ВЕРСИЯ      ПОРТ    СОСТОЯНИЕ');
  for (const s of list) {
    out([
      String(s.id).padEnd(9),
      String(s.name || '').slice(0, 20).padEnd(20),
      String(s.type || '').padEnd(11),
      String(s.version || '—').padEnd(11),
      String(s.port || '').padEnd(7),
      fmtStatus(s.status),
    ].join(' '));
  }
}
// Ждём завершения скачивания ядра, рисуя прогресс одной строкой.
async function waitDownload(id) {
  const tty = process.stdout.isTTY;
  for (let i = 0; i < 2400; i++) { // до ~20 минут
    let s;
    try { s = await apiCall('GET', '/api/servers/' + id); } catch (e) { break; }
    const d = s.download || {};
    // Ориентируемся ТОЛЬКО на download.phase: общий status сервера бывает 'error'
    // и по другой причине (например, прошлый неудачный запуск) — тогда мы бы
    // сообщили о несуществующей ошибке скачивания.
    if (d.phase === 'error') { out(''); return { ok: false, error: d.error || 'ошибка скачивания' }; }
    if (!s.download || d.phase === 'done') { if (tty) process.stdout.write('\r' + ' '.repeat(60) + '\r'); return { ok: true, server: s }; }
    const pct = Math.round((d.progress || 0) * 100);
    const mb = d.totalBytes ? ' ' + (d.doneBytes / 1048576).toFixed(1) + '/' + (d.totalBytes / 1048576).toFixed(1) + ' МБ' : '';
    const line = '  Скачивание ядра: ' + pct + '%' + mb + ' (' + (d.phase || '') + ')';
    if (tty) process.stdout.write('\r' + line.padEnd(60));
    else if (i % 20 === 0) out(line);
    await new Promise((r) => setTimeout(r, 500));
  }
  return { ok: false, error: 'слишком долго' };
}

async function cmdServer(args) {
  const { flags, rest } = parseFlags(args);
  const sub = rest[0] || 'list';

  if (sub === 'list' || sub === 'ls') { await ensurePanel(); return printServers(); }

  if (sub === 'create' || sub === 'new' || sub === 'add') {
    await ensurePanel();
    const existing = await serverList();
    const interactive = !flags.name; // без --name идём мастером
    if (interactive) { banner(); out('Создание сервера Minecraft — по шагам.'); out(''); }

    // имя
    let name = flags.name ? String(flags.name) : null;
    while (!name) {
      const raw = await askLine('  Название сервера: ', '');
      if (raw == null) abortNoInput();
      const v = String(raw).trim();
      if (v && v.length <= 40) name = v; else out('  От 1 до 40 символов.');
    }

    // тип ядра
    let type = flags.type ? String(flags.type).toLowerCase() : null;
    if (!type) {
      out('');
      out('  Ядро:');
      TYPE_INFO.forEach((t, i) => out('    ' + (i + 1) + ') ' + t[1]));
      for (;;) {
        const raw = await askLine('  Номер [1]: ', '1');
        if (raw == null) abortNoInput();
        const n = parseInt(String(raw).trim(), 10);
        if (n >= 1 && n <= TYPE_INFO.length) { type = TYPE_INFO[n - 1][0]; break; }
        out('  Введите число от 1 до ' + TYPE_INFO.length + '.');
      }
    }
    if (!TYPE_INFO.some((t) => t[0] === type)) die('Неизвестный тип ядра «' + type + '». Доступно: ' + TYPE_INFO.map((t) => t[0]).join(', '));

    // версия
    let version = flags.version ? String(flags.version) : null;
    let versions = [];
    try { versions = (await apiCall('GET', '/api/versions/' + type)).versions || []; }
    catch (e) { if (!version) die('Не удалось получить список версий: ' + e.message); }
    if (!version) {
      const top = versions.slice(0, 10);
      out('');
      out('  Доступные версии (последние): ' + (top.join(', ') || '—'));
      const raw = await askLine('  Версия [' + (versions[0] || 'latest') + ']: ', versions[0] || 'latest');
      if (raw == null) abortNoInput();
      version = String(raw).trim();
    }
    if (versions.length && versions.indexOf(version) < 0) {
      out('  ⚠ Версии «' + version + '» нет в списке — пробую всё равно.');
    }

    // порт
    let port = flags.port ? parseInt(flags.port, 10) : null;
    if (!port) {
      let def = 25565;
      while (existing.some((s) => s.port === def)) def++;
      const raw = await askLine('  Порт [' + def + ']: ', String(def));
      if (raw == null) abortNoInput();
      port = parseInt(String(raw).trim(), 10);
    }
    if (!(port >= 1024 && port <= 65535)) die('Порт: число от 1024 до 65535.');
    if (existing.some((s) => s.port === port)) die('Порт ' + port + ' уже занят сервером «' + existing.find((s) => s.port === port).name + '».');

    // память
    let memoryMb = flags.memory ? parseInt(flags.memory, 10) : (flags.memoryMb ? parseInt(flags.memoryMb, 10) : null);
    if (!memoryMb) {
      const raw = await askLine('  Память, МБ [2048]: ', '2048');
      if (raw == null) abortNoInput();
      memoryMb = parseInt(String(raw).trim(), 10) || 2048;
    }

    // EULA (прокси-ядра её не требуют)
    const isProxy = type === 'velocity' || type === 'bungeecord';
    let eula = !!(flags.yes || flags.eula || flags.y);
    if (!isProxy && !eula) {
      out('');
      out('  Minecraft EULA: https://aka.ms/MinecraftEULA');
      eula = await askYesNo('  Принимаете лицензионное соглашение Minecraft?', false);
      if (!eula) die('Без принятия EULA сервер создать нельзя.');
    }

    out('');
    out('Создаю: «' + name + '» · ' + type + ' ' + version + ' · порт ' + port + ' · ' + memoryMb + ' МБ');
    let created;
    try {
      created = await apiCall('POST', '/api/servers', {
        name: name, type: type, version: version, port: port, memoryMb: memoryMb, eulaAccepted: !isProxy ? true : undefined,
      });
    } catch (e) { die('Не удалось создать: ' + e.message); }
    out('  ✓ Сервер создан (ID ' + created.id + ').');

    if (flags['no-wait']) { out('Скачивание ядра идёт фоном: controlgui server list'); return; }
    const r = await waitDownload(created.id);
    if (!r.ok) { out('  ✗ ' + r.error); out('Повторить скачивание: controlgui server redownload ' + created.id); return; }
    out('  ✓ Ядро скачано, сервер готов.');
    out('');
    out('Дальше:');
    out('  controlgui server start ' + created.id + '     # запустить');
    out('  controlgui tui                       # консоль сервера в терминале');
    return;
  }

  if (sub === 'redownload') {
    await ensurePanel();
    const s = findServer(await serverList(), rest[1]);
    if (!s) die('Сервер не найден: ' + (rest[1] || '—'));
    await apiCall('POST', '/api/servers/' + s.id + '/download');
    const r = await waitDownload(s.id);
    return out(r.ok ? '  ✓ Ядро скачано.' : '  ✗ ' + r.error);
  }

  if (sub === 'start' || sub === 'stop' || sub === 'restart' || sub === 'kill') {
    await ensurePanel();
    const s = findServer(await serverList(), rest[1]);
    if (!s) die('Сервер не найден: ' + (rest[1] || '—') + '. Список: controlgui server list');
    await apiCall('POST', '/api/servers/' + s.id + '/' + sub);
    const verb = { start: 'запускается', stop: 'останавливается', restart: 'перезапускается', kill: 'убит' }[sub];
    out('Сервер «' + s.name + '» ' + verb + '. Консоль: controlgui tui');
    return;
  }

  if (sub === 'cmd' || sub === 'command' || sub === 'say') {
    await ensurePanel();
    const s = findServer(await serverList(), rest[1]);
    if (!s) die('Сервер не найден: ' + (rest[1] || '—'));
    const command = rest.slice(2).join(' ');
    if (!command) die('Что отправить? Пример: controlgui server cmd ' + s.id + ' "say привет"');
    await apiCall('POST', '/api/servers/' + s.id + '/command', { command: command });
    out('Отправлено серверу «' + s.name + '»: ' + command);
    return;
  }

  if (sub === 'rm' || sub === 'remove' || sub === 'delete') {
    await ensurePanel();
    const s = findServer(await serverList(), rest[1]);
    if (!s) die('Сервер не найден: ' + (rest[1] || '—'));
    if (!(flags.yes || flags.y)) {
      out('Удаление СНОСИТ папку сервера вместе с миром — восстановить будет нечем.');
      const okDel = await askYesNo('Удалить сервер «' + s.name + '» (' + s.id + ')?', false);
      if (!okDel) return out('Отменено.');
    }
    await apiCall('DELETE', '/api/servers/' + s.id);
    out('Сервер «' + s.name + '» удалён.');
    return;
  }

  if (sub === 'info' || sub === 'show') {
    await ensurePanel();
    const s = findServer(await serverList(), rest[1]);
    if (!s) die('Сервер не найден: ' + (rest[1] || '—'));
    const full = await apiCall('GET', '/api/servers/' + s.id);
    out('Имя:       ' + full.name);
    out('ID:        ' + full.id);
    out('Ядро:      ' + full.type + ' ' + (full.version || '—'));
    out('Порт:      ' + full.port);
    out('Память:    ' + (full.memoryMb || '—') + ' МБ');
    out('Состояние: ' + fmtStatus(full.status));
    return;
  }

  die('Доступно: server list | create | info <id> | start|stop|restart|kill <id> | cmd <id> "<команда>" | redownload <id> | rm <id>');
}

// ---------- systemd ----------
function cmdService(args) {
  if (process.platform !== 'linux') die('systemd-сервис доступен только на Linux.');
  const sub = args[0] || 'install';
  const unitPath = '/etc/systemd/system/controlgui.service';
  const run = (cmd, a) => {
    const r = require('child_process').spawnSync(cmd, a, { stdio: 'inherit' });
    if (r.status !== 0) die('Команда не удалась: ' + cmd + ' ' + a.join(' '));
  };
  if (sub === 'install') {
    if (process.getuid && process.getuid() !== 0) die('Нужен root: sudo controlgui service install');
    // сервис от имени вызвавшего пользователя (sudo) — его данные, его серверы.
    // Домашний каталог берём из системной БД, а не угадываем «/home/<user>».
    const user = process.env.SUDO_USER || 'root';
    let home = user === 'root' ? '/root' : '/home/' + user;
    try {
      const ent = require('child_process').execFileSync('getent', ['passwd', user], { encoding: 'utf8' }).trim();
      const f = ent.split(':');
      if (f[5]) home = f[5];
    } catch (e) { /* нет getent — оставляем догадку */ }
    // Каталог данных сервиса ОБЯЗАН совпадать с тем, что видит панель при обычном
    // запуске, иначе `controlgui remote setup` пишет в одно место, а сервис читает
    // другое (и серверы «пропадают»). Приоритет: явный CONTROLGUI_DATA → уже
    // существующие данные в старом месте (~/.local/share/controlgui — так ставит
    // .deb-лаунчер, не ломаем его) → тот же корень, что у lib/paths.js.
    const legacyDir = path.join(home, '.local', 'share', 'controlgui');
    const legacyUsed = (() => {
      try { return fs.existsSync(path.join(legacyDir, 'data', 'servers.json')); } catch (e) { return false; }
    })();
    let dataDir = process.env.CONTROLGUI_DATA || (legacyUsed ? legacyDir : require('./lib/paths').DATA_ROOT);
    // Относительный CONTROLGUI_DATA обычный CLI разрешает от текущего каталога.
    // В unit сохраняем уже тот же абсолютный путь, иначе systemd разрешил бы его от ROOT.
    dataDir = path.resolve(dataDir);
    // Старые системные лаунчеры вычисляли путь ещё под sudo и передавали /root.
    // Такой каталог недоступен сервису, который ниже запускается от SUDO_USER.
    if (user !== 'root' && path.resolve(dataDir).startsWith(path.resolve('/root') + path.sep)) dataDir = legacyDir;
    // systemd поддерживает двойные кавычки в ExecStart/Environment — экранируем пути с пробелами
    const q = (s) => '"' + String(s).replace(/"/g, '\\"') + '"';
    const unit = [
      '[Unit]',
      'Description=CONTROLGUI — Minecraft server panel',
      'After=network.target',
      '',
      '[Service]',
      'ExecStart=' + q(process.execPath) + ' ' + q(path.join(ROOT, 'server.js')),
      // БЕЗ кавычек: WorkingDirectory= (в отличие от ExecStart=) кавычки НЕ разбирает —
      // они попадают внутрь пути, и systemd отвергает юнит: «path is not absolute».
      // Значение берётся до конца строки целиком, поэтому пробелы в пути безопасны.
      'WorkingDirectory=' + ROOT,
      'Environment=PORT=' + PORT,
      'Environment=' + q('CONTROLGUI_DATA=' + dataDir),
      'User=' + user,
      'Restart=always',
      'RestartSec=3',
      '',
      '[Install]',
      'WantedBy=multi-user.target',
      '',
    ].join('\n');
    fs.writeFileSync(unitPath, unit);
    run('systemctl', ['daemon-reload']);
    run('systemctl', ['enable', '--now', 'controlgui']);
    out('Сервис controlgui установлен и запущен (пользователь ' + user + ', данные: ' + dataDir + ').');
    out('Логи:  journalctl -u controlgui -f');
    out('Дальше: controlgui remote user add <ник> && controlgui remote enable — и подключайтесь с другого ПК.');
    return;
  }
  if (sub === 'uninstall') {
    if (process.getuid && process.getuid() !== 0) die('Нужен root: sudo controlgui service uninstall');
    run('systemctl', ['disable', '--now', 'controlgui']);
    try { fs.rmSync(unitPath, { force: true }); } catch (e) { /* */ }
    run('systemctl', ['daemon-reload']);
    out('Сервис удалён (данные и серверы не тронуты).');
    return;
  }
  die('Доступно: service install | service uninstall');
}

// ---------- клиент-режим GUI ----------
function cmdConnect(args) {
  const target = args[0];
  if (!target) {
    try { out('Сейчас: ' + fs.readFileSync(REMOTE_URL_FILE, 'utf8').trim()); }
    catch (e) { out('Клиент-режим не настроен (GUI открывает локальную панель).'); }
    out('Использование: controlgui connect https://ip:8433  |  controlgui connect --local');
    return;
  }
  if (target === '--local' || target === 'local') {
    try { fs.rmSync(REMOTE_URL_FILE, { force: true }); } catch (e) { /* */ }
    out('Клиент-режим выключен — GUI снова открывает локальную панель.');
    return;
  }
  if (!/^https?:\/\/[^\s/]+/.test(target)) die('Ожидается адрес вида https://ip:8433');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(REMOTE_URL_FILE, target.trim() + '\n');
  out('GUI-приложение теперь подключается к: ' + target);
  out('Вернуть локальную панель: controlgui connect --local');
}

// ---------- справка ----------
function help() {
  banner();
  out('  controlgui serve                 запустить панель в этом терминале');
  out('  controlgui start | stop | status панель фоном / остановить / состояние');
  out('');
  out('  Серверы Minecraft прямо из терминала (без веб-панели):');
  out('  controlgui server create         создать сервер — мастер по шагам ★');
  out('  controlgui server list           список серверов и их состояние');
  out('  controlgui server start|stop <id> запустить / остановить сервер');
  out('  controlgui server restart|kill <id> перезапустить / убить процесс');
  out('  controlgui server cmd <id> "..."  отправить команду в консоль сервера');
  out('  controlgui server info|rm <id>    подробности / удалить сервер');
  out('');
  out('  controlgui remote setup          мастер удалённого доступа (по шагам) ★');
  out('  controlgui remote show           состояние удалённого доступа');
  out('  controlgui remote user add <ник> добавить пользователя (спросит пароль)');
  out('  controlgui remote user list|rm   список / удалить пользователя');
  out('  controlgui remote enable|disable включить/выключить HTTPS-доступ');
  out('  controlgui remote port <порт>    сменить HTTPS-порт (по умолчанию 8433)');
  out('  controlgui remote cert-reset     перевыпустить самоподписанный сертификат');
  out('  sudo controlgui service install  systemd-сервис с автозапуском (Linux)');
  out('  controlgui tui [url]             текстовый интерфейс в терминале');
  out('  controlgui connect <url>|--local GUI-приложение ходит на удалённую панель');
  out('');
  out('Установка на Linux-сервер:  git clone … && cd CONTROLGUI && ./install.sh');
}

(async () => {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') return help();
    if (cmd === 'serve') return cmdServe();
    if (cmd === 'start') return cmdStart();
    if (cmd === 'stop') return cmdStop();
    if (cmd === 'status') return cmdStatus();
    if (cmd === 'server' || cmd === 'servers') return await cmdServer(rest);
    if (cmd === 'remote') return await cmdRemote(rest);
    if (cmd === 'service') return cmdService(rest);
    if (cmd === 'connect') return cmdConnect(rest);
    if (cmd === 'tui') { process.argv = [process.argv[0], path.join(ROOT, 'tui.js'), ...rest]; return require(path.join(ROOT, 'tui.js')); }
    die('Неизвестная команда «' + cmd + '». controlgui help — список команд.');
  } catch (e) {
    die('Ошибка: ' + (e && e.message || e));
  }
})();
