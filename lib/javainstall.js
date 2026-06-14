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
  return 'https://api.adoptium.net/v3/binary/latest/' + major +
    '/ga/' + osTag() + '/' + archTag() + '/jre/hotspot/normal/eclipse';
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
  const pref = hits.find((h) => h.name.includes('jdk-' + major) || h.name.includes('-' + major + '.'));
  return (pref || hits[0]).path;
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
      const r = spawnSync('tar', args, { encoding: 'utf8', windowsHide: true });
      if (r.status !== 0) {
        throw new Error('Не удалось распаковать Java (нужен tar): ' + (r.stderr || (r.error && r.error.message) || 'ошибка tar'));
      }
      try { fs.unlinkSync(archive); } catch (e) { /* */ }

      javas.clearCache();
      const jp = findManagedJava(major);
      if (!jp) throw new Error('Java распакована, но java-бинарник не найден');
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

module.exports = { installJava, getState, findManagedJava };
