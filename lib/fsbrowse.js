'use strict';
/* Проводник по ФАЙЛОВОЙ СИСТЕМЕ КОМПЬЮТЕРА для панели внутри Minecraft
   (окно «Этот компьютер»). Отдаёт список каталогов, чтение/запись текстовых
   файлов, создание папок и документов по АБСОЛЮТНЫМ путям.

   БЕЗОПАСНОСТЬ: маршруты подключаются в server.js ТОЛЬКО в локальной ветке
   (loopback + заголовок x-cg-local:1). Проксированные центром удалённые
   запросы сюда не попадают (они уходят веткой internalUserFor раньше и не
   несут заголовок). Это личный компьютер пользователя — доступ к диску
   осознанный; удалённые «друзья» через центр к нему НЕ имеют доступа. */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const MAX_ENTRIES = 4000;        // не отдаём гигантские каталоги целиком
const MAX_READ = 2 * 1024 * 1024; // 2 МБ — предел чтения текстового файла
const MAX_COPY_FILES = 20000;              // защита от копирования гигантских деревьев
const MAX_COPY_BYTES = 8 * 1024 * 1024 * 1024; // 8 ГБ — и от переполнения диска

/* Находится ли child внутри parent (или равен ему). Защита от копирования
   папки в саму себя / в собственную подпапку (бесконечная рекурсия). */
function isInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

/* Копирование выполняем АСИНХРОННО (fs.promises) и периодически уступаем цикл
   событий (setImmediate), иначе большой синхронный обход/копирование заморозило
   бы весь процесс панели — включая SSE-туннель к центру (удалённые друзья) и
   опрос статуса. Символические ссылки не копируем (циклы/выход за пределы). */
async function yieldMaybe(acc) {
  if (++acc.since >= 200) { acc.since = 0; await new Promise((r) => setImmediate(r)); }
}

/* Оценка объёма дерева ДО копирования: бросает 413, если превышены лимиты
   (чтобы не оставлять частичную копию). Считаем и папки, и файлы. */
async function measureTree(src, acc) {
  const st = await fsp.lstat(src);
  if (st.isSymbolicLink()) return;
  acc.files++;
  if (acc.files > MAX_COPY_FILES) { const e = new Error('Слишком много файлов для копирования'); e.status = 413; throw e; }
  await yieldMaybe(acc);
  if (st.isDirectory()) {
    for (const name of await fsp.readdir(src)) await measureTree(path.join(src, name), acc);
  } else if (st.isFile()) {
    acc.bytes += st.size;
    if (acc.bytes > MAX_COPY_BYTES) { const e = new Error('Слишком большой объём (> 8 ГБ)'); e.status = 413; throw e; }
  }
}

/* Рекурсивное копирование файла/папки src → dst (dst — полный целевой путь). */
async function copyTree(src, dst, acc) {
  const st = await fsp.lstat(src);
  if (st.isSymbolicLink()) return; // ссылки пропускаем
  await yieldMaybe(acc);
  if (st.isDirectory()) {
    await fsp.mkdir(dst, { recursive: true });
    for (const name of await fsp.readdir(src)) await copyTree(path.join(src, name), path.join(dst, name), acc);
  } else if (st.isFile()) {
    await fsp.copyFile(src, dst);
  }
  // устройства/сокеты/каналы пропускаем
}

/* Копирует src ВНУТРЬ каталога destDir, сохраняя имя; при конфликте имени
   добавляет « (2)», « (3)»… (для файлов сохраняя расширение). Если свободного
   имени не нашлось — ошибка (не перезаписываем чужой файл молча). */
async function copyInto(src, destDir) {
  const parsed = path.parse(path.basename(src));
  let target = path.join(destDir, parsed.base);
  for (let n = 2; fs.existsSync(target); n++) {
    if (n >= 1000) { const e = new Error('Не удалось подобрать свободное имя для копии'); e.status = 409; throw e; }
    target = path.join(destDir, parsed.name + ' (' + n + ')' + parsed.ext);
  }
  await copyTree(src, target, { since: 0 });
  return target;
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    let over = false;
    req.on('data', (c) => {
      data += c;
      if (data.length > 8 * 1024 * 1024) { over = true; req.destroy(); }
    });
    req.on('end', () => {
      if (over) return resolve({});
      try { resolve(JSON.parse(data || '{}')); } catch (e) { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

/* Список логических дисков (Windows) или корень (POSIX) — стартовый экран. */
function listRoots() {
  if (process.platform === 'win32') {
    const drives = [];
    for (let c = 'C'.charCodeAt(0); c <= 'Z'.charCodeAt(0); c++) {
      const letter = String.fromCharCode(c) + ':\\';
      try {
        fs.accessSync(letter, fs.constants.R_OK);
        drives.push({ name: String.fromCharCode(c) + ':', type: 'dir', path: letter });
      } catch (e) { /* нет такого диска */ }
    }
    // диск C всегда есть, но на всякий случай не оставляем пустой список
    if (!drives.length) drives.push({ name: 'C:', type: 'dir', path: 'C:\\' });
    return drives;
  }
  return [{ name: '/', type: 'dir', path: '/' }];
}

/* Родительский каталог или null, если уже в корне/на списке дисков. */
function parentOf(p) {
  if (process.platform === 'win32') {
    // «C:\» — корень диска: родитель = список дисков (null-путь)
    if (/^[a-zA-Z]:[\\/]?$/.test(p)) return null;
  } else if (p === '/') {
    return null;
  }
  const par = path.dirname(p);
  if (par === p) return null;
  return par;
}

function listDir(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    const err = new Error(e.code === 'EACCES' || e.code === 'EPERM'
      ? 'Нет доступа к папке' : 'Папку не открыть: ' + e.code);
    err.status = e.code === 'ENOENT' ? 404 : 403;
    throw err;
  }
  const out = [];
  let truncated = false;
  for (const ent of entries) {
    if (out.length >= MAX_ENTRIES) { truncated = true; break; }
    let type = ent.isDirectory() ? 'dir' : (ent.isFile() ? 'file' : null);
    let size = 0;
    let mtime = 0;
    const full = path.join(dir, ent.name);
    if (ent.isSymbolicLink()) {
      // символическую ссылку разрешаем и показываем как её цель
      try {
        const st = fs.statSync(full);
        type = st.isDirectory() ? 'dir' : 'file';
        size = st.size; mtime = st.mtimeMs;
      } catch (e) { type = 'file'; }
    } else if (type === 'file') {
      try { const st = fs.statSync(full); size = st.size; mtime = st.mtimeMs; }
      catch (e) { /* недоступен — оставляем нули */ }
    } else if (type === 'dir') {
      try { mtime = fs.statSync(full).mtimeMs; } catch (e) { /* */ }
    }
    if (!type) continue; // устройства/сокеты/каналы пропускаем
    out.push({
      name: ent.name,
      type,
      size,
      mtime,
      hidden: ent.name.startsWith('.'),
      path: full,
    });
  }
  // папки сверху, затем по алфавиту без учёта регистра
  out.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase(), 'ru');
  });
  return { entries: out, truncated };
}

/* Похоже ли содержимое на бинарник (NUL-байт в начале). */
function looksBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/* Обрабатывает /api/fs/*. Возвращает true, если запрос обработан. Вызывать
   ТОЛЬКО из локальной ветки server.js (loopback + x-cg-local:1). */
async function handle(req, res, urlPath, query) {
  if (!urlPath.startsWith('/api/fs/')) return false;
  const action = urlPath.slice('/api/fs/'.length);

  try {
    if (action === 'list' && req.method === 'GET') {
      const p = query.get('path') || '';
      if (!p) return sendJson(res, 200, { path: '', parent: null, roots: true, entries: listRoots() });
      const abs = path.resolve(p);
      const { entries, truncated } = listDir(abs);
      return sendJson(res, 200, {
        path: abs, parent: parentOf(abs), roots: false, truncated, entries,
      });
    }

    if (action === 'read' && req.method === 'GET') {
      const p = query.get('path') || '';
      if (!p) return sendJson(res, 400, { error: 'Не указан путь' });
      const abs = path.resolve(p);
      let st;
      try { st = fs.statSync(abs); } catch (e) { return sendJson(res, 404, { error: 'Файл не найден' }); }
      if (st.isDirectory()) return sendJson(res, 400, { error: 'Это папка' });
      if (st.size > MAX_READ) return sendJson(res, 413, { error: 'Файл слишком большой для просмотра (> 2 МБ)', tooBig: true });
      const buf = fs.readFileSync(abs);
      if (looksBinary(buf)) return sendJson(res, 415, { error: 'Бинарный файл — не показывается', binary: true });
      return sendJson(res, 200, { path: abs, text: buf.toString('utf8'), size: st.size });
    }

    if (action === 'write' && req.method === 'POST') {
      const b = await readBody(req);
      const p = String(b.path || '');
      if (!p) return sendJson(res, 400, { error: 'Не указан путь' });
      const abs = path.resolve(p);
      try { if (fs.statSync(abs).isDirectory()) return sendJson(res, 400, { error: 'Это папка' }); }
      catch (e) { /* нового файла ещё нет — это ок */ }
      fs.writeFileSync(abs, String(b.text != null ? b.text : ''), 'utf8');
      return sendJson(res, 200, { ok: true, path: abs });
    }

    if (action === 'mkdir' && req.method === 'POST') {
      const b = await readBody(req);
      const dir = String(b.dir || '');
      const name = String(b.name || '').trim();
      if (!dir || !name) return sendJson(res, 400, { error: 'Не указана папка или имя' });
      if (/[\\/:*?"<>|]/.test(name)) return sendJson(res, 400, { error: 'Недопустимое имя' });
      const abs = path.join(path.resolve(dir), name);
      try { fs.mkdirSync(abs); }
      catch (e) {
        return sendJson(res, e.code === 'EEXIST' ? 409 : 403,
          { error: e.code === 'EEXIST' ? 'Такая папка уже есть' : 'Не удалось создать: ' + e.code });
      }
      return sendJson(res, 200, { ok: true, path: abs });
    }

    if (action === 'newfile' && req.method === 'POST') {
      const b = await readBody(req);
      const dir = String(b.dir || '');
      const name = String(b.name || '').trim();
      if (!dir || !name) return sendJson(res, 400, { error: 'Не указана папка или имя' });
      if (/[\\/:*?"<>|]/.test(name)) return sendJson(res, 400, { error: 'Недопустимое имя' });
      const abs = path.join(path.resolve(dir), name);
      if (fs.existsSync(abs)) return sendJson(res, 409, { error: 'Такой файл уже есть' });
      try { fs.writeFileSync(abs, '', { flag: 'wx' }); }
      catch (e) { return sendJson(res, 403, { error: 'Не удалось создать: ' + e.code }); }
      return sendJson(res, 200, { ok: true, path: abs });
    }

    // список серверов — для выбора «куда копировать»
    if (action === 'servers' && req.method === 'GET') {
      const store = require('./store');
      const list = store.all().map((s) => ({ id: s.id, name: s.name || s.id }));
      list.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase(), 'ru'));
      return sendJson(res, 200, { servers: list });
    }

    // копирование файла/папки с ПК прямо в каталог сервера (рекурсивно)
    if (action === 'copy-to-server' && req.method === 'POST') {
      const b = await readBody(req);
      const src = String(b.src || '');
      const serverId = String(b.serverId || '');
      const sub = String(b.sub || '').trim();
      if (!src || !serverId) return sendJson(res, 400, { error: 'Не указан источник или сервер' });
      const srv = require('./store').get(serverId);
      if (!srv) return sendJson(res, 404, { error: 'Сервер не найден' });
      const absSrc = path.resolve(src);
      let st;
      try { st = fs.lstatSync(absSrc); } catch (e) { return sendJson(res, 404, { error: 'Источник не найден' }); }
      if (st.isSymbolicLink()) return sendJson(res, 400, { error: 'Ссылки не копируются' });
      if (!st.isDirectory() && !st.isFile()) return sendJson(res, 400, { error: 'Можно копировать только файлы и папки' });
      let destDir = require('./paths').serverDir(serverId);
      if (sub) {
        if (/[\\/:*?"<>|]/.test(sub) || sub === '..' || sub === '.') return sendJson(res, 400, { error: 'Недопустимая подпапка' });
        destDir = path.join(destDir, sub);
      }
      if (isInside(destDir, absSrc)) return sendJson(res, 400, { error: 'Нельзя копировать папку в саму себя' });
      await fsp.mkdir(destDir, { recursive: true });
      await measureTree(absSrc, { files: 0, bytes: 0, since: 0 });
      const target = await copyInto(absSrc, destDir);
      return sendJson(res, 200, { ok: true, path: target, name: path.basename(target), server: srv.name || srv.id });
    }

    return sendJson(res, 404, { error: 'Неизвестный метод проводника' });
  } catch (e) {
    return sendJson(res, e.status || 500, { error: e.message || 'Ошибка проводника' });
  }
}

module.exports = { handle };
