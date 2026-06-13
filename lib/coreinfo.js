'use strict';
const { spawn } = require('child_process');

/* Определение версии Minecraft из server.jar и чтение отдельных файлов из jar.
   jar — это zip. На Windows системный tar — это bsdtar, который читает zip.
   На Linux `tar` — GNU tar и zip НЕ читает, поэтому пробуем bsdtar, затем unzip. */

const IS_WIN = process.platform === 'win32';

// команды для извлечения одного файла из zip/jar в stdout, по приоритету для ОС
function zipReaders(jarPath, entry) {
  const tar = ['tar', ['-xOf', jarPath, entry]];
  const bsdtar = ['bsdtar', ['-xOf', jarPath, entry]];
  const unzip = ['unzip', ['-p', jarPath, entry]];
  return IS_WIN ? [tar] : [bsdtar, unzip, tar];
}

function runRead(cmd, args) {
  return new Promise((resolve) => {
    let out = Buffer.alloc(0);
    let proc;
    try {
      proc = spawn(cmd, args, { windowsHide: true });
    } catch (e) { return resolve(null); }
    proc.stdout.on('data', (d) => { out = Buffer.concat([out, d]); });
    proc.on('error', () => resolve(null));
    proc.on('exit', (code) => resolve(code === 0 && out.length ? out.toString('utf8') : null));
  });
}

async function extractFromJar(jarPath, entry) {
  for (const [cmd, args] of zipReaders(jarPath, entry)) {
    const res = await runRead(cmd, args);
    if (res) return res;
  }
  return null;
}

async function detectVersion(jarPath) {
  // 1) version.json в корне (vanilla/paper/purpur/folia)
  const vj = await extractFromJar(jarPath, 'version.json');
  if (vj) {
    try {
      const j = JSON.parse(vj);
      if (j && j.id) return String(j.id);
      if (j && j.name) return String(j.name);
    } catch (e) { /* не json */ }
  }
  // 2) build.properties / META-INF — пробуем найти строку версии MC
  const mf = await extractFromJar(jarPath, 'META-INF/MANIFEST.MF');
  if (mf) {
    const m = mf.match(/(?:Implementation-Version|Specification-Version):\s*([\w.\-]+)/i);
    if (m) return m[1];
  }
  return null;
}

module.exports = { detectVersion, extractFromJar };
