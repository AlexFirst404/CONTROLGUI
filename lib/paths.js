'use strict';
const path = require('path');
const fs = require('fs');

// ROOT — каталог приложения (код + статика public/, только чтение).
const ROOT = path.join(__dirname, '..');
// DATA_ROOT — куда писать данные (серверы/настройки/бэкапы). По умолчанию рядом с
// кодом (как было), но переопределяется через CONTROLGUI_DATA — нужно, когда панель
// установлена системно (например, .deb в /opt), а пользователь пишет в свой домашний.
const DATA_ROOT = process.env.CONTROLGUI_DATA
  ? path.resolve(process.env.CONTROLGUI_DATA)
  : ROOT;

const DATA_DIR = path.join(DATA_ROOT, 'data');
const SERVERS_DIR = path.join(DATA_ROOT, 'servers');
const PUBLIC_DIR = path.join(ROOT, 'public');
const REGISTRY_FILE = path.join(DATA_DIR, 'servers.json');

for (const dir of [DATA_DIR, SERVERS_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function serverDir(id) {
  return path.join(SERVERS_DIR, id);
}

module.exports = { ROOT, DATA_ROOT, DATA_DIR, SERVERS_DIR, PUBLIC_DIR, REGISTRY_FILE, serverDir };
