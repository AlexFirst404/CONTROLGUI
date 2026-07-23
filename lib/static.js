'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { PUBLIC_DIR } = require('./paths');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

// расширения, которые имеет смысл сжимать (бинарные форматы уже сжаты)
const GZIP_EXT = new Set(['.html', '.css', '.js', '.json', '.svg']);

// кэш в памяти: путь -> { mtimeMs, size, etag, raw, gz }
// gz считается лениво один раз и переиспользуется, пока файл не изменится
const cache = new Map();

function entryFor(file, stat) {
  let e = cache.get(file);
  if (e && e.mtimeMs === stat.mtimeMs && e.size === stat.size) return e;
  e = {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    etag: '"' + stat.size.toString(16) + '-' + Math.round(stat.mtimeMs).toString(16) + '"',
    raw: null,
    gz: null,
  };
  cache.set(file, e);
  return e;
}

function serveStatic(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch (e) {
    pathname = '/';
  }
  if (pathname === '/') pathname = '/index.html';

  // NUL/управляющие байты в пути: fs.stat бросает синхронно (ERR_INVALID_ARG_VALUE)
  // и роняет процесс — отбиваем сразу как некорректный запрос
  if (pathname.indexOf('\0') !== -1) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('400: неверный запрос');
  }

  const file = path.normalize(path.join(PUBLIC_DIR, pathname));
  // строгая граница по разделителю: без неё путь в соседнюю папку с общим префиксом
  // имени (public-secret/) прошёл бы проверку startsWith(PUBLIC_DIR)
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404: файл не найден');
    }

    const ext = path.extname(file).toLowerCase();
    const e = entryFor(file, stat);

    // код SPA (html/js/css) отдаём БЕЗ кэша (no-store): WebView2/встроенный браузер
    // порой не ревалидирует ETag и держит старый app.js после обновления панели —
    // тогда новые фичи «не появляются». Для локальной панели кэш JS пользы не даёт.
    const noStore = ext === '.html' || ext === '.js' || ext === '.css';

    // условный GET (304) — только для кэшируемых ассетов (шрифты/картинки/иконки)
    if (!noStore && req.headers['if-none-match'] === e.etag) {
      res.writeHead(304, { ETag: e.etag, 'Cache-Control': 'no-cache' });
      return res.end();
    }

    const headers = noStore
      ? { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' }
      : { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache', ETag: e.etag };

    const wantsGzip = GZIP_EXT.has(ext) && /\bgzip\b/.test(req.headers['accept-encoding'] || '');

    const send = () => {
      if (wantsGzip) {
        if (!e.gz) e.gz = zlib.gzipSync(e.raw);
        headers['Content-Encoding'] = 'gzip';
        headers.Vary = 'Accept-Encoding';
        headers['Content-Length'] = e.gz.length;
        res.writeHead(200, headers);
        res.end(req.method === 'HEAD' ? undefined : e.gz);
      } else {
        headers['Content-Length'] = e.raw.length;
        res.writeHead(200, headers);
        res.end(req.method === 'HEAD' ? undefined : e.raw);
      }
    };

    if (e.raw) return send();
    fs.readFile(file, (rErr, data) => {
      if (rErr) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('404: файл не найден');
      }
      e.raw = data;
      send();
    });
  });
}

module.exports = { serveStatic };
