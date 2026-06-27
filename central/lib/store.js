'use strict';
/* Простое JSON-хранилище центрального сервера (без зависимостей).
   Данные — в CGR_DATA (по умолчанию central/data рядом с кодом). */
const fs = require('fs');
const path = require('path');

const DATA = process.env.CGR_DATA
  ? path.resolve(process.env.CGR_DATA)
  : path.join(__dirname, '..', 'data');

fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });

function file(name) { return path.join(DATA, name); }

function load(name, def) {
  let raw;
  try { raw = fs.readFileSync(file(name), 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') return def; // файла ещё нет — это норма
    throw e;                             // есть, но нечитаем — НЕ молчать (иначе ensureAdmin затрёт всех)
  }
  raw = raw.replace(/^﻿/, ''); // strip BOM
  try { return JSON.parse(raw); }
  catch (e) { throw new Error('Повреждён файл данных: ' + name); }
}

function save(name, obj) {
  // атомарная запись: пишем во временный (0600) и переименовываем (rename сохраняет права inode)
  const tmp = file(name + '.tmp');
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file(name));
}

module.exports = { DATA, load, save };
