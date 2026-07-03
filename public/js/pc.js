'use strict';
/* «Этот компьютер» — проводник по файловой системе ПК внутри Minecraft.
   Работает с локальным API /api/fs/* (только loopback + заголовок x-cg-local:1).
   Навигация по дискам/папкам, просмотр и правка текстовых файлов, создание
   папок и документов. Открывается окном рабочего стола (js/desktop.js). */
(() => {
  const $ = (s) => document.querySelector(s);
  const listEl = $('#pc-list');
  const editorEl = $('#pc-editor');
  const taEl = $('#pc-ta');
  const edInfo = $('#pc-ed-info');
  const pathEl = $('#pc-path');
  const saveBtn = $('#pc-save');
  const upBtn = $('#pc-up');

  // тема из общих настроек панели
  try {
    const s = JSON.parse(localStorage.getItem('controlgui-settings') || '{}');
    document.body.classList.add(s.theme === 'theme-blue' ? 'theme-blue' : 'theme-lime');
  } catch (e) { document.body.classList.add('theme-lime'); }

  const HDR = { 'x-cg-local': '1' };

  let cwd = '';          // текущий путь; '' — список дисков
  let parent = null;     // путь родителя (или null)
  let entries = [];
  let selected = null;
  let editing = null;    // путь открытого в редакторе файла или null
  let dirty = false;

  function api(action, opts) {
    return fetch('/api/fs/' + action, Object.assign({ headers: HDR }, opts || {}));
  }

  let toastTimer = null;
  function toast(text) {
    const t = $('#pc-toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
  }

  function fmtSize(n) {
    if (!n) return '';
    const u = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
    let i = 0; let v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (i === 0 ? v : v.toFixed(1)) + ' ' + u[i];
  }

  function setPath(text) { pathEl.textContent = text; pathEl.title = text; }

  function showList() {
    editorEl.classList.remove('on');
    saveBtn.style.display = 'none';
    editing = null; dirty = false;
  }

  async function navigate(p) {
    if (editing && dirty) toast('Несохранённые изменения не сохранены');
    showList();
    listEl.innerHTML = '<div class="pc-empty">Загрузка…</div>';
    let data;
    try {
      const r = await api('list?path=' + encodeURIComponent(p || ''));
      data = await r.json();
      if (!r.ok) throw new Error(data && data.error);
    } catch (e) {
      listEl.innerHTML = '';
      const err = document.createElement('div');
      err.className = 'pc-error';
      err.textContent = (e && e.message) || 'Не удалось открыть';
      listEl.appendChild(err);
      return;
    }
    cwd = data.roots ? '' : data.path;
    parent = data.roots ? null : data.parent;
    entries = data.entries || [];
    selected = null;
    upBtn.disabled = data.roots ? true : false;
    setPath(data.roots ? 'Этот компьютер' : data.path);
    try { localStorage.setItem('cgPcLastPath', cwd); } catch (e) { /* */ }
    renderList(data.roots, data.truncated);
  }

  function renderList(roots, truncated) {
    listEl.innerHTML = '';
    if (!entries.length) {
      const e = document.createElement('div');
      e.className = 'pc-empty';
      e.textContent = roots ? 'Диски не найдены' : 'Папка пуста';
      listEl.appendChild(e);
      return;
    }
    for (const ent of entries) {
      const el = document.createElement('div');
      el.className = 'pc-entry ' + (ent.type === 'dir' ? 'dir' : 'file') + (ent.hidden ? ' hidden-f' : '');
      const ic = document.createElement('i');
      ic.className = 'pi';
      ic.style.setProperty('--i', "url('/icons/" + (ent.type === 'dir' ? 'folder' : 'script-text') + ".svg')");
      const nm = document.createElement('span');
      nm.className = 'pc-name';
      nm.textContent = ent.name + (ent.type === 'file' && ent.size ? '' : '');
      el.appendChild(ic);
      el.appendChild(nm);
      if (ent.type === 'file' && ent.size) el.title = ent.name + ' — ' + fmtSize(ent.size);
      else el.title = ent.name;
      el.addEventListener('pointerdown', () => selectEntry(el));
      el.addEventListener('dblclick', () => openEntry(ent));
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault(); e.stopPropagation();
        selectEntry(el); showMenu(ent, e.clientX, e.clientY);
      });
      listEl.appendChild(el);
    }
    if (truncated) {
      const e = document.createElement('div');
      e.className = 'pc-empty';
      e.style.gridColumn = '1 / -1';
      e.textContent = 'Показаны не все файлы (папка очень большая)';
      listEl.appendChild(e);
    }
  }

  function selectEntry(el) {
    if (selected) selected.classList.remove('sel');
    selected = el;
    el.classList.add('sel');
  }

  async function openEntry(ent) {
    if (ent.type === 'dir') { navigate(ent.path); return; }
    let data;
    try {
      const r = await api('read?path=' + encodeURIComponent(ent.path));
      data = await r.json();
      if (!r.ok) { toast((data && data.error) || 'Не удалось открыть файл'); return; }
    } catch (e) { toast('Не удалось открыть файл'); return; }
    editing = ent.path;
    dirty = false;
    taEl.value = data.text || '';
    edInfo.textContent = ent.path + ' — ' + fmtSize(data.size || 0);
    editorEl.classList.add('on');
    saveBtn.style.display = '';
    taEl.focus();
  }

  async function save() {
    if (!editing) return;
    try {
      const r = await api('write', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, HDR),
        body: JSON.stringify({ path: editing, text: taEl.value }),
      });
      const data = await r.json();
      if (!r.ok) { toast((data && data.error) || 'Не удалось сохранить'); return; }
      dirty = false;
      toast('Сохранено');
    } catch (e) { toast('Не удалось сохранить'); }
  }

  taEl.addEventListener('input', () => { dirty = true; });
  taEl.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); save(); }
  });
  saveBtn.addEventListener('click', save);

  upBtn.addEventListener('click', () => {
    if (editing) { showList(); navigate(cwd); return; }
    if (parent === null && !cwd) return;
    navigate(parent === null ? '' : parent);
  });
  $('#pc-refresh').addEventListener('click', () => {
    if (editing) { const p = editing; showList(); openByPath(p); }
    else navigate(cwd);
  });

  async function openByPath(p) {
    // повторно открыть файл по пути (обновление в редакторе)
    try {
      const r = await api('read?path=' + encodeURIComponent(p));
      const data = await r.json();
      if (!r.ok) { toast((data && data.error) || 'Не удалось открыть'); navigate(cwd); return; }
      editing = p; dirty = false; taEl.value = data.text || '';
      edInfo.textContent = p + ' — ' + fmtSize(data.size || 0);
      editorEl.classList.add('on'); saveBtn.style.display = '';
    } catch (e) { navigate(cwd); }
  }

  /* ── создание папки/документа ─────────────────────────────── */
  const promptEl = $('#pc-prompt');
  const promptInput = $('#pc-prompt-input');
  let promptKind = null;

  function openPrompt(kind) {
    if (!cwd) { toast('Выберите диск или папку'); return; }
    promptKind = kind;
    $('#pc-prompt-title').textContent = kind === 'folder' ? 'Имя новой папки' : 'Имя документа (например, заметки.txt)';
    promptInput.value = kind === 'doc' ? 'новый.txt' : 'Новая папка';
    promptEl.classList.add('on');
    promptInput.focus();
    promptInput.select();
  }
  function closePrompt() { promptEl.classList.remove('on'); promptKind = null; }

  async function submitPrompt() {
    const name = promptInput.value.trim();
    if (!name) { closePrompt(); return; }
    const action = promptKind === 'folder' ? 'mkdir' : 'newfile';
    try {
      const r = await api(action, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, HDR),
        body: JSON.stringify({ dir: cwd, name }),
      });
      const data = await r.json();
      if (!r.ok) { toast((data && data.error) || 'Не удалось создать'); return; }
      closePrompt();
      navigate(cwd);
    } catch (e) { toast('Не удалось создать'); }
  }

  $('#pc-newfolder').addEventListener('click', () => openPrompt('folder'));
  $('#pc-newdoc').addEventListener('click', () => openPrompt('doc'));
  $('#pc-prompt-ok').addEventListener('click', submitPrompt);
  $('#pc-prompt-cancel').addEventListener('click', closePrompt);
  promptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitPrompt(); }
    else if (e.key === 'Escape') { e.preventDefault(); closePrompt(); }
  });

  /* ── контекстное меню: копировать в сервер / на рабочий стол ─── */
  document.addEventListener('contextmenu', (e) => e.preventDefault());
  const menuEl = $('#pc-menu');
  let menuTarget = null; // элемент {name,type,path}, над которым открыто меню

  function hideMenu() { menuEl.classList.remove('on'); menuTarget = null; }

  function showMenu(ent, x, y) {
    menuTarget = ent;
    menuEl.innerHTML = '';
    const add = (icon, label, fn) => {
      const mi = document.createElement('div');
      mi.className = 'pc-mi';
      const i = document.createElement('i');
      i.className = 'pi'; i.style.setProperty('--i', "url('/icons/" + icon + ".svg')");
      const s = document.createElement('span'); s.textContent = label;
      mi.appendChild(i); mi.appendChild(s);
      mi.addEventListener('click', () => { hideMenu(); fn(); });
      menuEl.appendChild(mi);
    };
    add('server', 'Копировать в сервер…', () => openCopy(ent));
    add('monitor', 'На рабочий стол', () => toDesktop(ent));
    menuEl.classList.add('on');
    // держим меню в пределах окна
    const r = menuEl.getBoundingClientRect();
    const nx = Math.min(x, window.innerWidth - r.width - 6);
    const ny = Math.min(y, window.innerHeight - r.height - 6);
    menuEl.style.left = Math.max(4, nx) + 'px';
    menuEl.style.top = Math.max(4, ny) + 'px';
  }
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('#pc-menu')) hideMenu();
  }, true);
  window.addEventListener('blur', hideMenu);
  listEl.addEventListener('scroll', hideMenu);

  /* «На рабочий стол» — просим окно рабочего стола создать ярлык на этот путь. */
  function toDesktop(ent) {
    if (window.parent === window) { toast('Доступно только внутри Minecraft'); return; }
    try {
      window.parent.postMessage({
        cg: 'add-desktop-file', path: ent.path, name: ent.name, isDir: ent.type === 'dir',
      }, location.origin);
      toast('Добавлено на рабочий стол');
    } catch (e) { toast('Не удалось добавить'); }
  }

  /* ── копирование в сервер ─────────────────────────────────── */
  const copyEl = $('#pc-copy');
  const copyServerSel = $('#pc-copy-server');
  const copySubSel = $('#pc-copy-sub');
  const copyOkBtn = $('#pc-copy-ok');
  let copyTarget = null;
  let serversLoaded = false;

  async function openCopy(ent) {
    copyTarget = ent;
    if (!serversLoaded) {
      copyServerSel.innerHTML = '<option>Загрузка…</option>';
      try {
        const r = await api('servers');
        const data = await r.json();
        const list = (data && data.servers) || [];
        if (!list.length) { toast('Нет ни одного сервера'); return; }
        copyServerSel.innerHTML = '';
        for (const s of list) {
          const o = document.createElement('option');
          o.value = s.id; o.textContent = s.name;
          copyServerSel.appendChild(o);
        }
        serversLoaded = true;
      } catch (e) { toast('Не удалось получить список серверов'); return; }
    }
    if (!copyServerSel.options.length) { toast('Нет ни одного сервера'); return; }
    $('#pc-copy-title').textContent = 'Копировать «' + ent.name + '» в сервер';
    copyEl.classList.add('on');
  }
  function closeCopy() { copyEl.classList.remove('on'); copyTarget = null; }

  async function submitCopy() {
    if (!copyTarget) { closeCopy(); return; }
    const serverId = copyServerSel.value;
    const sub = copySubSel.value;
    if (!serverId) { toast('Выберите сервер'); return; }
    copyOkBtn.disabled = true;
    const prev = copyOkBtn.textContent;
    copyOkBtn.textContent = 'Копирование…';
    try {
      const r = await api('copy-to-server', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, HDR),
        body: JSON.stringify({ src: copyTarget.path, serverId, sub }),
      });
      const data = await r.json();
      if (!r.ok) { toast((data && data.error) || 'Не удалось скопировать'); return; }
      toast('Скопировано в «' + (data.server || 'сервер') + '»' + (sub ? ' → ' + sub : ''));
      closeCopy();
    } catch (e) { toast('Не удалось скопировать'); }
    finally { copyOkBtn.disabled = false; copyOkBtn.textContent = prev; }
  }
  copyOkBtn.addEventListener('click', submitCopy);
  $('#pc-copy-cancel').addEventListener('click', closeCopy);

  // навигация по просьбе рабочего стола (двойной клик по ярлыку на ПК-путь)
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || !e.data || e.data.cg !== 'pc-navigate') return;
    if (editing) showList();
    navigate(String(e.data.path || ''));
  });

  // старт: путь, заданный рабочим столом (ярлык), иначе последняя папка/диски
  let start = '';
  try {
    start = localStorage.getItem('cgPcStartPath') || '';
    if (start) localStorage.removeItem('cgPcStartPath');
    else start = localStorage.getItem('cgPcLastPath') || '';
  } catch (e) { /* */ }
  navigate(start);
})();
