'use strict';
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const SERVERS_DIR = path.join(ROOT, 'servers');
const PUBLIC_DIR = path.join(ROOT, 'public');
const REGISTRY_FILE = path.join(DATA_DIR, 'servers.json');

for (const dir of [DATA_DIR, SERVERS_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function serverDir(id) {
  return path.join(SERVERS_DIR, id);
}

module.exports = { ROOT, DATA_DIR, SERVERS_DIR, PUBLIC_DIR, REGISTRY_FILE, serverDir };
