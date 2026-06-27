'use strict';
/* Настройки центра (settings.json). Сейчас: адрес-эндпоинт, который клиенты узнают
   через GET /api/endpoint и на который мигрируют (см. design 2026-06-27 §3). Без зависимостей. */
const store = require('./store');

const FILE = 'settings.json';
function load() { return store.load(FILE, {}) || {}; }
function save(s) { store.save(FILE, s); }

const DEFAULT_HOST = process.env.CGR_PUBLIC_HOST || '89.125.169.61';
const DEFAULT_PORT = parseInt(process.env.CGR_PUBLIC_PORT, 10) || 443;

function endpoint() {
  const e = load().endpoint || {};
  return { host: e.host || DEFAULT_HOST, port: e.port || DEFAULT_PORT };
}

/* Сменить адрес центра (host[:port]). Клиенты подхватят при следующем подключении.
   Серт пинуется по отпечатку, а не по хосту — тот же серт на новом IP работает без TOFU. */
function setEndpoint(host, port) {
  host = String(host || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (host.includes(':')) { const parts = host.split(':'); host = parts[0]; if (!port) port = parts[1]; }
  if (!/^[a-zA-Z0-9.\-]{1,253}$/.test(host)) return { error: 'Некорректный host (буквы, цифры, точка, дефис)' };
  port = parseInt(port, 10) || 443;
  if (port < 1 || port > 65535) return { error: 'Некорректный порт' };
  const s = load();
  s.endpoint = { host, port };
  save(s);
  return { ok: true, endpoint: { host, port } };
}

module.exports = { endpoint, setEndpoint };
