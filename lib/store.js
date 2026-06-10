'use strict';
const fs = require('fs');
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
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2));
}

function all() {
  return load().servers;
}

function get(id) {
  return load().servers.find((s) => s.id === id) || null;
}

function add(server) {
  load().servers.push(server);
  save();
}

function update(id, patch) {
  const server = get(id);
  if (!server) return null;
  Object.assign(server, patch);
  save();
  return server;
}

function remove(id) {
  const list = load().servers;
  const i = list.findIndex((s) => s.id === id);
  if (i >= 0) {
    list.splice(i, 1);
    save();
  }
}

module.exports = { all, get, add, update, remove };
