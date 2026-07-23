'use strict';
/* Минимальный ZIP-писатель без зависимостей (только zlib) — упаковывает папку в ZIP
   и стримит в поток (res). Каждый файл читается в память по одному: CRC32 + deflate
   считаются сразу, поэтому локальный заголовок пишется с готовыми размерами (без data
   descriptor). Память = самый большой ОДИН файл, а не весь архив. Для гигантских миров
   лучше «Бэкапы» (.tar.gz системным tar). ZIP открывается везде (Windows/mac/Linux). */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// --- CRC32 ---
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// --- DOS date/time из mtime ---
function dosDateTime(ms) {
  const d = new Date(ms);
  const year = Math.max(1980, d.getFullYear());
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  return { date: date & 0xFFFF, time: time & 0xFFFF };
}

const FLAG_UTF8 = 0x0800; // имена файлов в UTF-8

function localHeader(nameBuf, method, crc, csize, usize, date, time) {
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0);
  h.writeUInt16LE(20, 4);            // version needed
  h.writeUInt16LE(FLAG_UTF8, 6);     // general purpose flags
  h.writeUInt16LE(method, 8);        // 0 = store, 8 = deflate
  h.writeUInt16LE(time, 10);
  h.writeUInt16LE(date, 12);
  h.writeUInt32LE(crc, 14);
  h.writeUInt32LE(csize, 18);
  h.writeUInt32LE(usize, 22);
  h.writeUInt16LE(nameBuf.length, 26);
  h.writeUInt16LE(0, 28);            // extra length
  return Buffer.concat([h, nameBuf]);
}
function centralHeader(e) {
  const h = Buffer.alloc(46);
  h.writeUInt32LE(0x02014b50, 0);
  h.writeUInt16LE(20, 4);            // version made by
  h.writeUInt16LE(20, 6);            // version needed
  h.writeUInt16LE(FLAG_UTF8, 8);
  h.writeUInt16LE(e.method, 10);
  h.writeUInt16LE(e.time, 12);
  h.writeUInt16LE(e.date, 14);
  h.writeUInt32LE(e.crc, 16);
  h.writeUInt32LE(e.csize, 20);
  h.writeUInt32LE(e.usize, 24);
  h.writeUInt16LE(e.nameBuf.length, 28);
  h.writeUInt16LE(0, 30);            // extra
  h.writeUInt16LE(0, 32);            // comment
  h.writeUInt16LE(0, 34);            // disk start
  h.writeUInt16LE(0, 36);            // internal attrs
  // внешние атрибуты: unix-права в старших 16 битах + флаг каталога (0x10) в младших
  const extAttr = e.dir ? ((0o40755 << 16) >>> 0) | 0x10 : (0o100644 << 16) >>> 0;
  h.writeUInt32LE(extAttr >>> 0, 38);
  h.writeUInt32LE(e.offset, 42);
  return Buffer.concat([h, e.nameBuf]);
}
function endRecord(count, cdSize, cdOffset) {
  const h = Buffer.alloc(22);
  h.writeUInt32LE(0x06054b50, 0);
  h.writeUInt16LE(0, 4);             // disk
  h.writeUInt16LE(0, 6);             // cd disk
  h.writeUInt16LE(count & 0xFFFF, 8);
  h.writeUInt16LE(count & 0xFFFF, 10);
  h.writeUInt32LE(cdSize, 12);
  h.writeUInt32LE(cdOffset, 14);
  h.writeUInt16LE(0, 18);            // comment length
  return h;
}

// запись с учётом backpressure (иначе большой архив забьёт память Node)
function write(stream, buf) {
  return new Promise((resolve, reject) => {
    if (stream.destroyed) return reject(new Error('поток закрыт'));
    const ok = stream.write(buf);
    if (ok) resolve();
    else stream.once('drain', resolve);
  });
}

/* Упаковать директорию rootDir в ZIP и записать в stream (например, res). */
async function zipDirToStream(rootDir, stream) {
  const entries = []; // порядок обхода
  (function walk(dir, rel) {
    let list;
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of list) {
      const abs = path.join(dir, e.name);
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { entries.push({ abs, rel: r + '/', dir: true }); walk(abs, r); }
      else if (e.isFile()) entries.push({ abs, rel: r, dir: false });
    }
  })(rootDir, '');

  const central = [];
  let offset = 0;
  for (const f of entries) {
    const nameBuf = Buffer.from(f.rel, 'utf8');
    let mtime = Date.now();
    try { mtime = fs.statSync(f.abs).mtimeMs; } catch (e) { /* нет — берём now */ }
    const { date, time } = dosDateTime(mtime);
    if (f.dir) {
      const lfh = localHeader(nameBuf, 0, 0, 0, 0, date, time);
      await write(stream, lfh);
      central.push({ nameBuf, crc: 0, csize: 0, usize: 0, offset, date, time, method: 0, dir: true });
      offset += lfh.length;
      continue;
    }
    let data;
    try { data = fs.readFileSync(f.abs); } catch (e) { continue; } // пропали при обходе — пропускаем
    const crc = crc32(data);
    let method = 8;
    let body;
    try { body = zlib.deflateRawSync(data); if (body.length >= data.length) { method = 0; body = data; } }
    catch (e) { method = 0; body = data; }
    const lfh = localHeader(nameBuf, method, crc, body.length, data.length, date, time);
    const start = offset;
    await write(stream, lfh);
    await write(stream, body);
    offset += lfh.length + body.length;
    central.push({ nameBuf, crc, csize: body.length, usize: data.length, offset: start, date, time, method, dir: false });
  }

  const cdStart = offset;
  for (const c of central) {
    const cd = centralHeader(c);
    await write(stream, cd);
    offset += cd.length;
  }
  await write(stream, endRecord(central.length, offset - cdStart, cdStart));
  stream.end();
}

module.exports = { zipDirToStream };
