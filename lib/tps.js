'use strict';
const fs = require('fs');
const path = require('path');

function numberTps(raw) {
  const value = Number(String(raw || '').replace(',', '.'));
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.min(20, Math.round(value * 1000) / 1000);
}

/* Форматы Paper/Spigot/Arclight и Forge/NeoForge различаются. Возвращаем
   «overall» отдельно: в Forge перед общей строкой идут TPS каждого измерения. */
function parseLine(line, waitingForValues) {
  const text = String(line || '');
  let m = text.match(/\bOverall\s*:.*?\bMean TPS\s*:\s*\*?([0-9]+(?:[.,][0-9]+)?)/i);
  if (m) return { tps: numberTps(m[1]), kind: 'overall' };
  m = text.match(/\bMean TPS\s*:\s*\*?([0-9]+(?:[.,][0-9]+)?)/i);
  if (m) return { tps: numberTps(m[1]), kind: 'dimension' };

  const header = /\bTPS from last\b/i.test(text);
  if (header) {
    const tail = text.slice(text.search(/\bTPS from last\b/i)).replace(/^.*?:/, '');
    m = tail.match(/\*?([0-9]+(?:[.,][0-9]+)?)/);
    if (m) return { tps: numberTps(m[1]), kind: 'rolling' };
    return { header: true };
  }
  if (waitingForValues) {
    m = text.trim().match(/^\*?([0-9]+(?:[.,][0-9]+)?)(?:\s*,|\s*$)/);
    if (m) return { tps: numberTps(m[1]), kind: 'rolling' };
  }
  m = text.match(/\b(?:Current\s+)?TPS\s*(?:=|:)\s*\*?([0-9]+(?:[.,][0-9]+)?)/i);
  if (m) return { tps: numberTps(m[1]), kind: 'rolling' };
  return null;
}

function launchText(server) {
  const launch = server && server.launch;
  const target = launch && Array.isArray(launch.target) ? launch.target.join('/') : (launch && launch.target);
  return [server && server.type, server && server.jarFile, target].filter(Boolean).join(' ').toLowerCase();
}

function rootHints(serverRoot) {
  let names = '';
  try { names = fs.readdirSync(serverRoot).join(' ').toLowerCase(); } catch (e) { /* импорт ещё не готов */ }
  let log = '';
  try {
    const file = path.join(serverRoot, 'logs', 'latest.log');
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(64 * 1024);
      const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
      log = buffer.subarray(0, read).toString('utf8').toLowerCase();
    } finally { fs.closeSync(fd); }
  } catch (e) { /* лог появится после запуска */ }
  return {
    names,
    neo: fs.existsSync(path.join(serverRoot, 'libraries', 'net', 'neoforged')),
    forge: fs.existsSync(path.join(serverRoot, 'libraries', 'net', 'minecraftforge')),
    arclight: fs.existsSync(path.join(serverRoot, 'libraries', 'io', 'izzel', 'arclight')) ||
      /\barclight\b/.test(log),
    log,
  };
}

function commandsFor(server, serverRoot) {
  const type = String(server && server.type || '').toLowerCase();
  if (['paper', 'purpur', 'folia', 'mohist'].includes(type)) return ['tps'];

  const text = launchText(server);
  const hints = rootHints(serverRoot);
  const arclight = type === 'arclight' || /arclight/.test(text) || /arclight/.test(hints.names) || hints.arclight;
  const neo = type === 'neoforge' || /neoforge|neoforged/.test(text) ||
    /neoforge/.test(hints.names) || /\bneoforge\b/.test(hints.log) || hints.neo;
  const forge = type === 'forge' || /(?:^|[\s/_.-])forge(?:[\s/_.-]|$)/.test(text) ||
    /forge/.test(hints.names) || /\bforge\b/.test(hints.log) || hints.forge;
  if (arclight) return ['tps', neo ? 'neoforge tps' : 'forge tps'];
  if (neo) return ['neoforge tps', 'forge tps', 'tps'];
  if (forge) return ['forge tps', 'neoforge tps', 'tps'];
  return [];
}

function isCommandError(line, command) {
  const text = String(line || '').trim().toLowerCase();
  const expected = String(command || '').trim().toLowerCase().replace(/^\//, '');
  if (!expected) return false;
  const here = text.indexOf('<--[here]');
  if (here !== -1 && text.slice(0, here).trim().replace(/^\//, '').endsWith(expected)) return true;
  // Общая строка «Unknown command» без самой команды может относиться к ручному
  // вводу пользователя; её не гасим и полагаемся на таймаут автоопроса.
  return text.includes(expected) &&
    /unknown (?:or incomplete )?command|unknown command|неизвестн(?:ая|ую) команд/i.test(text);
}

module.exports = { parseLine, commandsFor, isCommandError };
