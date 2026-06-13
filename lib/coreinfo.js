'use strict';
const { spawn } = require('child_process');

/* Определение версии Minecraft из server.jar. В jar лежит version.json
   ({"id":"1.21.4", ...}) у vanilla/paper/purpur/folia. Извлекаем его из
   jar (это zip) системным tar/bsdtar, который умеет читать zip. */

function extractFromJar(jarPath, entry) {
  return new Promise((resolve) => {
    let out = Buffer.alloc(0);
    let proc;
    try {
      proc = spawn('tar', ['-xOf', jarPath, entry], { windowsHide: true });
    } catch (e) { return resolve(null); }
    proc.stdout.on('data', (d) => { out = Buffer.concat([out, d]); });
    proc.on('error', () => resolve(null));
    proc.on('exit', (code) => resolve(code === 0 && out.length ? out.toString('utf8') : null));
  });
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
