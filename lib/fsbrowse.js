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
const path = require('path');

const MAX_ENTRIES = 4000;        // не отдаём гигантские каталоги целиком
const MAX_READ = 2 * 1024 * 1024; // 2 МБ — предел чтения текстового файла

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

    return sendJson(res, 404, { error: 'Неизвестный метод проводника' });
  } catch (e) {
    return sendJson(res, e.status || 500, { error: e.message || 'Ошибка проводника' });
  }
}

module.exports = { handle };
