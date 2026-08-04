'use strict';
// Прокси-серверы (BungeeCord / Velocity): генерация конфигов и привязка
// backend-серверов. Привязка делает «legacy»-форвардинг — самый совместимый:
// прокси аутентифицирует игроков (online), а backend'ы переводятся в offline
// (online-mode=false) + spigot.yml settings.bungeecord: true.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const props = require('./properties');
const { serverDir } = require('./paths');

const PROXY_TYPES = ['velocity', 'bungeecord'];
// какие ядра можно поставить за прокси (понимают bungee/velocity-форвардинг)
const BACKEND_OK = ['paper', 'purpur', 'folia', 'mohist', 'custom'];

/* Конфиги участвуют в общей транзакции привязки. Запись через временный файл в той
   же папке не оставляет обрезанный YAML/TOML/properties при падении процесса. */
function writeFileAtomic(file, data, requestedMode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let mode = requestedMode;
  try { mode = fs.statSync(file).mode & 0o777; } catch (e) { /* новый файл */ }
  const tmp = path.join(path.dirname(file), '.' + path.basename(file) + '.tmp-' +
    process.pid + '-' + crypto.randomBytes(6).toString('hex'));
  try {
    fs.writeFileSync(tmp, data, { mode: mode == null ? 0o600 : mode });
    fs.renameSync(tmp, file);
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch (e) { /* rename уже перенёс файл */ }
  }
}

function isProxyType(type) {
  return PROXY_TYPES.includes(type);
}
function canBeBackend(type) {
  return BACKEND_OK.includes(type);
}

function snapshotFile(file) {
  const exists = fs.existsSync(file);
  return { file, exists, data: exists ? fs.readFileSync(file) : null };
}

function snapshotBackend(backend) {
  const dir = serverDir(backend.id);
  return ['server.properties', 'spigot.yml'].map((name) => snapshotFile(path.join(dir, name)));
}

function snapshotProxy(proxy) {
  const dir = serverDir(proxy.id);
  const names = proxy.type === 'bungeecord'
    ? ['config.yml']
    : ['velocity.toml', 'forwarding.secret'];
  return names.map((name) => snapshotFile(path.join(dir, name)));
}

function restoreBackendSnapshot(snapshot) {
  for (const item of snapshot || []) {
    if (item.exists) writeFileAtomic(item.file, item.data);
    else fs.rmSync(item.file, { force: true });
  }
}

function restoreBackendSnapshots(snapshots, sourceError) {
  let rollbackError = null;
  for (const snapshot of snapshots) {
    try { restoreBackendSnapshot(snapshot); } catch (e) { rollbackError = rollbackError || e; }
  }
  if (rollbackError && sourceError) sourceError.message += '; не удалось полностью вернуть прежние конфиги: ' + rollbackError.message;
  return rollbackError;
}

/* Привязка меняет backend и один/несколько конфигов прокси. Снимки позволяют
   вернуть ВСЕ файлы, если bind/write/store оборвётся на любом шаге. */
function beginConfigTransaction(backends, proxies) {
  const snapshots = [];
  const seen = new Set();
  for (const backend of backends || []) {
    if (!backend || seen.has('b:' + backend.id)) continue;
    seen.add('b:' + backend.id);
    snapshots.push(snapshotBackend(backend));
  }
  for (const item of proxies || []) {
    if (!item || seen.has('p:' + item.id)) continue;
    seen.add('p:' + item.id);
    snapshots.push(snapshotProxy(item));
  }
  let finished = false;
  return {
    commit() { finished = true; },
    rollback(sourceError) {
      if (finished) return;
      finished = true;
      const rollbackError = restoreBackendSnapshots(snapshots, sourceError);
      if (rollbackError && !sourceError) throw rollbackError;
    },
  };
}

const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
  й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
  у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '',
  э: 'e', ю: 'yu', я: 'ya',
};

// безопасное имя сервера для конфига прокси (латиница/цифры/_-), уникальное.
// Кириллицу транслитерируем, чтобы /server-имена были читаемыми.
function slugify(name, used) {
  let base = String(name || 'server').toLowerCase()
    .replace(/[а-яё]/g, (c) => (c in TRANSLIT ? TRANSLIT[c] : '-'))
    .replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'server';
  let slug = base;
  let i = 2;
  while (used.has(slug)) slug = base + '-' + i++;
  used.add(slug);
  return slug;
}

// перевести backend-сервер в proxy-режим: offline + ТОЛЬКО loopback +
// spigot.yml bungeecord:true. Иначе игрок обойдёт аутентификацию прокси,
// подключившись напрямую к открытому offline-mode порту backend-сервера.
function bindBackend(backend) {
  const dir = serverDir(backend.id);
  const snapshot = snapshotBackend(backend);
  try {
    // server.properties — обязательная часть привязки: если безопасный bind не
    // записался, прекращаем операцию и не добавляем backend в конфиг прокси.
    const pf = path.join(dir, 'server.properties');
    const p = fs.existsSync(pf) ? props.parse(fs.readFileSync(pf, 'utf8')) : {};
    p['online-mode'] = 'false';
    p['server-ip'] = '127.0.0.1';
    writeFileAtomic(pf, props.stringify(p));
    // spigot.yml: settings.bungeecord: true (Spigot/Paper добавят остальное при старте)
    const sf = path.join(dir, 'spigot.yml');
    if (fs.existsSync(sf)) {
      let y = fs.readFileSync(sf, 'utf8');
      if (/bungeecord:\s*false/.test(y)) y = y.replace(/bungeecord:\s*false/, 'bungeecord: true');
      else if (!/bungeecord:\s*true/.test(y)) y = 'settings:\n  bungeecord: true\n' + y;
      writeFileAtomic(sf, y);
    } else {
      writeFileAtomic(sf, 'settings:\n  bungeecord: true\n');
    }
  } catch (e) {
    const error = Object.assign(new Error('Не удалось безопасно привязать backend: проверьте доступ к server.properties и spigot.yml'), { status: 409 });
    try { restoreBackendSnapshot(snapshot); }
    catch (rollbackError) { error.message += '; не удалось полностью вернуть прежние настройки'; }
    throw error;
  }
}

// вернуть backend-сервер в обычный режим (отвязка от прокси): online-mode=true,
// снимаем loopback-bind и выключаем forwarding. Применяется после перезапуска backend'а.
function unbindBackend(backend) {
  const dir = serverDir(backend.id);
  const snapshot = snapshotBackend(backend);
  try {
    const pf = path.join(dir, 'server.properties');
    if (!fs.existsSync(pf)) throw new Error('server.properties не найден');
    const p = props.parse(fs.readFileSync(pf, 'utf8'));
    p['online-mode'] = 'true';
    p['server-ip'] = '';
    writeFileAtomic(pf, props.stringify(p));
    const sf = path.join(dir, 'spigot.yml');
    if (fs.existsSync(sf)) {
      const y = fs.readFileSync(sf, 'utf8').replace(/bungeecord:\s*true/, 'bungeecord: false');
      writeFileAtomic(sf, y);
    }
  } catch (e) {
    const error = Object.assign(new Error('Не удалось безопасно отвязать backend: проверьте доступ к server.properties и spigot.yml'), { status: 409 });
    try { restoreBackendSnapshot(snapshot); }
    catch (rollbackError) { error.message += '; не удалось полностью вернуть прежние настройки'; }
    throw error;
  }
}

/* Групповая отвязка — транзакция на уровне конфигов backend. Вызывающий код
   может откатить её, если удаление/обновление самого прокси не удалось. */
function unbindBackends(backends) {
  const snapshots = backends.map(snapshotBackend);
  try {
    for (const backend of backends) unbindBackend(backend);
  } catch (e) {
    restoreBackendSnapshots(snapshots, e);
    throw e;
  }
  let finished = false;
  return {
    commit() { finished = true; },
    rollback(sourceError) {
      if (finished) return;
      finished = true;
      const rollbackError = restoreBackendSnapshots(snapshots, sourceError);
      if (rollbackError && !sourceError) throw rollbackError;
    },
  };
}

// перезаписать конфиг прокси из текущего списка backend'ов (velocity.toml / config.yml).
// host в сохранённых записях может отсутствовать — подставляем 127.0.0.1.
function proxyWithLegacyOptions(proxy, dir) {
  if (proxy.motd && proxy.maxPlayers) return proxy;
  const effective = Object.assign({}, proxy);
  try {
    const file = path.join(dir, proxy.type === 'bungeecord' ? 'config.yml' : 'velocity.toml');
    const text = fs.readFileSync(file, 'utf8');
    if (!effective.motd) {
      if (proxy.type === 'bungeecord') {
        const match = text.match(/^\s*motd:\s*'((?:''|[^'])*)'/m);
        if (match) effective.motd = match[1].replace(/''/g, "'");
      } else {
        const match = text.match(/^motd\s*=\s*"((?:\\.|[^"\\])*)"/m);
        if (match) effective.motd = match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      }
    }
    if (!effective.maxPlayers) {
      const pattern = proxy.type === 'bungeecord' ? /^\s*max_players:\s*(\d+)/m : /^show-max-players\s*=\s*(\d+)/m;
      const match = text.match(pattern);
      const value = match ? parseInt(match[1], 10) : 0;
      if (value > 0) effective.maxPlayers = value;
    }
  } catch (e) { /* у совсем старого/не запущенного прокси конфига могло не быть */ }
  return effective;
}

function writeProxyConfig(proxy, list) {
  const dir = serverDir(proxy.id);
  fs.mkdirSync(dir, { recursive: true });
  const effectiveProxy = proxyWithLegacyOptions(proxy, dir);
  const full = (list || []).map((b) => Object.assign({ host: '127.0.0.1' }, b));
  if (proxy.type === 'bungeecord') {
    writeFileAtomic(path.join(dir, 'config.yml'), bungeeConfig(effectiveProxy, full));
  } else {
    writeFileAtomic(path.join(dir, 'velocity.toml'), velocityConfig(effectiveProxy, full));
    if (!fs.existsSync(path.join(dir, 'forwarding.secret'))) {
      writeFileAtomic(path.join(dir, 'forwarding.secret'), crypto.randomBytes(12).toString('hex'), 0o600);
    }
  }
}

// собрать список {id,name,slug,host,port} для выбранных backend-серверов
function buildBackendList(backends) {
  const used = new Set();
  return backends.map((b) => ({
    id: b.id,
    name: b.name,
    slug: slugify(b.name, used),
    host: '127.0.0.1',
    port: b.port,
  }));
}

function yamlEscape(s) {
  return String(s || '').replace(/'/g, "''");
}

function bungeeConfig(proxy, list) {
  const first = list[0] ? list[0].slug : 'lobby';
  const servers = list.map((b) =>
    "  " + b.slug + ":\n" +
    "    motd: '" + yamlEscape(proxy.motd || b.name) + "'\n" +
    "    address: " + b.host + ":" + b.port + "\n" +
    "    restricted: false\n"
  ).join('');
  return [
    'listeners:',
    '- query_port: ' + proxy.port,
    "  motd: '" + yamlEscape(proxy.motd || proxy.name) + "'",
    '  tab_list: GLOBAL_PING',
    '  query_enabled: false',
    '  proxy_protocol: false',
    '  forced_hosts: {}',
    '  ping_passthrough: false',
    '  priorities:',
    '  - ' + first,
    '  bind_local_address: true',
    '  host: 0.0.0.0:' + proxy.port,
    '  max_players: ' + (proxy.maxPlayers || 100),
    '  tab_size: 60',
    '  force_default_server: false',
    'remote_ping_cache: -1',
    'network_compression_threshold: 256',
    'permissions:',
    '  default:',
    '  - bungeecord.command.server',
    '  - bungeecord.command.list',
    '  admin:',
    '  - bungeecord.command.alert',
    '  - bungeecord.command.end',
    '  - bungeecord.command.ip',
    '  - bungeecord.command.reload',
    'timeout: 30000',
    'player_limit: -1',
    'ip_forward: true',
    'groups: {}',
    'connection_throttle: 4000',
    'connection_throttle_limit: 3',
    'stats: ' + crypto.randomUUID(),
    'prevent_proxy_connections: false',
    'online_mode: true',
    'forge_support: false',
    'disabled_commands:',
    '- disabledcommandhere',
    'servers:',
    servers.replace(/\n$/, ''),
  ].join('\n') + '\n';
}

function velocityConfig(proxy, list) {
  const servers = list.map((b) => '  ' + b.slug + ' = "' + b.host + ':' + b.port + '"').join('\n');
  const tryList = list.map((b) => '"' + b.slug + '"').join(', ');
  return [
    'config-version = "2.7"',
    'bind = "0.0.0.0:' + proxy.port + '"',
    'motd = "' + String(proxy.motd || proxy.name).replace(/"/g, '\\"') + '"',
    'show-max-players = ' + (proxy.maxPlayers || 100),
    'online-mode = true',
    'force-key-authentication = false',
    'prevent-client-proxy-connections = false',
    'player-info-forwarding-mode = "legacy"',
    'forwarding-secret-file = "forwarding.secret"',
    'announce-forge = false',
    'kick-existing-players = false',
    'ping-passthrough = "DISABLED"',
    'enable-player-address-logging = true',
    '',
    '[servers]',
    servers,
    'try = [' + tryList + ']',
    '',
    '[forced-hosts]',
    '',
    '[advanced]',
    'compression-threshold = 256',
    'compression-level = -1',
    'login-ratelimit = 3000',
    'connection-timeout = 5000',
    'read-timeout = 30000',
    'tcp-fast-open = false',
    'proxy-protocol = false',
    '',
    '[query]',
    'enabled = false',
    'port = ' + proxy.port,
    'map = "Velocity"',
    'show-plugins = false',
  ].join('\n') + '\n';
}

// записать конфиг прокси + привязать выбранные backend'ы. Возвращает сводку.
function setupProxy(proxy, backends) {
  const dir = serverDir(proxy.id);
  const transaction = beginConfigTransaction(backends, [proxy]);
  fs.mkdirSync(dir, { recursive: true });
  const list = buildBackendList(backends);

  try {
    // Сначала гарантируем offline+loopback на каждом backend. Если хотя бы один
    // не удалось защитить, возвращаем точные прежние конфиги всех уже изменённых.
    for (const b of backends) bindBackend(b);

    if (proxy.type === 'bungeecord') {
      writeFileAtomic(path.join(dir, 'config.yml'), bungeeConfig(proxy, list));
    } else {
      writeFileAtomic(path.join(dir, 'velocity.toml'), velocityConfig(proxy, list));
      // legacy-форвардингу секрет не нужен, но файл лучше создать (Velocity его ждёт)
      writeFileAtomic(path.join(dir, 'forwarding.secret'), crypto.randomBytes(12).toString('hex'), 0o600);
    }
  } catch (e) {
    transaction.rollback(e);
    throw e;
  }

  return {
    servers: list.map((b) => ({ id: b.id, name: b.name, slug: b.slug, port: b.port })),
    transaction,
  };
}

module.exports = { PROXY_TYPES, isProxyType, canBeBackend, setupProxy, bindBackend, unbindBackend,
  unbindBackends, beginConfigTransaction, writeProxyConfig, buildBackendList, slugify };
