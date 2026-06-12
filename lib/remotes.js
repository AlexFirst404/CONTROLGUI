'use strict';
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { DATA_DIR } = require('./paths');

/* Список удалённых установок CONTROLGUI (другие машины/серверы), которые
   админ-панель собирает в одном месте. Дашборд сам ходит на них (pull):
   логинится паролем, забирает /api/admin/overview. Хранится в
   data/admin-remotes.json (с паролями — это локальный админ-инструмент). */

const FILE = path.join(DATA_DIR, 'admin-remotes.json');

function load() {
  try {
    const list = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch (e) { return []; }
}

function save(list) {
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2));
}

function normalizeUrl(raw) {
  let u = String(raw || '').trim();
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  try {
    const parsed = new URL(u);
    return parsed.origin; // http://host:port без хвоста
  } catch (e) { return null; }
}

function list() {
  return load().map((r) => ({ url: r.url, label: r.label || '' }));
}

function add(rawUrl, password, label) {
  const url = normalizeUrl(rawUrl);
  if (!url) throw Object.assign(new Error('Некорректный адрес панели'), { status: 400 });
  const items = load();
  const existing = items.find((r) => r.url === url);
  if (existing) {
    existing.password = password || existing.password;
    if (label != null) existing.label = label;
  } else {
    items.push({ url, password: password || '', label: label || '' });
  }
  save(items);
  return url;
}

function remove(rawUrl) {
  const url = normalizeUrl(rawUrl);
  const items = load().filter((r) => r.url !== url);
  save(items);
}

// ---- опрос удалённой панели ----

function request(method, urlStr, { headers = {}, body = null, timeout = 6000 } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(urlStr); } catch (e) { return reject(new Error('Некорректный URL')); }
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error('Таймаут')));
    if (body) req.write(body);
    req.end();
  });
}

/* Залогиниться паролем и забрать сводку удалённой панели. */
async function fetchOverview(remote) {
  try {
    let cookie = '';
    // если у панели включён пароль — логинимся; если нет — overview отдаст и так
    const login = await request('POST', remote.url + '/api/login', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: remote.password || '' }),
    });
    if (login.status === 401) return { url: remote.url, online: false, error: 'Неверный пароль' };
    const setCookie = login.headers['set-cookie'];
    if (setCookie && setCookie.length) cookie = setCookie[0].split(';')[0];

    // includeRemotes=0 — берём только локальные серверы удалённой панели,
    // чтобы не запускать каскад опросов их удалёнок
    const ov = await request('GET', remote.url + '/api/admin/overview?includeRemotes=0', {
      headers: cookie ? { Cookie: cookie } : {},
    });
    if (ov.status === 401) return { url: remote.url, online: false, error: 'Нет доступа (нужен пароль)' };
    if (ov.status !== 200) return { url: remote.url, online: false, error: 'HTTP ' + ov.status };
    const data = JSON.parse(ov.body);
    return {
      url: remote.url,
      label: remote.label || '',
      online: true,
      panel: data.panel,
      servers: data.servers || [],
    };
  } catch (e) {
    const reason = e.code === 'ECONNREFUSED' ? 'Панель недоступна'
      : (e.message === 'Таймаут' ? 'Нет ответа (таймаут)' : (e.message || 'Ошибка связи'));
    return { url: remote.url, label: remote.label || '', online: false, error: reason };
  }
}

/* Опросить все удалённые панели параллельно. */
async function fetchAll() {
  const items = load();
  return Promise.all(items.map((r) => fetchOverview(r)));
}

module.exports = { list, add, remove, fetchAll };
