'use strict';

/* CONTROLGUI — логика SPA. Все элементы — компоненты UI-кита
   (css/minecraft.css). Иконки — Pixelarticons (public/icons), красятся
   через CSS-mask в currentColor. Редактор файлов — CodeMirror (CDN)
   с fallback на textarea, если CDN недоступен. */

(function () {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const STATUS_LABEL = {
    stopped: 'Остановлен',
    starting: 'Запускается...',
    running: 'Работает',
    stopping: 'Останавливается...',
    downloading: 'Установка...',
    error: 'Ошибка',
    'no-jar': 'Ядро не установлено',
    orphaned: 'Работает вне панели',
  };

  const CORE_NAMES = {
    vanilla: 'Vanilla', paper: 'Paper', purpur: 'Purpur',
    folia: 'Folia', mohist: 'Mohist', forge: 'Forge',
  };

  // официальные текстуры предметов (по id), item -> block -> текст
  const TEX_BASE = 'https://raw.githubusercontent.com/InventivetalentDev/minecraft-assets/1.21.4/assets/minecraft/textures/';

  const COMMANDS = [
    'advancement', 'attribute', 'ban', 'ban-ip', 'banlist', 'bossbar', 'clear', 'clone',
    'damage', 'data', 'datapack', 'debug', 'defaultgamemode', 'deop', 'difficulty', 'effect',
    'enchant', 'execute', 'experience', 'fill', 'fillbiome', 'forceload', 'function',
    'gamemode', 'gamerule', 'give', 'help', 'item', 'kick', 'kill', 'list', 'locate', 'loot',
    'me', 'msg', 'op', 'pardon', 'pardon-ip', 'particle', 'place', 'playsound', 'random',
    'recipe', 'reload', 'return', 'ride', 'rotate', 'save-all', 'save-off', 'save-on', 'say',
    'schedule', 'scoreboard', 'seed', 'setblock', 'setidletimeout', 'setworldspawn',
    'spawnpoint', 'spectate', 'spreadplayers', 'stop', 'stopsound', 'summon', 'tag', 'team',
    'teammsg', 'teleport', 'tell', 'tellraw', 'tick', 'time', 'title', 'tp', 'transfer',
    'trigger', 'weather', 'whitelist', 'worldborder', 'xp',
  ];

  const state = {
    screen: 'list',
    servers: [],
    selectedId: null,
    currentId: null,
    current: null,
    currentTab: 'console',
    sse: null,
    pollTimer: null,
    history: [],
    historyIdx: -1,
    lanIps: [],
    rootPath: '',
    maxMemMb: 8192,
    filesPath: '',
    editorPath: null,
    memCreateSlider: null,
    memSettingsSlider: null,
    playTimes: {},
    sugItems: [],
    sugIndex: -1,
    cm: null, // CodeMirror instance
  };

  // ---------- иконки ----------

  function applyIcons(root) {
    Array.from((root || document).querySelectorAll('.pi[data-ic]')).forEach((el) => {
      el.style.setProperty('--i', "url('/icons/" + el.dataset.ic + ".svg')");
    });
  }

  function picon(name, color) {
    const i = document.createElement('i');
    i.className = 'pi';
    i.style.setProperty('--i', "url('/icons/" + name + ".svg')");
    if (color) i.style.color = color;
    return i;
  }

  // ---------- утилиты ----------

  function showToast(message, type) {
    const el = document.createElement('div');
    el.className = 'toast ' + (type === 'ok' ? 'toast-ok' : 'toast-error');
    el.textContent = message;
    $('#toast-root').appendChild(el);
    setTimeout(() => el.remove(), 6000);
  }

  function confirmDialog(text, opts) {
    opts = opts || {};
    return new Promise((resolve) => {
      $('#dialog-title').textContent = opts.title || 'Подтверждение';
      $('#dialog-text').textContent = text;
      const yes = $('#dialog-yes');
      yes.textContent = opts.yesText || 'Да';
      yes.className = 'mc-btn ' + (opts.danger === false ? 'primary' : 'danger');
      $('#dialog-root').classList.remove('hidden');
      const done = (answer) => {
        $('#dialog-root').classList.add('hidden');
        yes.onclick = null;
        $('#dialog-no').onclick = null;
        resolve(answer);
      };
      yes.onclick = () => done(true);
      $('#dialog-no').onclick = () => done(false);
    });
  }

  function promptDialog(title, value, placeholder) {
    return new Promise((resolve) => {
      $('#input-title').textContent = title;
      const field = $('#input-field');
      field.value = value || '';
      field.placeholder = placeholder || '';
      $('#input-root').classList.remove('hidden');
      field.focus();
      field.select();
      const done = (answer) => {
        $('#input-root').classList.add('hidden');
        $('#input-ok').onclick = null;
        $('#input-cancel').onclick = null;
        field.onkeydown = null;
        resolve(answer);
      };
      $('#input-ok').onclick = () => done(field.value.trim() || null);
      $('#input-cancel').onclick = () => done(null);
      field.onkeydown = (event) => {
        if (event.key === 'Enter') done(field.value.trim() || null);
        if (event.key === 'Escape') done(null);
      };
    });
  }

  async function guard(fn) {
    try { return await fn(); }
    catch (e) { showToast(e.message); }
  }

  function fmtBytes(n) {
    if (n == null) return '';
    if (n < 1024) return Math.round(n) + ' Б';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' КБ';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' МБ';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' ГБ';
  }

  function fmtDuration(ms) {
    const min = Math.floor(ms / 60000);
    if (min < 1) return 'меньше минуты';
    if (min < 60) return min + ' мин';
    return Math.floor(min / 60) + ' ч ' + (min % 60) + ' мин';
  }

  function fmtTicks(ticks) {
    const totalMin = Math.floor(ticks / 20 / 60);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (h >= 100) return h + ' ч';
    if (h > 0) return h + ' ч ' + m + ' мин';
    return m + ' мин';
  }

  function fmtMem(v) {
    return v + ' МБ (' + (v / 1024).toFixed(1).replace('.0', '') + ' ГБ)';
  }

  // ---------- компоненты кита ----------

  function mkToggle(el, initialOn) {
    if (initialOn) el.classList.add('on');
    el.innerHTML = '<div class="fill"></div><div class="knob"><div class="face"></div></div>';
    el.addEventListener('click', () => el.classList.toggle('on'));
  }

  function mkSlider(el, opts) {
    el.innerHTML = '<div class="track-off"></div><div class="fill"></div><div class="knob"><div class="face"></div></div>';
    const fill = el.querySelector('.fill');
    const knob = el.querySelector('.knob');
    let value = clamp(opts.value);

    function clamp(v) {
      v = Math.round(v / opts.step) * opts.step;
      return Math.max(opts.min, Math.min(opts.max, v));
    }
    function render() {
      const w = el.clientWidth;
      const knobW = knob.offsetWidth || 32;
      const x = ((value - opts.min) / (opts.max - opts.min || 1)) * (w - knobW);
      knob.style.left = x + 'px';
      fill.style.width = Math.max(0, x + knobW / 2 - 3) + 'px';
      if (opts.labelEl) opts.labelEl.textContent = opts.format ? opts.format(value) : String(value);
    }
    function fromPointer(event) {
      const rect = el.getBoundingClientRect();
      const knobW = knob.offsetWidth || 32;
      const r = (event.clientX - rect.left - knobW / 2) / Math.max(1, rect.width - knobW);
      value = clamp(opts.min + Math.max(0, Math.min(1, r)) * (opts.max - opts.min));
      render();
    }
    el.addEventListener('pointerdown', (event) => {
      el.setPointerCapture(event.pointerId);
      fromPointer(event);
      const move = (ev) => fromPointer(ev);
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
    if (window.ResizeObserver) new ResizeObserver(render).observe(el);
    render();
    return {
      get value() { return value; },
      set(v) { value = clamp(v); render(); },
      setRange(min, max) { opts.min = min; opts.max = max; value = clamp(value); render(); },
      refresh: render,
    };
  }

  // ---------- экраны ----------

  function showScreen(name) {
    state.screen = name;
    $('#screen-list').classList.toggle('hidden', name !== 'list');
    $('#screen-create').classList.toggle('hidden', name !== 'create');
    $('#screen-server').classList.toggle('hidden', name !== 'server');
    if (name !== 'server' && state.sse) {
      state.sse.close();
      state.sse = null;
    }
  }

  function initCycleButtons(root) {
    Array.from(root.querySelectorAll('.mc-cycle')).forEach((btn) => {
      const values = btn.dataset.values.split(',');
      const names = btn.dataset.names.split(',');
      let idx = parseInt(btn.dataset.start || '0', 10);
      const render = () => {
        btn.dataset.value = values[idx];
        btn.textContent = btn.dataset.label + ': ' + names[idx];
      };
      btn.addEventListener('click', () => {
        idx = (idx + 1) % values.length;
        render();
      });
      render();
    });
  }

  // ---------- статус панели / Java ----------

  async function loadStatus() {
    try {
      const st = await API.status();
      state.lanIps = st.lanIps || [];
      state.rootPath = st.root || '';
      if (st.totalMemMb) {
        state.maxMemMb = Math.max(2048, Math.min(32768, Math.floor((st.totalMemMb - 2048) / 512) * 512));
        if (state.memCreateSlider) state.memCreateSlider.setRange(1024, state.maxMemMb);
      }
      const alert = $('#java-alert');
      if (st.java && st.java.available) {
        alert.classList.add('hidden');
      } else {
        alert.classList.remove('hidden');
        alert.innerHTML = 'Java не найдена! Серверы не запустятся. Установите Java 21+ с <a href="https://adoptium.net" target="_blank" rel="noopener">adoptium.net</a> и перезапустите панель.';
      }
    } catch (e) {
      showToast(e.message);
    }
  }

  // ---------- список серверов ----------

  async function loadServers() {
    const data = await API.servers();
    state.servers = data.servers;
    renderList();
  }

  function renderList() {
    const panel = $('#server-list');
    Array.from(panel.querySelectorAll('.server-row')).forEach((el) => el.remove());
    $('#list-empty').classList.toggle('hidden', state.servers.length > 0);

    if (!state.servers.some((s) => s.id === state.selectedId)) state.selectedId = null;

    for (const server of state.servers) {
      const row = document.createElement('div');
      row.className = 'mc-row server-row' + (server.id === state.selectedId ? ' sel' : '');

      const icon = document.createElement('img');
      icon.className = 'server-icon';
      icon.src = iconFor(server.id);
      icon.alt = '';

      const mid = document.createElement('div');
      mid.className = 'server-row-mid';
      const nameEl = document.createElement('div');
      nameEl.className = 'server-row-name';
      nameEl.textContent = server.name;
      const subEl = document.createElement('div');
      subEl.className = 'server-row-sub';
      subEl.textContent = (CORE_NAMES[server.type] || server.type) + ' ' + server.version + ' · порт ' + server.port;
      mid.appendChild(nameEl);
      mid.appendChild(subEl);

      const right = document.createElement('div');
      right.className = 'server-row-right';
      const statusEl = document.createElement('div');
      statusEl.className = 'st-' + server.status;
      statusEl.textContent = statusText(server);
      right.appendChild(statusEl);
      if (server.status === 'running') {
        const playersEl = document.createElement('div');
        playersEl.className = 'server-row-players';
        playersEl.textContent = 'Игроки: ' + server.players.length;
        right.appendChild(playersEl);
      }

      row.appendChild(icon);
      row.appendChild(mid);
      row.appendChild(right);

      row.addEventListener('click', () => {
        state.selectedId = server.id;
        renderList();
      });
      row.addEventListener('dblclick', () => openServer(server.id));
      panel.appendChild(row);
    }

    $('#btn-manage').disabled = !state.selectedId;
    $('#btn-delete').disabled = !state.selectedId;
  }

  function iconFor(id) {
    let h = 7;
    for (let i = 0; i < String(id).length; i++) h = (h * 31 + String(id).charCodeAt(i)) | 0;
    return '/assets/menu-icons/0' + ((Math.abs(h) % 5) + 1) + '.png';
  }

  function headUrl(player, size) {
    const key = player.uuid || player.name;
    return 'https://mc-heads.net/avatar/' + encodeURIComponent(key) + '/' + (size || 36);
  }

  function statusText(server) {
    if (server.status === 'downloading' && server.download) {
      if (server.download.phase === 'installing') return 'Установка ядра...';
      if (server.download.phase === 'downloading') return 'Загрузка ' + Math.round((server.download.progress || 0) * 100) + '%';
      return 'Подготовка...';
    }
    return STATUS_LABEL[server.status] || server.status;
  }

  // ---------- создание сервера ----------

  async function loadVersions() {
    const type = $('#core-select').value || 'vanilla';
    const select = $('#version-select');
    select.innerHTML = '<option value="">Загрузка версий...</option>';
    try {
      const data = await API.versions(type);
      select.innerHTML = '';
      for (const v of data.versions) {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = v;
        select.appendChild(opt);
      }
      if (!data.versions.length) select.innerHTML = '<option value="">Версии не найдены</option>';
    } catch (e) {
      select.innerHTML = '<option value="">Не удалось загрузить (нет сети?)</option>';
      showToast(e.message);
    }
  }

  function suggestPort() {
    const taken = new Set(state.servers.map((s) => Number(s.port)));
    let port = 25565;
    while (taken.has(port)) port++;
    $('#create-form [name=port]').value = port;
  }

  async function submitCreate(event) {
    event.preventDefault();
    if (!$('#eula-check').classList.contains('on')) {
      showToast('Нужно принять Minecraft EULA');
      return;
    }
    const form = $('#create-form');
    const body = {
      name: form.name.value,
      motd: form.motd.value,
      type: $('#core-select').value,
      version: form.version.value,
      port: form.port.value,
      memoryMb: state.memCreateSlider.value,
      gamemode: $('#cycle-gamemode').dataset.value,
      difficulty: $('#cycle-difficulty').dataset.value,
      maxPlayers: form.maxPlayers.value,
      levelSeed: form.levelSeed.value,
      onlineMode: $('#toggle-online').classList.contains('on'),
      pvp: $('#toggle-pvp').classList.contains('on'),
      eulaAccepted: true,
    };
    if (!body.version) {
      showToast('Выберите версию');
      return;
    }
    $('#btn-create').disabled = true;
    try {
      const created = await API.create(body);
      showToast('Сервер «' + created.name + '» создан, устанавливаю ядро...', 'ok');
      form.reset();
      $('#eula-check').classList.remove('on');
      await loadServers();
      openServer(created.id);
    } catch (e) {
      showToast(e.message);
    } finally {
      $('#btn-create').disabled = false;
    }
  }

  // ---------- экран сервера ----------

  function openServer(id) {
    state.currentId = id;
    state.current = state.servers.find((s) => s.id === id) || null;
    state.filesPath = '';
    state.editorPath = null;
    state.playTimes = {};
    showScreen('server');
    switchTab('console');
    renderServerHead();
    connectConsole(id);
    refreshServer();
    loadSettings();
  }

  async function refreshServer() {
    if (state.screen !== 'server' || !state.currentId) return;
    try {
      state.current = await API.server(state.currentId);
      renderServerHead();
      if (state.currentTab === 'console') loadStats();
    } catch (e) {
      showScreen('list');
      showToast(e.message);
    }
  }

  function renderServerHead() {
    const server = state.current;
    if (!server) return;
    $('#server-title').textContent = server.name;
    const st = $('#server-status');
    st.className = 'status-badge st-' + server.status;
    st.textContent = statusText(server);
    $('#server-addr').textContent = (CORE_NAMES[server.type] || server.type) + ' ' + server.version + ' · localhost:' + server.port;

    const dlWrap = $('#download-wrap');
    const dl = server.download;
    const fill = $('#download-fill');
    if (dl && (dl.phase === 'resolving' || dl.phase === 'downloading' || dl.phase === 'installing')) {
      dlWrap.classList.remove('hidden');
      fill.classList.toggle('indeterminate', dl.phase !== 'downloading');
      if (dl.phase === 'downloading') {
        $('#download-label').textContent = 'Загрузка: ' + fmtBytes(dl.doneBytes) + ' / ' + fmtBytes(dl.totalBytes);
        fill.style.width = Math.round((dl.progress || 0) * 100) + '%';
      } else if (dl.phase === 'installing') {
        $('#download-label').textContent = 'Установка ядра (Forge)... подробности в консоли';
      } else {
        $('#download-label').textContent = 'Поиск файлов ядра в официальном репозитории...';
      }
    } else {
      dlWrap.classList.add('hidden');
      fill.classList.remove('indeterminate');
    }

    const status = server.status;
    const processAlive = status === 'starting' || status === 'running' || status === 'stopping';
    const orphaned = status === 'orphaned';
    $('#btn-start').disabled = processAlive || orphaned || status === 'downloading' || !server.jarReady;
    $('#btn-stop').disabled = !processAlive;
    $('#btn-restart').disabled = orphaned || status === 'downloading' || !server.jarReady;
    $('#btn-kill').disabled = !(processAlive || orphaned);
    $('#btn-redownload').classList.toggle(
      'hidden',
      !(status === 'no-jar' || (dl && dl.phase === 'error'))
    );

    renderInfo(server);
    renderPlayers(server);
  }

  function renderInfo(server) {
    const grid = $('#info-grid');
    const rows = [
      ['Адрес (этот ПК)', 'localhost:' + server.port],
      ['Адрес (локальная сеть)', state.lanIps.length ? state.lanIps.map((ip) => ip + ':' + server.port).join('  ') : '—'],
      ['Ядро', (CORE_NAMES[server.type] || server.type) + ' ' + server.version],
      ['Память', fmtMem(server.memoryMb)],
      ['Создан', new Date(server.createdAt).toLocaleString('ru-RU')],
      ['Файлы сервера', (state.rootPath ? state.rootPath + '\\' : '') + 'servers\\' + server.id],
    ];
    grid.innerHTML = '';
    for (const [k, v] of rows) {
      const kEl = document.createElement('div');
      kEl.className = 'k';
      kEl.textContent = k;
      const vEl = document.createElement('div');
      vEl.className = 'v';
      vEl.textContent = v;
      grid.appendChild(kEl);
      grid.appendChild(vEl);
    }
  }

  // ---------- метрики процесса (чёткие графики с учётом DPI) ----------

  function sparkline(canvasId, values, maxValue) {
    const canvas = $(canvasId);
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 240;
    const cssH = canvas.clientHeight || 46;
    const W = Math.round(cssW * dpr);
    const H = Math.round(cssH * dpr);
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    if (!values.length) return;
    const max = maxValue || Math.max.apply(null, values.concat([1])) * 1.15;
    const stepX = cssW / 59;
    const accent = getComputedStyle(document.body).getPropertyValue('--accent-bright').trim() || '#80da5b';

    const xy = (v, i) => [
      cssW - (values.length - 1 - i) * stepX,
      cssH - 2.5 - Math.min(1, v / max) * (cssH - 7),
    ];
    ctx.beginPath();
    values.forEach((v, i) => {
      const [x, y] = xy(v, i);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    ctx.stroke();
    const [x0] = xy(values[0], 0);
    ctx.lineTo(cssW, cssH);
    ctx.lineTo(x0, cssH);
    ctx.closePath();
    ctx.fillStyle = 'rgba(92,181,61,.16)';
    ctx.fill();
  }

  async function loadStats() {
    const server = state.current;
    if (!server) return;
    const active = server.status === 'running' || server.status === 'starting' || server.status === 'stopping';
    if (!active) {
      $('#stat-cpu').textContent = '—';
      $('#stat-ram').textContent = '—';
      $('#stat-read').textContent = '—';
      $('#stat-write').textContent = '—';
      ['#graph-cpu', '#graph-ram', '#graph-read', '#graph-write'].forEach((id) => sparkline(id, [], 1));
      return;
    }
    try {
      const data = await API.stats(state.currentId);
      const pts = data.points || [];
      const last = pts[pts.length - 1];
      if (last) {
        $('#stat-cpu').textContent = last.cpu.toFixed(1) + '% из 100%';
        $('#stat-ram').textContent = last.ramMb + ' / ' + data.memLimitMb + ' МБ';
        $('#stat-read').textContent = fmtBytes(last.readBps) + '/с';
        $('#stat-write').textContent = fmtBytes(last.writeBps) + '/с';
      } else {
        $('#stat-cpu').textContent = 'сбор...';
      }
      sparkline('#graph-cpu', pts.map((p) => p.cpu), 100);
      sparkline('#graph-ram', pts.map((p) => p.ramMb), data.memLimitMb);
      sparkline('#graph-read', pts.map((p) => p.readBps), null);
      sparkline('#graph-write', pts.map((p) => p.writeBps), null);
    } catch (e) { /* статы не критичны */ }
  }

  // ---------- игроки ----------

  /* До перезапуска панели бэкенд мог прислать имена с ANSI-кодами цвета
     (Paper/Purpur) — одна и та же личность распадается на две записи.
     Чистим имена и сливаем записи. */
  function cleanPlayerName(name) {
    return String(name)
      .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
      .replace(/§[0-9a-fk-orx]/gi, '')
      .replace(/[\x00-\x1f\x7f]/g, '');
  }

  function mergedPlayers(list) {
    const byName = new Map();
    for (const raw of list || []) {
      const name = cleanPlayerName(raw.name);
      if (!name) continue;
      const p = byName.get(name) || {
        name, uuid: null, ip: null, online: false, joinedAt: null,
        lastSeen: null, loginPos: null, advancements: 0, lastAdvancement: null,
      };
      p.uuid = p.uuid || raw.uuid;
      p.ip = p.ip || raw.ip;
      p.loginPos = p.loginPos || raw.loginPos;
      if (raw.online) { p.online = true; p.joinedAt = raw.joinedAt || p.joinedAt; }
      if (raw.lastSeen && (!p.lastSeen || raw.lastSeen > p.lastSeen)) p.lastSeen = raw.lastSeen;
      if (raw.advancements > p.advancements) {
        p.advancements = raw.advancements;
        p.lastAdvancement = raw.lastAdvancement;
      }
      byName.set(name, p);
    }
    return Array.from(byName.values())
      .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  }

  function renderPlayers(server) {
    const panel = $('#players-list');
    const players = mergedPlayers(server.playersInfo);
    panel.innerHTML = '';
    if (!players.length) {
      const empty = document.createElement('div');
      empty.className = 'players-empty';
      empty.textContent = 'Игроки ещё не заходили (статистика собирается, пока сервер работает).';
      panel.appendChild(empty);
      return;
    }
    for (const p of players) {
      const row = document.createElement('div');
      row.className = 'player-row';

      const head = document.createElement('img');
      head.className = 'player-head';
      head.alt = '';
      head.loading = 'lazy';
      head.src = headUrl(p, 36);
      head.onerror = () => { head.onerror = null; head.src = '/assets/gear.png'; };

      const main = document.createElement('div');
      main.className = 'player-main';
      const nameEl = document.createElement('div');
      nameEl.className = 'player-name';
      const dot = document.createElement('span');
      dot.className = 'dot' + (p.online ? ' on' : '');
      dot.title = p.online ? 'В сети' : 'Не в сети';
      nameEl.appendChild(dot);
      nameEl.appendChild(document.createTextNode(p.name));
      const sub = document.createElement('div');
      sub.className = 'player-sub';
      const subParts = [];
      if (p.ip) subParts.push('IP: ' + p.ip);
      if (p.advancements) subParts.push('Достижений: ' + p.advancements);
      if (state.playTimes[p.name] != null) subParts.push('Всего в игре: ' + fmtTicks(state.playTimes[p.name]));
      sub.textContent = subParts.join(' · ') || 'Подробности — по кнопке «Инвентарь»';
      main.appendChild(nameEl);
      main.appendChild(sub);

      const right = document.createElement('div');
      right.className = 'player-right';
      const l1 = document.createElement('div');
      if (p.online && p.joinedAt) l1.textContent = 'Сессия: ' + fmtDuration(Date.now() - p.joinedAt);
      else if (p.lastSeen) l1.textContent = 'Был(а): ' + new Date(p.lastSeen).toLocaleTimeString('ru-RU');
      right.appendChild(l1);

      const actions = document.createElement('div');
      actions.className = 'player-actions';
      const invBtn = document.createElement('button');
      invBtn.className = 'mc-btn sm';
      invBtn.appendChild(picon('info-box'));
      invBtn.appendChild(document.createTextNode(' Информация'));
      invBtn.addEventListener('click', () => openInventory(p.name));
      actions.appendChild(invBtn);

      row.appendChild(head);
      row.appendChild(main);
      row.appendChild(right);
      row.appendChild(actions);
      panel.appendChild(row);
    }
  }

  async function fetchPlayTimes() {
    const server = state.current;
    if (!server) return;
    const names = mergedPlayers(server.playersInfo).map((p) => p.name).slice(0, 12);
    for (const name of names) {
      if (state.playTimes[name] != null) continue;
      try {
        const data = await API.player(state.currentId, name);
        if (data.playTimeTicks != null) state.playTimes[name] = data.playTimeTicks;
      } catch (e) { /* нет данных */ }
    }
    if (state.currentTab === 'info') renderPlayers(server);
  }

  // ---------- инвентарь (широкая раскладка, иконки предметов) ----------

  const ARMOR_SLOTS = [[103, 'Шлем'], [102, 'Нагрудник'], [101, 'Поножи'], [100, 'Ботинки'], [-106, 'Левая рука']];

  function invCell(item, label) {
    const cell = document.createElement('div');
    cell.className = 'inv-cell' + (item ? '' : ' empty');
    if (item) {
      cell.title = item.id.replace(/_/g, ' ') + (item.count > 1 ? ' ×' + item.count : '');
      const img = document.createElement('img');
      img.className = 'it-img';
      img.alt = '';
      img.loading = 'lazy';
      // у составных блоков (верстак, печка) нет плоской текстуры — пробуем грани
      const candidates = [
        'item/' + item.id, 'block/' + item.id,
        'block/' + item.id + '_front', 'block/' + item.id + '_top', 'block/' + item.id + '_side',
      ];
      let attempt = 0;
      img.src = TEX_BASE + candidates[attempt] + '.png';
      img.onerror = () => {
        attempt++;
        if (attempt < candidates.length) {
          img.src = TEX_BASE + candidates[attempt] + '.png';
        } else {
          const it = document.createElement('span');
          it.className = 'it';
          it.textContent = item.id.replace(/_/g, ' ');
          cell.replaceChild(it, img);
        }
      };
      cell.appendChild(img);
      if (item.count > 1) {
        const cnt = document.createElement('span');
        cnt.className = 'cnt';
        cnt.textContent = item.count;
        cell.appendChild(cnt);
      }
    } else if (label) {
      cell.title = label;
    }
    return cell;
  }

  function metaRow(grid, iconName, key, value) {
    const kEl = document.createElement('div');
    kEl.className = 'k';
    kEl.appendChild(picon(iconName));
    kEl.appendChild(document.createTextNode(key));
    const vEl = document.createElement('div');
    vEl.textContent = value;
    grid.appendChild(kEl);
    grid.appendChild(vEl);
  }

  async function openInventory(name) {
    await guard(async () => {
      const data = await API.player(state.currentId, name);
      $('#inv-title').textContent = 'Игрок: ' + name;
      const body = $('#inv-body');
      body.innerHTML = '';

      const flex = document.createElement('div');
      flex.className = 'inv-flex';

      // левая колонка — карточка игрока
      const side = document.createElement('div');
      side.className = 'inv-side';
      const sideCard = document.createElement('div');
      sideCard.className = 'mc-card inset';
      const secInfo = document.createElement('div');
      secInfo.className = 'inv-sec';
      secInfo.appendChild(picon('user'));
      secInfo.appendChild(document.createTextNode('Об игроке'));
      sideCard.appendChild(secInfo);
      const avatar = document.createElement('img');
      avatar.className = 'inv-avatar';
      avatar.alt = '';
      avatar.src = headUrl({ uuid: data.uuid, name: name }, 96);
      avatar.onerror = () => { avatar.onerror = null; avatar.src = '/assets/gear.png'; };
      sideCard.appendChild(avatar);
      const meta = document.createElement('div');
      meta.className = 'inv-meta';
      metaRow(meta, 'check', 'Статус', data.online ? 'В сети' : 'Не в сети');
      metaRow(meta, 'clock', 'Всего в игре', data.playTimeTicks != null ? fmtTicks(data.playTimeTicks) : 'нет данных');
      if (data.lastPlayed) metaRow(meta, 'save', 'Сохранение', new Date(data.lastPlayed).toLocaleString('ru-RU'));
      if (data.xpLevel != null) metaRow(meta, 'chart-bar', 'Опыт', 'уровень ' + data.xpLevel);
      if (data.health != null) metaRow(meta, 'zap', 'Здоровье', data.health + ' / 20');
      if (data.food != null) metaRow(meta, 'minus', 'Сытость', data.food + ' / 20');
      if (data.pos) metaRow(meta, 'search', 'Позиция', data.pos.join(', ') + (data.dimension ? ' · ' + data.dimension : ''));
      const uuidEl = document.createElement('div');
      uuidEl.className = 'inv-uuid';
      uuidEl.textContent = 'UUID: ' + (data.uuid || '—');
      sideCard.appendChild(meta);
      sideCard.appendChild(uuidEl);
      side.appendChild(sideCard);

      // правая колонка — инвентарь
      const main = document.createElement('div');
      main.className = 'inv-main';
      if (!data.inventory) {
        const note = document.createElement('div');
        note.className = 'inv-empty-note';
        note.textContent = 'Файл инвентаря ещё не создан (игрок не заходил в этот мир).';
        main.appendChild(note);
      } else {
        const bySlot = new Map();
        for (const item of data.inventory) bySlot.set(item.slot, item);

        const mkSec = (iconName, title) => {
          const sec = document.createElement('div');
          sec.className = 'inv-sec';
          sec.appendChild(picon(iconName));
          sec.appendChild(document.createTextNode(title));
          return sec;
        };

        main.appendChild(mkSec('user', 'Броня и левая рука'));
        const armorGrid = document.createElement('div');
        armorGrid.className = 'inv-grid row5';
        for (const [slot, label] of ARMOR_SLOTS) armorGrid.appendChild(invCell(bySlot.get(slot), label));
        main.appendChild(armorGrid);

        main.appendChild(mkSec('folder', 'Инвентарь'));
        const mainGrid = document.createElement('div');
        mainGrid.className = 'inv-grid';
        for (let slot = 9; slot <= 35; slot++) mainGrid.appendChild(invCell(bySlot.get(slot)));
        main.appendChild(mainGrid);

        main.appendChild(mkSec('command', 'Хотбар'));
        const hotGrid = document.createElement('div');
        hotGrid.className = 'inv-grid';
        for (let slot = 0; slot <= 8; slot++) hotGrid.appendChild(invCell(bySlot.get(slot)));
        main.appendChild(hotGrid);

        const hint = document.createElement('div');
        hint.className = 'inv-empty-note';
        hint.textContent = 'Данные из сохранения мира — для игрока в сети обновляются при автосохранении.';
        main.appendChild(hint);
      }

      flex.appendChild(side);
      flex.appendChild(main);
      body.appendChild(flex);

      if (data.playTimeTicks != null) state.playTimes[name] = data.playTimeTicks;
      $('#inv-root').classList.remove('hidden');
    });
  }

  // ---------- консоль ----------

  function connectConsole(id) {
    if (state.sse) state.sse.close();
    const consoleEl = $('#console');
    consoleEl.innerHTML = '';
    const sse = API.consoleStream(id);
    state.sse = sse;
    sse.onmessage = (event) => {
      let line;
      try { line = JSON.parse(event.data); } catch (e) { return; }
      appendConsoleLine(line);
    };
    sse.onerror = () => {
      consoleEl.innerHTML = '';
    };
  }

  function appendConsoleLine(line) {
    line = String(line).replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''); // ANSI-цвета Paper/Purpur
    const consoleEl = $('#console');
    const atBottom = consoleEl.scrollTop + consoleEl.clientHeight >= consoleEl.scrollHeight - 40;
    const el = document.createElement('span');
    el.className = 'ln';
    if (line.startsWith('> ')) el.classList.add('ln-cmd');
    else if (line.includes('[ПАНЕЛЬ]')) el.classList.add('ln-panel');
    else if (/ERROR|SEVERE|Exception|FAILED/i.test(line)) el.classList.add('ln-error');
    else if (/WARN/.test(line)) el.classList.add('ln-warn');
    el.textContent = line;
    consoleEl.appendChild(el);
    while (consoleEl.childNodes.length > 1200) consoleEl.removeChild(consoleEl.firstChild);
    if (atBottom) consoleEl.scrollTop = consoleEl.scrollHeight;
  }

  function sendCommand() {
    const input = $('#command-input');
    let command = input.value.trim();
    if (!command || !state.currentId) return;
    if (command.startsWith('/')) command = command.slice(1);
    state.history.push(input.value.trim());
    state.historyIdx = state.history.length;
    input.value = '';
    hideSuggest();
    guard(() => API.command(state.currentId, command));
  }

  // ---------- автоподсказки команд ----------

  function updateSuggest() {
    const input = $('#command-input');
    const value = input.value;
    if (!value.startsWith('/') || value.includes(' ')) {
      hideSuggest();
      return;
    }
    const prefix = value.slice(1).toLowerCase();
    state.sugItems = COMMANDS.filter((c) => c.startsWith(prefix));
    if (!state.sugItems.length) {
      hideSuggest();
      return;
    }
    if (state.sugIndex >= state.sugItems.length) state.sugIndex = -1;
    renderSuggest();
  }

  function renderSuggest() {
    const box = $('#cmd-suggest');
    box.innerHTML = '';
    state.sugItems.slice(0, 30).forEach((cmd, i) => {
      const el = document.createElement('div');
      el.className = 'sug' + (i === state.sugIndex ? ' sel' : '');
      const name = document.createElement('span');
      name.textContent = '/' + cmd;
      el.appendChild(name);
      el.addEventListener('mousedown', (event) => {
        event.preventDefault();
        applySuggest(cmd);
      });
      box.appendChild(el);
    });
    const hint = document.createElement('div');
    hint.className = 'sug-hint';
    hint.textContent = state.sugItems.length === 1
      ? 'Tab — подставить команду'
      : 'Tab — листать (' + state.sugItems.length + '), Enter — отправить';
    box.appendChild(hint);
    box.classList.remove('hidden');
    const selEl = box.querySelector('.sug.sel');
    if (selEl) selEl.scrollIntoView({ block: 'nearest' });
  }

  function applySuggest(cmd) {
    const input = $('#command-input');
    input.value = '/' + cmd + ' ';
    hideSuggest();
    input.focus();
  }

  function hideSuggest() {
    $('#cmd-suggest').classList.add('hidden');
    state.sugItems = [];
    state.sugIndex = -1;
  }

  function suggestVisible() {
    return !$('#cmd-suggest').classList.contains('hidden');
  }

  function onCommandKeydown(event) {
    if (event.key === 'Tab') {
      event.preventDefault();
      if (!suggestVisible()) { updateSuggest(); return; }
      if (state.sugItems.length === 1) {
        applySuggest(state.sugItems[0]);
      } else if (state.sugItems.length > 1) {
        state.sugIndex = (state.sugIndex + 1) % state.sugItems.length;
        const input = $('#command-input');
        input.value = '/' + state.sugItems[state.sugIndex];
        renderSuggest();
      }
      return;
    }
    if (suggestVisible()) {
      if (event.key === 'Escape') { hideSuggest(); event.preventDefault(); return; }
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault();
        const dir = event.key === 'ArrowDown' ? 1 : -1;
        const n = state.sugItems.length;
        state.sugIndex = ((state.sugIndex + dir) % n + n) % n;
        renderSuggest();
        return;
      }
      if (event.key === 'Enter') { sendCommand(); return; }
      return;
    }
    if (event.key === 'Enter') sendCommand();
    else if (event.key === 'ArrowUp') {
      if (state.historyIdx > 0) {
        state.historyIdx--;
        event.target.value = state.history[state.historyIdx] || '';
        event.preventDefault();
      }
    } else if (event.key === 'ArrowDown') {
      if (state.historyIdx < state.history.length) {
        state.historyIdx++;
        event.target.value = state.history[state.historyIdx] || '';
        event.preventDefault();
      }
    }
  }

  // ---------- настройки ----------

  const KNOWN_FIELDS = [
    { key: 'motd', label: 'MOTD (описание)', type: 'text' },
    { key: 'server-port', label: 'Порт', type: 'number' },
    { key: 'gamemode', label: 'Режим игры', type: 'select', options: [['survival', 'Выживание'], ['creative', 'Творческий'], ['adventure', 'Приключение'], ['spectator', 'Наблюдатель']] },
    { key: 'difficulty', label: 'Сложность', type: 'select', options: [['peaceful', 'Мирная'], ['easy', 'Лёгкая'], ['normal', 'Нормальная'], ['hard', 'Сложная']] },
    { key: 'max-players', label: 'Макс. игроков', type: 'number' },
    { key: 'online-mode', label: 'Лицензия (online-mode)', type: 'bool' },
    { key: 'pvp', label: 'PVP', type: 'bool' },
    { key: 'hardcore', label: 'Хардкор', type: 'bool' },
    { key: 'white-list', label: 'Белый список', type: 'bool' },
    { key: 'view-distance', label: 'Дальность прорисовки', type: 'number' },
    { key: 'spawn-protection', label: 'Защита спавна (блоки)', type: 'number' },
    { key: 'enable-command-block', label: 'Командные блоки', type: 'bool' },
  ];

  async function loadSettings() {
    if (!state.currentId) return;
    try {
      const data = await API.properties(state.currentId);
      renderSettings(data);
    } catch (e) {
      showToast(e.message);
    }
  }

  function renderSettings(data) {
    const grid = $('#settings-known');
    grid.innerHTML = '';
    const properties = data.properties || {};
    const used = new Set();

    grid.appendChild(makeField('Имя сервера (в панели)', 'text', '__name', data.name || ''));

    const memWrap = document.createElement('div');
    memWrap.className = 'opt-card slider-block';
    const memLabel = document.createElement('span');
    memLabel.className = 'opt-label';
    const memVal = document.createElement('span');
    memVal.className = 'slider-val';
    memLabel.appendChild(document.createTextNode('Память: '));
    memLabel.appendChild(memVal);
    const memSlider = document.createElement('div');
    memSlider.className = 'mc-slider';
    memWrap.appendChild(memLabel);
    memWrap.appendChild(memSlider);
    grid.appendChild(memWrap);
    state.memSettingsSlider = mkSlider(memSlider, {
      min: 1024, max: state.maxMemMb, step: 512,
      value: parseInt(data.memoryMb, 10) || 2048,
      format: fmtMem, labelEl: memVal,
    });

    for (const field of KNOWN_FIELDS) {
      if (!(field.key in properties)) continue;
      used.add(field.key);
      grid.appendChild(makeField(field.label, field.type, field.key, properties[field.key], field.options));
    }

    const rest = Object.keys(properties)
      .filter((k) => !used.has(k))
      .sort()
      .map((k) => k + '=' + properties[k]);
    $('#settings-raw').value = rest.join('\n');
  }

  function makeField(label, type, key, value, options) {
    if (type === 'bool') {
      const row = document.createElement('div');
      row.className = 'opt-card toggle-row';
      row.dataset.propKey = key;
      const lbl = document.createElement('span');
      lbl.className = 'toggle-label';
      lbl.textContent = label;
      const toggle = document.createElement('div');
      toggle.className = 'mc-toggle';
      row.appendChild(lbl);
      row.appendChild(toggle);
      mkToggle(toggle, String(value) === 'true');
      row._getValue = () => (toggle.classList.contains('on') ? 'true' : 'false');
      return row;
    }

    const wrap = document.createElement('label');
    wrap.className = 'mc-label';
    wrap.dataset.propKey = key;
    wrap.appendChild(document.createTextNode(label));
    let input;
    if (type === 'select') {
      input = document.createElement('select');
      for (const [val, name] of options) {
        const opt = document.createElement('option');
        opt.value = val;
        opt.textContent = name;
        input.appendChild(opt);
      }
      input.value = String(value);
      if (input.selectedIndex < 0) input.selectedIndex = 0;
    } else {
      input = document.createElement('input');
      input.type = type;
      input.value = value;
    }
    input.className = 'fld';
    wrap.appendChild(input);
    wrap._getValue = () => input.value;
    return wrap;
  }

  async function saveSettings(event) {
    event.preventDefault();
    if (!state.currentId) return;

    const server = state.current || {};
    const isRunning = server.status === 'running' || server.status === 'starting';
    const ok = await confirmDialog(
      'Сохранить изменения настроек сервера «' + (server.name || '') + '»?' +
      (isRunning ? '\nСервер сейчас работает — изменения применятся после перезапуска.' : ''),
      { title: 'Сохранение настроек', yesText: 'Сохранить', danger: false }
    );
    if (!ok) return;

    const properties = {};
    let name = null;
    const memoryMb = state.memSettingsSlider ? state.memSettingsSlider.value : null;

    for (const el of $$('#settings-known [data-prop-key]')) {
      const key = el.dataset.propKey;
      const value = el._getValue ? el._getValue() : '';
      if (key === '__name') name = value;
      else properties[key] = value;
    }
    for (const rawLine of $('#settings-raw').value.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const i = line.indexOf('=');
      if (i <= 0) continue;
      properties[line.slice(0, i).trim()] = line.slice(i + 1);
    }

    await guard(async () => {
      state.current = await API.saveProperties(state.currentId, { properties, name, memoryMb });
      renderServerHead();
      showToast(isRunning
        ? 'Сохранено. Перезапустите сервер, чтобы применить изменения.'
        : 'Настройки сохранены.', 'ok');
      loadSettings();
      loadServers();
    });
  }

  // ---------- файлы ----------

  function joinPath(base, name) {
    return base ? base + '/' + name : name;
  }

  async function loadFiles() {
    if (!state.currentId) return;
    await guard(async () => {
      const data = await API.files(state.currentId, state.filesPath);
      renderFiles(data.entries || []);
    });
  }

  function renderFiles(entries) {
    $('#files-path').textContent =
      (state.rootPath ? state.rootPath + '\\' : '') + 'servers\\' + state.currentId +
      (state.filesPath ? '\\' + state.filesPath.replace(/\//g, '\\') : '');

    const crumbs = $('#files-crumbs');
    crumbs.innerHTML = '';
    const rootLink = document.createElement('a');
    rootLink.appendChild(picon('folder'));
    rootLink.appendChild(document.createTextNode(' корень'));
    rootLink.addEventListener('click', () => { state.filesPath = ''; loadFiles(); });
    crumbs.appendChild(rootLink);
    if (state.filesPath) {
      const parts = state.filesPath.split('/');
      let acc = '';
      for (let i = 0; i < parts.length; i++) {
        acc = joinPath(acc, parts[i]);
        const sep = document.createElement('span');
        sep.className = 'sep-ch';
        sep.textContent = '/';
        crumbs.appendChild(sep);
        if (i === parts.length - 1) {
          const cur = document.createElement('span');
          cur.className = 'cur';
          cur.textContent = parts[i];
          crumbs.appendChild(cur);
        } else {
          const link = document.createElement('a');
          link.textContent = parts[i];
          const target = acc;
          link.addEventListener('click', () => { state.filesPath = target; loadFiles(); });
          crumbs.appendChild(link);
        }
      }
    }

    const list = $('#files-list');
    list.innerHTML = '';
    if (!entries.length) {
      const empty = document.createElement('div');
      empty.className = 'files-empty';
      empty.textContent = 'Папка пуста';
      list.appendChild(empty);
      return;
    }
    for (const entry of entries) {
      const row = document.createElement('div');
      row.className = 'mc-row file-row';

      const ic = document.createElement('span');
      ic.className = 'file-ic';
      ic.appendChild(picon(entry.dir ? 'folder' : 'file', entry.dir ? 'var(--accent-bright)' : '#9fb0a4'));

      const nameEl = document.createElement('span');
      nameEl.className = 'file-name';
      nameEl.textContent = entry.name;

      const meta = document.createElement('span');
      meta.className = 'file-meta';
      meta.textContent = (entry.dir ? '' : fmtBytes(entry.size) + ' · ') +
        new Date(entry.mtime).toLocaleString('ru-RU');

      const actions = document.createElement('span');
      actions.className = 'file-actions';
      const mkBtn = (iconName, title, cls, handler) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'mc-btn sm ' + cls;
        b.title = title;
        b.appendChild(picon(iconName));
        b.addEventListener('click', (event) => { event.stopPropagation(); handler(); });
        return b;
      };
      actions.appendChild(mkBtn('edit', 'Переименовать', '', () => renameEntry(entry)));
      actions.appendChild(mkBtn('trash', 'Удалить', 'danger', () => deleteEntry(entry)));

      row.appendChild(ic);
      row.appendChild(nameEl);
      row.appendChild(meta);
      row.appendChild(actions);

      row.addEventListener('click', () => {
        if (entry.dir) {
          state.filesPath = joinPath(state.filesPath, entry.name);
          loadFiles();
        } else {
          openFileEditor(joinPath(state.filesPath, entry.name));
        }
      });
      list.appendChild(row);
    }
  }

  // ---------- редактор (CodeMirror с fallback на textarea) ----------

  function editorModeFor(path) {
    const ext = (path.split('.').pop() || '').toLowerCase();
    if (ext === 'json' || ext === 'mcmeta') return { name: 'javascript', json: true };
    if (ext === 'js') return 'javascript';
    if (ext === 'xml' || ext === 'html' || ext === 'svg') return 'xml';
    if (ext === 'yml' || ext === 'yaml') return 'yaml';
    if (['properties', 'cfg', 'conf', 'ini', 'toml', 'env', 'lang'].includes(ext)) return 'properties';
    return null;
  }

  function ensureEditor() {
    if (state.cm) return state.cm;
    if (!window.CodeMirror) return null;
    const cm = CodeMirror($('#editor-cm'), {
      value: '',
      theme: 'material-darker',
      lineNumbers: true,
      styleActiveLine: true,
      matchBrackets: true,
      autoCloseBrackets: true,
      indentUnit: 2,
      tabSize: 2,
      extraKeys: {
        'Ctrl-S': () => saveFileEditor(),
        'Ctrl-Space': 'autocomplete',
      },
    });
    // автоподсказки при вводе (anyword: tru -> true, если слово есть в файле)
    cm.on('inputRead', (instance, change) => {
      if (!change.text || !change.text[0]) return;
      if (!/[\w\-]/.test(change.text[0])) return;
      const token = instance.getTokenAt(instance.getCursor());
      const word = (token.string || '').replace(/[^\w\-]/g, '');
      if (word.length >= 2) {
        instance.showHint({ hint: CodeMirror.hint.anyword, completeSingle: false });
      }
    });
    state.cm = cm;
    return cm;
  }

  async function openFileEditor(relPath) {
    await guard(async () => {
      const data = await API.fileGet(state.currentId, relPath);
      if (data.binary) {
        showToast('Этот файл нельзя открыть в редакторе: ' + (data.reason || 'двоичный') + ' (' + fmtBytes(data.size) + ')');
        return;
      }
      state.editorPath = relPath;
      $('#editor-name').textContent = relPath;
      $('#files-browser').classList.add('hidden');
      $('#file-editor').classList.remove('hidden');

      const cm = ensureEditor();
      if (cm) {
        $('#editor-cm').classList.remove('hidden');
        $('#editor-text').classList.add('hidden');
        cm.setOption('mode', editorModeFor(relPath));
        cm.setValue(data.content);
        cm.clearHistory();
        setTimeout(() => { cm.refresh(); cm.focus(); }, 30);
      } else {
        $('#editor-cm').classList.add('hidden');
        const ta = $('#editor-text');
        ta.classList.remove('hidden');
        ta.value = data.content;
      }
    });
  }

  function closeFileEditor() {
    state.editorPath = null;
    $('#file-editor').classList.add('hidden');
    $('#files-browser').classList.remove('hidden');
    loadFiles();
  }

  async function saveFileEditor() {
    if (!state.editorPath) return;
    const ok = await confirmDialog('Сохранить изменения в файле «' + state.editorPath + '»?',
      { title: 'Сохранение файла', yesText: 'Сохранить', danger: false });
    if (!ok) return;
    const content = state.cm && !$('#editor-cm').classList.contains('hidden')
      ? state.cm.getValue()
      : $('#editor-text').value;
    await guard(async () => {
      await API.fileSave(state.currentId, state.editorPath, content);
      showToast('Файл сохранён.', 'ok');
    });
  }

  async function createEntry(type) {
    const title = type === 'dir' ? 'Имя новой папки' : 'Имя нового файла';
    const name = await promptDialog(title, '', type === 'dir' ? 'datapacks' : 'config.yml');
    if (!name) return;
    if (/[\\/]/.test(name)) { showToast('Имя не должно содержать / и \\'); return; }
    await guard(async () => {
      await API.filesCreate(state.currentId, joinPath(state.filesPath, name), type);
      showToast((type === 'dir' ? 'Папка' : 'Файл') + ' «' + name + '» создан(а).', 'ok');
      loadFiles();
    });
  }

  async function renameEntry(entry) {
    const newName = await promptDialog('Новое имя для «' + entry.name + '»', entry.name);
    if (!newName || newName === entry.name) return;
    if (/[\\/]/.test(newName)) { showToast('Имя не должно содержать / и \\'); return; }
    await guard(async () => {
      await API.filesRename(state.currentId,
        joinPath(state.filesPath, entry.name),
        joinPath(state.filesPath, newName));
      showToast('Переименовано.', 'ok');
      loadFiles();
    });
  }

  async function deleteEntry(entry) {
    const ok = await confirmDialog(
      'Удалить ' + (entry.dir ? 'папку' : 'файл') + ' «' + entry.name + '»?' +
      (entry.dir ? '\nВсё содержимое папки будет стёрто.' : '') + '\nЭто действие необратимо.',
      { title: 'Удаление' }
    );
    if (!ok) return;
    await guard(async () => {
      await API.fileDelete(state.currentId, joinPath(state.filesPath, entry.name));
      showToast('Удалено.', 'ok');
      loadFiles();
    });
  }

  async function uploadFile(file) {
    if (!file) return;
    await guard(async () => {
      await API.upload(state.currentId, joinPath(state.filesPath, file.name), file);
      showToast('Файл «' + file.name + '» загружен (' + fmtBytes(file.size) + ').', 'ok');
      loadFiles();
    });
  }

  // ---------- вкладки ----------

  function switchTab(tab) {
    state.currentTab = tab;
    $$('.mc-tab').forEach((btn) => btn.classList.toggle('sel', btn.dataset.tab === tab));
    $('#tab-console').classList.toggle('hidden', tab !== 'console');
    $('#tab-settings').classList.toggle('hidden', tab !== 'settings');
    $('#tab-files').classList.toggle('hidden', tab !== 'files');
    $('#tab-info').classList.toggle('hidden', tab !== 'info');
    if (tab === 'settings') loadSettings();
    if (tab === 'console') loadStats();
    if (tab === 'info') fetchPlayTimes();
    if (tab === 'files') {
      $('#file-editor').classList.add('hidden');
      $('#files-browser').classList.remove('hidden');
      loadFiles();
    }
  }

  // ---------- удаление сервера ----------

  async function deleteServer(id) {
    const server = state.servers.find((s) => s.id === id) || state.current;
    if (!server) return;
    const ok = await confirmDialog(
      'Удалить сервер «' + server.name + '»?\nБудут стёрты ВСЕ файлы, включая мир. Это действие необратимо.',
      { title: 'Удаление сервера' }
    );
    if (!ok) return;
    await guard(async () => {
      await API.remove(id);
      showToast('Сервер «' + server.name + '» удалён.', 'ok');
      if (state.currentId === id) {
        state.currentId = null;
        showScreen('list');
      }
      state.selectedId = null;
      await loadServers();
    });
  }

  // ---------- опрос ----------

  function startPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = setInterval(() => {
      if (state.screen === 'list') guard(loadServers);
      else if (state.screen === 'server') refreshServer();
    }, 2500);
  }

  // ---------- инициализация ----------

  function bind() {
    $('#btn-goto-create').addEventListener('click', () => {
      showScreen('create');
      suggestPort();
      loadVersions();
      if (state.memCreateSlider) state.memCreateSlider.refresh();
    });
    $('#btn-refresh').addEventListener('click', () => guard(loadServers));
    $('#btn-manage').addEventListener('click', () => state.selectedId && openServer(state.selectedId));
    $('#btn-delete').addEventListener('click', () => state.selectedId && deleteServer(state.selectedId));

    $('#create-form').addEventListener('submit', submitCreate);
    $('#btn-create-cancel').addEventListener('click', () => showScreen('list'));
    $('#core-select').addEventListener('change', loadVersions);
    $('#eula-row').addEventListener('click', (event) => {
      if (event.target.tagName !== 'A') $('#eula-check').classList.toggle('on');
    });

    $('#btn-back').addEventListener('click', () => {
      showScreen('list');
      guard(loadServers);
    });

    $$('.mc-tab').forEach((btn) => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

    $('#btn-start').addEventListener('click', () => guard(async () => {
      state.current = await API.start(state.currentId);
      renderServerHead();
    }));
    $('#btn-stop').addEventListener('click', async () => {
      const name = state.current ? state.current.name : '';
      const online = state.current && state.current.players.length;
      if (await confirmDialog('Остановить сервер «' + name + '»?' +
            (online ? '\nСейчас онлайн: ' + online + ' игрок(ов) — они будут отключены.' : ''),
            { title: 'Остановка сервера', yesText: 'Остановить' })) {
        guard(() => API.stop(state.currentId));
      }
    });
    $('#btn-restart').addEventListener('click', async () => {
      const name = state.current ? state.current.name : '';
      if (await confirmDialog('Перезапустить сервер «' + name + '»?',
            { title: 'Перезапуск', yesText: 'Перезапустить', danger: false })) {
        guard(() => API.restart(state.currentId));
      }
    });
    $('#btn-kill').addEventListener('click', async () => {
      const orphaned = state.current && state.current.status === 'orphaned';
      const text = orphaned
        ? 'Завершить процесс сервера, оставшийся от прошлого запуска панели? Несохранённые данные мира могут быть потеряны.'
        : 'Убить процесс сервера? Несохранённые данные мира могут быть потеряны.';
      if (await confirmDialog(text, { title: 'Принудительное завершение' })) {
        guard(() => API.kill(state.currentId));
      }
    });
    $('#btn-redownload').addEventListener('click', () => guard(async () => {
      state.current = await API.download(state.currentId);
      renderServerHead();
    }));

    $('#btn-send').addEventListener('click', sendCommand);
    const cmdInput = $('#command-input');
    cmdInput.addEventListener('keydown', onCommandKeydown);
    cmdInput.addEventListener('input', () => { state.sugIndex = -1; updateSuggest(); });
    cmdInput.addEventListener('blur', () => setTimeout(hideSuggest, 150));

    $('#settings-form').addEventListener('submit', saveSettings);
    $('#btn-delete-server').addEventListener('click', () => state.currentId && deleteServer(state.currentId));

    $('#btn-new-file').addEventListener('click', () => createEntry('file'));
    $('#btn-new-dir').addEventListener('click', () => createEntry('dir'));
    $('#btn-files-refresh').addEventListener('click', () => loadFiles());
    $('#btn-upload').addEventListener('click', () => $('#upload-input').click());
    $('#upload-input').addEventListener('change', (event) => {
      const file = event.target.files[0];
      event.target.value = '';
      uploadFile(file);
    });
    $('#btn-editor-save').addEventListener('click', saveFileEditor);
    $('#btn-editor-close').addEventListener('click', closeFileEditor);

    $('#inv-close').addEventListener('click', () => $('#inv-root').classList.add('hidden'));
    $('#inv-root').addEventListener('click', (event) => {
      if (event.target === $('#inv-root')) $('#inv-root').classList.add('hidden');
    });
  }

  applyIcons(document);
  initCycleButtons(document);
  mkToggle($('#toggle-online'), true);
  mkToggle($('#toggle-pvp'), true);
  state.memCreateSlider = mkSlider($('#mem-create'), {
    min: 1024, max: state.maxMemMb, step: 512, value: 2048,
    format: fmtMem, labelEl: $('#mem-create-val'),
  });

  bind();
  loadStatus();
  guard(loadServers);
  startPolling();

  // прямые ссылки: #create — мастер создания, #server=<id> — экран сервера
  if (location.hash === '#create') {
    showScreen('create');
    loadVersions();
    guard(loadServers).then(suggestPort);
  } else if (location.hash.startsWith('#server=')) {
    const rest = location.hash.slice(8);
    const parts = rest.split('/player/');
    const id = parts[0];
    guard(loadServers).then(() => {
      if (state.servers.some((s) => s.id === id)) {
        openServer(id);
        if (parts[1]) setTimeout(() => openInventory(decodeURIComponent(parts[1])), 400);
      }
    });
  }
})();
