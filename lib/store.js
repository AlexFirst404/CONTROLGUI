'use strict';
const fs = require('fs');
const crypto = require('crypto');
const { REGISTRY_FILE } = require('./paths');

let registry = null;

function load() {
  if (registry) return registry;
  try {
    registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
    if (!Array.isArray(registry.servers)) registry.servers = [];
  } catch (e) {
    registry = { servers: [] };
  }
  return registry;
}

function save() {
  // Реестр — единый источник всех связей серверов и прокси. Пишем через
  // уникальный tmp + rename, чтобы сбой питания не оставил обрезанный JSON.
  const tmp = REGISTRY_FILE + '.' + process.pid + '.' + crypto.randomBytes(5).toString('hex') + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(registry, null, 2));
    fs.renameSync(tmp, REGISTRY_FILE);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch (removeError) { /* tmp мог не создаться */ }
    throw e;
  }
}

function all() {
  return load().servers;
}

function get(id) {
  return load().servers.find((s) => s.id === id) || null;
}

function add(server) {
  const list = load().servers;
  list.push(server);
  try { save(); }
  catch (e) { list.pop(); throw e; }
}

function update(id, patch) {
  const server = get(id);
  if (!server) return null;
  const before = {};
  const existed = {};
  for (const key of Object.keys(patch || {})) {
    existed[key] = Object.prototype.hasOwnProperty.call(server, key);
    before[key] = server[key];
  }
  Object.assign(server, patch);
  try { save(); }
  catch (e) {
    for (const key of Object.keys(patch || {})) {
      if (existed[key]) server[key] = before[key]; else delete server[key];
    }
    throw e;
  }
  return server;
}

/* Несколько proxyServers меняются одной записью реестра. Либо видны все новые
   связи, либо память и файл остаются в точности прежними. */
function updateMany(updates) {
  const changes = [];
  const seen = new Set();
  for (const item of updates || []) {
    if (!item || seen.has(item.id)) continue;
    const server = get(item.id);
    if (!server) continue;
    seen.add(item.id);
    const patch = item.patch || {};
    const before = {};
    const existed = {};
    for (const key of Object.keys(patch)) {
      existed[key] = Object.prototype.hasOwnProperty.call(server, key);
      before[key] = server[key];
    }
    changes.push({ server, patch, before, existed });
    Object.assign(server, patch);
  }
  try { save(); }
  catch (e) {
    for (const change of changes) {
      for (const key of Object.keys(change.patch)) {
        if (change.existed[key]) change.server[key] = change.before[key];
        else delete change.server[key];
      }
    }
    throw e;
  }
  return changes.map((change) => change.server);
}

function remove(id) {
  const list = load().servers;
  const i = list.findIndex((s) => s.id === id);
  if (i >= 0) {
    const removed = list.splice(i, 1)[0];
    try { save(); }
    catch (e) { list.splice(i, 0, removed); throw e; }
  }
}

module.exports = { all, get, add, update, updateMany, remove };
