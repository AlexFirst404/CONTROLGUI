'use strict';
/* Каталог загрузок приложения. Файлы инсталляторов кладутся в data/downloads/
   (папка вне git — деплой `git archive` их не трогает). Манифест НЕ ведём вручную:
   список строится сканированием каталога + разбором имён файлов, поэтому «выложить
   новую версию» = просто скопировать файл в data/downloads/. Без зависимостей. */
const fs = require('fs');
const path = require('path');
const store = require('./store');

const DIR = path.join(store.DATA, 'downloads');

/* Разбор одного имени файла инсталлятора -> платформа/версия/арх или null. */
function classify(name) {
  const low = name.toLowerCase();
  const vm = name.match(/(\d+\.\d+\.\d+)/);
  const version = vm ? vm[1] : '0.0.0';
  const arch = /(arm64|aarch64)/i.test(name) ? 'arm64' : 'x64';
  let os = null; let label = null; let order = 99;
  if (low.endsWith('.exe')) { os = 'windows'; label = 'Windows'; order = 0; }
  else if (low.endsWith('.deb')) { os = 'linux-deb'; label = 'Linux · .deb'; order = 1; }
  else if (low.endsWith('.appimage')) { os = 'linux-appimage'; label = 'Linux · AppImage'; order = 2; }
  else if (low.endsWith('.pkg') || low.endsWith('.dmg')) { os = 'macos'; label = 'macOS'; order = 3; }
  else return null;
  return { name, os, label, arch, version, order };
}

/* Сравнение семвер-строк «a.b.c» по убыванию (новые сверху). */
function cmpVer(a, b) {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i += 1) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pb[i] || 0) - (pa[i] || 0); }
  return 0;
}

/* Список версий с файлами, новые сверху. */
function list() {
  let names = [];
  try { names = fs.readdirSync(DIR); } catch (e) { return []; }
  const byVer = new Map();
  for (const n of names) {
    if (n.startsWith('.') || n.endsWith('.tmp')) continue;
    const c = classify(n);
    if (!c) continue;
    let size = 0; let mtime = 0;
    try { const st = fs.statSync(path.join(DIR, n)); if (!st.isFile()) continue; size = st.size; mtime = st.mtimeMs; } catch (e) { continue; }
    const arr = byVer.get(c.version) || [];
    arr.push({ name: c.name, os: c.os, label: c.label, arch: c.arch, size, mtime, order: c.order,
      url: '/downloads/' + encodeURIComponent(c.name) });
    byVer.set(c.version, arr);
  }
  const versions = Array.from(byVer.keys()).sort(cmpVer).map((version) => {
    const files = byVer.get(version).sort((a, b) => a.order - b.order || a.arch.localeCompare(b.arch));
    const date = files.reduce((mx, f) => Math.max(mx, f.mtime), 0);
    return { version, date, files: files.map((f) => ({ name: f.name, os: f.os, label: f.label, arch: f.arch, size: f.size, url: f.url })) };
  });
  return versions;
}

/* Валидный ли запрошенный файл (защита от обхода пути): один сегмент, реально есть в DIR. */
function resolveFile(rawName) {
  const name = decodeURIComponent(String(rawName || ''));
  if (!name || name.indexOf('/') !== -1 || name.indexOf('\\') !== -1 || name.indexOf('\0') !== -1 || name.indexOf('..') !== -1) return null;
  const full = path.join(DIR, name);
  if (path.dirname(full) !== DIR) return null; // на всякий: только прямые дети DIR
  try { const st = fs.statSync(full); if (!st.isFile()) return null; return { full, size: st.size, name }; } catch (e) { return null; }
}

module.exports = { DIR, list, resolveFile };
