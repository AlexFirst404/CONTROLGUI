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

// 2) manage.html из index.html панели + бутстрап (читает ?s=<globalId>) + верхняя панель центра
let html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
const boot =
  '<!-- сгенерировано central/bundle-ui.js: режим полного удалённого управления -->\n' +
  "<script>(function(){var s=(new URLSearchParams(location.search).get('s')||'').replace(/[^a-f0-9]/g,'');" +
  "window.CG_API_BASE='/r/'+s;window.CG_REMOTE=true;})();</script>\n";
if (html.indexOf('<script src="js/api.js"></script>') < 0) { console.error('Не нашёл тег js/api.js в index.html'); process.exit(1); }
html = html.replace('<script src="js/api.js"></script>', boot + '<script src="js/api.js"></script>');

// верхняя панель центра — связь с сайтом (на главную / к серверам / аккаунт / выйти)
const bar =
  '<style>' +
  '#cg-remote-bar{position:sticky;top:0;z-index:80;display:flex;align-items:center;justify-content:space-between;gap:12px;' +
  'padding:8px 16px;background:#171717;border-bottom:2px solid #454545;font-family:\'Minecraft Ten\',\'Minecraft\',sans-serif}' +
  '#cg-remote-bar .cgrb-brand{color:#e6e6e6;text-decoration:none;font-size:16px;letter-spacing:1px}' +
  '#cg-remote-bar .cgrb-brand b{color:#80da5b}' +
  '#cg-remote-bar .cgrb-nav{display:flex;align-items:center;gap:16px;font-size:13px}' +
  '#cg-remote-bar .cgrb-nav a{color:#80da5b;text-decoration:none}' +
  '#cg-remote-bar #cgrb-user{color:#a9a9a9}' +
  '#cg-remote-bar #cgrb-logout{color:#ff8a7e}' +
  '</style>' +
  '<div id="cg-remote-bar">' +
  '<a class="cgrb-brand" href="/">CONTROL<b>GUI</b> Remote</a>' +
  '<div class="cgrb-nav">' +
  '<a href="/">← К серверам</a>' +
  '<span id="cgrb-user"></span>' +
  '<a href="#" id="cgrb-logout">Выйти</a>' +
  '</div></div>\n' +
  '<script>' +
  "fetch('/api/me').then(function(r){return r.json();}).then(function(d){if(d&&d.user){var e=document.getElementById('cgrb-user');if(e)e.textContent=d.user.username+(d.user.role==='admin'?' · админ':'');}}).catch(function(){});" +
  "(function(){var l=document.getElementById('cgrb-logout');if(l)l.onclick=function(ev){ev.preventDefault();fetch('/api/logout',{method:'POST'}).then(function(){location.href='/';});};})();" +
  '</script>\n';
const bodyTag = html.match(/<body[^>]*>/);
if (bodyTag) html = html.replace(bodyTag[0], bodyTag[0] + '\n' + bar);
fs.writeFileSync(path.join(DST, 'manage.html'), html);

console.log('UI панели собран в central/public + manage.html');
