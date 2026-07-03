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

  // тема — из общих настроек панели
  try {
    const s = JSON.parse(localStorage.getItem('controlgui-settings') || '{}');
    document.body.classList.add(s.theme === 'theme-blue' ? 'theme-blue' : 'theme-lime');
  } catch (e) { document.body.classList.add('theme-lime'); }

  // нативное контекстное меню CEF не к месту на рабочем столе
  document.addEventListener('contextmenu', (e) => e.preventDefault());

  const SRC = {
    servers: '/?embed=1&go=home',
    settings: '/?embed=1&go=settings',
    profile: '/?embed=1&go=profile',
    gate: '/?embed=1&go=gate',
  };
  const DEFAULTS = {
    servers: { w: 840, h: 560, title: 'Серверы', icon: 'server' },
    settings: { w: 540, h: 560, title: 'Настройки', icon: 'sliders' },
    profile: { w: 620, h: 560, title: 'Аккаунт', icon: 'user' },
    gate: { w: 520, h: 560, title: 'Вход в аккаунт', icon: 'user' },
    server: { w: 900, h: 600, title: 'Сервер', icon: 'command' },
    editor: { w: 760, h: 540, title: 'Редактор', icon: 'script-text' },
    files: { w: 820, h: 560, title: 'Проводник', icon: 'folder' },
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
    win.el.classList.add('min');
    win.btn.classList.add('minned');
    win.btn.classList.remove('active');
    saveGeom(win);
  }

  function restore(win) {
    win.min = false;
    win.el.classList.remove('min');
    win.btn.classList.remove('minned');
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

  function closeWindow(key) {
    const win = wins.get(key);
    if (!win) return;
    win.el.remove();
    win.btn.remove();
    wins.delete(key);
    delete geom[key];
    try { sessionStorage.setItem('cgWinGeom', JSON.stringify(geom)); } catch (e) { /* */ }
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
      restore(existing);
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

    // содержимое
    const body = document.createElement('div');
    body.className = 'cg-win-body';
    const frame = document.createElement('iframe');
    frame.className = 'cg-win-frame';
    frame.src = srcFor(kind, id);
    body.appendChild(frame);
    el.appendChild(body);

    const win = { key, kind, id, el, frame, btn: null, nameEl, btnLabel: null, min: false, maxed: false };

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
      const sx = e.clientX - el.offsetLeft, sy = e.clientY - el.offsetTop;
      gesture(e, 'move', (ev) => {
        el.style.left = (ev.clientX - sx) + 'px';
        el.style.top = (ev.clientY - sy) + 'px';
      }, () => { clampToDesktop(el); saveGeom(win); });
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

  function renderIcons() {
    iconsBox.textContent = '';
    selectedIcon = null;
    for (const srv of servers) {
      const ico = document.createElement('div');
      ico.className = 'cg-ico';
      ico.dataset.id = srv.id;
      const img = document.createElement('i');
      img.className = 'pi cg-ico-img';
      img.style.setProperty('--i', "url('/icons/server.svg')");
      const dot = document.createElement('span');
      dot.className = 'cg-ico-dot ' + statusDot(srv.status);
      const name = document.createElement('span');
      name.className = 'cg-ico-name';
      name.textContent = srv.name || srv.id;
      ico.appendChild(img);
      ico.appendChild(dot);
      ico.appendChild(name);

      ico.addEventListener('pointerdown', () => {
        if (selectedIcon) selectedIcon.classList.remove('sel');
        selectedIcon = ico;
        ico.classList.add('sel');
      });
      ico.addEventListener('dblclick', () => createWindow('server', srv.id, srv.name));
      ico.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showServerMenu(srv, e.clientX, e.clientY);
      });
      iconsBox.appendChild(ico);
    }
  }

  async function refreshServers() {
    const list = await fetchServers();
    if (!list) return;
    const sig = JSON.stringify(list.map((s) => [s.id, s.name, s.status]));
    if (sig === refreshServers.lastSig) return; // без изменений — не трогаем DOM
    refreshServers.lastSig = sig;
    servers = list;
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

  function showServerMenu(srv, x, y) {
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
        if (w.frame.contentWindow === e.source) {
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
      if (!DEFAULTS[kind] || kind === 'gate') continue;
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
