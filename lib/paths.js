'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');

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

/* Однократный перенос данных из старой раскладки. Раньше обёртки (Windows-
   приложение) не задавали CONTROLGUI_DATA, и данные жили внутри версионной
   папки панели <корень>/app/<версия> — при обновлении версии «терялись».
   Теперь корень един; при первом запуске с пустым реестром забираем данные
   из самой свежей версионной папки (реестр, серверы, бэкапы). */
function migrateLegacyData() {
  try {
    if (!process.env.CONTROLGUI_DATA) return;
    if (fs.existsSync(REGISTRY_FILE)) return; // данные нового формата уже есть
    const appRoot = path.join(DATA_ROOT, 'app');
    if (!fs.existsSync(appRoot)) return;
    let best = null;
    for (const name of fs.readdirSync(appRoot)) {
      const reg = path.join(appRoot, name, 'data', 'servers.json');
      try {
        const m = fs.statSync(reg).mtimeMs;
        if (!best || m > best.m) best = { dir: path.join(appRoot, name), m };
      } catch (e) { /* в этой версии реестра нет */ }
    }
    if (!best) return;
    for (const sub of ['data', 'servers', 'backups']) {
      const from = path.join(best.dir, sub);
      const to = path.join(DATA_ROOT, sub);
      if (!fs.existsSync(from)) continue;
      if (fs.existsSync(to)) {
        // пустую папку (создана прошлым пуском) убираем, непустую не трогаем
        try { if (fs.readdirSync(to).length === 0) fs.rmdirSync(to); else continue; } catch (e) { continue; }
      }
      fs.renameSync(from, to);
    }
    console.log('[ПАНЕЛЬ] Данные перенесены из ' + best.dir + ' в ' + DATA_ROOT);
  } catch (e) {
    console.error('[ПАНЕЛЬ] Перенос старых данных не удался: ' + e.message);
  }
}
migrateLegacyData();

for (const dir of [DATA_DIR, SERVERS_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function serverDir(id) {
  // сервер, импортированный «на месте», живёт в своей внешней папке (server.dir);
  // ленивый require — чтобы не было циклической зависимости paths<->store на загрузке.
  try { const s = require('./store').get(id); if (s && s.dir) return s.dir; } catch (e) { /* */ }
  return path.join(SERVERS_DIR, id);
}

// Режим открытия (app|browser) хранится в фиксированном per-user каталоге —
// чтобы и панель, и лаунчер (.exe / AppRun / .deb) читали один и тот же файл,
// независимо от того, где лежат данные серверов.
function launchModeDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || os.homedir(), 'CONTROLGUI');
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'controlgui');
}
function launchModeFile() {
  return path.join(launchModeDir(), 'launch-mode');
}
function readLaunchMode() {
  try {
    const m = fs.readFileSync(launchModeFile(), 'utf8').trim();
    return m === 'app' || m === 'browser' ? m : null;
  } catch (e) { return null; }
}
function writeLaunchMode(mode) {
  if (mode !== 'app' && mode !== 'browser') throw new Error('Режим: app или browser');
  fs.mkdirSync(launchModeDir(), { recursive: true });
  fs.writeFileSync(launchModeFile(), mode + '\n');
  return mode;
}

// Сворачивание в трей (Windows-обёртка читает этот файл). '1' = в трей, иначе обычное поведение.
function trayMinimizeFile() { return path.join(launchModeDir(), 'tray-minimize'); }
function readTrayMinimize() {
  try { return fs.readFileSync(trayMinimizeFile(), 'utf8').trim() === '1'; } catch (e) { return false; }
}
function writeTrayMinimize(on) {
  fs.mkdirSync(launchModeDir(), { recursive: true });
  fs.writeFileSync(trayMinimizeFile(), on ? '1' : '0');
  return !!on;
}

module.exports = {
  ROOT, DATA_ROOT, DATA_DIR, SERVERS_DIR, PUBLIC_DIR, REGISTRY_FILE, serverDir,
  launchModeFile, readLaunchMode, writeLaunchMode,
  trayMinimizeFile, readTrayMinimize, writeTrayMinimize,
};
