'use strict';
/* Сборка .deb-пакетов панели CONTROLGUI на чистом Node (без dpkg-deb и tar) —
   работает на любой ОС. .deb = ar-архив из debian-binary + control.tar.gz + data.tar.gz.

   Запуск:
     node linux/build-deb.js          # единый пакет controlgui
     node linux/build-deb.js 1.4.1    # с указанием версии
   Режим открытия (приложение/браузер) выбирается при первом запуске. */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const VERSION = process.argv[2] || '1.6.6';
const MTIME = 1700000000; // фиксированное время для воспроизводимости

// ----------------------------------------------------------------- ustar tar ---
function octal(n, width) {
  let s = (n >>> 0).toString(8);
  while (s.length < width - 1) s = '0' + s;
  return Buffer.from(s.slice(0, width - 1) + '\0', 'ascii');
}
function tarHeader(name, size, mode, type) {
  const h = Buffer.alloc(512);
  Buffer.from(name, 'utf8').copy(h, 0, 0, 100);
  octal(mode, 8).copy(h, 100);
  octal(0, 8).copy(h, 108);
  octal(0, 8).copy(h, 116);
  octal(size, 12).copy(h, 124);
  octal(MTIME, 12).copy(h, 136);
  h.write('        ', 148, 8, 'ascii');
  h.write(type, 156, 1, 'ascii');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  h.write('root', 265, 4, 'ascii');
  h.write('root', 297, 4, 'ascii');
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i];
  Buffer.from(sum.toString(8).padStart(6, '0') + '\0 ', 'ascii').copy(h, 148);
  return h;
}
function buildTar(entries) {
  const parts = [];
  for (const e of entries) {
    if (e.type === '5') {
      parts.push(tarHeader(e.name.endsWith('/') ? e.name : e.name + '/', 0, e.mode, '5'));
    } else {
      parts.push(tarHeader(e.name, e.data.length, e.mode, '0'));
      parts.push(e.data);
      const pad = (512 - (e.data.length % 512)) % 512;
      if (pad) parts.push(Buffer.alloc(pad));
    }
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

// --------------------------------------------------------------------- ar -----
function arMember(name, data) {
  const h = Buffer.alloc(60, 0x20);
  h.write(name, 0, 'ascii');
  h.write(String(MTIME), 16, 'ascii');
  h.write('0', 28, 'ascii');
  h.write('0', 34, 'ascii');
  h.write('100644', 40, 'ascii');
  h.write(String(data.length), 48, 'ascii');
  h.write('`\n', 58, 'ascii');
  const out = [h, data];
  if (data.length % 2) out.push(Buffer.from('\n', 'ascii'));
  return Buffer.concat(out);
}

// ------------------------------------------------------- дерево пакета ---------
function makeTree() {
  const entries = [];
  const dirs = new Set();
  function addDir(name) {
    if (!name || dirs.has(name)) return;
    const parent = name.replace(/\/+$/, '').split('/').slice(0, -1).join('/');
    if (parent && parent !== '.') addDir(parent + '/');
    dirs.add(name);
    entries.push({ name, type: '5', mode: 0o755 });
  }
  function addFile(destRel, srcAbs, mode) {
    const dir = path.posix.dirname(destRel);
    if (dir && dir !== '.') addDir('./' + dir + '/');
    entries.push({ name: './' + destRel, type: '0', mode, data: fs.readFileSync(srcAbs) });
  }
  function addTree(srcAbs, destRel) {
    for (const e of fs.readdirSync(srcAbs, { withFileTypes: true })) {
      const s = path.join(srcAbs, e.name);
      const d = destRel + '/' + e.name;
      if (e.isDirectory()) addTree(s, d);
      else if (e.isFile()) addFile(d, s, 0o644);
    }
  }
  return { entries, addFile, addTree };
}

function panel(t) {
  t.addFile('opt/controlgui/server.js', path.join(ROOT, 'server.js'), 0o644);
  t.addTree(path.join(ROOT, 'lib'), 'opt/controlgui/lib');
  t.addTree(path.join(ROOT, 'public'), 'opt/controlgui/public');
  // окно WebKitGTK для режима «приложение» (общее с AppImage)
  t.addFile('opt/controlgui/controlgui-window.py', path.join(__dirname, 'appimage', 'controlgui-window.py'), 0o644);
  for (const extra of ['package.json', 'LICENSE', 'README.md']) {
    const p = path.join(ROOT, extra);
    if (fs.existsSync(p)) t.addFile('opt/controlgui/' + extra, p, 0o644);
  }
}
function icons(t) {
  const icon = path.join(ROOT, 'public', 'assets', 'controlgui.png');
  for (const sz of ['16x16', '32x32', '48x48', '256x256']) {
    t.addFile('usr/share/icons/hicolor/' + sz + '/apps/controlgui.png', icon, 0o644);
  }
}

function buildPackage() {
  const t = makeTree();
  panel(t);
  t.addFile('usr/bin/controlgui', path.join(__dirname, 'controlgui'), 0o755);
  t.addFile('usr/share/applications/controlgui.desktop', path.join(__dirname, 'controlgui.desktop'), 0o644);
  icons(t);

  const dataEntries = t.entries;
  const installedSizeKb = Math.ceil(dataEntries.reduce((a, e) => a + (e.data ? e.data.length : 0), 0) / 1024);
  const dataTarGz = zlib.gzipSync(buildTar(dataEntries));

  const control = fs.readFileSync(path.join(__dirname, 'DEBIAN', 'control'), 'utf8')
    .replace('__VERSION__', VERSION)
    .replace('__SIZE__', String(installedSizeKb));
  const postinst = fs.readFileSync(path.join(__dirname, 'DEBIAN', 'postinst'));
  const prerm = fs.readFileSync(path.join(__dirname, 'DEBIAN', 'prerm'));
  const postrm = fs.readFileSync(path.join(__dirname, 'DEBIAN', 'postrm'));
  const controlTarGz = zlib.gzipSync(buildTar([
    { name: './control', type: '0', mode: 0o644, data: Buffer.from(control, 'utf8') },
    { name: './postinst', type: '0', mode: 0o755, data: postinst },
    { name: './prerm', type: '0', mode: 0o755, data: prerm },
    { name: './postrm', type: '0', mode: 0o755, data: postrm },
  ]));

  const deb = Buffer.concat([
    Buffer.from('!<arch>\n', 'ascii'),
    arMember('debian-binary   ', Buffer.from('2.0\n', 'ascii')),
    arMember('control.tar.gz  ', controlTarGz),
    arMember('data.tar.gz     ', dataTarGz),
  ]);
  const outName = 'controlgui_' + VERSION + '_all.deb';
  fs.writeFileSync(path.join(__dirname, outName), deb);
  console.log('Собран ' + outName + ' (' + Math.round(deb.length / 1024) + ' КБ, файлов: ' +
    dataEntries.filter((e) => e.type === '0').length + ', установленный размер: ' + installedSizeKb + ' КБ)');
}

buildPackage();
