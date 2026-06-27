'use strict';
/* Простое JSON-хранилище центрального сервера (без зависимостей).
   Данные — в CGR_DATA (по умолчанию central/data рядом с кодом). */
const fs = require('fs');
const path = require('path');

const DATA = process.env.CGR_DATA
  ? path.resolve(process.env.CGR_DATA)
  : path.join(__dirname, '..', 'data');

fs.mkdirSync(DATA, { recursive: true });

function file(name) { return path.join(DATA, name); }

function load(name, def) {
  try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); }
  catch (e) { return def; }
}

function save(name, obj) {
  // атомарная запись: пишем во временный и переименовываем
  const tmp = file(name + '.tmp');
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file(name));
}

module.exports = { DATA, load, save };
