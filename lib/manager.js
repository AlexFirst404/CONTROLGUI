'use strict';
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { serverDir } = require('./paths');
const store = require('./store');
const javas = require('./javas');

const IS_WIN = process.platform === 'win32';
const MAX_CONSOLE_LINES = 1000;
const STATS_INTERVAL = 3000;
const STATS_POINTS = 60;

// Рантайм-состояние серверов. Не персистится: после рестарта панели всё в "stopped".
const states = new Map();

function getState(id) {
  let s = states.get(id);
  if (!s) {
    s = {
      proc: null,
      status: 'stopped', // stopped | starting | running | stopping | error
      console: [],
      clients: new Set(),
      players: new Set(),       // имена онлайн-игроков
      playersInfo: new Map(),   // имя -> подробности (uuid, ip, времена, достижения)
      download: null, // { phase: resolving|downloading|installing|done|error, progress, doneBytes, totalBytes, error }
      startedAt: null,
      stopTimer: null,
      onExit: null,
      orphanPid: null, // java-процесс, переживший перезапуск панели
      entityQuery: null, // активный запрос `data get entity` (реалтайм-инвентарь)
      historyMap: null,  // кэш panel-players.json (первый вход, IP)
      stats: [],       // [{t, cpu, ramMb, readBps, writeBps, players}]
      statsTimer: null,
      statsPrev: null,
      statsPid: null,
      statsMisses: 0,
    };
    states.set(id, s);
  }
  return s;
}

function dropState(id) {
  const s = states.get(id);
  if (s) {
    if (s.statsTimer) clearInterval(s.statsTimer);
    for (const res of s.clients) {
      try { res.end(); } catch (e) { /* клиент уже отвалился */ }
    }
  }
  states.delete(id);
}

/* Paper/Purpur пишут в консоль ANSI-коды цвета (\x1b[38;...m) — без очистки
   они попадают в имена игроков из лога и ломают парсинг. */
function stripAnsi(text) {
  return String(text)
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/§[0-9a-fk-orx]/gi, '');
}

function pushLine(id, line) {
  const s = getState(id);
  s.console.push(line);
  if (s.console.length > MAX_CONSOLE_LINES) s.console.splice(0, s.console.length - MAX_CONSOLE_LINES);
  const payload = 'data: ' + JSON.stringify(line) + '\n\n';
  for (const res of s.clients) {
    try { res.write(payload); } catch (e) { s.clients.delete(res); }
  }
}

// ---- игроки ----

function ensurePlayer(s, name) {
  let p = s.playersInfo.get(name);
  if (!p) {
    p = {
      name,
      uuid: null,
      ip: null,
      online: false,
      joinedAt: null,
      lastSeen: null,
      loginPos: null,
      advancements: 0,
      lastAdvancement: null,
    };
    s.playersInfo.set(name, p);
  }
  return p;
}

function parseGameLine(id, line) {
  const s = getState(id);
  if (s.status === 'starting' && /Done \([\d.,]+s\)!/.test(line)) {
    s.status = 'running';
    pushLine(id, '[ПАНЕЛЬ] Сервер запущен и готов принимать игроков.');
    // порт уже привязан — навешиваем лимит CPU на реальную JVM
    reapplyCpuLimit(id);
  }

  // версия сервера из стартового лога (для кастомных ядер без version.json)
  const mv = line.match(/Starting minecraft server version (\S+)/i);
  if (mv) {
    const srv = store.get(id);
    if (srv && (!srv.version || srv.version === '-')) store.update(id, { version: mv[1] });
  }

  let m = line.match(/UUID of player (\S+) is ([0-9a-fA-F-]{32,36})/);
  if (m) ensurePlayer(s, m[1]).uuid = m[2];

  m = line.match(/\]:\s*(\S+)\[\/([^\]]+)\] logged in with entity id \d+ at \(([^)]*)\)/);
  if (m) {
    const p = ensurePlayer(s, m[1]);
    const addr = m[2];
    const portSep = addr.lastIndexOf(':');
    p.ip = portSep > 0 ? addr.slice(0, portSep) : addr;
    p.loginPos = m[3].replace(/\s+/g, ' ').trim();
  }

  m = line.match(/\]:\s+(\S+) joined the game/);
  if (m) {
    const p = ensurePlayer(s, m[1]);
    p.online = true;
    p.joinedAt = Date.now();
    s.players.add(m[1]);
    recordJoin(id, p);
  }

  m = line.match(/\]:\s+(\S+) left the game/);
  if (m) {
    const p = ensurePlayer(s, m[1]);
    p.online = false;
    p.lastSeen = Date.now();
    s.players.delete(m[1]);
  }

  m = line.match(/\]:\s+(\S+) has (?:made the advancement|reached the goal|completed the challenge) \[(.+)\]/);
  if (m) {
    const p = ensurePlayer(s, m[1]);
    p.advancements++;
    p.lastAdvancement = m[2];
  }
}

function playersView(id) {
  const s = getState(id);
  return Array.from(s.playersInfo.values())
    .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
}

// ---- персистентная история игроков (первый вход, последний вход, IP) ----

function historyFile(id) {
  return path.join(serverDir(id), 'panel-players.json');
}

function getHistoryMap(id) {
  const s = getState(id);
  if (!s.historyMap) {
    try { s.historyMap = JSON.parse(fs.readFileSync(historyFile(id), 'utf8')) || {}; }
    catch (e) { s.historyMap = {}; }
  }
  return s.historyMap;
}

function recordJoin(id, p) {
  const map = getHistoryMap(id);
  const key = p.name.toLowerCase();
  const entry = map[key] || (map[key] = { name: p.name, uuid: null, firstJoinAt: null, lastJoinAt: null, ips: [] });
  if (p.uuid && !entry.uuid) entry.uuid = p.uuid;
  entry.lastJoinAt = Date.now();
  if (!entry.firstJoinAt) entry.firstJoinAt = entry.lastJoinAt;
  if (p.ip) entry.ips = [p.ip].concat((entry.ips || []).filter((x) => x !== p.ip)).slice(0, 10);
  fs.writeFile(historyFile(id), JSON.stringify(map, null, 1), () => {});
}

function getHistory(id, name) {
  return getHistoryMap(id)[String(name).toLowerCase()] || null;
}

function historyView(id) {
  return Object.values(getHistoryMap(id));
}

function removeHistory(id, name) {
  const map = getHistoryMap(id);
  delete map[String(name).toLowerCase()];
  fs.writeFile(historyFile(id), JSON.stringify(map, null, 1), () => {});
}

/* Стереть игрока из рантайма (список, инфо) — для «удалить игрока» */
function forgetPlayer(id, name) {
  const s = getState(id);
  const norm = stripAnsi(String(name)).toLowerCase();
  for (const key of Array.from(s.playersInfo.keys())) {
    if (stripAnsi(key).toLowerCase() === norm) s.playersInfo.delete(key);
  }
  for (const key of Array.from(s.players)) {
    if (stripAnsi(key).toLowerCase() === norm) s.players.delete(key);
  }
}

// ---- реалтайм-данные игрока: `data get entity <ник>` без шума в консоли ----

function queryEntityData(id, name) {
  const s = getState(id);
  // entityUnsupported — ядро (Folia и т.п.) не поддерживает data get entity
  if (!s.proc || s.entityQuery || s.entityUnsupported) return Promise.resolve(null);
  return new Promise((resolve) => {
    const query = {
      name: String(name).toLowerCase(),
      resolve,
      timer: setTimeout(() => {
        if (s.entityQuery === query) s.entityQuery = null;
        resolve(null);
      }, 4000),
    };
    s.entityQuery = query;
    try {
      s.proc.stdin.write('data get entity ' + name + '\n');
    } catch (e) {
      clearTimeout(query.timer);
      s.entityQuery = null;
      resolve(null);
    }
  });
}

/* true — строка была ответом на служебный запрос и в консоль не идёт */
function interceptEntityData(s, line) {
  // гасим вторую строку ошибки («data get entity ...<--[HERE]») после первой
  if (s.eatHereLine && /<--\[HERE\]/.test(line)) { s.eatHereLine = false; return true; }
  const query = s.entityQuery;
  if (!query) return false;
  let m = line.match(/\]:\s*(\S+) has the following entity data: (.*)$/);
  if (m && m[1].toLowerCase() === query.name) {
    s.entityQuery = null;
    clearTimeout(query.timer);
    query.resolve(m[2]);
    return true;
  }
  if (/\]:\s*No entity was found$/.test(line)) {
    s.entityQuery = null;
    clearTimeout(query.timer);
    query.resolve(null);
    return true;
  }
  // ядро не понимает `data get entity` (например, Folia) — помечаем и больше не спрашиваем
  if (/Unknown or incomplete command/i.test(line)) {
    s.entityQuery = null;
    clearTimeout(query.timer);
    s.entityUnsupported = true;
    s.eatHereLine = true; // следующая строка с <--[HERE] — продолжение этой ошибки
    query.resolve(null);
    return true;
  }
  return false;
}

function markAllOffline(s) {
  const now = Date.now();
  for (const p of s.playersInfo.values()) {
    if (p.online) { p.online = false; p.lastSeen = now; }
  }
  s.players.clear();
}

// ---- осиротевшие процессы (панель перезапустили, java остался жить) ----

function isPidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

function pidIsJava(pid) {
  if (!IS_WIN) {
    try {
      const comm = fs.readFileSync('/proc/' + pid + '/comm', 'utf8');
      if (/java/i.test(comm)) return true;
      return /java/i.test(fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8'));
    } catch (e) { return false; }
  }
  try {
    const out = spawnSync('tasklist', ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'],
      { encoding: 'utf8', windowsHide: true }).stdout || '';
    return /"java(w)?(\.exe)?"/i.test(out);
  } catch (e) { return false; }
}

function listeningPorts() {
  const map = new Map(); // порт -> pid
  try {
    if (!IS_WIN) {
      // Linux: ss из iproute2; формат «LISTEN 0 50 *:25565 *:* users:(("java",pid=123,...))»
      const out = spawnSync('ss', ['-Htlnp'], { encoding: 'utf8' }).stdout || '';
      for (const line of out.split('\n')) {
        const pm = line.match(/:(\d+)\s/);
        const um = line.match(/pid=(\d+)/);
        if (pm && um && !map.has(+pm[1])) map.set(+pm[1], +um[1]);
      }
      return map;
    }
    const out = spawnSync('netstat', ['-ano', '-p', 'TCP'],
      { encoding: 'utf8', windowsHide: true }).stdout || '';
    for (const line of out.split('\n')) {
      const m = line.match(/TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/);
      if (m && !map.has(+m[1])) map.set(+m[1], +m[2]);
    }
  } catch (e) { /* нет ss/netstat — пропускаем */ }
  return map;
}

function adoptOrphans() {
  const ports = listeningPorts();
  for (const server of store.all()) {
    const s = getState(server.id);
    let pid = null;
    if (server.pid && isPidAlive(server.pid) && pidIsJava(server.pid)) {
      pid = server.pid;
    } else {
      const byPort = ports.get(Number(server.port));
      if (byPort && byPort !== process.pid && pidIsJava(byPort)) pid = byPort;
    }
    if (pid) {
      s.orphanPid = pid;
      store.update(server.id, { pid });
      pushLine(server.id, '[ПАНЕЛЬ] Найден процесс этого сервера (PID ' + pid + '), запущенный до перезапуска панели. ' +
        'Консоль недоступна — сервер можно только принудительно завершить («Убить процесс»).');
      console.log('[CONTROLGUI] Сервер "' + server.name + '" работает вне панели (PID ' + pid + ')');
    } else if (server.pid) {
      store.update(server.id, { pid: null });
    }
  }
}

function orphanAlive(id) {
  const s = getState(id);
  if (!s.orphanPid) return false;
  if (isPidAlive(s.orphanPid)) return true;
  s.orphanPid = null;
  store.update(id, { pid: null });
  return false;
}

// ---- запуск ----

function launchSpec(server) {
  return server.launch || { mode: 'jar', target: server.jarFile || 'server.jar' };
}

function isLaunchReady(server) {
  const spec = launchSpec(server);
  if (server.type === 'forge' && !server.launch) return false; // ещё не установлен
  try { return fs.existsSync(path.join(serverDir(server.id), spec.target)); }
  catch (e) { return false; }
}

function jarPath(server) {
  return path.join(serverDir(server.id), server.jarFile || 'server.jar');
}

function buildJavaArgs(server) {
  const memoryMb = Math.max(512, parseInt(server.memoryMb, 10) || 2048);
  const spec = launchSpec(server);
  const base = ['-Xms512M', '-Xmx' + memoryMb + 'M'];
  if (spec.mode === 'args') return base.concat(['@' + spec.target, 'nogui']);
  // прокси (Bungee/Velocity) не понимают nogui — только обычный jar-запуск
  const tail = server.proxy ? [] : ['nogui'];
  return base.concat(['-jar', spec.target].concat(tail));
}

/* Подбор java под версию сервера. Приоритет: путь из настроек → нужный мажор
   под версию (≤1.16.5 и старый Forge — Java 8) → java из PATH.
   Возвращает { bin, label, error }. */
function pickJava(server) {
  if (server.javaPath && fs.existsSync(server.javaPath)) {
    return { bin: server.javaPath, label: 'Java из настроек сервера' };
  }
  const major = javas.requiredJavaMajor(server.version);
  if (major) {
    const found = javas.findJava(major);
    if (found) return { bin: found, label: 'Java ' + major + ' под версию ' + server.version };
    if (major === 8) {
      return { bin: null, error: 'Этой версии (' + server.version + ', напр. старый Forge) нужна Java 8, но она не найдена. ' +
        'Установите Java 8 (adoptium.net) или укажите путь к java.exe в настройках сервера.' };
    }
    return { bin: 'java', label: 'java из PATH (Java ' + major + ' не найдена)' };
  }
  return { bin: 'java', label: 'java из PATH' };
}

function start(server) {
  const s = getState(server.id);
  if (s.proc) { const err = new Error('Сервер уже запущен'); err.status = 409; throw err; }
  if (orphanAlive(server.id)) {
    const err = new Error('Этот сервер уже работает (PID ' + s.orphanPid + ', запущен до перезапуска панели). Сначала нажмите «Убить процесс».');
    err.status = 409; throw err;
  }
  if (s.download && s.download.phase !== 'done' && s.download.phase !== 'error') {
    const err = new Error('Файлы сервера ещё устанавливаются'); err.status = 409; throw err;
  }
  if (!isLaunchReady(server)) {
    const err = new Error('Файлы сервера не найдены. Скачайте/установите ядро заново.'); err.status = 409; throw err;
  }

  const dir = serverDir(server.id);
  const args = buildJavaArgs(server);

  const picked = pickJava(server);
  if (picked.error) { const e = new Error(picked.error); e.status = 409; throw e; }

  s.status = 'starting';
  s.startedAt = Date.now();
  s.javaHintShown = false;
  s.intentionalStop = false;
  s.entityUnsupported = false;
  s.eatHereLine = false;
  markAllOffline(s);
  pushLine(server.id, '[ПАНЕЛЬ] Запуск (' + picked.label + '): "' + picked.bin + '" ' + args.join(' '));

  const proc = spawn(picked.bin, args, { cwd: dir, windowsHide: true });
  s.proc = proc;
  store.update(server.id, { pid: proc.pid || null });
  beginStats(server, proc.pid);
  // лимит CPU (affinity): сразу на лаунчер (часть дочерних JVM унаследует),
  // основной повтор — по детекту «Done» в parseGameLine, плюс запасной таймер
  applyCpuLimit(proc.pid, server.cpuPercent);
  if (cpuMaskFor(server.cpuPercent)) {
    setTimeout(() => { if (s.proc) reapplyCpuLimit(server.id); }, 20000).unref();
    setTimeout(() => { if (s.proc) reapplyCpuLimit(server.id); }, 45000).unref();
  }

  const buffers = { stdout: '', stderr: '' };
  const onData = (key) => (data) => {
    buffers[key] += data.toString('utf8');
    let i;
    while ((i = buffers[key].indexOf('\n')) >= 0) {
      const line = stripAnsi(buffers[key].slice(0, i).replace(/\r$/, ''));
      buffers[key] = buffers[key].slice(i + 1);
      if (line.trim()) {
        if (interceptEntityData(s, line)) continue;
        pushLine(server.id, line);
        if (!s.javaHintShown && /URLClassLoader|UnsupportedClassVersionError/i.test(line)) {
          s.javaHintShown = true;
          pushLine(server.id, '[ПАНЕЛЬ] Похоже, ядру нужна другая версия Java (старый Forge/Minecraft — Java 8). Укажите путь к java.exe в настройках сервера.');
        }
        parseGameLine(server.id, line);
      }
    }
  };
  proc.stdout.on('data', onData('stdout'));
  proc.stderr.on('data', onData('stderr'));

  proc.on('error', (err) => {
    s.status = 'error';
    s.proc = null;
    endStats(s);
    const hint = err.code === 'ENOENT'
      ? ' Java не найдена в PATH. Установите Java 21+ (https://adoptium.net).'
      : '';
    pushLine(server.id, '[ПАНЕЛЬ] Ошибка запуска: ' + err.message + hint);
  });

  proc.on('exit', (code, signal) => {
    s.proc = null;
    store.update(server.id, { pid: null });
    endStats(s);
    markAllOffline(s);
    if (s.stopTimer) { clearTimeout(s.stopTimer); s.stopTimer = null; }
    // намеренная остановка/убийство — всегда «остановлен», даже при ненулевом коде;
    // ненулевой код БЕЗ нашей команды — реальный краш сервера
    if (s.intentionalStop) {
      s.status = 'stopped';
    } else if (s.status !== 'error') {
      s.status = code === 0 || code === null ? 'stopped' : 'error';
    }
    s.intentionalStop = false;
    pushLine(server.id, '[ПАНЕЛЬ] Процесс завершён (' + (code === null ? 'сигнал ' + signal : 'код ' + code) + ')');
    if (s.onExit) {
      const cb = s.onExit;
      s.onExit = null;
      cb();
    }
    // лаунчер java мог оставить дочернюю JVM (например, после «Убить процесс»)
    setTimeout(() => {
      if (s.proc) return;
      const byPort = listeningPorts().get(Number(server.port));
      if (byPort && byPort !== process.pid && pidIsJava(byPort)) {
        s.orphanPid = byPort;
        store.update(server.id, { pid: byPort });
        pushLine(server.id, '[ПАНЕЛЬ] Остался дочерний процесс JVM (PID ' + byPort + ') — завершите его кнопкой «Убить процесс».');
      }
    }, 2500).unref();
  });
}

function stop(id) {
  const s = getState(id);
  if (!s.proc) return;
  s.status = 'stopping';
  s.intentionalStop = true;
  // прокси понимают свою команду остановки, обычные серверы — stop
  const srv = store.get(id) || {};
  const cmd = srv.type === 'bungeecord' ? 'end' : (srv.type === 'velocity' ? 'shutdown' : 'stop');
  pushLine(id, '[ПАНЕЛЬ] Останавливаю сервер (' + cmd + ')...');
  try { s.proc.stdin.write(cmd + '\n'); } catch (e) { /* stdin уже закрыт */ }
  if (!s.stopTimer) {
    s.stopTimer = setTimeout(() => {
      s.stopTimer = null;
      if (s.proc) {
        pushLine(id, '[ПАНЕЛЬ] Сервер не остановился за 30 с — завершаю принудительно.');
        killPidTree(s.proc.pid);
      }
    }, 30000);
  }
}

/* Жёстко убить процесс ВМЕСТЕ со всем деревом потомков (java.exe — лаунчер,
   реальная JVM — его дочерний процесс). Один вызов гасит всё. */
function killPidTree(pid) {
  if (!pid) return;
  if (IS_WIN) {
    try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }); }
    catch (e) { try { process.kill(pid); } catch (e2) { /* мёртв */ } }
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch (e) { /* нет группы */ }
    try { process.kill(pid, 'SIGKILL'); } catch (e) { /* мёртв */ }
  }
}

/* Ограничение использования CPU: процент переводим в число логических ядер
   и задаём процессорную маску (affinity). Дочерние процессы JVM наследуют
   маску при создании, поэтому ставим её сразу после spawn и повторяем по
   готовности (на случай, если тяжёлая JVM — отдельный дочерний процесс). */
function cpuMaskFor(cpuPercent) {
  const pct = parseInt(cpuPercent, 10);
  if (!(pct > 0 && pct < 100)) return null; // 100 или пусто — без ограничения
  const cores = os.cpus().length || 1;
  const allow = Math.max(1, Math.min(cores, Math.round(cores * pct / 100)));
  if (allow >= cores || allow > 30) return null; // все ядра / слишком много — не трогаем
  return { mask: Math.pow(2, allow) - 1, allow, cores };
}

/* Повторно навешиваем лимит на уже запущенную JVM, найдя её по слушаемому порту
   (реальный сервер — дочерний процесс лаунчера, привязывает порт только под конец
   загрузки, поэтому момент важен). */
function reapplyCpuLimit(id) {
  const s = getState(id);
  const srv = store.get(id);
  if (!srv || !cpuMaskFor(srv.cpuPercent)) return;
  if (s.proc) applyCpuLimit(s.proc.pid, srv.cpuPercent);
  const byPort = listeningPorts().get(Number(srv.port));
  if (byPort && pidIsJava(byPort)) applyCpuLimit(byPort, srv.cpuPercent);
}

function applyCpuLimit(pid, cpuPercent) {
  if (!pid) return;
  const m = cpuMaskFor(cpuPercent);
  if (!m) return;
  if (IS_WIN) {
    try {
      spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        '$p=Get-Process -Id ' + pid + ' -ErrorAction SilentlyContinue; if($p){$p.ProcessorAffinity=[IntPtr]' + m.mask + '}'],
        { windowsHide: true });
    } catch (e) { /* affinity не критична */ }
  } else {
    try { spawnSync('taskset', ['-a', '-p', m.mask.toString(16), String(pid)], { windowsHide: true }); }
    catch (e) { /* нет taskset */ }
  }
}

function kill(id) {
  const s = getState(id);
  const port = (store.get(id) || {}).port;
  if (s.proc) {
    s.intentionalStop = true; // убийство — это «остановлен», а не «ошибка»
    pushLine(id, '[ПАНЕЛЬ] Аварийное завершение (процесс и дочерняя JVM)...');
    killPidTree(s.proc.pid);
    // если реальная JVM осталась слушать порт (отдельный PID) — добиваем
    const byPort = listeningPorts().get(Number(port));
    if (byPort && byPort !== s.proc.pid && pidIsJava(byPort)) killPidTree(byPort);
    return;
  }
  if (s.orphanPid) {
    const pid = s.orphanPid;
    pushLine(id, '[ПАНЕЛЬ] Аварийное завершение осиротевшего процесса (PID ' + pid + ')...');
    killPidTree(pid);
    const byPort = listeningPorts().get(Number(port));
    if (byPort && byPort !== pid && pidIsJava(byPort)) killPidTree(byPort);
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      if (!isPidAlive(pid)) {
        clearInterval(timer);
        s.orphanPid = null;
        store.update(id, { pid: null });
        pushLine(id, '[ПАНЕЛЬ] Процесс завершён. Сервер можно запускать и удалять.');
      } else if (tries > 20) {
        clearInterval(timer);
        killPidTree(pid);
      }
    }, 400);
    timer.unref();
  }
}

function restart(server) {
  const s = getState(server.id);
  if (s.proc) {
    s.onExit = () => {
      try { start(server); } catch (e) { pushLine(server.id, '[ПАНЕЛЬ] Не удалось перезапустить: ' + e.message); }
    };
    stop(server.id);
  } else {
    start(server);
  }
}

function sendCommand(id, command) {
  const s = getState(id);
  if (!s.proc) { const err = new Error('Сервер не запущен'); err.status = 409; throw err; }
  const clean = String(command).replace(/[\r\n]/g, ' ').trim();
  if (!clean) return;
  pushLine(id, '> ' + clean);
  s.proc.stdin.write(clean + '\n');
}

// ---- установка Forge ----

function findForgeLaunch(dir) {
  // новые версии (1.17+): libraries/net/minecraftforge/forge/<ver>/win_args.txt
  const forgeLib = path.join(dir, 'libraries', 'net', 'minecraftforge', 'forge');
  try {
    for (const ver of fs.readdirSync(forgeLib)) {
      const argsFile = path.join(forgeLib, ver, 'win_args.txt');
      if (fs.existsSync(argsFile)) {
        return { mode: 'args', target: ['libraries', 'net', 'minecraftforge', 'forge', ver, 'win_args.txt'].join('/') };
      }
    }
  } catch (e) { /* нет каталога — старая версия forge */ }
  // старые версии: forge-<ver>.jar или server.jar в корне
  try {
    for (const name of fs.readdirSync(dir)) {
      if (/^forge-.*\.jar$/i.test(name) && !/installer/i.test(name)) {
        return { mode: 'jar', target: name };
      }
    }
  } catch (e) { /* пусто */ }
  if (fs.existsSync(path.join(dir, 'server.jar'))) return { mode: 'jar', target: 'server.jar' };
  return null;
}

/* Запускает официальный installer Forge; пишет лог в консоль сервера.
   resolve -> launch-спецификация, reject -> ошибка. */
function installForge(server) {
  return new Promise((resolve, reject) => {
    const dir = serverDir(server.id);
    const picked = pickJava(server);
    if (picked.error) return reject(new Error(picked.error));
    const jbin = picked.bin || 'java';
    pushLine(server.id, '[ПАНЕЛЬ] Устанавливаю Forge (' + picked.label + ')... Это может занять несколько минут.');
    let proc;
    try {
      proc = spawn(jbin, ['-jar', 'installer.jar', '--installServer'], { cwd: dir, windowsHide: true });
    } catch (e) {
      return reject(e);
    }
    const onData = (data) => {
      for (const line of data.toString('utf8').split(/\r?\n/)) {
        if (line.trim()) pushLine(server.id, '[FORGE] ' + stripAnsi(line));
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', (err) => {
      reject(new Error('Не удалось запустить установщик: ' + err.message +
        (err.code === 'ENOENT' ? ' (нужна Java в PATH)' : '')));
    });
    proc.on('exit', (code) => {
      if (code !== 0) return reject(new Error('Установщик Forge завершился с кодом ' + code));
      const launch = findForgeLaunch(dir);
      if (!launch) return reject(new Error('Forge установлен, но файлы запуска не найдены'));
      for (const junk of ['installer.jar', 'installer.jar.log']) {
        try { fs.rmSync(path.join(dir, junk), { force: true }); } catch (e) { /* не критично */ }
      }
      resolve(launch);
    });
  });
}

// ---- метрики процесса (CPU/ОЗУ/ввод-вывод) ----

/* Из абсолютных значений (секунды CPU, рабочий набор, прочитано/записано байт)
   считает точку графика по дельте к предыдущему замеру. */
function pushStatPoint(s, cpuSec, ws, readB, writeB) {
  const now = Date.now();
  const prev = s.statsPrev;
  s.statsPrev = { t: now, cpuSec, readB, writeB };
  if (!prev) return;
  const dt = (now - prev.t) / 1000;
  if (dt <= 0) return;
  const cores = os.cpus().length || 1;
  const point = {
    t: now,
    cpu: Math.max(0, Math.min(100, ((cpuSec - prev.cpuSec) / dt) * 100 / cores)),
    ramMb: Math.round(ws / 1048576),
    readBps: Math.max(0, (readB - prev.readB) / dt),
    writeBps: Math.max(0, (writeB - prev.writeB) / dt),
    players: s.players.size,
  };
  s.stats.push(point);
  if (s.stats.length > STATS_POINTS) s.stats.splice(0, s.stats.length - STATS_POINTS);
}

/* Снятие метрик процесса на Linux через /proc/<pid>/{stat,statm,io}. */
function collectStatsLinux(server, s, pid) {
  try {
    const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
    // после "<pid> (comm) " идут поля; utime=14, stime=15 (1-based)
    const after = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
    const utime = parseInt(after[11], 10) || 0; // поле 14
    const stime = parseInt(after[12], 10) || 0; // поле 15
    const cpuSec = (utime + stime) / 100;        // USER_HZ обычно 100
    let ws = 0;
    try {
      const statm = fs.readFileSync('/proc/' + pid + '/statm', 'utf8').trim().split(/\s+/);
      ws = (parseInt(statm[1], 10) || 0) * 4096;  // resident pages × размер страницы
    } catch (e) { /* нет statm */ }
    let readB = 0; let writeB = 0;
    try {
      const io = fs.readFileSync('/proc/' + pid + '/io', 'utf8');
      const rm = io.match(/rchar:\s*(\d+)/); if (rm) readB = parseInt(rm[1], 10);
      const wm = io.match(/wchar:\s*(\d+)/); if (wm) writeB = parseInt(wm[1], 10);
    } catch (e) { /* io недоступен */ }
    s.statsMisses = 0;
    pushStatPoint(s, cpuSec, ws, readB, writeB);
  } catch (e) {
    // процесс исчез — возможно, JVM перезапустила себя: ищем по порту
    s.statsMisses++;
    if (s.statsMisses >= 2) {
      s.statsMisses = 0;
      const byPort = listeningPorts().get(Number(server.port));
      if (byPort && pidIsJava(byPort)) { s.statsPid = byPort; s.statsPrev = null; }
    }
  }
}

function collectStats(server, s) {
  // java.exe (JDK 21+/Windows) — лаунчер, который порождает реальную JVM
  // отдельным процессом: метрики надо снимать с того, кто слушает порт
  if (!s.statsPidVerified) {
    const byPort = listeningPorts().get(Number(server.port));
    if (byPort && pidIsJava(byPort)) {
      if (byPort !== s.statsPid) {
        s.statsPid = byPort;
        s.statsPrev = null;
      }
      s.statsPidVerified = true;
    }
  }
  const pid = s.statsPid;
  if (!pid) return;
  if (!IS_WIN) { collectStatsLinux(server, s, pid); return; }
  const cmd =
    '$p=Get-Process -Id ' + pid + ' -ErrorAction SilentlyContinue; if($p){' +
    "$w=Get-CimInstance Win32_Process -Filter 'ProcessId=" + pid + "' -ErrorAction SilentlyContinue; " +
    '$ci=[Globalization.CultureInfo]::InvariantCulture; ' +
    'Write-Output (([double]$p.CPU).ToString($ci)+\',\'+$p.WorkingSet64+\',\'+$w.ReadTransferCount+\',\'+$w.WriteTransferCount)}';
  let out = '';
  let proc;
  try {
    proc = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true });
  } catch (e) { return; }
  proc.stdout.on('data', (d) => { out += d; });
  proc.on('error', () => { /* powershell недоступен */ });
  proc.on('exit', () => {
    const parts = out.trim().split(',');
    if (parts.length !== 4) {
      // процесс не найден — возможно, JVM перезапустила себя: ищем по порту
      s.statsMisses++;
      if (s.statsMisses >= 2) {
        s.statsMisses = 0;
        const byPort = listeningPorts().get(Number(server.port));
        if (byPort && pidIsJava(byPort)) {
          s.statsPid = byPort;
          s.statsPrev = null;
        }
      }
      return;
    }
    s.statsMisses = 0;
    const now = Date.now();
    const cpuSec = parseFloat(parts[0]) || 0;
    const ws = parseInt(parts[1], 10) || 0;
    const readB = parseInt(parts[2], 10) || 0;
    const writeB = parseInt(parts[3], 10) || 0;
    const prev = s.statsPrev;
    s.statsPrev = { t: now, cpuSec, readB, writeB };
    if (!prev) return;
    const dt = (now - prev.t) / 1000;
    if (dt <= 0) return;
    const cores = os.cpus().length || 1;
    const point = {
      t: now,
      cpu: Math.max(0, Math.min(100, ((cpuSec - prev.cpuSec) / dt) * 100 / cores)),
      ramMb: Math.round(ws / 1048576),
      readBps: Math.max(0, (readB - prev.readB) / dt),
      writeBps: Math.max(0, (writeB - prev.writeB) / dt),
      players: s.players.size,
    };
    s.stats.push(point);
    if (s.stats.length > STATS_POINTS) s.stats.splice(0, s.stats.length - STATS_POINTS);
  });
}

function beginStats(server, pid) {
  const s = getState(server.id);
  endStats(s);
  s.stats = [];
  s.statsPrev = null;
  s.statsMisses = 0;
  s.statsPid = pid;
  s.statsPidVerified = false;
  s.statsTimer = setInterval(() => collectStats(server, s), STATS_INTERVAL);
  s.statsTimer.unref();
}

function endStats(s) {
  if (s.statsTimer) { clearInterval(s.statsTimer); s.statsTimer = null; }
  s.statsPrev = null;
}

function getStats(id) {
  return getState(id).stats;
}

// ---- SSE ----

let heartbeat = null;

function attachConsole(id, res) {
  const s = getState(id);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  for (const line of s.console) {
    res.write('data: ' + JSON.stringify(line) + '\n\n');
  }
  s.clients.add(res);
  res.on('close', () => s.clients.delete(res));

  if (!heartbeat) {
    heartbeat = setInterval(() => {
      for (const state of states.values()) {
        for (const client of state.clients) {
          try { client.write(': hb\n\n'); } catch (e) { state.clients.delete(client); }
        }
      }
    }, 25000);
    heartbeat.unref();
  }
}

// ---- Java / система ----

let javaInfo = null;

function checkJava() {
  return new Promise((resolve) => {
    if (javaInfo) return resolve(javaInfo);
    let settled = false;
    const finish = (info) => { if (!settled) { settled = true; javaInfo = info; resolve(info); } };
    let out = '';
    let proc;
    try {
      proc = spawn('java', ['-version'], { windowsHide: true });
    } catch (e) {
      return finish({ available: false, version: null });
    }
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { out += d; });
    proc.on('error', () => finish({ available: false, version: null }));
    proc.on('exit', () => {
      const m = out.match(/version "([^"]+)"/);
      finish({ available: true, version: m ? m[1] : (out.split('\n')[0] || '').trim() });
    });
  });
}

function lanAddresses() {
  const result = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const addr of ifaces[name] || []) {
      if (addr.family === 'IPv4' && !addr.internal) result.push(addr.address);
    }
  }
  return result;
}

function systemMemoryMb() {
  return Math.round(os.totalmem() / 1048576);
}

function cpuCores() {
  return os.cpus().length || 1;
}

function anyRunning() {
  for (const s of states.values()) if (s.proc) return true;
  return false;
}

function stopAll() {
  for (const [id, s] of states) {
    if (s.proc) stop(id);
  }
}

function listJavas() { return javas.listJavas(); }

module.exports = {
  getState, dropState, pushLine, start, stop, kill, restart, sendCommand,
  attachConsole, checkJava, lanAddresses, systemMemoryMb, cpuCores, listJavas,
  isLaunchReady, jarPath, anyRunning, stopAll, playersView,
  adoptOrphans, orphanAlive, installForge, getStats,
  queryEntityData, getHistory, historyView, removeHistory, forgetPlayer, stripAnsi,
};
