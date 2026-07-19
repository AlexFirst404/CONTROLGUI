#!/usr/bin/env node
'use strict';
/* CLI панели CONTROLGUI: запуск/демон/статус, управление удалённым доступом,
   TUI и клиент-режим GUI. Без зависимостей. Работает на Windows/Linux/macOS,
   на Linux-сервере — без GUI-пакетов.

   controlgui serve                 панель в текущем терминале (Ctrl+C — стоп)
   controlgui start|stop|status     панель фоном (pid-файл в данных)
   controlgui remote ...            удалённый доступ (show/enable/disable/password/port)
   controlgui service install       systemd-сервис (Linux, от root)
   controlgui tui [url]             текстовый интерфейс (локально или по https)
   controlgui connect <url>|--local клиент-режим GUI-обёрток */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = __dirname;
const { DATA_DIR } = require('./lib/paths');
const PID_FILE = path.join(DATA_DIR, 'panel.pid');
const REMOTE_URL_FILE = path.join(DATA_DIR, 'remote-connect');
const PORT = parseInt(process.env.PORT, 10) || 8400;

function out(s) { process.stdout.write(s + '\n'); }
function die(s) { process.stderr.write(s + '\n'); process.exit(1); }

// ---------- пароль без эха ----------
let stdinBuf = '';        // остаток буфера stdin между чтениями строк (не-TTY)
let stdinEnded = false;
function readLineNonTty() {
  return new Promise((resolve) => {
    const take = () => {
      const nl = stdinBuf.indexOf('\n');
      if (nl !== -1) { const line = stdinBuf.slice(0, nl); stdinBuf = stdinBuf.slice(nl + 1); return resolve(line.replace(/\r$/, '')); }
      if (stdinEnded) { const line = stdinBuf; stdinBuf = ''; return resolve(line.replace(/\r$/, '')); }
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
      readLineNonTty().then((s) => { try { stdin.pause(); } catch (e) { /* */ } resolve(s.trim()); });
      return;
    }
    stdin.setRawMode(true);
    stdin.resume();
    let pw = '';
    const onData = (ch) => {
      const c = String(ch);
      const code = c.charCodeAt(0);
      if (c === '\r' || c === '\n') {
        stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(pw);
      } else if (code === 3) { // Ctrl+C
        stdin.setRawMode(false); process.stdout.write('\n'); process.exit(130);
      } else if (code === 8 || code === 127) { // backspace / delete
        if (pw.length) { pw = pw.slice(0, -1); process.stdout.write('\b \b'); }
      } else if (code >= 32) {
        pw += c;
        process.stdout.write('*');
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
// штатная остановка: просим панель завершиться по HTTP (и остановить MC-серверы) —
// работает одинаково на всех ОС; kill по PID оставлен как фолбэк.
function cmdStop() {
  const http = require('http');
  const r = http.request({ host: '127.0.0.1', port: PORT, path: '/api/quit', method: 'POST',
    headers: { 'x-cg-local': '1', 'x-cg-stop-servers': '1' }, timeout: 4000 }, (res) => {
    res.resume();
    if (res.statusCode === 200) {
      try { fs.rmSync(PID_FILE, { force: true }); } catch (e) { /* */ }
      out('Панель штатно завершается (запущенные Minecraft-серверы останавливаются, миры сохраняются).');
    } else { out('Панель ответила HTTP ' + res.statusCode + '.'); killFallback(); }
  });
  r.on('error', () => killFallback());
  r.on('timeout', () => { r.destroy(); killFallback(); });
  r.end();
}
function killFallback() {
  const pid = panelPid();
  if (!pid) return out('Панель не запущена (не отвечает и pid-файла нет).');
  try { process.kill(pid, 'SIGTERM'); } catch (e) { return die('Не удалось остановить PID ' + pid + ': ' + e.message); }
  try { fs.rmSync(PID_FILE, { force: true }); } catch (e) { /* */ }
  out('Панель не ответила по HTTP — отправлен сигнал остановки процессу PID ' + pid + '.');
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
  die('Неизвестная подкоманда remote. Доступно: show, user (list/add/rm), enable, disable, port <порт>, cert-reset');
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
      const f = ent.split(':'); if (f[5]) home = f[5];
    } catch (e) { /* нет getent — оставляем догадку */ }
    const dataDir = process.env.CONTROLGUI_DATA || path.join(home, '.local', 'share', 'controlgui');
    // systemd поддерживает двойные кавычки в ExecStart/Environment — экранируем пути с пробелами
    const q = (s) => '"' + String(s).replace(/"/g, '\\"') + '"';
    const unit = [
      '[Unit]',
      'Description=CONTROLGUI — Minecraft server panel',
      'After=network.target',
      '',
      '[Service]',
      'ExecStart=' + q(process.execPath) + ' ' + q(path.join(ROOT, 'server.js')),
      'WorkingDirectory=' + q(ROOT),
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
  out('CONTROLGUI — панель Minecraft-серверов (https://github.com/AlexFirst404/CONTROLGUI)');
  out('');
  out('  controlgui serve                 запустить панель в этом терминале');
  out('  controlgui start | stop | status панель фоном / остановить / состояние');
  out('  controlgui remote show           состояние удалённого доступа');
  out('  controlgui remote user add <ник> добавить пользователя (спросит пароль)');
  out('  controlgui remote user list|rm   список / удалить пользователя');
  out('  controlgui remote enable|disable включить/выключить HTTPS-доступ');
  out('  controlgui remote port <порт>    сменить HTTPS-порт (по умолчанию 8433)');
  out('  controlgui remote cert-reset     перевыпустить самоподписанный сертификат');
  out('  sudo controlgui service install  systemd-сервис с автозапуском (Linux)');
  out('  controlgui tui [url]             текстовый интерфейс в терминале');
  out('  controlgui connect <url>|--local GUI-приложение ходит на удалённую панель');
}

(async () => {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') return help();
    if (cmd === 'serve') return cmdServe();
    if (cmd === 'start') return cmdStart();
    if (cmd === 'stop') return cmdStop();
    if (cmd === 'status') return cmdStatus();
    if (cmd === 'remote') return await cmdRemote(rest);
    if (cmd === 'service') return cmdService(rest);
    if (cmd === 'connect') return cmdConnect(rest);
    if (cmd === 'tui') { process.argv = [process.argv[0], path.join(ROOT, 'tui.js'), ...rest]; return require(path.join(ROOT, 'tui.js')); }
    die('Неизвестная команда «' + cmd + '». controlgui help — список команд.');
  } catch (e) {
    die('Ошибка: ' + (e && e.message || e));
  }
})();
