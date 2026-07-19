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
function askHidden(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    if (!stdin.isTTY) { // пайп/скрипт — читаем строку как есть
      let d = '';
      stdin.on('data', (c) => { d += c; });
      stdin.on('end', () => resolve(d.trim()));
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
  if (panelPid()) return out('Панель уже запущена (PID ' + panelPid() + ').');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const log = fs.openSync(path.join(DATA_DIR, 'panel.log'), 'a');
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    detached: true, stdio: ['ignore', log, log],
    env: Object.assign({}, process.env),
    windowsHide: true,
  });
  fs.writeFileSync(PID_FILE, String(child.pid));
  child.unref();
  out('Панель запущена фоном (PID ' + child.pid + '). Локально: http://localhost:' + PORT);
  out('Лог: ' + path.join(DATA_DIR, 'panel.log'));
}
function cmdStop() {
  const pid = panelPid();
  if (!pid) return out('Панель не запущена (pid-файла нет или процесс мёртв).');
  try { process.kill(pid, 'SIGTERM'); } catch (e) { return die('Не удалось остановить: ' + e.message); }
  try { fs.rmSync(PID_FILE, { force: true }); } catch (e) { /* */ }
  out('Панели отправлен сигнал остановки (PID ' + pid + '). Запущенные Minecraft-серверы будут остановлены штатно.');
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
      + (s.hasPassword ? '' : ' · пароль не задан'));
    if (s.enabled && s.lanIps.length) out('  В сети: https://' + s.lanIps[0] + ':' + s.port);
    if (s.fingerprint) out('  Отпечаток серта (SHA-256): ' + s.fingerprint);
    process.exit(0);
  });
}

// ---------- удалённый доступ ----------
async function cmdRemote(args) {
  const ra = require('./lib/remoteaccess');
  const sub = args[0] || 'show';
  if (sub === 'show') {
    const s = ra.status();
    out('включён: ' + (s.enabled ? 'да' : 'нет') + ' · порт: ' + s.port + ' · пароль задан: ' + (s.hasPassword ? 'да' : 'нет'));
    if (s.fingerprint) out('отпечаток серта: ' + s.fingerprint);
    if (s.lanIps.length) out('адреса в сети: ' + s.lanIps.map((ip) => 'https://' + ip + ':' + s.port).join('  '));
    out('Панель подхватывает изменения на лету (перезапуск не нужен).');
    return;
  }
  if (sub === 'password') {
    let pw = args[1];
    if (!pw) {
      pw = await askHidden('Новый пароль удалённого доступа (мин. 6): ');
      const pw2 = await askHidden('Повторите пароль: ');
      if (pw !== pw2) die('Пароли не совпадают.');
    }
    const r = ra.setPassword(pw);
    if (r.error) die(r.error);
    out('Пароль сохранён. Старые удалённые сессии сброшены.');
    return;
  }
  if (sub === 'port') {
    const r = ra.setPort(args[1]);
    if (r.error) die(r.error);
    out('Порт удалённого доступа: ' + r.port + '. Пробросьте его на роутере.');
    return;
  }
  if (sub === 'enable') {
    const r = ra.enable();
    if (r.error) die(r.error + ' (controlgui remote password)');
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
  die('Неизвестная подкоманда remote. Доступно: show, enable, disable, password [пароль], port <порт>, cert-reset');
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
    // сервис от имени вызвавшего пользователя (sudo) — его данные, его серверы
    const user = process.env.SUDO_USER || 'root';
    const home = user === 'root' ? '/root' : ('/home/' + user);
    const dataDir = process.env.CONTROLGUI_DATA || path.join(home, '.local', 'share', 'controlgui');
    const unit = [
      '[Unit]',
      'Description=CONTROLGUI — Minecraft server panel',
      'After=network.target',
      '',
      '[Service]',
      'ExecStart=' + process.execPath + ' ' + path.join(ROOT, 'server.js'),
      'WorkingDirectory=' + ROOT,
      'Environment=PORT=' + PORT,
      'Environment=CONTROLGUI_DATA=' + dataDir,
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
    out('Дальше: controlgui remote password && controlgui remote enable — и подключайтесь с другого ПК.');
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
  out('  controlgui remote password       задать пароль удалённого доступа');
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
