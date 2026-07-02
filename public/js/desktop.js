'use strict';
/* Рабочий стол CONTROLGUI внутри Minecraft: панель задач + окна.
   Каждое окно — iframe того же приложения в embed-режиме (?embed=1&go=...),
   поэтому все экраны панели работают без переписывания. Перетаскивание за
   заголовок, изменение размера за края/углы, сворачивание в панель задач,
   z-порядок по клику; геометрия запоминается в sessionStorage. */
(() => {
  const $ = (s) => document.querySelector(s);
  const desktop = $('#cg-desktop');
  const shield = $('#cg-drag-shield');
  const taskWins = $('#cg-task-wins');

  // тема — из общих настроек панели
  try {
    const s = JSON.parse(localStorage.getItem('controlgui-settings') || '{}');
    document.body.classList.add(s.theme === 'theme-blue' ? 'theme-blue' : 'theme-lime');
  } catch (e) { document.body.classList.add('theme-lime'); }

  const SRC = {
    servers: '/?embed=1&go=home',
    settings: '/?embed=1&go=settings',
    profile: '/?embed=1&go=profile',
    gate: '/?embed=1&go=gate',
  };
  const DEFAULTS = {
    servers: { w: 940, h: 640, title: 'Серверы', icon: 'server' },
    settings: { w: 600, h: 620, title: 'Настройки', icon: 'sliders' },
    profile: { w: 680, h: 620, title: 'Аккаунт', icon: 'user' },
    gate: { w: 560, h: 600, title: 'Вход в аккаунт', icon: 'user' },
    server: { w: 1000, h: 680, title: 'Сервер', icon: 'command' },
  };

  const wins = new Map(); // key -> {key, kind, id, el, frame, btn, min}
  let zTop = 10;
  let geom = {};
  try { geom = JSON.parse(sessionStorage.getItem('cgWinGeom') || '{}'); } catch (e) { /* пусто */ }

  function saveGeom(win) {
    const el = win.el;
    geom[win.key] = {
      x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight, min: win.min,
    };
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
     проглатывает pointermove и жест обрывается на границе окна. */
  function gesture(startEvent, onMove, onEnd) {
    startEvent.preventDefault();
    shield.classList.remove('hidden');
    const move = (e) => onMove(e);
    const up = () => {
      shield.classList.add('hidden');
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
      if (titleOverride) existing.nameEl.textContent = titleOverride;
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
    const btnClose = document.createElement('button');
    btnClose.className = 'cg-win-btn close';
    btnClose.title = 'Закрыть';
    btnClose.appendChild(icon('close'));
    btns.appendChild(btnMin);
    btns.appendChild(btnClose);
    title.appendChild(btns);
    el.appendChild(title);

    // содержимое
    const body = document.createElement('div');
    body.className = 'cg-win-body';
    const frame = document.createElement('iframe');
    frame.className = 'cg-win-frame';
    frame.src = kind === 'server' ? '/?embed=1&go=server/' + encodeURIComponent(id) : SRC[kind];
    body.appendChild(frame);
    el.appendChild(body);

    // ручки ресайза
    const DIRS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
    for (const d of DIRS) {
      const hnd = document.createElement('div');
      hnd.className = 'cg-rs cg-rs-' + d;
      hnd.addEventListener('pointerdown', (e) => {
        focus(win);
        const sx = e.clientX, sy = e.clientY;
        const sl = el.offsetLeft, st = el.offsetTop, sw = el.offsetWidth, sh = el.offsetHeight;
        gesture(e, (ev) => {
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

    const win = { key, kind, id, el, frame, btn, nameEl, btnLabel, min: false };
    wins.set(key, win);

    // события
    title.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.cg-win-btn')) return;
      focus(win);
      const sx = e.clientX - el.offsetLeft, sy = e.clientY - el.offsetTop;
      gesture(e, (ev) => {
        el.style.left = (ev.clientX - sx) + 'px';
        el.style.top = (ev.clientY - sy) + 'px';
      }, () => { clampToDesktop(el); saveGeom(win); });
    });
    el.addEventListener('pointerdown', () => focus(win), true);
    btnMin.addEventListener('click', () => minimize(win));
    btnClose.addEventListener('click', () => closeWindow(key));
    btn.addEventListener('click', () => {
      if (win.min) restore(win);
      else if (el.classList.contains('focus')) minimize(win);
      else focus(win);
    });

    desktop.appendChild(el);
    if (saved.min) minimize(win); else focus(win);
    saveGeom(win);
    return win;
  }

  // подписи окнам серверов — по данным панели
  async function serverTitle(id) {
    try {
      const r = await fetch('/api/servers');
      const data = await r.json();
      const srv = (data.servers || data || []).find((s) => s.id === id);
      return srv ? srv.name : null;
    } catch (e) { return null; }
  }

  // кнопки приложений в панели задач
  document.querySelectorAll('#cg-taskbar .cg-task-btn[data-app]').forEach((b) => {
    b.addEventListener('click', () => createWindow(b.dataset.app));
  });

  // сообщения от окон (открыть сервер, вход/выход)
  window.addEventListener('message', async (e) => {
    if (e.origin !== location.origin || !e.data || !e.data.cg) return;
    if (e.data.cg === 'open' && e.data.what === 'server' && e.data.id) {
      const win = createWindow('server', e.data.id, e.data.title || undefined);
      if (!e.data.title) {
        const t = await serverTitle(e.data.id);
        if (t) { win.nameEl.textContent = t; win.btnLabel.textContent = t; }
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
    }
  });

  // старт: восстанавливаем окна прошлой сессии, иначе — «Серверы»;
  // без входа в аккаунт центра сначала показываем окно входа
  (async () => {
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
      const [kind, id] = key.split(':');
      if (!DEFAULTS[kind] || kind === 'gate') continue;
      const win = createWindow(kind, id);
      opened++;
      if (kind === 'server') {
        serverTitle(id).then((t) => { if (t) { win.nameEl.textContent = t; win.btnLabel.textContent = t; } });
      }
    }
    if (!opened) createWindow('servers');
  })();
})();
