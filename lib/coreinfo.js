'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

/* Определение версии Minecraft из server.jar и чтение отдельных файлов из jar.
   jar — это zip. На Windows системный tar — это bsdtar, который читает zip.
   На Linux `tar` — GNU tar и zip НЕ читает, поэтому пробуем bsdtar, затем unzip. */

const IS_WIN = process.platform === 'win32';
const MAX_ENTRY_BYTES = 2 * 1024 * 1024;

// На Windows форсируем РОДНОЙ bsdtar из System32: в PATH может оказаться GNU/MSYS
// tar (Git for Windows), который не умеет читать .zip/.jar (как в backups.js/javainstall.js).
function tarBin() {
  if (IS_WIN) {
    const sys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    try { if (fs.existsSync(sys)) return sys; } catch (e) { /* */ }
  }
  return 'tar';
}

// команды для извлечения одного файла из zip/jar в stdout, по приоритету для ОС
function zipReaders(jarPath, entry) {
  const tar = [tarBin(), ['-xOf', jarPath, entry]];
  const bsdtar = ['bsdtar', ['-xOf', jarPath, entry]];
  const unzip = ['unzip', ['-p', jarPath, entry]];
  return IS_WIN ? [tar] : [bsdtar, unzip, tar];
}

function runRead(cmd, args) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let done = false;
    let proc;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    try {
      proc = spawn(cmd, args, { windowsHide: true });
    } catch (e) { return finish(null); }
    proc.stdout.on('data', (d) => {
      if (done) return;
      size += d.length;
      // Метаданные ядра малы; лимит не даёт подменённому JAR занять память панели.
      if (size > MAX_ENTRY_BYTES) {
        try { proc.kill(); } catch (e) { /* процесс уже завершился */ }
        finish(null);
        return;
      }
      chunks.push(d);
    });
    proc.stderr.resume();
    proc.on('error', () => finish(null));
    // Ждём закрытия потоков, чтобы не потерять последний фрагмент stdout.
    proc.on('close', (code) => finish(code === 0 && size ? Buffer.concat(chunks, size).toString('utf8') : null));
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
