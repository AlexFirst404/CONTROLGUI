'use strict';
// Скачивание и установка Java (Eclipse Temurin / Adoptium) силами панели —
// когда в системе нет нужной Java. JRE распаковывается в DATA_ROOT/runtime,
// откуда его подхватывает lib/javas.js. Кроссплатформенно (Windows/Linux/mac).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const dl = require('./download');
const javas = require('./javas');
const { DATA_ROOT } = require('./paths');

const IS_WIN = process.platform === 'win32';

// На Windows форсируем РОДНОЙ bsdtar из System32: в PATH может оказаться GNU/MSYS
// tar (Git for Windows), который НЕ умеет читать .zip — распаковка Java упадёт.
// bsdtar читает и zip, и tar.gz. На остальных ОС — системный tar.
function tarBin() {
  if (IS_WIN) {
    const sys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    try { if (fs.existsSync(sys)) return sys; } catch (e) { /* */ }
  }
  return 'tar';
}

function osTag() {
  if (IS_WIN) return 'windows';
  if (process.platform === 'darwin') return 'mac';
  return 'linux';
}
function archTag() {
  return process.arch === 'arm64' ? 'aarch64' : 'x64';
}
// Adoptium v3 API: редиректит на актуальный JRE-архив (zip для Windows, tar.gz иначе)
function adoptiumUrl(major) {
  const os = osTag();
  let arch = archTag();
  if (arch === 'aarch64') {
    // старых Temurin под ARM нет: mac/aarch64 — только 17+, windows/aarch64 — только 21;
    // берём x64 — на mac работает через Rosetta 2, на Windows 11 ARM — через эмуляцию
    if (os === 'mac' && major < 17) arch = 'x64';
    if (os === 'windows' && major < 21) arch = 'x64';
  }
  return 'https://api.adoptium.net/v3/binary/latest/' + major +
    '/ga/' + os + '/' + arch + '/jre/hotspot/normal/eclipse';
}

const runtimeDir = () => path.join(DATA_ROOT, 'runtime');

// найти java-бинарник нужного мажора среди распакованных в runtime
function findManagedJava(major) {
  let entries = [];
  try { entries = fs.readdirSync(runtimeDir()); } catch (e) { return null; }
  const bin = IS_WIN ? 'java.exe' : 'java';
  const hits = [];
  for (const e of entries) {
    for (const sub of [['bin'], ['jre', 'bin'], ['Contents', 'Home', 'bin']]) {
      const jp = path.join(runtimeDir(), e, ...sub, bin);
      try { if (fs.existsSync(jp)) hits.push({ name: e, path: jp }); } catch (x) { /* */ }
    }
  }
  if (!hits.length) return null;
  // строго свой мажор: Temurin 8 распаковывается в jdk8u..., 11+ — в jdk-11...;
  // возвращать «хоть какую-то» java нельзя — не тот мажор ломает запуск
  const pref = hits.find((h) => h.name.includes('jdk-' + major) || h.name.includes('-' + major + '.') || h.name.startsWith('jdk' + major + 'u'));
  return pref ? pref.path : null;
}

const state = { phase: 'idle', major: null, progress: 0, doneBytes: 0, totalBytes: 0, error: null, path: null };

function getState() { return state; }

function installJava(majorIn) {
  const major = [8, 11, 17, 21].includes(parseInt(majorIn, 10)) ? parseInt(majorIn, 10) : 21;
  if (state.phase === 'downloading' || state.phase === 'extracting') return state;

  Object.assign(state, { phase: 'downloading', major, progress: 0, doneBytes: 0, totalBytes: 0, error: null, path: null });
  (async () => {
    try {
      fs.mkdirSync(runtimeDir(), { recursive: true });
      const archive = path.join(runtimeDir(), 'temurin-' + major + (IS_WIN ? '.zip' : '.tar.gz'));
      await dl.downloadFile(adoptiumUrl(major), archive, (done, total) => {
        state.doneBytes = done;
        state.totalBytes = total;
        state.progress = total ? done / total : 0;
      });

      state.phase = 'extracting';
      // системный tar: bsdtar на Windows читает zip, GNU tar на Linux — tar.gz
      const args = IS_WIN ? ['-xf', archive, '-C', runtimeDir()] : ['-xzf', archive, '-C', runtimeDir()];
      const r = spawnSync(tarBin(), args, { encoding: 'utf8', windowsHide: true });
      if (r.status !== 0) {
        throw new Error('Не удалось распаковать Java (нужен tar): ' + (r.stderr || (r.error && r.error.message) || 'ошибка tar'));
      }
      try { fs.unlinkSync(archive); } catch (e) { /* */ }

      javas.clearCache();
      // проверяем реальный мажор запуском java -version (javas.findJava),
      // а не по имени папки — иначе можно вернуть java не той версии
      const jp = javas.findJava(major) || findManagedJava(major);
      if (!jp) throw new Error('Java распакована, но java ' + major + ' не найдена');
      state.path = jp;
      state.phase = 'done';
      state.progress = 1;
    } catch (e) {
      state.phase = 'error';
      state.error = e.message;
    }
  })();
  return state;
}

/* Установка с ожиданием: возвращает путь к java или бросает ошибку.
   Если установка уже идёт (в т.ч. другого мажора) — сперва дожидается её.
   onProgress(state) зовётся каждые полсекунды, пока идёт скачивание/распаковка. */
async function installJavaAndWait(major, onProgress) {
  const waitIdle = () => new Promise((resolve) => {
    const t = setInterval(() => {
      if (onProgress) { try { onProgress(state); } catch (e) { /* */ } }
      if (state.phase !== 'downloading' && state.phase !== 'extracting') { clearInterval(t); resolve(); }
    }, 500);
    if (t.unref) t.unref();
  });
  if (state.phase === 'downloading' || state.phase === 'extracting') await waitIdle();
  // реальная проверка мажора через java -version: свежая пересканировка
  // подхватит и установку, завершённую параллельным запросом
  javas.clearCache();
  const existing = javas.findJava(major);
  if (existing) return existing;
  installJava(major);
  await waitIdle();
  if (state.phase === 'done' && state.path) return state.path;
  throw new Error(state.error || 'Не удалось установить Java');
}

module.exports = { installJava, installJavaAndWait, getState, findManagedJava };
