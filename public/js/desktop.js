'use strict';
/* Рабочий стол CONTROLGUI внутри Minecraft: серверы-иконки с контекстным меню,
   панель задач, часы и окна. Каждое окно — iframe того же приложения в
   embed-режиме (?embed=1&go=...), поэтому все экраны панели работают без
   переписывания. Перетаскивание за заголовок, изменение размера только за
   края/углы, сворачивание в панель задач, разворот на весь экран, z-порядок
   по клику; геометрия запоминается в sessionStorage. */
(() => {
  const $ = (s) => document.querySelector(s);
  const desktop = $('#cg-desktop');
  const shield = $('#cg-drag-shield');
  const taskWins = $('#cg-task-wins');
  const iconsBox = $('#cg-icons');
  const menuEl = $('#cg-menu');

  // масштаб интерфейса применяем КО ВСЕМУ рабочему столу (а не к отдельному
  // окну-настроек, чей body-зум затрагивал только саму страницу настроек).
  // deskZoom — текущий множитель: при CSS zoom на <html> координаты указателя
  // (clientX) считаются в ВИЗУАЛЬНЫХ пикселях, а left/top/transform — в
  // ЛОГИЧЕСКИХ; чтобы окна/иконки при перетаскивании не «убегали» от курсора на
  // масштабе ≠100%, дельту жеста делим на deskZoom.
  let deskZoom = 1;
  function applyDeskScale(scale) {
    const z = (typeof scale === 'number' && scale >= 50 && scale <= 300) ? scale : 100;
    deskZoom = z / 100;
    document.documentElement.style.zoom = z === 100 ? '' : deskZoom;
  }

  // тема и масштаб — из общих настроек панели
  try {
    const s = JSON.parse(localStorage.getItem('controlgui-settings') || '{}');
    document.body.classList.add(s.theme === 'theme-blue' ? 'theme-blue' : 'theme-lime');
    applyDeskScale(s.scale);
  } catch (e) { document.body.classList.add('theme-lime'); }

  // нативное контекстное меню CEF не к месту на рабочем столе
  document.addEventListener('contextmenu', (e) => e.preventDefault());

  const SRC = {
    servers: '/?embed=1&go=home',
    settings: '/?embed=1&go=settings',
    profile: '/?embed=1&go=profile',
    gate: '/?embed=1&go=gate',
    pc: '/pc.html',
  };
  const DEFAULTS = {
    servers: { w: 840, h: 560, title: 'Серверы', icon: 'server' },
    settings: { w: 540, h: 560, title: 'Настройки', icon: 'sliders' },
    profile: { w: 620, h: 560, title: 'Аккаунт', icon: 'user' },
    gate: { w: 520, h: 560, title: 'Вход в аккаунт', icon: 'user' },
    server: { w: 900, h: 600, title: 'Сервер', icon: 'command' },
    editor: { w: 760, h: 540, title: 'Редактор', icon: 'script-text' },
    files: { w: 820, h: 560, title: 'Проводник', icon: 'folder' },
    pc: { w: 880, h: 600, title: 'Этот компьютер', icon: 'monitor' },
    // нативные окна рабочего стола (без iframe): папка и текстовый документ
    folder: { w: 560, h: 420, title: 'Папка', icon: 'folder', native: true },
    doc: { w: 620, h: 480, title: 'Документ', icon: 'script-text', native: true },
  };

  function srcFor(kind, id) {
    if (kind === 'server') return '/?embed=1&go=server/' + encodeURIComponent(id);
    if (kind === 'files') return '/?embed=1&go=files/' + encodeURIComponent(id);
    if (kind === 'editor') {
      // id = "<serverId>:<путь файла>" — путь кодируем вложенно, чтобы пережил go
      const cut = id.indexOf(':');
      const sid = id.slice(0, cut);
      const p = id.slice(cut + 1);
      return '/?embed=1&go=' + encodeURIComponent('editor/' + sid + '/' + encodeURIComponent(p));
    }
    return SRC[kind];
  }

  /* Недавно открытые файлы — для win-меню. */
  function recentFiles() {
    try { return JSON.parse(localStorage.getItem('cgRecentFiles') || '[]'); }
    catch (e) { return []; }
  }
  function rememberRecent(sid, path) {
    const list = recentFiles().filter((r) => !(r.sid === sid && r.path === path));
    list.unshift({ sid, path, ts: Date.now() });
    try { localStorage.setItem('cgRecentFiles', JSON.stringify(list.slice(0, 10))); }
    catch (e) { /* приватный режим */ }
  }
  /* Файл/сервер исчез — выкидываем из «недавних», чтобы не копить мёртвые. */
  function forgetRecent(sid, path) {
    const list = recentFiles().filter((r) =>
      path != null ? !(r.sid === sid && r.path === path) : r.sid !== sid);
    try { localStorage.setItem('cgRecentFiles', JSON.stringify(list)); }
    catch (e) { /* приватный режим */ }
  }

  const wins = new Map(); // key -> {key, kind, id, el, frame, btn, min, maxed}
  let zTop = 10;
  let geom = {};
  try { geom = JSON.parse(sessionStorage.getItem('cgWinGeom') || '{}'); } catch (e) { /* пусто */ }

  function saveGeom(win) {
    const el = win.el;
    // развёрнутое окно: храним «до-развёрнутую» геометрию; свёрнутое —
    // display:none, offsetWidth=0 — берём прежнее сохранённое, а не нули
    const base = win.maxed && win.premax
      ? win.premax
      : (win.min && geom[win.key])
        ? geom[win.key]
        : { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
    geom[win.key] = { x: base.x, y: base.y, w: base.w, h: base.h, min: win.min, max: win.maxed };
    try { sessionStorage.setItem('cgWinGeom', JSON.stringify(geom)); } catch (e) { /* приватный режим */ }
  }

  function icon(name) {
    const i = document.createElement('i');
    i.className = 'pi';
    i.style.setProperty('--i', "url('/icons/" + name + ".svg')");
    return i;
  }

  function focus(win) {
    win.el.style.zIndex = String(++zTop);
    for (const w of wins.values()) {
      w.el.classList.toggle('focus', w === win);
      w.btn.classList.toggle('active', w === win && !w.min);
    }
  }

  function minimize(win) {
    win.min = true;
    win.btn.classList.add('minned');
    win.btn.classList.remove('active');
    const el = win.el;
    el.classList.remove('cg-restoring');
    el.classList.add('cg-minimizing');
    // display:none ставим только ПОСЛЕ анимации сворачивания
    el.addEventListener('animationend', () => {
      el.classList.remove('cg-minimizing');
      if (win.min) el.classList.add('min');
    }, { once: true });
    saveGeom(win);
  }

  function restore(win) {
    win.min = false;
    const el = win.el;
    el.classList.remove('min');
    el.classList.remove('cg-minimizing');
    win.btn.classList.remove('minned');
    el.classList.add('cg-restoring');
    el.addEventListener('animationend', () => el.classList.remove('cg-restoring'), { once: true });
    focus(win);
    saveGeom(win);
  }

  /* Разворот на весь рабочий стол и обратно (прежняя геометрия запоминается). */
  function toggleMaximize(win) {
    const el = win.el;
    if (!win.maxed) {
      win.premax = { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
      win.maxed = true;
      el.classList.add('maxed');
      el.style.left = '0px';
      el.style.top = '0px';
      el.style.width = window.innerWidth + 'px';
      el.style.height = (window.innerHeight - 56) + 'px'; // не наезжаем на панель задач
    } else {
      win.maxed = false;
      el.classList.remove('maxed');
      const p = win.premax || {};
      el.style.left = (p.x != null ? p.x : 60) + 'px';
      el.style.top = (p.y != null ? p.y : 60) + 'px';
      el.style.width = (p.w || DEFAULTS[win.kind].w) + 'px';
      el.style.height = (p.h || DEFAULTS[win.kind].h) + 'px';
    }
    focus(win);
    saveGeom(win);
  }

  function closeWindow(key, opts) {
    const win = wins.get(key);
    if (!win) return;
    wins.delete(key);
    delete geom[key];
    try { sessionStorage.setItem('cgWinGeom', JSON.stringify(geom)); } catch (e) { /* */ }
    if (win.btn) win.btn.remove();
    const el = win.el;
    if (opts && opts.instant) { el.remove(); return; }
    // «уничтожение» окна — схлопывание к кнопкам (transform-origin в CSS)
    el.classList.add('cg-closing');
    const kill = () => { if (el.parentNode) el.remove(); };
    el.addEventListener('animationend', kill, { once: true });
    setTimeout(kill, 320); // фолбэк, если анимация не отработала
  }

  /* Перетаскивание/ресайз: во время жеста включаем «щит», иначе iframe
     проглатывает pointermove и жест обрывается на границе окна. cursorCss —
     курсор на время жеста (ns-resize и т.п.), чтобы не мигал стрелкой. */
  function gesture(startEvent, cursorCss, onMove, onEnd) {
    startEvent.preventDefault();
    shield.style.cursor = cursorCss || 'default';
    shield.classList.remove('hidden');
    const move = (e) => onMove(e);
    const up = () => {
      shield.classList.add('hidden');
      shield.style.cursor = '';
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (onEnd) onEnd();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  function clampToDesktop(el) {
    const maxX = Math.max(0, window.innerWidth - 120);
    const maxY = Math.max(0, window.innerHeight - 80);
    el.style.left = Math.min(Math.max(0, el.offsetLeft), maxX) + 'px';
    el.style.top = Math.min(Math.max(0, el.offsetTop), maxY) + 'px';
  }

  function createWindow(kind, id, titleOverride) {
    const key = kind + (id ? ':' + id : '');
    const existing = wins.get(key);
    if (existing) {
      if (titleOverride) { existing.nameEl.textContent = titleOverride; existing.btnLabel.textContent = titleOverride; }
      // свёрнутое — разворачиваем с анимацией; уже видимое — просто фокус
      // (иначе анимация «рост снизу» переигрывается у окна, что и так на экране)
      if (existing.min) restore(existing); else focus(existing);
      return existing;
    }
    const def = DEFAULTS[kind];
    const saved = geom[key] || {};
    const el = document.createElement('section');
    el.className = 'cg-win';
    const w = saved.w || def.w;
    const h = saved.h || def.h;
    el.style.width = Math.min(w, window.innerWidth - 24) + 'px';
    el.style.height = Math.min(h, window.innerHeight - 70) + 'px';
    const cascade = 48 + (wins.size % 8) * 34;
    el.style.left = (saved.x != null ? saved.x : cascade) + 'px';
    el.style.top = (saved.y != null ? saved.y : cascade) + 'px';

    // заголовок
    const title = document.createElement('div');
    title.className = 'cg-win-title';
    title.appendChild(icon(def.icon));
    const nameEl = document.createElement('span');
    nameEl.className = 'cg-win-name';
    nameEl.textContent = titleOverride || def.title;
    title.appendChild(nameEl);
    const btns = document.createElement('div');
    btns.className = 'cg-win-btns';
    const btnMin = document.createElement('button');
    btnMin.className = 'cg-win-btn';
    btnMin.title = 'Свернуть';
    btnMin.appendChild(icon('minus'));
    const btnMax = document.createElement('button');
    btnMax.className = 'cg-win-btn';
    btnMax.title = 'Развернуть/восстановить';
    btnMax.appendChild(icon('maximize'));
    const btnClose = document.createElement('button');
    btnClose.className = 'cg-win-btn close';
    btnClose.title = 'Закрыть';
    btnClose.appendChild(icon('close'));
    btns.appendChild(btnMin);
    btns.appendChild(btnMax);
    btns.appendChild(btnClose);
    title.appendChild(btns);
    el.appendChild(title);

    // содержимое: iframe панели ИЛИ нативное окно рабочего стола (папка/документ)
    const body = document.createElement('div');
    body.className = 'cg-win-body';
    let frame = null;
    if (def.native) {
      body.classList.add('cg-win-native');
    } else {
      frame = document.createElement('iframe');
      frame.className = 'cg-win-frame';
      frame.src = srcFor(kind, id);
      body.appendChild(frame);
    }
    el.appendChild(body);

    const win = { key, kind, id, el, frame, body, btn: null, nameEl, btnLabel: null, min: false, maxed: false };
    if (def.native) buildNativeContent(win, kind, id);

    // ручки ресайза — размер меняется ТОЛЬКО за края и углы окна
    const DIRS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
    for (const d of DIRS) {
      const hnd = document.createElement('div');
      hnd.className = 'cg-rs cg-rs-' + d;
      hnd.addEventListener('pointerdown', (e) => {
        if (win.maxed) return; // развёрнутое окно за края не тянется
        focus(win);
        const sx = e.clientX, sy = e.clientY;
        const sl = el.offsetLeft, st = el.offsetTop, sw = el.offsetWidth, sh = el.offsetHeight;
        gesture(e, getComputedStyle(hnd).cursor, (ev) => {
          const dx = ev.clientX - sx, dy = ev.clientY - sy;
          if (d.includes('e')) el.style.width = Math.max(380, sw + dx) + 'px';
          if (d.includes('s')) el.style.height = Math.max(240, sh + dy) + 'px';
          if (d.includes('w')) {
            const nw = Math.max(380, sw - dx);
            el.style.width = nw + 'px';
            el.style.left = (sl + (sw - nw)) + 'px';
          }
          if (d.includes('n')) {
            const nh = Math.max(240, sh - dy);
            el.style.height = nh + 'px';
            el.style.top = (st + (sh - nh)) + 'px';
          }
        }, () => saveGeom(win));
      });
      el.appendChild(hnd);
    }

    // кнопка в панели задач
    const btn = document.createElement('button');
    btn.className = 'cg-task-btn';
    btn.appendChild(icon(def.icon));
    const btnLabel = document.createElement('span');
    btnLabel.textContent = titleOverride || def.title;
    btn.appendChild(btnLabel);
    taskWins.appendChild(btn);
    win.btn = btn;
    win.btnLabel = btnLabel;

    wins.set(key, win);

    // события
    title.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.cg-win-btn')) return;
      focus(win);
      if (win.maxed) return; // развёрнутое не таскается
      const startLeft = el.offsetLeft, startTop = el.offsetTop;
      const ox = e.clientX, oy = e.clientY;
      let dx = 0, dy = 0;
      el.classList.add('cg-dragging');
      // Двигаем окно композитным transform, а не left/top: содержимое окна
      // (iframe панели) не перерастеризуется каждый кадр — только сдвигается
      // готовый слой. На высоком разрешении это убирает рывки перетаскивания.
      gesture(e, 'move', (ev) => {
        dx = (ev.clientX - ox) / deskZoom; dy = (ev.clientY - oy) / deskZoom;
        el.style.transform = 'translate3d(' + dx + 'px,' + dy + 'px,0)';
      }, () => {
        el.style.transform = '';
        el.classList.remove('cg-dragging');
        el.style.left = (startLeft + dx) + 'px';
        el.style.top = (startTop + dy) + 'px';
        clampToDesktop(el); saveGeom(win);
      });
    });
    title.addEventListener('dblclick', (e) => {
      if (e.target.closest('.cg-win-btn')) return;
      toggleMaximize(win);
    });
    el.addEventListener('pointerdown', () => focus(win), true);
    btnMin.addEventListener('click', () => minimize(win));
    btnMax.addEventListener('click', () => toggleMaximize(win));
    btnClose.addEventListener('click', () => closeWindow(key));
    btn.addEventListener('click', () => {
      if (win.min) restore(win);
      else if (el.classList.contains('focus')) minimize(win);
      else focus(win);
    });

    desktop.appendChild(el);
    // развёрнутость восстанавливаем ДО сворачивания и без чтения offsetов
    // (свёрнутое окно — display:none, offsetы нулевые): premax — из сохранённого
    if (saved.max) {
      win.premax = {
        x: saved.x != null ? saved.x : cascade,
        y: saved.y != null ? saved.y : cascade,
        w: saved.w || def.w,
        h: saved.h || def.h,
      };
      win.maxed = true;
      el.classList.add('maxed');
      el.style.left = '0px';
      el.style.top = '0px';
      el.style.width = window.innerWidth + 'px';
      el.style.height = (window.innerHeight - 56) + 'px';
    }
    if (saved.min) minimize(win); else focus(win);
    saveGeom(win);
    return win;
  }

  // развёрнутые окна следуют за размером вьюпорта (смена размера окна игры,
  // масштаба GUI), обычные — прижимаются обратно в пределы рабочего стола
  window.addEventListener('resize', () => {
    for (const w of wins.values()) {
      if (w.maxed) {
        w.el.style.left = '0px';
        w.el.style.top = '0px';
        w.el.style.width = window.innerWidth + 'px';
        w.el.style.height = (window.innerHeight - 56) + 'px';
      } else if (!w.min) {
        clampToDesktop(w.el);
      }
    }
  });

  /* ── серверы как иконки на рабочем столе ───────────────────── */

  let servers = [];
  let selectedIcon = null;
  let iconDragging = false;    // идёт перетаскивание иконки — не пересобирать слой
  let renderPending = false;   // пришло обновление серверов во время жеста

  // пользовательские элементы рабочего стола (папки/документы) + позиции иконок
  // + принадлежность серверов папкам — всё в localStorage
  let deskItems = loadJson('cgDeskItems', []);
  let iconPos = loadJson('cgIconPos', {});
  let serverParents = loadJson('cgServerParents', {});
  function loadJson(k, def) { try { return JSON.parse(localStorage.getItem(k) || JSON.stringify(def)); } catch (e) { return def; } }
  function saveJson(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* приватный режим */ } }
  const saveItems = () => saveJson('cgDeskItems', deskItems);
  const savePosAll = () => saveJson('cgIconPos', iconPos);
  const saveSP = () => saveJson('cgServerParents', serverParents);
  function newId() { return 'x' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36); }

  async function fetchServers() {
    try {
      const r = await fetch('/api/servers');
      const data = await r.json();
      return Array.isArray(data) ? data : (data.servers || []);
    } catch (e) { return null; }
  }

  function statusDot(st) {
    if (st === 'running' || st === 'orphaned') return 'run';
    if (st === 'starting' || st === 'stopping') return 'mid';
    return 'off';
  }

  function isUp(st) {
    return st === 'running' || st === 'starting' || st === 'stopping' || st === 'orphaned';
  }

  /* ── узлы рабочего стола: сервер или пользовательский элемент ── */
  // единая сетка рабочего стола: иконки прилипают к ячейкам этого размера
  // (совпадает с шагом авторасклада в renderIcons — 100×96)
  const GRID_X = 100, GRID_Y = 96;
  function snapToGrid(x, y) {
    return { x: Math.max(0, Math.round(x / GRID_X) * GRID_X),
             y: Math.max(0, Math.round(y / GRID_Y) * GRID_Y) };
  }
  function keyOf(node) { return node.kind === 'server' ? 'srv:' + node.id : 'itm:' + node.id; }
  function getPos(node) { return iconPos[keyOf(node)] || null; }
  function savePos(node, x, y) { const p = snapToGrid(x, y); iconPos[keyOf(node)] = { x: p.x, y: p.y }; savePosAll(); }
  function clearPos(node) { delete iconPos[keyOf(node)]; savePosAll(); }
  function parentOfNode(node) { return node.kind === 'server' ? (serverParents[node.id] || null) : (node.item.parent || null); }
  function setParent(node, folderId) {
    if (node.kind === 'server') { if (folderId) serverParents[node.id] = folderId; else delete serverParents[node.id]; saveSP(); }
    else { node.item.parent = folderId || null; saveItems(); }
  }
  function topNodes() {
    const out = [];
    for (const srv of servers) if (!serverParents[srv.id]) out.push({ kind: 'server', id: srv.id, srv });
    for (const it of deskItems) if (!it.parent) out.push({ kind: 'item', id: it.id, item: it });
    return out;
  }
  function folderChildren(folderId) {
    const out = [];
    for (const srv of servers) if (serverParents[srv.id] === folderId) out.push({ kind: 'server', id: srv.id, srv });
    for (const it of deskItems) if (it.parent === folderId) out.push({ kind: 'item', id: it.id, item: it });
    return out;
  }

  /* Строит DOM-иконку узла (сервер/папка/документ). draggable=false — внутри
     окна папки (там иконки в потоке, desktop-драг не имеет смысла). */
  function buildIcon(node, draggable) {
    const ico = document.createElement('div');
    ico.className = 'cg-ico';
    const img = document.createElement('i');
    img.className = 'pi cg-ico-img';
    let iconName = 'server';
    let label = '';
    if (node.kind === 'server') {
      iconName = 'server'; label = node.srv.name || node.srv.id;
      const dot = document.createElement('span');
      dot.className = 'cg-ico-dot ' + statusDot(node.srv.status);
      ico.appendChild(img); ico.appendChild(dot);
    } else {
      if (node.item.type === 'folder') iconName = 'folder';
      else if (node.item.type === 'file') iconName = node.item.isDir ? 'folder' : 'script-text';
      else iconName = 'script-text';
      label = node.item.name;
      ico.dataset.type = node.item.type;
      ico.dataset.itemId = node.item.id;
      ico.appendChild(img);
    }
    img.style.setProperty('--i', "url('/icons/" + iconName + ".svg')");
    const name = document.createElement('span');
    name.className = 'cg-ico-name';
    name.textContent = label;
    ico.appendChild(name);

    ico.addEventListener('pointerdown', (e) => {
      if (selectedIcon) selectedIcon.classList.remove('sel');
      selectedIcon = ico; ico.classList.add('sel');
      if (draggable !== false) startIconDrag(e, node, ico);
    });
    ico.addEventListener('dblclick', () => openNode(node));
    ico.addEventListener('contextmenu', (e) => {
      e.preventDefault(); e.stopPropagation();
      showNodeMenu(node, e.clientX, e.clientY);
    });
    return ico;
  }

  function openNode(node) {
    if (node.kind === 'server') { createWindow('server', node.srv.id, node.srv.name); return; }
    if (node.item.type === 'folder') createWindow('folder', node.item.id, node.item.name);
    else if (node.item.type === 'file') openDesktopFile(node.item);
    else createWindow('doc', node.item.id, node.item.name);
  }

  /* Ярлык на реальный путь ПК (создан из проводника «На рабочий стол») —
     открывает окно «Этот компьютер» в нужной папке. */
  function parentDir(p) {
    const norm = String(p || '');
    const i = Math.max(norm.lastIndexOf('\\'), norm.lastIndexOf('/'));
    if (i < 0) return norm;
    let par = norm.slice(0, i);
    if (/^[a-zA-Z]:$/.test(par)) par += '\\'; // корень диска Windows
    if (par === '') par = '/';                // корень POSIX
    return par;
  }
  function openDesktopFile(item) {
    const folder = item.isDir ? item.path : parentDir(item.path);
    const existing = wins.get('pc');
    if (existing) {
      if (existing.min) restore(existing); else focus(existing);
      try { existing.frame.contentWindow.postMessage({ cg: 'pc-navigate', path: folder }, location.origin); } catch (e) { /* */ }
      return;
    }
    try { localStorage.setItem('cgPcStartPath', folder); } catch (e) { /* */ }
    createWindow('pc');
  }
  function addDesktopFile(p, name, isDir) {
    if (!p) return;
    const it = { id: newId(), type: 'file', name: name || String(p), path: String(p), isDir: !!isDir, parent: null };
    deskItems.push(it); saveItems();
    renderIcons();
    toast('Добавлено на рабочий стол: ' + it.name);
  }

  function renderIcons() {
    iconsBox.textContent = '';
    selectedIcon = null;
    const nodes = topNodes();
    const areaH = iconsBox.clientHeight || (window.innerHeight - 90);
    const perCol = Math.max(1, Math.floor((areaH - 8) / 96));
    let auto = 0;
    for (const node of nodes) {
      const ico = buildIcon(node);
      const pos = getPos(node);
      if (pos) { ico.style.left = pos.x + 'px'; ico.style.top = pos.y + 'px'; }
      else {
        ico.style.left = (Math.floor(auto / perCol) * 100) + 'px';
        ico.style.top = ((auto % perCol) * 96) + 'px';
        auto++;
      }
      iconsBox.appendChild(ico);
    }
  }

  /* Перетаскивание иконки: начинается только после порога сдвига, чтобы не
     ломать выделение и двойной клик. Бросок на папку — переносит внутрь. */
  function startIconDrag(e, node, iconEl) {
    if (e.button !== 0) return;
    const startX = e.clientX, startY = e.clientY;
    const startLeft = iconEl.offsetLeft, startTop = iconEl.offsetTop;
    let dragging = false, dx = 0, dy = 0;
    const move = (ev) => {
      dx = (ev.clientX - startX) / deskZoom; dy = (ev.clientY - startY) / deskZoom;
      if (!dragging && Math.abs(dx) + Math.abs(dy) < 5) return;
      if (!dragging) {
        dragging = true;
        iconDragging = true; // фоновый renderIcons не должен открепить этот элемент
        shield.style.cursor = 'grabbing';
        shield.classList.remove('hidden');
        iconEl.classList.add('cg-ico-dragging');
      }
      // тянем композитным transform, а не left/top — нет relayout и перекраски
      // содержимого рабочего стола каждый кадр (важно на высоком разрешении)
      iconEl.style.transform = 'translate3d(' + dx + 'px,' + dy + 'px,0)';
    };
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (!dragging) return;
      iconDragging = false;
      shield.classList.add('hidden'); shield.style.cursor = '';
      iconEl.classList.remove('cg-ico-dragging');
      iconEl.style.transform = '';
      // финальную позицию считаем от старта + сдвиг (transform не меняет offset)
      const finalX = Math.max(0, startLeft + dx), finalY = Math.max(0, startTop + dy);
      // элемент мог быть откреплён фоновым обновлением — тогда позицию не
      // сохраняем (иначе иконка «прыгнет» в угол)
      const detached = !iconEl.isConnected;
      const folderId = detached ? null : folderUnder(ev.clientX, ev.clientY, node);
      if (folderId) {
        if (node.kind === 'item' && node.item.type === 'folder' && wouldCycle(node.id, folderId)) {
          toast('Нельзя вложить папку в саму себя');
          savePos(node, finalX, finalY);
        } else {
          setParent(node, folderId); clearPos(node);
        }
        renderIcons(); refreshFolderWindows();
      } else if (!detached) {
        savePos(node, finalX, finalY); // savePos прилипает к сетке
        const p = snapToGrid(finalX, finalY);
        iconEl.style.left = p.x + 'px'; iconEl.style.top = p.y + 'px';
      }
      if (renderPending) { renderPending = false; renderIcons(); }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  // истинно, если target — это folderId или лежит внутри его поддерева
  // (тогда вложение folderId в target создало бы петлю)
  function wouldCycle(folderId, targetId) {
    const byId = {};
    for (const it of deskItems) byId[it.id] = it;
    let cur = targetId, guard = 0;
    while (cur && guard++ < 1000) {
      if (cur === folderId) return true;
      cur = byId[cur] ? byId[cur].parent : null;
    }
    return false;
  }

  function folderUnder(x, y, selfNode) {
    for (const el of iconsBox.children) {
      if (el.dataset.type !== 'folder') continue;
      if (selfNode.kind === 'item' && el.dataset.itemId === selfNode.id) continue;
      const r = el.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return el.dataset.itemId;
    }
    return null;
  }

  /* ── создание/переименование/удаление элементов ── */
  function createItem(type, x, y) {
    const it = { id: newId(), type, name: type === 'folder' ? 'Новая папка' : 'Документ.txt', parent: null };
    if (type === 'doc') it.content = '';
    deskItems.push(it); saveItems();
    if (x != null) { iconPos['itm:' + it.id] = { x: Math.max(0, x), y: Math.max(0, y) }; savePosAll(); }
    renderIcons();
    startRename({ kind: 'item', id: it.id, item: it });
  }

  async function startRename(node) {
    if (node.kind === 'server') { toast('Имя сервера меняется в его настройках'); return; }
    const name = await promptBox('Новое имя:', node.item.name);
    if (!name) return;
    node.item.name = name; saveItems();
    renderIcons(); refreshFolderWindows();
    const w = wins.get(node.item.type + ':' + node.id);
    if (w) { w.nameEl.textContent = name; w.btnLabel.textContent = name; }
  }

  async function deleteItem(node) {
    const it = node.item;
    if (it.type === 'folder') {
      const kids = folderChildren(it.id);
      const ok = await confirmBox('Удалить папку «' + it.name + '»?' + (kids.length ? ' Её содержимое вернётся на рабочий стол.' : ''));
      if (!ok) return;
      for (const k of kids) setParent(k, null); // не теряем сервера/документы
    } else if (it.type === 'file') {
      const ok = await confirmBox('Убрать ярлык «' + it.name + '» с рабочего стола? Сам файл на диске останется.');
      if (!ok) return;
    } else {
      const ok = await confirmBox('Удалить документ «' + it.name + '»?');
      if (!ok) return;
    }
    deskItems = deskItems.filter((x) => x.id !== it.id); saveItems();
    clearPos(node);
    closeWindow(it.type + ':' + it.id);
    renderIcons(); refreshFolderWindows();
  }

  /* ── нативное содержимое окон папки и документа ── */
  function buildNativeContent(win, kind, id) {
    if (kind === 'folder') renderFolderInto(win, id);
    else if (kind === 'doc') renderDocInto(win, id);
  }

  function renderFolderInto(win, folderId) {
    const it = deskItems.find((x) => x.id === folderId);
    win.body.textContent = '';
    if (!it) { const e = document.createElement('div'); e.className = 'cg-folder-empty'; e.textContent = 'Папка удалена'; win.body.appendChild(e); return; }
    const wrap = document.createElement('div');
    wrap.className = 'cg-folder';
    const kids = folderChildren(folderId);
    if (!kids.length) {
      const e = document.createElement('div');
      e.className = 'cg-folder-empty';
      e.textContent = 'Папка пуста. Перетащите сюда иконки с рабочего стола.';
      wrap.appendChild(e);
    }
    for (const node of kids) wrap.appendChild(buildIcon(node, false));
    win.body.appendChild(wrap);
    win.refresh = () => renderFolderInto(win, folderId);
  }

  function renderDocInto(win, docId) {
    const it = deskItems.find((x) => x.id === docId);
    win.body.textContent = '';
    const ta = document.createElement('textarea');
    ta.className = 'cg-doc-ta';
    ta.spellcheck = false;
    ta.value = it ? (it.content || '') : '';
    if (!it) ta.disabled = true;
    let t = null;
    ta.addEventListener('input', () => {
      if (!it) return;
      it.content = ta.value;
      clearTimeout(t); t = setTimeout(saveItems, 400);
    });
    win.body.appendChild(ta);
  }

  function refreshFolderWindows() {
    for (const w of wins.values()) if (w.kind === 'folder' && w.refresh) w.refresh();
  }

  async function refreshServers() {
    const list = await fetchServers();
    if (!list) return;
    const sig = JSON.stringify(list.map((s) => [s.id, s.name, s.status]));
    if (sig === refreshServers.lastSig) return; // без изменений — не трогаем DOM
    refreshServers.lastSig = sig;
    servers = list;
    // во время перетаскивания иконки НЕ пересобираем слой (иначе откепляем
    // перетаскиваемый элемент) — отложим до конца жеста
    if (iconDragging) { renderPending = true; return; }
    renderIcons();
  }

  /* ── контекстное меню ПКМ ──────────────────────────────────── */

  function hideMenu() {
    menuEl.classList.add('hidden');
    menuEl.textContent = '';
  }
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('#cg-menu')) hideMenu();
  });
  window.addEventListener('blur', hideMenu);

  function menuItem(label, iconName, danger, handler) {
    const it = document.createElement('button');
    it.className = 'cg-menu-item' + (danger ? ' danger' : '');
    it.appendChild(icon(iconName));
    const sp = document.createElement('span');
    sp.textContent = label;
    it.appendChild(sp);
    it.addEventListener('click', () => { hideMenu(); handler(); });
    return it;
  }

  function showMenuAt(x, y, items) {
    menuEl.textContent = '';
    for (const it of items) menuEl.appendChild(it);
    menuEl.classList.remove('hidden');
    // не выпускаем меню за экран
    const r = menuEl.getBoundingClientRect();
    menuEl.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
    menuEl.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
  }

  async function serverAction(id, action) {
    try {
      const r = await fetch('/api/servers/' + encodeURIComponent(id) + '/' + action, { method: 'POST' });
      if (!r.ok) {
        const err = await r.json().catch(() => null);
        toast((err && err.error) || ('Не удалось: ' + action));
      }
    } catch (e) { toast('Панель недоступна'); }
    refreshServers.lastSig = null;
    refreshServers();
  }

  function showNodeMenu(node, x, y) {
    if (node.kind === 'server') { showServerMenu(node.srv, x, y, node); return; }
    const it = node.item;
    const items = [
      menuItem('Открыть', (it.type === 'folder' || (it.type === 'file' && it.isDir)) ? 'folder' : 'script-text', false, () => openNode(node)),
      menuItem('Переименовать', 'edit', false, () => startRename(node)),
    ];
    if (parentOfNode(node)) {
      items.push(menuItem('На рабочий стол', 'chevron-up', false, () => {
        setParent(node, null); renderIcons(); refreshFolderWindows();
      }));
    }
    items.push(menuItem('Удалить', 'trash', true, () => deleteItem(node)));
    showMenuAt(x, y, items);
  }

  function showServerMenu(srv, x, y, node) {
    const up = isUp(srv.status);
    const items = [
      menuItem('Открыть панель', 'command', false, () => createWindow('server', srv.id, srv.name)),
      menuItem('Проводник', 'folder', false, () => createWindow('files', srv.id, 'Проводник — ' + (srv.name || srv.id))),
    ];
    if (up) {
      items.push(menuItem('Остановить', 'pause', false, () => serverAction(srv.id, 'stop')));
      items.push(menuItem('Убить', 'close-box', true, () => serverAction(srv.id, 'kill')));
      items.push(menuItem('Перезапустить', 'reload', false, () => serverAction(srv.id, 'restart')));
    } else {
      items.push(menuItem('Запустить', 'play', false, () => serverAction(srv.id, 'start')));
    }
    if (node && parentOfNode(node)) {
      items.push(menuItem('На рабочий стол', 'chevron-up', false, () => {
        setParent(node, null); renderIcons(); refreshFolderWindows();
      }));
    }
    items.push(menuItem('Удалить', 'trash', true, async () => {
      // inPlace-импорт: панель НЕ удаляет файлы — честный текст без ввода имени;
      // настоящий сервер: стирается всё, включая мир — требуем ввести название
      const nm = srv.name || srv.id;
      const ok = srv.inPlace
        ? await confirmBox('Убрать сервер «' + nm + '» из панели? Файлы в вашей папке НЕ удаляются.')
        : await confirmBox('Будут стёрты ВСЕ файлы сервера «' + nm + '», включая мир. Это необратимо. Введите название сервера для подтверждения:', nm);
      if (!ok) return;
      try {
        const r = await fetch('/api/servers/' + encodeURIComponent(srv.id), { method: 'DELETE' });
        if (!r.ok) {
          const err = await r.json().catch(() => null);
          toast((err && err.error) || 'Не удалось удалить');
        } else {
          // закрываем ВСЕ окна удалённого сервера: панель, проводник, редакторы
          for (const w of Array.from(wins.values())) {
            if ((w.kind === 'server' || w.kind === 'files') && w.id === srv.id) closeWindow(w.key);
            if (w.kind === 'editor' && w.id && w.id.slice(0, w.id.indexOf(':')) === srv.id) closeWindow(w.key);
          }
          forgetRecent(srv.id, null);
          // прибираем позицию иконки и принадлежность папке удалённого сервера
          delete serverParents[srv.id]; saveSP();
          delete iconPos['srv:' + srv.id]; savePosAll();
          refreshFolderWindows();
        }
      } catch (e) { toast('Панель недоступна'); }
      refreshServers.lastSig = null;
      refreshServers();
    }));
    showMenuAt(x, y, items);
  }

  /* ── свой confirm (нативные JS-диалоги в OSR-браузере молча гасятся) ── */

  /* typedName задан — опасное действие: подтверждается только точным вводом
     названия (как в главном UI панели при удалении сервера). */
  function confirmBox(text, typedName) {
    return new Promise((resolve) => {
      const root = $('#cg-confirm');
      const input = $('#cg-confirm-input');
      $('#cg-confirm-text').textContent = text;
      input.value = '';
      input.classList.toggle('hidden', !typedName);
      if (typedName) input.placeholder = typedName;
      root.classList.remove('hidden');
      if (typedName) input.focus();
      const yes = $('#cg-confirm-yes');
      const no = $('#cg-confirm-no');
      const done = (v) => {
        root.classList.add('hidden');
        yes.removeEventListener('click', onYes);
        no.removeEventListener('click', onNo);
        resolve(v);
      };
      const onYes = () => {
        if (typedName && input.value.trim() !== typedName) {
          toast('Название не совпадает — удаление отменено');
          return done(false);
        }
        done(true);
      };
      const onNo = () => done(false);
      yes.addEventListener('click', onYes);
      no.addEventListener('click', onNo);
    });
  }

  /* Диалог ввода строки (создание/переименование). Возвращает строку или null.
     Переиспользует DOM #cg-confirm (нативный prompt в OSR гасится). */
  function promptBox(text, initial) {
    return new Promise((resolve) => {
      const root = $('#cg-confirm');
      const input = $('#cg-confirm-input');
      $('#cg-confirm-text').textContent = text;
      input.classList.remove('hidden');
      input.placeholder = '';
      input.value = initial || '';
      root.classList.remove('hidden');
      input.focus();
      input.select();
      const yes = $('#cg-confirm-yes');
      const no = $('#cg-confirm-no');
      const done = (v) => {
        root.classList.add('hidden');
        yes.removeEventListener('click', onYes);
        no.removeEventListener('click', onNo);
        input.removeEventListener('keydown', onKey);
        resolve(v);
      };
      const onYes = () => { const v = input.value.trim(); done(v || null); };
      const onNo = () => done(null);
      const onKey = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); onYes(); }
        else if (e.key === 'Escape') { e.preventDefault(); onNo(); }
      };
      yes.addEventListener('click', onYes);
      no.addEventListener('click', onNo);
      input.addEventListener('keydown', onKey);
    });
  }

  let toastTimer = null;
  function toast(text) {
    let t = $('#cg-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'cg-toast';
      document.body.appendChild(t);
    }
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
  }

  /* ── часы и дата (снизу справа) ────────────────────────────── */

  function tickClock() {
    const now = new Date();
    const two = (n) => (n < 10 ? '0' : '') + n;
    $('#cg-clock-time').textContent = two(now.getHours()) + ':' + two(now.getMinutes());
    const days = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
    $('#cg-clock-date').textContent =
      days[now.getDay()] + ', ' + two(now.getDate()) + '.' + two(now.getMonth() + 1) + '.' + now.getFullYear();
  }
  tickClock();
  setInterval(tickClock, 1000);

  // подписи окнам серверов — по данным панели
  async function serverTitle(id) {
    const list = servers.length ? servers : (await fetchServers()) || [];
    const srv = list.find((s) => s.id === id);
    return srv ? srv.name : null;
  }

  // кнопки приложений в панели задач
  document.querySelectorAll('#cg-taskbar .cg-task-btn[data-app]').forEach((b) => {
    b.addEventListener('click', () => createWindow(b.dataset.app));
  });

  // ПКМ по пустому рабочему столу — создать папку/документ, открыть компьютер
  desktop.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.cg-ico') || e.target.closest('.cg-win') || e.target.closest('#cg-menu')) return;
    e.preventDefault();
    const gx = e.clientX, gy = e.clientY;
    const box = iconsBox.getBoundingClientRect();
    showMenuAt(gx, gy, [
      menuItem('Создать папку', 'folder', false, () => createItem('folder', gx - box.left, gy - box.top)),
      menuItem('Создать документ', 'script-text', false, () => createItem('doc', gx - box.left, gy - box.top)),
      menuItem('Этот компьютер', 'monitor', false, () => createWindow('pc')),
    ]);
  });

  // мод зовёт по пробелу: открыть win-меню, если фокус НЕ в поле ввода
  window.__cgSpace = function () {
    let el = document.activeElement;
    try {
      while (el && el.tagName === 'IFRAME' && el.contentDocument) el = el.contentDocument.activeElement;
    } catch (e) { return; } // чужой кадр — вероятно ввод, не мешаем
    if (el) {
      const t = el.tagName;
      if (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT' || el.isContentEditable) return;
    }
    toggleStartMenu();
  };

  // размытие фона игры: мод читает параметр cgblur из URL рабочего стола
  function currentBlurPref() {
    try { return localStorage.getItem('cgIngameBlur') !== '0'; } catch (e) { return true; }
  }
  function reconcileBlurUrl() {
    const on = currentBlurPref();
    const u = new URL(window.location.href);
    const off = u.searchParams.get('cgblur') === '0';
    // history.replaceState вместо location.replace: URL меняется БЕЗ перезагрузки
    // страницы (окна/iframe не сносятся, нет мигания), а CEF отражает новый URL в
    // browser.getURL() через OnAddressChange — мост блюра к моду продолжает работать
    if (on && off) { u.searchParams.delete('cgblur'); history.replaceState(null, '', u.toString()); }
    else if (!on && !off) { u.searchParams.set('cgblur', '0'); history.replaceState(null, '', u.toString()); }
  }
  function setIngameBlur(on) {
    try { localStorage.setItem('cgIngameBlur', on ? '1' : '0'); } catch (e) { /* */ }
    reconcileBlurUrl();
  }
  reconcileBlurUrl();

  /* ── win-меню («Пуск»): серверы, недавние файлы, аккаунт, настройки ── */

  const startBtn = $('#cg-start');
  const startMenu = $('#cg-start-menu');

  function smItem(label, iconName, handler, dotClass) {
    const it = document.createElement('button');
    it.className = 'cg-sm-item';
    it.appendChild(icon(iconName));
    const sp = document.createElement('span');
    sp.textContent = label;
    it.appendChild(sp);
    if (dotClass) {
      const dot = document.createElement('span');
      dot.className = 'cg-sm-dot ' + dotClass;
      it.appendChild(dot);
    }
    it.addEventListener('click', () => { hideStartMenu(); handler(); });
    return it;
  }

  function renderStartMenu() {
    const srvBox = $('#cg-sm-servers');
    srvBox.textContent = '';
    if (!servers.length) {
      const e = document.createElement('div');
      e.className = 'cg-sm-empty';
      e.textContent = 'Серверов пока нет';
      srvBox.appendChild(e);
    }
    for (const srv of servers) {
      srvBox.appendChild(smItem(srv.name || srv.id, 'server',
        () => createWindow('server', srv.id, srv.name), statusDot(srv.status)));
    }
    const recBox = $('#cg-sm-recent');
    recBox.textContent = '';
    const rec = recentFiles();
    if (!rec.length) {
      const e = document.createElement('div');
      e.className = 'cg-sm-empty';
      e.textContent = 'Ещё ничего не открывали';
      recBox.appendChild(e);
    }
    for (const r of rec) {
      const base = String(r.path || '').split('/').pop();
      recBox.appendChild(smItem(base, 'script-text', () => {
        // наверх списка НЕ двигаем: если файл мёртв, editor-окно закроется с
        // reason=editor-failed и запись будет вычищена
        createWindow('editor', r.sid + ':' + r.path, base);
      }));
    }
  }

  /* Ник и аватар аккаунта центра (через локальную панель). */
  async function loadAccountCard() {
    let nick = 'Аккаунт';
    let avatarUrl = null;
    try {
      const me = await (await fetch('/api/central/me')).json();
      if (me && me.user && me.user.username) nick = me.user.username;
      else if (me && me.username) nick = me.username;
      if (me && me.user && me.user.discord && me.user.discord.avatar) avatarUrl = me.user.discord.avatar;
    } catch (e) { /* центр недоступен */ }
    $('#cg-sm-nick').textContent = nick;
    const av = $('#cg-sm-avatar');
    av.textContent = '';
    if (avatarUrl) {
      const img = document.createElement('img');
      img.src = avatarUrl;
      img.alt = '';
      av.appendChild(img);
    } else {
      av.textContent = (nick[0] || '?').toUpperCase();
    }
  }

  function hideStartMenu() {
    startMenu.classList.add('hidden');
    startBtn.classList.remove('open');
  }
  function toggleStartMenu() {
    if (startMenu.classList.contains('hidden')) {
      renderStartMenu();
      loadAccountCard();
      startMenu.classList.remove('hidden');
      startBtn.classList.add('open');
    } else {
      hideStartMenu();
    }
  }
  startBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleStartMenu(); });
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('#cg-start-menu') && !e.target.closest('#cg-start')) hideStartMenu();
  });
  // клик внутрь iframe-окна не доходит до document — ловим по потере фокуса
  window.addEventListener('blur', hideStartMenu);
  $('#cg-sm-account').addEventListener('click', () => { hideStartMenu(); createWindow('profile'); });
  $('#cg-sm-settings').addEventListener('click', () => { hideStartMenu(); createWindow('settings'); });
  const smPc = $('#cg-sm-pc');
  if (smPc) smPc.addEventListener('click', () => { hideStartMenu(); createWindow('pc'); });

  // сообщения от окон (открыть сервер/редактор, вход/выход, закрыть окно)
  window.addEventListener('message', async (e) => {
    if (e.origin !== location.origin || !e.data || !e.data.cg) return;
    if (e.data.cg === 'open' && e.data.what === 'server' && e.data.id) {
      const win = createWindow('server', e.data.id, e.data.title || undefined);
      if (!e.data.title) {
        const t = await serverTitle(e.data.id);
        if (t) { win.nameEl.textContent = t; win.btnLabel.textContent = t; }
      }
    } else if (e.data.cg === 'open' && e.data.what === 'editor' && e.data.id && e.data.path) {
      rememberRecent(e.data.id, e.data.path);
      createWindow('editor', e.data.id + ':' + e.data.path, e.data.title || e.data.path);
    } else if (e.data.cg === 'close-win') {
      // окно просит закрыть само себя (например «Закрыть» в редакторе)
      for (const w of wins.values()) {
        if (w.frame && w.frame.contentWindow === e.source) {
          // редактор не смог открыть файл (удалён/недоступен) — чистим
          // «недавние» и говорим об этом, иначе окно молча мигнёт и исчезнет
          if (e.data.reason === 'editor-failed' && w.kind === 'editor' && w.id) {
            const cut = w.id.indexOf(':');
            forgetRecent(w.id.slice(0, cut), w.id.slice(cut + 1));
            toast('Файл недоступен (удалён или сервер выключен)');
          }
          closeWindow(w.key);
          break;
        }
      }
    } else if (e.data.cg === 'set-blur') {
      setIngameBlur(!!e.data.on);
    } else if (e.data.cg === 'set-scale') {
      // окно-настройки сообщило новый масштаб — применяем ко всему десктопу
      applyDeskScale(e.data.scale);
    } else if (e.data.cg === 'add-desktop-file') {
      addDesktopFile(e.data.path, e.data.name, !!e.data.isDir);
    } else if (e.data.cg === 'need-login') {
      createWindow('gate');
    } else if (e.data.cg === 'logged-in') {
      closeWindow('gate');
      // обновляем остальные окна — они могли грузиться без сессии
      for (const w of wins.values()) {
        try { w.frame.contentWindow.location.reload(); } catch (err) { /* чужой кадр */ }
      }
      if (!wins.size) createWindow('servers');
      refreshServers.lastSig = null;
      refreshServers();
    }
  });

  // старт: иконки серверов + восстановление окон прошлой сессии;
  // без входа в аккаунт центра сначала показываем окно входа
  (async () => {
    refreshServers();
    setInterval(refreshServers, 4000);

    let loggedIn = true;
    try {
      const r = await fetch('/api/central');
      const cs = await r.json();
      loggedIn = !!(cs && cs.loggedIn);
    } catch (e) { /* панель без центра — пускаем как есть */ }
    const savedKeys = Object.keys(geom);
    if (!loggedIn) {
      createWindow('gate');
      return;
    }
    let opened = 0;
    for (const key of savedKeys) {
      const cut = key.indexOf(':');
      const kind = cut >= 0 ? key.slice(0, cut) : key;
      const id = cut >= 0 ? key.slice(cut + 1) : undefined;
      if (!DEFAULTS[kind] || kind === 'gate' || DEFAULTS[kind].native) continue;
      const win = createWindow(kind, id);
      opened++;
      if (kind === 'server') {
        serverTitle(id).then((t) => { if (t) { win.nameEl.textContent = t; win.btnLabel.textContent = t; } });
      }
      if (kind === 'files') {
        serverTitle(id).then((t) => {
          if (t) { win.nameEl.textContent = 'Проводник — ' + t; win.btnLabel.textContent = 'Проводник — ' + t; }
        });
      }
      if (kind === 'editor' && id) {
        const base = id.slice(id.indexOf(':') + 1).split('/').pop();
        win.nameEl.textContent = base;
        win.btnLabel.textContent = base;
      }
    }
    if (!opened) createWindow('servers');
  })();
})();
