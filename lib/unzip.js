'use strict';

/* Минимальный чтец ZIP без внешних зависимостей (только встроенный zlib).
   Читает центральный каталог, затем каждую запись через её локальный заголовок.
   Поддержка: метод 0 (stored) и 8 (deflate), базовый ZIP64 (размеры/смещение
   в extra-поле 0x0001 и ZIP64 EOCD). Имена трактуем как UTF-8.
   Используется только для распаковки архивов в проводнике сервера; вызывающий
   код обязан прогонять каждое имя через safePath (zip-slip) и лимиты (zip-bomb). */

const zlib = require('zlib');

const EOCD_SIG = 0x06054b50;      // End Of Central Directory
const EOCD64_LOC_SIG = 0x07064b50; // ZIP64 EOCD locator
const EOCD64_SIG = 0x06064b50;    // ZIP64 EOCD
const CEN_SIG = 0x02014b50;       // Central directory file header
const LOC_SIG = 0x04034b50;       // Local file header

function findEOCD(buf) {
  // EOCD в самом конце; комментарий архива может быть до 65535 байт
  const start = buf.length - 22;
  const min = Math.max(0, buf.length - (22 + 0xffff));
  for (let i = start; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

// Возвращает массив записей: { name, method, compSize, uncompSize, localOffset }.
// maxEntries (если задан) жёстко обрывает разбор — чтобы вредоносный cdCount
// (через ZIP64) не заставил построить миллионы объектов до внешней проверки.
function readEntries(buf, maxEntries) {
  const eocd = findEOCD(buf);
  if (eocd < 0) throw new Error('не найден конец ZIP (EOCD)');
  let cdCount = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);

  // ZIP64: поля забиты 0xFFFF/0xFFFFFFFF — читаем ZIP64-структуры
  if (cdCount === 0xffff || cdOffset === 0xffffffff) {
    const locOff = eocd - 20;
    if (locOff >= 0 && buf.readUInt32LE(locOff) === EOCD64_LOC_SIG) {
      const z64 = Number(buf.readBigUInt64LE(locOff + 8));
      if (z64 >= 0 && z64 + 56 <= buf.length && buf.readUInt32LE(z64) === EOCD64_SIG) {
        cdCount = Number(buf.readBigUInt64LE(z64 + 32));
        cdOffset = Number(buf.readBigUInt64LE(z64 + 48));
      }
    }
  }

  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    if (maxEntries != null && entries.length >= maxEntries) break;
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) break;
    const method = buf.readUInt16LE(p + 10);
    let compSize = buf.readUInt32LE(p + 20);
    let uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    let localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    // ZIP64 extra (0x0001): подставляем 64-битные значения вместо 0xFFFFFFFF
    const extraStart = p + 46 + nameLen;
    const extraEnd = extraStart + extraLen;
    let ep = extraStart;
    while (ep + 4 <= extraEnd) {
      const hid = buf.readUInt16LE(ep);
      const hsz = buf.readUInt16LE(ep + 2);
      let dp = ep + 4;
      if (hid === 0x0001) {
        if (uncompSize === 0xffffffff && dp + 8 <= extraEnd) { uncompSize = Number(buf.readBigUInt64LE(dp)); dp += 8; }
        if (compSize === 0xffffffff && dp + 8 <= extraEnd) { compSize = Number(buf.readBigUInt64LE(dp)); dp += 8; }
        if (localOffset === 0xffffffff && dp + 8 <= extraEnd) { localOffset = Number(buf.readBigUInt64LE(dp)); dp += 8; }
      }
      ep += 4 + hsz;
    }

    entries.push({ name, method, compSize, uncompSize, localOffset });
    p = extraStart + extraLen + commentLen;
  }
  return entries;
}

// Возвращает Buffer с распакованными данными записи. maxBytes (если задан)
// ограничивает РЕАЛЬНЫЙ размер вывода — защита от zip-бомбы: uncompSize из архива
// не проверяется inflate'ом, поэтому доверять ему нельзя; кап ставим на выход.
function entryData(buf, entry, maxBytes) {
  let p = entry.localOffset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== LOC_SIG) throw new Error('битый локальный заголовок');
  // длины имени/extra в локальном заголовке могут отличаться от центрального
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const dataStart = p + 30 + nameLen + extraLen;
  const raw = buf.subarray(dataStart, dataStart + entry.compSize);
  if (entry.method === 0) {                                 // stored
    if (maxBytes != null && raw.length > maxBytes) throw new Error('запись превышает лимит распаковки');
    return Buffer.from(raw);
  }
  if (entry.method === 8) {                                 // deflate
    return zlib.inflateRawSync(raw, maxBytes != null ? { maxOutputLength: maxBytes } : undefined);
  }
  throw new Error('неподдерживаемый метод сжатия: ' + entry.method);
}

module.exports = { readEntries, entryData };
