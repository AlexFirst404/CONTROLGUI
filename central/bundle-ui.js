'use strict';
/* Сборка UI панели в central/public для полного удалённого управления (1:1 как в приложении).
   Копирует js/app.js, js/api.js, icons/, assets/, fonts/, css/minecraft.css из панели и
   генерирует manage.html из index.html (с бутстрапом CG_API_BASE/CG_REMOTE).
   ЗАПУСКАТЬ при изменении UI панели: node central/bundle-ui.js  (результат КОММИТИТСЯ). */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'public');     // public/ панели
const DST = path.join(__dirname, 'public');           // central/public/

function copyDir(src, dst) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name); const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

// 1) ассеты UI панели (НЕ трогаем index.html/admin.html/style.css центра)
copyDir(path.join(SRC, 'js'), path.join(DST, 'js'));        // api.js + app.js
copyDir(path.join(SRC, 'icons'), path.join(DST, 'icons'));
copyDir(path.join(SRC, 'assets'), path.join(DST, 'assets')); // merge (cursor.png центра остаётся)
copyDir(path.join(SRC, 'fonts'), path.join(DST, 'fonts'));
fs.mkdirSync(path.join(DST, 'css'), { recursive: true });
fs.copyFileSync(path.join(SRC, 'css', 'minecraft.css'), path.join(DST, 'css', 'minecraft.css'));
if (fs.existsSync(path.join(SRC, 'logo.png'))) fs.copyFileSync(path.join(SRC, 'logo.png'), path.join(DST, 'logo.png'));

// 2) manage.html из index.html панели + бутстрап (читает ?s=<globalId>)
let html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
const boot =
  '<!-- сгенерировано central/bundle-ui.js: режим полного удалённого управления -->\n' +
  "<script>(function(){var s=(new URLSearchParams(location.search).get('s')||'').replace(/[^a-f0-9]/g,'');" +
  "window.CG_API_BASE='/r/'+s;window.CG_REMOTE=true;})();</script>\n";
if (html.indexOf('<script src="js/api.js"></script>') < 0) { console.error('Не нашёл тег js/api.js в index.html'); process.exit(1); }
html = html.replace('<script src="js/api.js"></script>', boot + '<script src="js/api.js"></script>');
fs.writeFileSync(path.join(DST, 'manage.html'), html);

console.log('UI панели собран в central/public + manage.html');
