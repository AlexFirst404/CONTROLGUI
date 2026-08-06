'use strict';

/* Поиск иконок предметов внутри установленных модов.
   JAR читаются как ZIP с произвольным доступом: в память не загружается архив
   целиком, только центральный каталог, нужный JSON или одна PNG-текстура. */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const unzip = require('./unzip');

const MAX_JARS = 1024;
const MAX_JAR_BYTES = 512 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 100000;
const MAX_CENTRAL_BYTES = 64 * 1024 * 1024;
const MAX_ASSETS = 150000;
const MAX_TOTAL_CENTRAL_BYTES = 512 * 1024 * 1024;
const MAX_MODEL_BYTES = 256 * 1024;
const MAX_META_BYTES = 64 * 1024;
const MAX_PNG_BYTES = 8 * 1024 * 1024;
const MAX_MODEL_DEPTH = 16;
const MAX_MODEL_BRANCHES = 32;
const MAX_JSON_NODES = 256;
const MAX_JSON_CACHE = 256;
const MAX_JSON_CACHE_BYTES = 8 * 1024 * 1024;
const MAX_TEXTURE_CANDIDATES = 128;
const MAX_ICON_RESOLVE_BYTES = 64 * 1024 * 1024;
const MAX_ICON_RESOLVE_READS = 256;
const MAX_IMAGE_SIDE = 8192;
const MAX_IMAGE_PIXELS = 16 * 1024 * 1024;
const MANIFEST_TTL_MS = 2000;
const MAX_MANIFESTS = 4;
const MAX_CACHED_ASSETS = 200000;
const MAX_ICON_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_ICON_CACHE_ITEMS = 1024;
const MAX_ICONS_PER_DIR = 256;

const manifestCache = new Map();
const iconCache = new Map();
const iconInflight = new Map();
const generations = new Map();
let generationEpoch = 0;
let iconCacheBytes = 0;
const warnedIncomplete = new Set();

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

function mapKey(modsDir) {
  if (typeof modsDir !== 'string' || !modsDir.trim()) throw fail(400, 'Не указана папка модов');
  return path.resolve(modsDir);
}

function inside(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function generation(key) {
  return generationEpoch + ':' + (generations.get(key) || 0);
}

function bumpGeneration(key) {
  generations.set(key, (generations.get(key) || 0) + 1);
}

const RETRYABLE_CODES = new Set(['EACCES', 'EAGAIN', 'EBUSY', 'EMFILE', 'ENFILE', 'ENOENT', 'EIO', 'EPERM', 'ESTALE', 'ETXTBSY']);
function retryableReadError(error) {
  return !!(error && (error.retryable || RETRYABLE_CODES.has(error.code)));
}

function canonicalResourceId(value) {
  const input = String(value == null ? '' : value);
  if (!input || input.length > 256 || input !== input.trim()) throw fail(400, 'Некорректный ID предмета');
  const colon = input.indexOf(':');
  if (colon <= 0 || colon !== input.lastIndexOf(':')) throw fail(400, 'ID предмета должен иметь вид namespace:item');
  const namespace = input.slice(0, colon);
  const itemPath = input.slice(colon + 1);
  if (!/^[a-z0-9_.-]{1,64}$/.test(namespace) || !/^[a-z0-9_./-]+$/.test(itemPath) ||
      itemPath.startsWith('/') || itemPath.endsWith('/') || itemPath.includes('//')) {
    throw fail(400, 'Некорректный ID предмета');
  }
  const segments = itemPath.split('/');
  if (segments.some((part) => part === '.' || part === '..')) throw fail(400, 'Некорректный ID предмета');
  return { id: namespace + ':' + itemPath, namespace, path: itemPath };
}

function resourceLocations(value, currentNamespace) {
  const raw = String(value == null ? '' : value).trim().replace(/\.json$/i, '');
  if (!raw || raw[0] === '#') return [];
  const values = [];
  const add = (candidate) => {
    try {
      const parsed = canonicalResourceId(candidate);
      if (!values.some((item) => item.id === parsed.id)) values.push(parsed);
    } catch (e) { /* битая ссылка в моде не должна ломать остальные иконки */ }
  };
  if (raw.includes(':')) add(raw);
  else {
    if (currentNamespace) add(currentNamespace + ':' + raw);
    add('minecraft:' + raw);
  }
  return values;
}

function wantedAssetName(name) {
  if (typeof name !== 'string' || !name || name.length > 768 || name !== name.toLowerCase() ||
      name.includes('\\') || name.includes('\0') || name.startsWith('/')) return false;
  const segments = name.split('/');
  if (segments.some((part) => !part || part === '.' || part === '..')) return false;
  const match = /^assets\/([a-z0-9_.-]+)\/(items|models|textures)\/(.+)$/.exec(name);
  if (!match || !/^[a-z0-9_./-]+(?:\.json|\.png|\.png\.mcmeta)$/.test(match[3])) return false;
  if (match[2] === 'items' || match[2] === 'models') return name.endsWith('.json');
  return name.endsWith('.png') || name.endsWith('.png.mcmeta');
}

function scanModsDir(modsDir) {
  const key = mapKey(modsDir);
  const hash = crypto.createHash('sha256');
  hash.update(key);
  let rootStat;
  try { rootStat = fs.lstatSync(key); }
  catch (e) {
    if (e && e.code === 'ENOENT') {
      hash.update('\0нет-папки');
      return { key, realRoot: null, jars: [], discoveredCount: 0, signature: hash.digest('hex'), skipped: [] };
    }
    throw e;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw fail(400, 'Папка модов должна быть обычным каталогом без ссылки');
  }
  const realRoot = fs.realpathSync.native(key);
  const names = fs.readdirSync(key, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.jar$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a < b ? -1 : (a > b ? 1 : 0));
  const jars = [];
  const skipped = [];
  for (const name of names) {
    const filePath = path.join(key, name);
    let st;
    try { st = fs.lstatSync(filePath); } catch (e) { continue; }
    if (!st.isFile() || st.isSymbolicLink()) continue;
    let real;
    try { real = fs.realpathSync.native(filePath); } catch (e) { continue; }
    if (!inside(realRoot, real)) continue;
    const row = [name, st.size, Math.trunc(st.mtimeMs), Math.trunc(st.ctimeMs), st.dev || 0, st.ino || 0].join('\0');
    hash.update('\0' + row);
    if (jars.length >= MAX_JARS) { skipped.push({ name, reason: 'слишком много JAR' }); continue; }
    if (!Number.isSafeInteger(st.size) || st.size < 0 || st.size > MAX_JAR_BYTES) {
      skipped.push({ name, reason: 'JAR слишком большой' });
      continue;
    }
    jars.push({ name, path: real, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs });
  }
  if (names.length > MAX_JARS) hash.update('\0ограничено:' + names.length);
  return { key, realRoot, jars, discoveredCount: names.length, signature: hash.digest('hex'), skipped };
}

async function buildManifest(scan) {
  const assets = new Map();
  const errors = scan.skipped.slice();
  let relevant = 0;
  let complete = scan.skipped.length === 0;
  let retryableErrors = false;
  let totalCentralBytes = 0;
  let indexedJars = 0;
  let stop = false;
  for (const jar of scan.jars) {
    let entries;
    try {
      entries = await unzip.readFileEntriesAsync(jar.path, {
        maxEntries: MAX_ZIP_ENTRIES,
        maxCentralBytes: MAX_CENTRAL_BYTES,
        maxFileBytes: MAX_JAR_BYTES,
      });
    } catch (e) {
      errors.push({ name: jar.name, reason: e.message });
      complete = false;
      if (retryableReadError(e)) retryableErrors = true;
      await new Promise((resolve) => setImmediate(resolve));
      continue;
    }
    totalCentralBytes += Number(entries.centralSize) || 0;
    if (totalCentralBytes > MAX_TOTAL_CENTRAL_BYTES) {
      complete = false;
      errors.push({ name: jar.name, reason: 'суммарный центральный каталог модпака превышает лимит' });
      stop = true;
      break;
    }
    indexedJars++;
    for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
      if (entryIndex > 0 && (entryIndex & 511) === 0) await new Promise((resolve) => setImmediate(resolve));
      const entry = entries[entryIndex];
      if (!wantedAssetName(entry.name) || (entry.flags & 0x0001) || (entry.method !== 0 && entry.method !== 8)) continue;
      let entryLimit = MAX_PNG_BYTES;
      if (entry.name.endsWith('.png.mcmeta')) entryLimit = MAX_META_BYTES;
      else if (entry.name.endsWith('.json')) entryLimit = MAX_MODEL_BYTES;
      if (entry.uncompSize > entryLimit || entry.compSize > entryLimit + 64 * 1024) continue;
      relevant++;
      if (relevant > MAX_ASSETS) {
        complete = false;
        errors.push({ name: jar.name, reason: 'в модпаке слишком много ресурсов для одного индекса' });
        stop = true;
        break;
      }
      let sources = assets.get(entry.name);
      if (!sources) { sources = []; assets.set(entry.name, sources); }
      // Более позднее имя JAR имеет приоритет; предыдущий источник остаётся fallback,
      // если новый архив повредился между построением индекса и чтением текстуры.
      sources.push({ jarPath: jar.path, jarName: jar.name, entry });
    }
    if (stop) break;
    // Большой модпак не должен полностью замораживать HTTP-цикл на время индексации.
    await new Promise((resolve) => setImmediate(resolve));
  }
  const manifest = {
    key: scan.key,
    signature: scan.signature,
    assets,
    errors,
    complete,
    retryableErrors,
    jarCount: scan.discoveredCount,
    indexedJars,
    assetCount: assets.size,
    indexedEntries: Math.min(relevant, MAX_ASSETS),
    totalCentralBytes,
    transientReadSerial: 0,
    jsonCache: new Map(),
    jsonCacheBytes: 0,
  };
  if (!complete && !warnedIncomplete.has(scan.signature)) {
    warnedIncomplete.add(scan.signature);
    while (warnedIncomplete.size > 64) warnedIncomplete.delete(warnedIncomplete.values().next().value);
    console.warn('[ПАНЕЛЬ] Индекс иконок модов неполный: обработано JAR ' + indexedJars +
      ' из ' + scan.discoveredCount + ', ресурсов ' + assets.size + ', пропусков ' + errors.length + '.');
  }
  return manifest;
}

function trimManifestCache() {
  const assetTotal = () => {
    let total = 0;
    for (const entry of manifestCache.values()) {
      if (entry.value) total += entry.value.indexedEntries || entry.value.assetCount || entry.value.assets.size;
    }
    return total;
  };
  while (manifestCache.size > MAX_MANIFESTS ||
         (manifestCache.size > 1 && assetTotal() > MAX_CACHED_ASSETS)) {
    const oldest = manifestCache.keys().next().value;
    if (oldest == null) break;
    // Promise остаётся у уже ожидающих вызовов, но после удаления не сможет
    // самовольно вернуться в ограниченный кэш по завершении.
    manifestCache.delete(oldest);
  }
}

function touchManifest(key, entry) {
  manifestCache.delete(key);
  manifestCache.set(key, entry);
  trimManifestCache();
}

async function getManifest(modsDir) {
  const key = mapKey(modsDir);
  const now = Date.now();
  const cached = manifestCache.get(key);
  if (cached && now - cached.checkedAt < MANIFEST_TTL_MS) {
    cached.lastUsed = now;
    touchManifest(key, cached);
    return cached.value || cached.promise;
  }
  const scan = scanModsDir(key);
  if (cached && cached.signature === scan.signature) {
    if (cached.promise || !(cached.value && cached.value.retryableErrors)) {
      cached.checkedAt = now;
      cached.lastUsed = now;
      touchManifest(key, cached);
      return cached.value || cached.promise;
    }
    // Временная EBUSY/EACCES/подмена могла исчезнуть без изменения mtime/size.
    // После TTL строим индекс заново даже при прежней сигнатуре.
  }

  const currentGeneration = generation(key);
  const entry = {
    signature: scan.signature,
    checkedAt: now,
    lastUsed: now,
    value: null,
    promise: null,
  };
  entry.promise = buildManifest(scan).then((manifest) => {
    const live = manifestCache.get(key);
    if (live === entry && generation(key) === currentGeneration) {
      entry.value = manifest;
      entry.promise = null;
      entry.checkedAt = Date.now();
      entry.lastUsed = Date.now();
      touchManifest(key, entry);
    }
    return manifest;
  }, (error) => {
    if (manifestCache.get(key) === entry) manifestCache.delete(key);
    throw error;
  });
  touchManifest(key, entry);
  return entry.promise;
}

function sourcesFor(manifest, assetName) {
  return manifest.assets.get(assetName) || [];
}

function readAsset(manifest, assetName, maxBytes, budget) {
  const sources = sourcesFor(manifest, assetName);
  for (let i = sources.length - 1; i >= 0; i--) {
    const source = sources[i];
    if (budget) {
      const cost = Math.max(1, Number(source.entry.compSize) || 0, Number(source.entry.uncompSize) || 0);
      if (budget.reads >= MAX_ICON_RESOLVE_READS) { budget.exhausted = true; return null; }
      if (cost > budget.remaining) { budget.exhausted = true; continue; }
      budget.reads++;
      budget.remaining -= cost;
    }
    try {
      const buffer = unzip.entryDataFromFile(source.jarPath, source.entry, maxBytes, maxBytes + 64 * 1024, MAX_JAR_BYTES);
      return { buffer, source };
    } catch (e) {
      if (retryableReadError(e)) manifest.transientReadSerial++;
      // Следующий дубликат ресурса может быть целым.
    }
  }
  return null;
}

function readJsonAsset(manifest, assetName, maxBytes, budget) {
  const cacheKey = assetName + '\0' + maxBytes;
  if (manifest.jsonCache.has(cacheKey)) {
    const cached = manifest.jsonCache.get(cacheKey);
    manifest.jsonCache.delete(cacheKey);
    manifest.jsonCache.set(cacheKey, cached);
    return cached.value;
  }
  const serial = manifest.transientReadSerial;
  const raw = readAsset(manifest, assetName, maxBytes, budget);
  let value = null;
  if (raw) {
    try {
      const parsed = JSON.parse(raw.buffer.toString('utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) value = parsed;
    } catch (e) { /* повреждённый JSON даёт обычный fallback */ }
  }
  // Временный отказ чтения нельзя превращать в вечный отрицательный кэш при
  // неизменившемся JAR; следующий запрос должен попробовать entry ещё раз.
  if (value || manifest.transientReadSerial === serial) {
    const bytes = raw ? raw.buffer.length : 1;
    manifest.jsonCache.set(cacheKey, { value, bytes });
    manifest.jsonCacheBytes += bytes;
    while (manifest.jsonCache.size > MAX_JSON_CACHE || manifest.jsonCacheBytes > MAX_JSON_CACHE_BYTES) {
      const oldestKey = manifest.jsonCache.keys().next().value;
      const oldest = manifest.jsonCache.get(oldestKey);
      manifest.jsonCache.delete(oldestKey);
      manifest.jsonCacheBytes -= oldest.bytes;
    }
  }
  return value;
}

function modelAssetName(location) {
  return 'assets/' + location.namespace + '/models/' + location.path + '.json';
}

function itemDefinitionName(item) {
  return 'assets/' + item.namespace + '/items/' + item.path + '.json';
}

function textureAssetNames(value, currentNamespace) {
  const result = [];
  for (const location of resourceLocations(value, currentNamespace)) {
    let texturePath = location.path.replace(/^textures\//, '').replace(/\.png$/i, '');
    if (!texturePath || texturePath.split('/').some((part) => part === '.' || part === '..')) continue;
    const name = 'assets/' + location.namespace + '/textures/' + texturePath + '.png';
    if (!result.includes(name)) result.push(name);
  }
  return result;
}

function modernModelLocations(definition, namespace) {
  const result = [];
  const seen = new Set();
  const stack = [{ value: definition && definition.model, key: 'root', depth: 0 }];
  let nodes = 0;
  while (stack.length && nodes < MAX_JSON_NODES && result.length < MAX_MODEL_BRANCHES) {
    const current = stack.pop();
    nodes++;
    if (current.depth > MAX_MODEL_DEPTH || current.value == null) continue;
    if (typeof current.value === 'string') {
      if (current.key === 'model' || current.key === 'base' || current.key === 'root') {
        for (const loc of resourceLocations(current.value, namespace)) {
          if (!seen.has(loc.id)) { seen.add(loc.id); result.push(loc); }
        }
      }
      continue;
    }
    if (Array.isArray(current.value)) {
      for (let i = current.value.length - 1; i >= 0; i--) {
        stack.push({ value: current.value[i], key: current.key, depth: current.depth + 1 });
      }
      continue;
    }
    if (typeof current.value !== 'object') continue;
    const entries = Object.entries(current.value);
    for (let i = entries.length - 1; i >= 0; i--) {
      const pair = entries[i];
      stack.push({ value: pair[1], key: pair[0], depth: current.depth + 1 });
    }
  }
  return result;
}

function mergedModelTextures(manifest, location, depth, stack, budget) {
  if (depth > MAX_MODEL_DEPTH || stack.has(location.id)) return {};
  const data = readJsonAsset(manifest, modelAssetName(location), MAX_MODEL_BYTES, budget);
  if (!data) return {};
  const nextStack = new Set(stack);
  nextStack.add(location.id);
  let inherited = {};
  if (typeof data.parent === 'string') {
    const parents = resourceLocations(data.parent, location.namespace);
    for (const parent of parents) {
      inherited = mergedModelTextures(manifest, parent, depth + 1, nextStack, budget);
      if (Object.keys(inherited).length || sourcesFor(manifest, modelAssetName(parent)).length) break;
    }
  }
  const own = data.textures && typeof data.textures === 'object' && !Array.isArray(data.textures)
    ? data.textures : {};
  // Object.assign({}, JSON) особым образом обрабатывает ключ __proto__.
  // Нулевой прототип оставляет даже вредоносный model JSON обычными данными.
  const merged = Object.create(null);
  for (const [key, value] of Object.entries(inherited)) merged[key] = value;
  for (const [key, value] of Object.entries(own)) merged[key] = value;
  return merged;
}

function textureValue(textures, key) {
  const visited = new Set();
  let value = textures[key];
  while (typeof value === 'string' && value.startsWith('#')) {
    const alias = value.slice(1);
    if (!alias || visited.has(alias)) return null;
    visited.add(alias);
    value = textures[alias];
  }
  return typeof value === 'string' && value && !value.startsWith('#') ? value : null;
}

function textureCandidates(manifest, item, budget) {
  const candidates = [];
  const add = (assetName) => {
    if (sourcesFor(manifest, assetName).length && !candidates.includes(assetName)) candidates.push(assetName);
  };
  const definition = readJsonAsset(manifest, itemDefinitionName(item), MAX_MODEL_BYTES, budget);
  const models = definition ? modernModelLocations(definition, item.namespace) : [];
  const legacy = canonicalResourceId(item.namespace + ':item/' + item.path);
  if (!models.some((model) => model.id === legacy.id)) models.push(legacy);
  if (/^(?:item|block)\//.test(item.path)) {
    const exact = canonicalResourceId(item.namespace + ':' + item.path);
    if (!models.some((model) => model.id === exact.id)) models.push(exact);
  }

  const preferred = ['layer0', 'layer1', 'layer2', 'layer3', 'layer4', 'texture', 'all', 'particle', 'front', 'top', 'side', 'end'];
  for (const model of models.slice(0, MAX_MODEL_BRANCHES)) {
    const textures = mergedModelTextures(manifest, model, 0, new Set(), budget);
    const keys = preferred.concat(Object.keys(textures).sort()).filter((key, index, all) => all.indexOf(key) === index)
      .slice(0, MAX_TEXTURE_CANDIDATES);
    for (const key of keys) {
      const value = textureValue(textures, key);
      if (!value) continue;
      for (const assetName of textureAssetNames(value, model.namespace)) add(assetName);
      if (candidates.length >= MAX_TEXTURE_CANDIDATES) break;
    }
    if (candidates.length >= MAX_TEXTURE_CANDIDATES) break;
  }

  // Некоторые простые моды не кладут model JSON, а имя texture совпадает с ID.
  for (const folder of ['item', 'items', 'block', 'blocks']) {
    add('assets/' + item.namespace + '/textures/' + folder + '/' + item.path + '.png');
  }
  for (const suffix of ['_front', '_top', '_side']) {
    add('assets/' + item.namespace + '/textures/block/' + item.path + suffix + '.png');
    add('assets/' + item.namespace + '/textures/blocks/' + item.path + suffix + '.png');
  }
  return candidates;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_DEPTHS = {
  0: new Set([1, 2, 4, 8, 16]),
  2: new Set([8, 16]),
  3: new Set([1, 2, 4, 8]),
  4: new Set([8, 16]),
  6: new Set([8, 16]),
};

function pngInfo(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 45 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE) ||
      buffer.readUInt32BE(8) !== 13 || buffer.toString('ascii', 12, 16) !== 'IHDR' ||
      buffer.readUInt32BE(buffer.length - 12) !== 0 || buffer.toString('ascii', buffer.length - 8, buffer.length - 4) !== 'IEND') {
    return null;
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const bitDepth = buffer[24];
  const colorType = buffer[25];
  if (!width || !height || width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE ||
      width * height > MAX_IMAGE_PIXELS || !PNG_DEPTHS[colorType] || !PNG_DEPTHS[colorType].has(bitDepth) ||
      buffer[26] !== 0 || buffer[27] !== 0 || (buffer[28] !== 0 && buffer[28] !== 1)) return null;
  return { width, height };
}

function cropMetadata(manifest, assetName, info, budget) {
  const meta = readJsonAsset(manifest, assetName + '.mcmeta', MAX_META_BYTES, budget);
  const animation = meta && meta.animation && typeof meta.animation === 'object' ? meta.animation : null;
  let frameWidth = animation && Number.isInteger(animation.width) ? animation.width : null;
  let frameHeight = animation && Number.isInteger(animation.height) ? animation.height : null;
  if (!frameWidth && !frameHeight) {
    frameWidth = info.width;
    frameHeight = info.height > info.width && info.height % info.width === 0 ? info.width : info.height;
  } else {
    if (!frameWidth) frameWidth = frameHeight || info.width;
    if (!frameHeight) frameHeight = frameWidth || info.height;
  }
  if (frameWidth <= 0 || frameHeight <= 0 || frameWidth > info.width || frameHeight > info.height) {
    frameWidth = info.width;
    frameHeight = info.height;
  }
  const frames = Math.max(1, Math.floor(info.width / frameWidth) * Math.floor(info.height / frameHeight));
  return {
    animated: !!animation || frames > 1,
    frames,
    crop: frames > 1 ? { x: 0, y: 0, width: frameWidth, height: frameHeight } : null,
  };
}

function iconCacheKey(key, signature, itemId) {
  return key + '\0' + signature + '\0' + itemId;
}

function cachedIcon(cacheKey) {
  if (!iconCache.has(cacheKey)) return undefined;
  const entry = iconCache.get(cacheKey);
  iconCache.delete(cacheKey);
  iconCache.set(cacheKey, entry);
  return entry.value;
}

function evictFirst(predicate) {
  for (const [key, entry] of iconCache) {
    if (!predicate || predicate(entry)) {
      iconCache.delete(key);
      iconCacheBytes -= entry.bytes;
      return true;
    }
  }
  return false;
}

function cacheIcon(cacheKey, dirKey, value) {
  const previous = iconCache.get(cacheKey);
  if (previous) { iconCache.delete(cacheKey); iconCacheBytes -= previous.bytes; }
  const bytes = value && value.buffer ? value.buffer.length : 0;
  let perDir = 0;
  for (const entry of iconCache.values()) if (entry.dirKey === dirKey) perDir++;
  while (perDir >= MAX_ICONS_PER_DIR && evictFirst((entry) => entry.dirKey === dirKey)) perDir--;
  iconCache.set(cacheKey, { dirKey, bytes, value });
  iconCacheBytes += bytes;
  while (iconCache.size > MAX_ICON_CACHE_ITEMS || iconCacheBytes > MAX_ICON_CACHE_BYTES) {
    if (!evictFirst()) break;
  }
}

async function resolveUncached(manifest, item) {
  const transientStart = manifest.transientReadSerial;
  const budget = { remaining: MAX_ICON_RESOLVE_BYTES, reads: 0, exhausted: false };
  for (const assetName of textureCandidates(manifest, item, budget)) {
    const raw = readAsset(manifest, assetName, MAX_PNG_BYTES, budget);
    if (!raw) continue;
    const info = pngInfo(raw.buffer);
    if (!info) continue;
    const animation = cropMetadata(manifest, assetName, info, budget);
    const tag = crypto.createHash('sha256')
      .update(manifest.signature).update('\0').update(item.id).update('\0').update(assetName)
      .update('\0').update(String(raw.source.entry.crc32)).digest('hex').slice(0, 32);
    return { value: {
      buffer: raw.buffer,
      etag: '"cg-mod-item-' + tag + '"',
      signature: manifest.signature,
      source: assetName,
      width: info.width,
      height: info.height,
      animated: animation.animated,
      frames: animation.frames,
      crop: animation.crop,
    }, retryable: manifest.retryableErrors || manifest.transientReadSerial !== transientStart };
  }
  return { value: null, retryable: manifest.retryableErrors || manifest.transientReadSerial !== transientStart };
}

/* Возвращает готовую PNG и метаданные либо null. modsDir должен быть заранее
   получен вызывающим кодом через общий safePath конкретного сервера. */
async function resolveIcon(modsDir, itemId) {
  const item = canonicalResourceId(itemId);
  const key = mapKey(modsDir);
  const manifest = await getManifest(key);
  const cacheKey = iconCacheKey(key, manifest.signature, item.id);
  const cached = cachedIcon(cacheKey);
  if (cached !== undefined) return cached;
  if (iconInflight.has(cacheKey)) return iconInflight.get(cacheKey);
  const currentGeneration = generation(key);
  const promise = resolveUncached(manifest, item).then((outcome) => {
    if (generation(key) === currentGeneration && (outcome.value || !outcome.retryable)) {
      cacheIcon(cacheKey, key, outcome.value);
    }
    return outcome.value;
  }).finally(() => {
    if (iconInflight.get(cacheKey) === promise) iconInflight.delete(cacheKey);
  });
  iconInflight.set(cacheKey, promise);
  return promise;
}

async function getSignature(modsDir) {
  return (await getManifest(modsDir)).signature;
}

async function getIndexInfo(modsDir) {
  const manifest = await getManifest(modsDir);
  return {
    signature: manifest.signature,
    complete: manifest.complete,
    retryableErrors: manifest.retryableErrors,
    jarCount: manifest.jarCount,
    indexedJars: manifest.indexedJars,
    assetCount: manifest.assetCount,
    indexedEntries: manifest.indexedEntries,
    centralBytes: manifest.totalCentralBytes,
    skipped: manifest.errors.length,
  };
}

function invalidate(modsDir) {
  if (modsDir == null) {
    // Старые Promise могут завершиться уже после очистки. Новая эпоха не даст
    // им вернуть удалённую иконку обратно в свежий кэш.
    generationEpoch++;
    manifestCache.clear();
    iconCache.clear();
    iconInflight.clear();
    generations.clear();
    iconCacheBytes = 0;
    return;
  }
  const key = mapKey(modsDir);
  bumpGeneration(key);
  manifestCache.delete(key);
  for (const [cacheKey, entry] of iconCache) {
    if (entry.dirKey !== key) continue;
    iconCache.delete(cacheKey);
    iconCacheBytes -= entry.bytes;
  }
  // Уже начатое чтение безопасно завершится, но из-за generation не попадёт в кэш.
  for (const cacheKey of iconInflight.keys()) {
    if (cacheKey.startsWith(key + '\0')) iconInflight.delete(cacheKey);
  }
}

module.exports = { resolveIcon, getSignature, getIndexInfo, invalidate, canonicalResourceId };
