'use strict';

/* Минимальный чтец ZIP без внешних зависимостей (только встроенный zlib).
   Читает центральный каталог, затем каждую запись через её локальный заголовок.
   Поддержка: метод 0 (stored) и 8 (deflate), базовый ZIP64 (размеры/смещение
   в extra-поле 0x0001 и ZIP64 EOCD). Имена трактуем как UTF-8.
   Буферный API используется распаковщиком проводника, а файловый random-access
   API — индексом ассетов mod JAR. При распаковке вызывающий обязан прогонять
   каждое имя через safePath (zip-slip) и лимиты (zip-bomb). */

const zlib = require('zlib');
const fs = require('fs');

const EOCD_SIG = 0x06054b50;      // End Of Central Directory
const EOCD64_LOC_SIG = 0x07064b50; // ZIP64 EOCD locator
const EOCD64_SIG = 0x06064b50;    // ZIP64 EOCD
const CEN_SIG = 0x02014b50;       // Central directory file header
const LOC_SIG = 0x04034b50;       // Local file header

const DEFAULT_FILE_ENTRY_LIMIT = 100000;
const DEFAULT_CENTRAL_LIMIT = 64 * 1024 * 1024;

function safeNumber(value, label) {
  if (typeof value === 'bigint') {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(label + ' выходит за безопасный диапазон');
    }
    return Number(value);
  }
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(label + ' имеет недопустимое значение');
  return value;
}

function readExactly(fd, length, position) {
  safeNumber(length, 'размер чтения');
  safeNumber(position, 'смещение чтения');
  if (position > Number.MAX_SAFE_INTEGER - length) throw new Error('чтение выходит за безопасный диапазон');
  const out = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const count = fs.readSync(fd, out, offset, length - offset, position + offset);
    if (!count) throw truncatedReadError();
    offset += count;
  }
  return out;
}

function sameFileIdentity(before, after) {
  // На некоторых файловых системах Windows ino/dev равны нулю. Там остаётся
  // сверка размера после open; на NTFS и POSIX дополнительно ловим подмену inode.
  const hasIdentity = Number(before.dev) !== 0 && Number(before.ino) !== 0 &&
    Number(after.dev) !== 0 && Number(after.ino) !== 0;
  return !hasIdentity || (before.dev === after.dev && before.ino === after.ino);
}

function replacedFileError() {
  const error = new Error('JAR был заменён во время чтения');
  error.retryable = true;
  return error;
}

function truncatedReadError() {
  const error = new Error('архив неожиданно закончился');
  error.retryable = true;
  return error;
}

function openVerifiedFile(filePath, maxFileBytes) {
  const before = fs.lstatSync(filePath);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('JAR должен быть обычным файлом');
  const beforeSize = safeNumber(before.size, 'размер JAR');
  if (beforeSize > maxFileBytes) throw new Error('JAR превышает допустимый размер');
  let fd;
  try {
    // O_NOFOLLOW закрывает окно подмены на symlink на POSIX. Windows этот флаг
    // не предоставляет, поэтому ниже обязательны fstat и сверка идентичности.
    const noFollow = process.platform !== 'win32' && fs.constants.O_NOFOLLOW ? fs.constants.O_NOFOLLOW : 0;
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
    const after = fs.fstatSync(fd);
    const afterSize = safeNumber(after.size, 'размер открытого JAR');
    if (!after.isFile() || afterSize !== beforeSize || !sameFileIdentity(before, after)) {
      throw replacedFileError();
    }
    return { fd, size: afterSize };
  } catch (e) {
    if (fd != null) { try { fs.closeSync(fd); } catch (closeError) { /* исходная ошибка важнее */ } }
    throw e;
  }
}

function zip64Value(buf, start, end, cursor, label) {
  if (cursor.pos + 8 > end) throw new Error('битое ZIP64 extra-поле (' + label + ')');
  const value = safeNumber(buf.readBigUInt64LE(cursor.pos), label);
  cursor.pos += 8;
  return value;
}

function fillZip64Values(buf, extraStart, extraEnd, values) {
  let p = extraStart;
  while (p + 4 <= extraEnd) {
    const id = buf.readUInt16LE(p);
    const size = buf.readUInt16LE(p + 2);
    const dataStart = p + 4;
    const dataEnd = dataStart + size;
    if (dataEnd > extraEnd) throw new Error('битое extra-поле центрального каталога');
    if (id === 0x0001) {
      const cursor = { pos: dataStart };
      if (values.uncompSize === 0xffffffff) values.uncompSize = zip64Value(buf, dataStart, dataEnd, cursor, 'размер записи');
      if (values.compSize === 0xffffffff) values.compSize = zip64Value(buf, dataStart, dataEnd, cursor, 'сжатый размер записи');
      if (values.localOffset === 0xffffffff) values.localOffset = zip64Value(buf, dataStart, dataEnd, cursor, 'смещение записи');
      return;
    }
    p = dataEnd;
  }
  if (values.uncompSize === 0xffffffff || values.compSize === 0xffffffff || values.localOffset === 0xffffffff) {
    throw new Error('не найдено обязательное ZIP64 extra-поле');
  }
}

function centralEntryAt(central, p, fileSize) {
  if (p + 46 > central.length || central.readUInt32LE(p) !== CEN_SIG) {
    throw new Error('битая запись центрального каталога');
  }
  const flags = central.readUInt16LE(p + 8);
  const method = central.readUInt16LE(p + 10);
  const crc = central.readUInt32LE(p + 16);
  const values = {
    compSize: central.readUInt32LE(p + 20),
    uncompSize: central.readUInt32LE(p + 24),
    localOffset: central.readUInt32LE(p + 42),
  };
  const nameLength = central.readUInt16LE(p + 28);
  const extraLength = central.readUInt16LE(p + 30);
  const commentLength = central.readUInt16LE(p + 32);
  const end = p + 46 + nameLength + extraLength + commentLength;
  if (end > central.length) throw new Error('запись центрального каталога обрезана');
  const name = central.toString('utf8', p + 46, p + 46 + nameLength);
  if (name.includes('\0')) throw new Error('имя ZIP-записи содержит NUL');
  fillZip64Values(central, p + 46 + nameLength, p + 46 + nameLength + extraLength, values);
  safeNumber(values.compSize, 'сжатый размер записи');
  safeNumber(values.uncompSize, 'размер записи');
  safeNumber(values.localOffset, 'смещение записи');
  if (fileSize < 30 || values.localOffset > fileSize - 30) throw new Error('запись ZIP выходит за границы файла');
  return {
    end,
    entry: {
      name,
      flags,
      method,
      crc32: crc >>> 0,
      compSize: values.compSize,
      uncompSize: values.uncompSize,
      localOffset: values.localOffset,
    },
  };
}

function decorateEntries(entries, centralSize, fileSize) {
  Object.defineProperties(entries, {
    centralSize: { value: centralSize, enumerable: false },
    archiveSize: { value: fileSize, enumerable: false },
  });
  return entries;
}

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

/* Читает только хвост и центральный каталог ZIP-файла. Это важно для JAR модов:
   целый архив может занимать сотни мегабайт, хотя для индекса нужны лишь имена
   записей и их смещения. */
function readFileEntries(filePath, options) {
  options = options || {};
  const maxEntries = Math.max(1, Number(options.maxEntries) || DEFAULT_FILE_ENTRY_LIMIT);
  const maxCentralBytes = Math.max(1024, Number(options.maxCentralBytes) || DEFAULT_CENTRAL_LIMIT);
  const maxFileBytes = options.maxFileBytes == null ? Number.MAX_SAFE_INTEGER : safeNumber(Number(options.maxFileBytes), 'лимит JAR');
  const opened = openVerifiedFile(filePath, maxFileBytes);
  const fileSize = opened.size;
  const fd = opened.fd;
  try {
    if (fileSize < 22) throw new Error('файл слишком мал для ZIP');
    // Дополнительные 20 байт нужны для ZIP64 locator перед EOCD с максимальным комментарием.
    const tailSize = Math.min(fileSize, 22 + 0xffff + 20);
    const tailOffset = fileSize - tailSize;
    const tail = readExactly(fd, tailSize, tailOffset);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) !== EOCD_SIG) continue;
      const commentLength = tail.readUInt16LE(i + 20);
      // Сигнатура может случайно встретиться в комментарии — истинный EOCD завершает файл.
      if (i + 22 + commentLength === tail.length) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('не найден конец ZIP (EOCD)');
    const eocdOffset = tailOffset + eocd;

    const disk = tail.readUInt16LE(eocd + 4);
    const centralDisk = tail.readUInt16LE(eocd + 6);
    let diskEntries = tail.readUInt16LE(eocd + 8);
    let count = tail.readUInt16LE(eocd + 10);
    let centralSize = tail.readUInt32LE(eocd + 12);
    let centralOffset = tail.readUInt32LE(eocd + 16);
    if (disk !== 0 || centralDisk !== 0) throw new Error('многотомные ZIP не поддерживаются');

    const needsZip64 = diskEntries === 0xffff || count === 0xffff ||
      centralSize === 0xffffffff || centralOffset === 0xffffffff;
    if (needsZip64) {
      if (eocdOffset < 20) throw new Error('не найден ZIP64 locator');
      const locator = readExactly(fd, 20, eocdOffset - 20);
      if (locator.readUInt32LE(0) !== EOCD64_LOC_SIG) throw new Error('не найден ZIP64 locator');
      if (locator.readUInt32LE(4) !== 0 || locator.readUInt32LE(16) !== 1) {
        throw new Error('многотомные ZIP64 не поддерживаются');
      }
      const zip64Offset = safeNumber(locator.readBigUInt64LE(8), 'смещение ZIP64 EOCD');
      if (fileSize < 56 || zip64Offset > fileSize - 56) throw new Error('битое смещение ZIP64 EOCD');
      const zip64 = readExactly(fd, 56, zip64Offset);
      if (zip64.readUInt32LE(0) !== EOCD64_SIG) throw new Error('битый ZIP64 EOCD');
      const recordSize = safeNumber(zip64.readBigUInt64LE(4), 'размер ZIP64 EOCD');
      if (recordSize < 44 || zip64Offset > fileSize - 12 || recordSize > fileSize - zip64Offset - 12) {
        throw new Error('битый размер ZIP64 EOCD');
      }
      if (zip64.readUInt32LE(16) !== 0 || zip64.readUInt32LE(20) !== 0) {
        throw new Error('многотомные ZIP64 не поддерживаются');
      }
      diskEntries = safeNumber(zip64.readBigUInt64LE(24), 'число записей на диске');
      count = safeNumber(zip64.readBigUInt64LE(32), 'число записей');
      centralSize = safeNumber(zip64.readBigUInt64LE(40), 'размер центрального каталога');
      centralOffset = safeNumber(zip64.readBigUInt64LE(48), 'смещение центрального каталога');
    }

    safeNumber(diskEntries, 'число записей на диске');
    safeNumber(count, 'число записей');
    safeNumber(centralSize, 'размер центрального каталога');
    safeNumber(centralOffset, 'смещение центрального каталога');
    if (diskEntries !== count) throw new Error('многотомные ZIP не поддерживаются');
    if (count > maxEntries) throw new Error('слишком много записей в ZIP (> ' + maxEntries + ')');
    if (centralSize > maxCentralBytes) throw new Error('центральный каталог ZIP слишком большой');
    if (centralOffset > eocdOffset || centralSize > eocdOffset - centralOffset ||
        centralOffset > fileSize || centralSize > fileSize - centralOffset) {
      throw new Error('центральный каталог выходит за границы ZIP');
    }

    const central = readExactly(fd, centralSize, centralOffset);
    const entries = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      const parsed = centralEntryAt(central, p, fileSize);
      entries.push(parsed.entry);
      p = parsed.end;
    }
    return decorateEntries(entries, centralSize, fileSize);
  } finally {
    fs.closeSync(fd);
  }
}

function immediate() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function readExactlyAsync(handle, length, position) {
  safeNumber(length, 'размер чтения');
  safeNumber(position, 'смещение чтения');
  if (position > Number.MAX_SAFE_INTEGER - length) throw new Error('чтение выходит за безопасный диапазон');
  // Буфер возвращается только после полного заполнения; unsafe здесь исключает
  // заметную синхронную zero-fill паузу перед асинхронным чтением 64-МБ каталога.
  const out = Buffer.allocUnsafe(length);
  let offset = 0;
  const chunkSize = 1024 * 1024;
  while (offset < length) {
    const part = Math.min(chunkSize, length - offset);
    const result = await handle.read(out, offset, part, position + offset);
    if (!result.bytesRead) throw truncatedReadError();
    offset += result.bytesRead;
    // FileHandle.read уже асинхронный; явная уступка не даёт цепочке быстрых
    // чтений из файлового кэша монополизировать цикл событий.
    if (offset < length) await immediate();
  }
  return out;
}

async function openVerifiedFileAsync(filePath, maxFileBytes) {
  const before = await fs.promises.lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('JAR должен быть обычным файлом');
  const beforeSize = safeNumber(before.size, 'размер JAR');
  if (beforeSize > maxFileBytes) throw new Error('JAR превышает допустимый размер');
  let handle;
  try {
    const noFollow = process.platform !== 'win32' && fs.constants.O_NOFOLLOW ? fs.constants.O_NOFOLLOW : 0;
    handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | noFollow);
    const after = await handle.stat();
    const afterSize = safeNumber(after.size, 'размер открытого JAR');
    if (!after.isFile() || afterSize !== beforeSize || !sameFileIdentity(before, after)) throw replacedFileError();
    return { handle, size: afterSize };
  } catch (e) {
    if (handle) { try { await handle.close(); } catch (closeError) { /* исходная ошибка важнее */ } }
    throw e;
  }
}

/* Асинхронный вариант для фоновой индексации модов. Центральный каталог всё
   равно имеет жёсткий размерный предел, но читается мегабайтными порциями, а
   парсер регулярно уступает event loop — большой единичный JAR не стопорит UI. */
async function readFileEntriesAsync(filePath, options) {
  options = options || {};
  const maxEntries = Math.max(1, Number(options.maxEntries) || DEFAULT_FILE_ENTRY_LIMIT);
  const maxCentralBytes = Math.max(1024, Number(options.maxCentralBytes) || DEFAULT_CENTRAL_LIMIT);
  const maxFileBytes = options.maxFileBytes == null ? Number.MAX_SAFE_INTEGER : safeNumber(Number(options.maxFileBytes), 'лимит JAR');
  const opened = await openVerifiedFileAsync(filePath, maxFileBytes);
  const handle = opened.handle;
  const fileSize = opened.size;
  try {
    if (fileSize < 22) throw new Error('файл слишком мал для ZIP');
    const tailSize = Math.min(fileSize, 22 + 0xffff + 20);
    const tailOffset = fileSize - tailSize;
    const tail = await readExactlyAsync(handle, tailSize, tailOffset);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) !== EOCD_SIG) continue;
      const commentLength = tail.readUInt16LE(i + 20);
      if (i + 22 + commentLength === tail.length) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('не найден конец ZIP (EOCD)');
    const eocdOffset = tailOffset + eocd;

    const disk = tail.readUInt16LE(eocd + 4);
    const centralDisk = tail.readUInt16LE(eocd + 6);
    let diskEntries = tail.readUInt16LE(eocd + 8);
    let count = tail.readUInt16LE(eocd + 10);
    let centralSize = tail.readUInt32LE(eocd + 12);
    let centralOffset = tail.readUInt32LE(eocd + 16);
    if (disk !== 0 || centralDisk !== 0) throw new Error('многотомные ZIP не поддерживаются');

    const needsZip64 = diskEntries === 0xffff || count === 0xffff ||
      centralSize === 0xffffffff || centralOffset === 0xffffffff;
    if (needsZip64) {
      if (eocdOffset < 20) throw new Error('не найден ZIP64 locator');
      const locator = await readExactlyAsync(handle, 20, eocdOffset - 20);
      if (locator.readUInt32LE(0) !== EOCD64_LOC_SIG) throw new Error('не найден ZIP64 locator');
      if (locator.readUInt32LE(4) !== 0 || locator.readUInt32LE(16) !== 1) {
        throw new Error('многотомные ZIP64 не поддерживаются');
      }
      const zip64Offset = safeNumber(locator.readBigUInt64LE(8), 'смещение ZIP64 EOCD');
      if (fileSize < 56 || zip64Offset > fileSize - 56) throw new Error('битое смещение ZIP64 EOCD');
      const zip64 = await readExactlyAsync(handle, 56, zip64Offset);
      if (zip64.readUInt32LE(0) !== EOCD64_SIG) throw new Error('битый ZIP64 EOCD');
      const recordSize = safeNumber(zip64.readBigUInt64LE(4), 'размер ZIP64 EOCD');
      if (recordSize < 44 || zip64Offset > fileSize - 12 || recordSize > fileSize - zip64Offset - 12) {
        throw new Error('битый размер ZIP64 EOCD');
      }
      if (zip64.readUInt32LE(16) !== 0 || zip64.readUInt32LE(20) !== 0) {
        throw new Error('многотомные ZIP64 не поддерживаются');
      }
      diskEntries = safeNumber(zip64.readBigUInt64LE(24), 'число записей на диске');
      count = safeNumber(zip64.readBigUInt64LE(32), 'число записей');
      centralSize = safeNumber(zip64.readBigUInt64LE(40), 'размер центрального каталога');
      centralOffset = safeNumber(zip64.readBigUInt64LE(48), 'смещение центрального каталога');
    }

    safeNumber(diskEntries, 'число записей на диске');
    safeNumber(count, 'число записей');
    safeNumber(centralSize, 'размер центрального каталога');
    safeNumber(centralOffset, 'смещение центрального каталога');
    if (diskEntries !== count) throw new Error('многотомные ZIP не поддерживаются');
    if (count > maxEntries) throw new Error('слишком много записей в ZIP (> ' + maxEntries + ')');
    if (centralSize > maxCentralBytes) throw new Error('центральный каталог ZIP слишком большой');
    if (centralOffset > eocdOffset || centralSize > eocdOffset - centralOffset ||
        centralOffset > fileSize || centralSize > fileSize - centralOffset) {
      throw new Error('центральный каталог выходит за границы ZIP');
    }

    const central = await readExactlyAsync(handle, centralSize, centralOffset);
    const entries = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      const parsed = centralEntryAt(central, p, fileSize);
      entries.push(parsed.entry);
      p = parsed.end;
      if ((i & 255) === 255) await immediate();
    }
    return decorateEntries(entries, centralSize, fileSize);
  } finally {
    await handle.close();
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/* Извлекает одну запись из файла по смещению центрального каталога. В память
   попадают лишь сжатые байты этой записи, а maxOutputLength ограничивает уже
   настоящий результат inflate — заявленному размеру из недоверенного JAR не верим. */
function entryDataFromFile(filePath, entry, maxBytes, maxCompressedBytes, maxFileBytes) {
  const outputLimit = maxBytes == null ? 512 * 1024 * 1024 : safeNumber(Number(maxBytes), 'лимит распаковки');
  const compressedLimit = maxCompressedBytes == null
    ? Math.min(Number.MAX_SAFE_INTEGER, outputLimit + 64 * 1024)
    : safeNumber(Number(maxCompressedBytes), 'лимит сжатой записи');
  const localOffset = safeNumber(Number(entry && entry.localOffset), 'смещение записи');
  const compSize = safeNumber(Number(entry && entry.compSize), 'сжатый размер записи');
  const uncompSize = safeNumber(Number(entry && entry.uncompSize), 'размер записи');
  const flags = Number(entry && entry.flags) || 0;
  const method = Number(entry && entry.method);
  if (flags & 0x0001) throw new Error('зашифрованные ZIP-записи не поддерживаются');
  if (method !== 0 && method !== 8) throw new Error('неподдерживаемый метод сжатия: ' + method);
  if (uncompSize > outputLimit) throw new Error('запись превышает лимит распаковки');
  if (compSize > compressedLimit) throw new Error('сжатая запись превышает лимит чтения');

  const archiveLimit = maxFileBytes == null ? Number.MAX_SAFE_INTEGER : safeNumber(Number(maxFileBytes), 'лимит JAR');
  const opened = openVerifiedFile(filePath, archiveLimit);
  const fileSize = opened.size;
  const fd = opened.fd;
  try {
    if (fileSize < 30 || localOffset > fileSize - 30) throw new Error('битое смещение локального заголовка');
    const header = readExactly(fd, 30, localOffset);
    if (header.readUInt32LE(0) !== LOC_SIG) throw new Error('битый локальный заголовок');
    const localFlags = header.readUInt16LE(6);
    const localMethod = header.readUInt16LE(8);
    if ((localFlags & 0x0001) || localMethod !== method) throw new Error('локальный заголовок не совпадает с центральным каталогом');
    const nameLength = header.readUInt16LE(26);
    const extraLength = header.readUInt16LE(28);
    const headerSize = 30 + nameLength + extraLength;
    if (localOffset > fileSize - headerSize) throw new Error('локальный заголовок выходит за границы ZIP');
    const dataStart = localOffset + headerSize;
    if (compSize > fileSize - dataStart) throw new Error('данные записи выходят за границы ZIP');
    const raw = readExactly(fd, compSize, dataStart);
    let result;
    if (method === 0) result = raw;
    else {
      // Центральный каталог всё равно проверяется по итоговой длине. Используем
      // её ещё и как более узкий cap: ложное uncompSize=0 не заставит сначала
      // раздувать maxBytes, а затем лишь обнаруживать несовпадение.
      result = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, Math.min(outputLimit, uncompSize)) });
    }
    if (result.length !== uncompSize) throw new Error('размер распакованной записи не совпадает с каталогом');
    if (entry.crc32 != null && crc32(result) !== (Number(entry.crc32) >>> 0)) {
      throw new Error('контрольная сумма ZIP-записи не совпадает');
    }
    return result;
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { readEntries, entryData, readFileEntries, readFileEntriesAsync, entryDataFromFile };
