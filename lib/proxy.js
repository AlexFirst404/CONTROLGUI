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

function isProxyType(type) {
  return PROXY_TYPES.includes(type);
}
function canBeBackend(type) {
  return BACKEND_OK.includes(type);
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

// перевести backend-сервер в proxy-режим: offline + spigot.yml bungeecord:true
function bindBackend(backend) {
  const dir = serverDir(backend.id);
  // server.properties: online-mode=false (аутентификация на прокси)
  try {
    const pf = path.join(dir, 'server.properties');
    const p = fs.existsSync(pf) ? props.parse(fs.readFileSync(pf, 'utf8')) : {};
    p['online-mode'] = 'false';
    fs.writeFileSync(pf, props.stringify(p));
  } catch (e) { /* пропускаем — backend донастроится вручную */ }
  // spigot.yml: settings.bungeecord: true (Spigot/Paper добавят остальное при старте)
  try {
    const sf = path.join(dir, 'spigot.yml');
    if (fs.existsSync(sf)) {
      let y = fs.readFileSync(sf, 'utf8');
      if (/bungeecord:\s*false/.test(y)) y = y.replace(/bungeecord:\s*false/, 'bungeecord: true');
      else if (!/bungeecord:\s*true/.test(y)) y = 'settings:\n  bungeecord: true\n' + y;
      fs.writeFileSync(sf, y);
    } else {
      fs.writeFileSync(sf, 'settings:\n  bungeecord: true\n');
    }
  } catch (e) { /* пропускаем */ }
}

// вернуть backend-сервер в обычный режим (отвязка от прокси): online-mode=true,
// spigot.yml settings.bungeecord: false. Применяется после перезапуска backend'а.
function unbindBackend(backend) {
  const dir = serverDir(backend.id);
  try {
    const pf = path.join(dir, 'server.properties');
    if (fs.existsSync(pf)) {
      const p = props.parse(fs.readFileSync(pf, 'utf8'));
      p['online-mode'] = 'true';
      fs.writeFileSync(pf, props.stringify(p));
    }
  } catch (e) { /* донастроится вручную */ }
  try {
    const sf = path.join(dir, 'spigot.yml');
    if (fs.existsSync(sf)) {
      const y = fs.readFileSync(sf, 'utf8').replace(/bungeecord:\s*true/, 'bungeecord: false');
      fs.writeFileSync(sf, y);
    }
  } catch (e) { /* */ }
}

// перезаписать конфиг прокси из текущего списка backend'ов (velocity.toml / config.yml).
// host в сохранённых записях может отсутствовать — подставляем 127.0.0.1.
function writeProxyConfig(proxy, list) {
  const dir = serverDir(proxy.id);
  fs.mkdirSync(dir, { recursive: true });
  const full = (list || []).map((b) => Object.assign({ host: '127.0.0.1' }, b));
  if (proxy.type === 'bungeecord') {
    fs.writeFileSync(path.join(dir, 'config.yml'), bungeeConfig(proxy, full));
  } else {
    fs.writeFileSync(path.join(dir, 'velocity.toml'), velocityConfig(proxy, full));
    if (!fs.existsSync(path.join(dir, 'forwarding.secret'))) {
      fs.writeFileSync(path.join(dir, 'forwarding.secret'), crypto.randomBytes(12).toString('hex'));
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
  fs.mkdirSync(dir, { recursive: true });
  const list = buildBackendList(backends);

  if (proxy.type === 'bungeecord') {
    fs.writeFileSync(path.join(dir, 'config.yml'), bungeeConfig(proxy, list));
  } else {
    fs.writeFileSync(path.join(dir, 'velocity.toml'), velocityConfig(proxy, list));
    // legacy-форвардингу секрет не нужен, но файл лучше создать (Velocity его ждёт)
    fs.writeFileSync(path.join(dir, 'forwarding.secret'), crypto.randomBytes(12).toString('hex'));
  }

  for (const b of backends) bindBackend(b);
  return { servers: list.map((b) => ({ id: b.id, name: b.name, slug: b.slug, port: b.port })) };
}

module.exports = { PROXY_TYPES, isProxyType, canBeBackend, setupProxy, bindBackend, unbindBackend, writeProxyConfig, buildBackendList, slugify };
