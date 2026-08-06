'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const modassets = require('../lib/modassets');
const unzip = require('../lib/unzip');

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  name.copy(header, 4);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([header, data, checksum]);
}

function png(width, height, rgba) {
  const color = rgba || [80, 160, 220, 255];
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const start = y * (width * 4 + 1);
    for (let x = 0; x < width; x++) {
      const pixel = start + 1 + x * 4;
      rows[pixel] = color[0]; rows[pixel + 1] = color[1];
      rows[pixel + 2] = color[2]; rows[pixel + 3] = color[3];
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* Минимальный ZIP-конструктор нужен для вредоносных имён/флагов, которые
   обычная файловая система не позволяет создать как fixture. */
function makeZip(files) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data), 'utf8');
    const method = file.method === 8 ? 8 : 0;
    const body = method === 8 ? zlib.deflateRawSync(data) : data;
    const flags = file.flags == null ? 0x0800 : file.flags;
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flags, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(file.uncompSize == null ? data.length : file.uncompSize, 22);
    lh.writeUInt16LE(name.length, 26);
    local.push(lh, name, body);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(flags, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(file.uncompSize == null ? data.length : file.uncompSize, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += lh.length + name.length + body.length;
  }
  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat(local.concat([centralBuffer, end]));
}

function tempMods(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'controlgui-modassets-'));
  const mods = path.join(root, 'mods');
  fs.mkdirSync(mods);
  t.after(() => {
    modassets.invalidate(mods);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return mods;
}

function writeJar(mods, name, files) {
  const list = Object.entries(files).map(([entryName, value], index) => ({
    name: entryName,
    data: value,
    // Чередуем stored/deflate, чтобы оба безопасных пути чтения использовались.
    method: index % 2 ? 8 : 0,
  }));
  const target = path.join(mods, name);
  fs.writeFileSync(target, makeZip(list));
  return target;
}

test('стандартные, наследуемые, современные и блочные модели находят PNG', async (t) => {
  const mods = tempMods(t);
  const hammer = png(16, 16, [200, 80, 40, 255]);
  const inherited = png(16, 16, [40, 200, 80, 255]);
  const wand = png(32, 32, [80, 40, 200, 255]);
  const block = png(16, 16, [160, 160, 40, 255]);
  const direct = png(16, 16, [100, 100, 100, 255]);
  const animated = png(16, 64, [30, 130, 220, 255]);
  writeJar(mods, 'demo.jar', {
    'assets/demo/models/item/hammer.json': JSON.stringify({ parent: 'minecraft:item/generated', textures: { layer0: 'demo:item/hammer' } }),
    'assets/demo/textures/item/hammer.png': hammer,
    'assets/demo/models/item/base.json': JSON.stringify({ textures: { base: 'demo:item/inherited' } }),
    'assets/demo/models/item/inherited.json': JSON.stringify({ parent: 'demo:item/base', textures: { layer0: '#base' } }),
    'assets/demo/textures/item/inherited.png': inherited,
    'assets/demo/items/wand.json': JSON.stringify({ model: { type: 'minecraft:model', model: 'demo:item/wand_visual' } }),
    'assets/demo/models/item/wand_visual.json': JSON.stringify({ parent: 'item/generated', textures: { layer0: 'demo:item/wand' } }),
    'assets/demo/textures/item/wand.png': wand,
    'assets/demo/models/item/machine.json': JSON.stringify({ parent: 'demo:block/machine' }),
    'assets/demo/models/block/machine.json': JSON.stringify({ textures: { all: 'demo:block/machine' } }),
    'assets/demo/textures/block/machine.png': block,
    'assets/demo/textures/items/direct.png': direct,
    'assets/demo/models/item/animated.json': JSON.stringify({ textures: { layer0: 'demo:item/animated' } }),
    'assets/demo/textures/item/animated.png': animated,
    'assets/demo/textures/item/animated.png.mcmeta': JSON.stringify({ animation: { frametime: 2 } }),
  });

  assert.deepEqual((await modassets.resolveIcon(mods, 'demo:hammer')).buffer, hammer);
  assert.deepEqual((await modassets.resolveIcon(mods, 'demo:inherited')).buffer, inherited);
  assert.deepEqual((await modassets.resolveIcon(mods, 'demo:wand')).buffer, wand);
  assert.deepEqual((await modassets.resolveIcon(mods, 'demo:machine')).buffer, block);
  assert.deepEqual((await modassets.resolveIcon(mods, 'demo:direct')).buffer, direct);
  const animation = await modassets.resolveIcon(mods, 'demo:animated');
  assert.equal(animation.animated, true);
  assert.equal(animation.frames, 4);
  assert.deepEqual(animation.crop, { x: 0, y: 0, width: 16, height: 16 });
  assert.match(animation.etag, /^"cg-mod-item-[a-f0-9]{32}"$/);
  assert.match(animation.signature, /^[a-f0-9]{64}$/);
  assert.equal(animation.source, 'assets/demo/textures/item/animated.png');
});

test('учитываются только включённые mods/*.jar, а смена состава меняет signature', async (t) => {
  const mods = tempMods(t);
  const icon = png(16, 16);
  const disabled = writeJar(mods, 'hidden.jar.disabled', {
    'assets/hidden/textures/item/tool.png': icon,
  });
  const firstSignature = await modassets.getSignature(mods);
  assert.equal(await modassets.resolveIcon(mods, 'hidden:tool'), null);
  fs.renameSync(disabled, path.join(mods, 'hidden.jar'));
  modassets.invalidate(mods);
  const secondSignature = await modassets.getSignature(mods);
  assert.notEqual(secondSignature, firstSignature);
  assert.deepEqual((await modassets.resolveIcon(mods, 'hidden:tool')).buffer, icon);

  // Вложенный JAR намеренно не считается установленным top-level модом.
  const nested = path.join(mods, '1.21');
  fs.mkdirSync(nested);
  writeJar(nested, 'nested.jar', { 'assets/nested/textures/item/tool.png': icon });
  modassets.invalidate(mods);
  assert.equal(await modassets.resolveIcon(mods, 'nested:tool'), null);
});

test('random-access ZIP читает одну запись и жёстко проверяет лимиты/CRC/шифрование', (t) => {
  const mods = tempMods(t);
  const image = png(16, 16);
  const jar = writeJar(mods, 'reader.jar', {
    'assets/reader/models/item/tool.json': JSON.stringify({ textures: { layer0: 'reader:item/tool' } }),
    'assets/reader/textures/item/tool.png': image,
  });
  const entries = unzip.readFileEntries(jar, { maxEntries: 10, maxCentralBytes: 1024 * 1024, maxFileBytes: 1024 * 1024 });
  const entry = entries.find((item) => item.name.endsWith('/tool.png'));
  assert.deepEqual(unzip.entryDataFromFile(jar, entry, 1024 * 1024), image);
  assert.throws(() => unzip.readFileEntries(jar, { maxEntries: 1 }), /слишком много записей/);
  assert.throws(() => unzip.readFileEntries(jar, { maxFileBytes: 10 }), /превышает допустимый размер/);
  assert.throws(() => unzip.entryDataFromFile(jar, Object.assign({}, entry, { flags: 1 }), 1024 * 1024), /зашифрованные/);
  assert.throws(() => unzip.entryDataFromFile(jar, Object.assign({}, entry, { uncompSize: 9 * 1024 * 1024 }), 8 * 1024 * 1024), /лимит распаковки/);
  assert.throws(() => unzip.entryDataFromFile(jar, Object.assign({}, entry, { crc32: entry.crc32 ^ 1 }), 1024 * 1024), /контрольная сумма/);
});

test('path traversal, шифрованные записи и опасная PNG не попадают в результат', async (t) => {
  const mods = tempMods(t);
  const badSide = png(8193, 1);
  const jar = makeZip([
    { name: 'assets/escape/textures/item/../secret.png', data: png(16, 16) },
    { name: 'assets/escape/textures/item/encrypted.png', data: png(16, 16), flags: 0x0801 },
    { name: 'assets/escape/textures/item/huge.png', data: badSide },
  ]);
  fs.writeFileSync(path.join(mods, 'hostile.jar'), jar);
  assert.equal(await modassets.resolveIcon(mods, 'escape:secret'), null);
  assert.equal(await modassets.resolveIcon(mods, 'escape:encrypted'), null);
  assert.equal(await modassets.resolveIcon(mods, 'escape:huge'), null);
  await assert.rejects(modassets.resolveIcon(mods, '../escape:secret'), /Некорректный ID/);
  await assert.rejects(modassets.resolveIcon(mods, 'escape:../secret'), /Некорректный ID/);
});

test('одновременные запросы объединяются и кэш возвращает один результат', async (t) => {
  const mods = tempMods(t);
  writeJar(mods, 'same.jar', { 'assets/same/textures/item/tool.png': png(16, 16) });
  modassets.invalidate(mods);
  const results = await Promise.all(Array.from({ length: 24 }, () => modassets.resolveIcon(mods, 'same:tool')));
  assert.ok(results[0]);
  for (const result of results) assert.strictEqual(result, results[0]);
  assert.strictEqual(await modassets.resolveIcon(mods, 'same:tool'), results[0]);
  assert.equal(crypto.createHash('sha256').update(results[0].buffer).digest('hex').length, 64);
});

test('асинхронный parser большого central directory уступает event loop', async (t) => {
  const mods = tempMods(t);
  const files = Array.from({ length: 5000 }, (_, index) => ({
    name: 'META-INF/padding/' + String(index).padStart(5, '0') + '.txt',
    data: '',
  }));
  const jar = path.join(mods, 'large-central.jar');
  fs.writeFileSync(jar, makeZip(files));
  let yielded = false;
  setImmediate(() => { yielded = true; });
  const entries = await unzip.readFileEntriesAsync(jar, {
    maxEntries: 6000,
    maxCentralBytes: 4 * 1024 * 1024,
    maxFileBytes: 4 * 1024 * 1024,
  });
  assert.equal(entries.length, 5000);
  assert.ok(entries.centralSize > 250000);
  assert.equal(yielded, true);
});

test('manifest LRU остаётся bounded после параллельного завершения индексов', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'controlgui-modassets-lru-'));
  const dirs = [];
  for (let i = 0; i < 6; i++) {
    const mods = path.join(root, 'mods-' + i);
    fs.mkdirSync(mods);
    writeJar(mods, 'mod.jar', { ['assets/m' + i + '/textures/item/tool.png']: png(1, 1) });
    dirs.push(mods);
  }
  t.after(() => {
    modassets.invalidate();
    fs.rmSync(root, { recursive: true, force: true });
  });
  modassets.invalidate();
  const original = unzip.readFileEntriesAsync;
  let reads = 0;
  unzip.readFileEntriesAsync = async function () {
    reads++;
    return original.apply(this, arguments);
  };
  try {
    await Promise.all(dirs.map((mods) => modassets.getSignature(mods)));
    assert.equal(reads, 6);
    await modassets.getSignature(dirs[5]);
    assert.equal(reads, 6, 'самый свежий manifest должен остаться в LRU');
    await modassets.getSignature(dirs[0]);
    assert.equal(reads, 7, 'старый параллельный Promise не должен вернуться в bounded-кэш');
  } finally {
    unzip.readFileEntriesAsync = original;
  }
});

test('временная ошибка индекса повторяется после TTL при прежней signature', async (t) => {
  const mods = tempMods(t);
  const image = png(16, 16);
  writeJar(mods, 'busy.jar', { 'assets/busy/textures/item/tool.png': image });
  const originalRead = unzip.readFileEntriesAsync;
  const originalWarn = console.warn;
  let attempts = 0;
  console.warn = () => {};
  unzip.readFileEntriesAsync = async function () {
    attempts++;
    if (attempts === 1) throw Object.assign(new Error('файл временно занят'), { code: 'EBUSY' });
    return originalRead.apply(this, arguments);
  };
  try {
    const first = await modassets.getIndexInfo(mods);
    assert.equal(first.complete, false);
    assert.equal(first.retryableErrors, true);
    assert.equal(await modassets.resolveIcon(mods, 'busy:tool'), null);
    assert.equal(attempts, 1, 'до TTL используется тот же неполный manifest');
    await new Promise((resolve) => setTimeout(resolve, 2100));
    const second = await modassets.getIndexInfo(mods);
    assert.equal(attempts, 2);
    assert.equal(second.complete, true);
    assert.deepEqual((await modassets.resolveIcon(mods, 'busy:tool')).buffer, image);
  } finally {
    unzip.readFileEntriesAsync = originalRead;
    console.warn = originalWarn;
  }
});

test('временный отказ чтения PNG не становится отрицательным кэшем', async (t) => {
  const mods = tempMods(t);
  const image = png(16, 16);
  writeJar(mods, 'asset-busy.jar', { 'assets/assetbusy/textures/item/tool.png': image });
  await modassets.getSignature(mods);
  const original = unzip.entryDataFromFile;
  let failed = false;
  unzip.entryDataFromFile = function (file, entry) {
    if (!failed && entry.name.endsWith('/tool.png')) {
      failed = true;
      throw Object.assign(new Error('файл временно занят'), { code: 'EBUSY' });
    }
    return original.apply(this, arguments);
  };
  try {
    assert.equal(await modassets.resolveIcon(mods, 'assetbusy:tool'), null);
    assert.deepEqual((await modassets.resolveIcon(mods, 'assetbusy:tool')).buffer, image);
  } finally {
    unzip.entryDataFromFile = original;
  }
});

test('индекс без обрезания принимает модпак больше прежних 256 JAR', async (t) => {
  const mods = tempMods(t);
  const emptyJar = makeZip([]);
  for (let i = 0; i < 300; i++) {
    fs.writeFileSync(path.join(mods, 'empty-' + String(i).padStart(3, '0') + '.jar'), emptyJar);
  }
  const info = await modassets.getIndexInfo(mods);
  assert.equal(info.jarCount, 300);
  assert.equal(info.indexedJars, 300);
  assert.equal(info.complete, true);
});

test('одна иконка не может последовательно inflate сотню ложных 8-МБ текстур', async (t) => {
  const mods = tempMods(t);
  const textures = {};
  const files = [];
  for (let i = 0; i < 24; i++) {
    const name = 'bad' + String(i).padStart(2, '0');
    textures['layer' + i] = 'budget:item/' + name;
    files.push({
      name: 'assets/budget/textures/item/' + name + '.png',
      data: 'не PNG',
      // Центральный каталог обещает максимум, поэтому каждая попытка обязана
      // заранее списать 8 МБ из общего бюджета, даже если тело архива крошечное.
      uncompSize: 8 * 1024 * 1024,
    });
  }
  files.unshift({
    name: 'assets/budget/models/item/tool.json',
    data: JSON.stringify({ textures }),
  });
  fs.writeFileSync(path.join(mods, 'budget.jar'), makeZip(files));
  const original = unzip.entryDataFromFile;
  let reads = 0;
  unzip.entryDataFromFile = function () {
    reads++;
    return original.apply(this, arguments);
  };
  try {
    assert.equal(await modassets.resolveIcon(mods, 'budget:tool'), null);
    assert.ok(reads <= 10, '64-МБ бюджет должен остановить дорогие попытки, чтений: ' + reads);
  } finally {
    unzip.entryDataFromFile = original;
  }
});
