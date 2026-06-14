'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

/* Поиск установленных Java и их мажорных версий. Старые версии Minecraft/Forge
   требуют конкретную Java (например, ≤1.16.5 и Forge 1.12.2 — только Java 8),
   а в PATH часто стоит новая. Подбираем подходящий java.exe. */

const IS_WIN = process.platform === 'win32';
let cache = null;

function parseMajor(text) {
  const m = String(text).match(/version "([^"]+)"/);
  const v = m ? m[1] : String(text).trim();
  const parts = v.replace(/[_-].*$/, '').split('.').map((n) => parseInt(n, 10) || 0);
  if (parts[0] === 1) return parts[1] || 0; // старый формат 1.8.0_x → 8
  return parts[0] || 0;
}

function probe(javaPath) {
  try {
    const out = spawnSync(javaPath, ['-version'], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    const text = (out.stderr || '') + (out.stdout || '');
    const m = text.match(/version "([^"]+)"/);
    if (!m) return null;
    return { path: javaPath, version: m[1], major: parseMajor(text) };
  } catch (e) { return null; }
}

function candidatePaths() {
  const found = new Set(['java']); // из PATH
  if (IS_WIN) {
    const roots = [
      'C:\\Program Files\\Java', 'C:\\Program Files\\Eclipse Adoptium',
      'C:\\Program Files\\Microsoft', 'C:\\Program Files\\Zulu',
      'C:\\Program Files\\Amazon Corretto', 'C:\\Program Files\\BellSoft',
      'C:\\Program Files\\Temurin', 'C:\\Program Files (x86)\\Java',
    ];
    for (const root of roots) {
      let entries = [];
      try { entries = fs.readdirSync(root); } catch (e) { continue; }
      for (const e of entries) {
        for (const sub of [['bin'], ['jre', 'bin']]) {
          const jp = path.join(root, e, ...sub, 'java.exe');
          try { if (fs.existsSync(jp)) found.add(jp); } catch (x) { /* */ }
        }
      }
    }
  } else {
    // Linux/macOS: стандартные каталоги установки JDK
    const roots = ['/usr/lib/jvm', '/usr/lib64/jvm', '/opt/java', '/opt',
      '/usr/java', '/Library/Java/JavaVirtualMachines'];
    for (const root of roots) {
      let entries = [];
      try { entries = fs.readdirSync(root); } catch (e) { continue; }
      for (const e of entries) {
        for (const sub of [['bin'], ['jre', 'bin'], ['Contents', 'Home', 'bin']]) {
          const jp = path.join(root, e, ...sub, 'java');
          try { if (fs.existsSync(jp)) found.add(jp); } catch (x) { /* */ }
        }
      }
    }
  }
  if (process.env.JAVA_HOME) {
    const jp = path.join(process.env.JAVA_HOME, 'bin', IS_WIN ? 'java.exe' : 'java');
    try { if (fs.existsSync(jp)) found.add(jp); } catch (e) { /* */ }
  }
  // Java, скачанная самой панелью (lib/javainstall.js) — DATA_ROOT/runtime/*
  try {
    const { DATA_ROOT } = require('./paths');
    const runtimeDir = path.join(DATA_ROOT, 'runtime');
    for (const e of fs.readdirSync(runtimeDir)) {
      for (const sub of [['bin'], ['jre', 'bin'], ['Contents', 'Home', 'bin']]) {
        const jp = path.join(runtimeDir, e, ...sub, IS_WIN ? 'java.exe' : 'java');
        try { if (fs.existsSync(jp)) found.add(jp); } catch (x) { /* */ }
      }
    }
  } catch (e) { /* нет runtime */ }
  return Array.from(found);
}

function detect() {
  if (cache) return cache;
  const byMajor = new Map();
  for (const p of candidatePaths()) {
    const info = probe(p);
    if (!info || !info.major) continue;
    // на каждый мажор — первый найденный (PATH идёт первым)
    if (!byMajor.has(info.major)) byMajor.set(info.major, info);
  }
  cache = Array.from(byMajor.values()).sort((a, b) => a.major - b.major);
  return cache;
}

/* Путь к java нужного мажора, либо null. */
function findJava(major) {
  const hit = detect().find((j) => j.major === major);
  return hit ? hit.path : null;
}

function listJavas() {
  return detect().map((j) => ({ path: j.path, major: j.major, version: j.version }));
}

/* Какая Java нужна для версии Minecraft. null — не навязываем (неизвестно). */
function requiredJavaMajor(mcVersion) {
  const m = String(mcVersion || '').match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  const maj = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const patch = parseInt(m[3] || '0', 10);
  if (maj !== 1) return 21;        // нестандартная/будущая → новейшая
  if (min <= 16) return 8;         // ≤1.16.5
  if (min < 20) return 17;         // 1.17–1.19
  if (min === 20) return patch >= 5 ? 21 : 17; // 1.20.5+ → 21
  return 21;                        // 1.21+
}

function clearCache() { cache = null; }

module.exports = { findJava, listJavas, requiredJavaMajor, parseMajor, clearCache };
