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

  /* Иконки предметов «как в игре»:
     1) mc.nerothe.com — пре-рендеренные иконки инвентаря (блоки — изометрия),
        версия совпадает с версией сервера, с откатом к ближайшей доступной;
     2) плоские текстуры из InventivetalentDev/minecraft-assets той же версии;
     3) текстовое имя. */
  const ICON_RENDER_HOST = 'https://mc.nerothe.com/img/';
  const ICON_TEX_HOST = 'https://raw.githubusercontent.com/InventivetalentDev/minecraft-assets/';
  const ICON_VERSION_FALLBACKS = ['1.21.11', '1.21.4'];
  const iconBaseCache = new Map(); // версия сервера -> Promise<{render, tex}>

  function probeImage(url) {
    return new Promise((resolve) => {
      const im = new Image();
      im.onload = () => resolve(true);
      im.onerror = () => resolve(false);
      im.src = url;
    });
  }

  function resolveIconBases(version) {
    if (iconBaseCache.has(version)) return iconBaseCache.get(version);
    const promise = (async () => {
      const candidates = [version].concat(ICON_VERSION_FALLBACKS)
        .filter((v, i, arr) => v && arr.indexOf(v) === i);
      let render = null;
      let tex = null;
      for (const v of candidates) {
        if (await probeImage(ICON_RENDER_HOST + v + '/minecraft_stone.png')) {
          render = ICON_RENDER_HOST + v + '/';
          break;
        }
      }
      for (const v of candidates) {
        if (await probeImage(ICON_TEX_HOST + v + '/assets/minecraft/textures/item/diamond.png')) {
          tex = ICON_TEX_HOST + v + '/assets/minecraft/textures/';
          break;
        }
      }
      if (!tex) tex = ICON_TEX_HOST + '1.21.4/assets/minecraft/textures/';
      return { render, tex };
    })();
    iconBaseCache.set(version, promise);
    return promise;
  }

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
    me: null,            // текущий пользователь {username, admin, perms}
    permissions: [],     // список всех прав (из бэкенда)
    openMode: true,      // нет пользователей — полный доступ
    editUser: null,      // редактируемый пользователь (null — режим создания)
    logName: null,       // выбранный лог-файл
    logContent: '',      // загруженный текст лога
    logTimer: null,      // таймер live-обновления логов
    customCoreFile: null, // выбранный пользователем jar для своего ядра
  };

  // ---------- права ----------

  function can(perm) {
    const m = state.me;
    if (!m) return true; // ещё не загрузили — не блокируем заранее
    if (m.admin || (m.perms && m.perms.admin)) return true;
    return !!(m.perms && m.perms[perm]);
  }

  function canAny(perms) {
    return perms.some((p) => can(p));
  }

  function accountLabel() {
    if (state.openMode || !state.me || !state.me.username) return 'Локальный режим';
    return state.me.username + (state.me.admin ? ' · админ' : '');
  }

  async function loadMe() {
    try {
      const data = await API.me();
      state.me = data.user;
      state.permissions = data.permissions || [];
      state.openMode = !!data.openMode;
      applyPermissions();
    } catch (e) { /* при 401 клиент сам уведёт на /login */ }
  }

  /* Прячем вкладки/кнопки/пункты меню, недоступные пользователю. */
  function applyPermissions() {
    const isAdmin = state.me && (state.me.admin || (state.me.perms && state.me.perms.admin));
    // текущий аккаунт — в меню и на главной
    const accName = $('#menu-account-name'); if (accName) accName.textContent = accountLabel();
    const homeAcc = $('#home-account');
    if (homeAcc) {
      homeAcc.innerHTML = '';
      homeAcc.appendChild(picon('user'));
      const t = document.createElement('span');
      t.textContent = 'Вы вошли как: ' + accountLabel();
      homeAcc.appendChild(t);
    }
    // пункт «Пользователи» — админу или в открытом режиме (создать первого)
    $('#menu-users').classList.toggle('hidden', !(isAdmin || state.openMode));
    // «Выйти» — только когда есть вход
    $('#menu-logout').classList.toggle('hidden', state.openMode);
    // создание сервера
    $('#btn-goto-create').classList.toggle('hidden', !can('server.create'));
    // вкладки сервера (по любому из соответствующих прав)
    const tabPerm = {
      console: ['console.view'],
      settings: ['settings.edit'],
      files: ['files.read'],
      players: ['players.kick', 'players.ban', 'players.whitelist', 'players.delete'],
      logs: ['console.view'],
      backups: ['backups.create', 'backups.restore', 'backups.delete'],
    };
    $$('.mc-tab').forEach((btn) => {
      const p = tabPerm[btn.dataset.tab];
      btn.classList.toggle('hidden', p ? !canAny(p) : false);
    });
    // файловый тулбар по правам
    const fb = (sel, ok) => { const el = $(sel); if (el) el.classList.toggle('perm-hidden', !ok); };
    fb('#btn-new-file', can('files.write'));
    fb('#btn-new-dir', can('files.write'));
    fb('#btn-upload', can('files.upload'));
    // кнопки питания — каждая по своему праву
    const toggleBtn = (sel, perm) => { const el = $(sel); if (el) el.classList.toggle('perm-hidden', !can(perm)); };
    toggleBtn('#btn-start', 'server.start');
    toggleBtn('#btn-restart', 'server.stop');
    toggleBtn('#btn-stop', 'server.stop');
    toggleBtn('#btn-kill', 'server.kill');
    toggleBtn('#btn-redownload', 'server.install');
    const noCmd = !can('console.command');
    ['#command-input', '#btn-send'].forEach((s) => { const el = $(s); if (el) el.classList.toggle('perm-hidden', noCmd); });
    // создание бэкапа
    const bk = $('#bk-create-btn'); if (bk) bk.classList.toggle('perm-hidden', !can('backups.create'));
    const bkLabel = $('#bk-label'); if (bkLabel) bkLabel.classList.toggle('perm-hidden', !can('backups.create'));
  }

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

  // ---------- настройки панели (тема, масштаб и т.д.) ----------

  const APPSET_KEY = 'controlgui-settings';
  const APPSET_DEFAULTS = { theme: 'theme-lime', scale: 100, bgAnim: true, graphs: true };

  function loadAppSettings() {
    try { return Object.assign({}, APPSET_DEFAULTS, JSON.parse(localStorage.getItem(APPSET_KEY)) || {}); }
    catch (e) { return Object.assign({}, APPSET_DEFAULTS); }
  }

  function saveAppSettings(settings) {
    try { localStorage.setItem(APPSET_KEY, JSON.stringify(settings)); } catch (e) { /* приватный режим */ }
  }

  function applyAppSettings(settings) {
    document.body.classList.remove('theme-lime', 'theme-blue');
    document.body.classList.add(settings.theme === 'theme-blue' ? 'theme-blue' : 'theme-lime');
    document.body.style.zoom = settings.scale === 100 ? '' : settings.scale + '%';
    document.body.classList.toggle('no-bganim', settings.bgAnim === false);
    document.body.classList.toggle('hide-graphs', settings.graphs === false);
  }

  let appSettings = loadAppSettings();
  let scaleSlider = null;

  function changeAppSettings(patch) {
    appSettings = Object.assign({}, appSettings, patch);
    saveAppSettings(appSettings);
    applyAppSettings(appSettings);
  }

  function openAppSettings() {
    $('#set-theme').value = appSettings.theme;
    if (!scaleSlider) {
      scaleSlider = mkSlider($('#set-scale'), {
        min: 80, max: 140, step: 5, value: appSettings.scale,
        format: (v) => v + '%', labelEl: $('#set-scale-val'),
      });
      // применяем масштаб по отпусканию ползунка
      $('#set-scale').addEventListener('pointerup', () => changeAppSettings({ scale: scaleSlider.value }));
    } else {
      scaleSlider.set(appSettings.scale);
    }
    $('#set-bganim').classList.toggle('on', appSettings.bgAnim !== false);
    $('#set-graphs').classList.toggle('on', appSettings.graphs !== false);
    $('#appset-root').classList.remove('hidden');
    setTimeout(() => scaleSlider.refresh(), 30);
  }

  // ---------- экраны ----------

  function showScreen(name) {
    state.screen = name;
    $('#screen-list').classList.toggle('hidden', name !== 'list');
    $('#screen-create').classList.toggle('hidden', name !== 'create');
    $('#screen-server').classList.toggle('hidden', name !== 'server');
    $('#screen-users').classList.toggle('hidden', name !== 'users');
    // бургер-меню — на главном и экране пользователей
    $('#btn-burger').classList.toggle('hidden', !(name === 'list' || name === 'users'));
    $('#app-menu').classList.remove('open');
    $('#app-scrim').classList.remove('open');
    $('#burger-ic').classList.remove('open');
    if (name !== 'server' && state.sse) {
      state.sse.close();
      state.sse = null;
    }
    // адрес отражает экран — после F5 возвращаемся туда же
    if (name === 'list') history.replaceState(null, '', location.pathname);
    else if (name === 'create') history.replaceState(null, '', '#create');
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
      $('#about-version').textContent = String(st.app || '').replace('CONTROLGUI', '').trim();
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

  function statusDotClass(status) {
    if (status === 'running') return ' on';
    if (status === 'starting' || status === 'stopping' || status === 'orphaned') return ' warn';
    if (status === 'error' || status === 'no-jar') return ' err';
    if (status === 'downloading') return ' dl';
    return '';
  }

  function renderHomeStats() {
    const box = $('#home-stats');
    box.innerHTML = '';
    const running = state.servers.filter((s) => s.status === 'running').length;
    const players = state.servers.reduce((sum, s) => sum + s.players.length, 0);
    const chip = (icon, html) => {
      const el = document.createElement('span');
      el.className = 'stat-chip';
      el.appendChild(picon(icon));
      const span = document.createElement('span');
      span.innerHTML = html;
      el.appendChild(span);
      box.appendChild(el);
    };
    chip('server', 'Серверов: <b>' + state.servers.length + '</b>');
    chip('zap', 'Работает: <b>' + running + '</b>');
    chip('users', 'Игроков онлайн: <b>' + players + '</b>');
  }

  function renderList() {
    const panel = $('#server-list');
    Array.from(panel.querySelectorAll('.srv-card')).forEach((el) => el.remove());
    $('#list-empty').classList.toggle('hidden', state.servers.length > 0);
    panel.classList.toggle('column', state.servers.length > 4);
    renderHomeStats();

    for (const server of state.servers) {
      const card = document.createElement('div');
      card.className = 'srv-card';

      const top = document.createElement('div');
      top.className = 'srv-card-top';
      const icon = document.createElement('img');
      icon.className = 'server-icon';
      icon.src = iconFor(server.id);
      icon.alt = '';
      const id = document.createElement('div');
      id.className = 'srv-card-id';
      const nameEl = document.createElement('div');
      nameEl.className = 'srv-card-name';
      nameEl.textContent = server.name;
      const subEl = document.createElement('div');
      subEl.className = 'srv-card-sub';
      subEl.textContent = (CORE_NAMES[server.type] || server.type) + ' ' + (server.version || '–');
      id.appendChild(nameEl);
      id.appendChild(subEl);
      top.appendChild(icon);
      top.appendChild(id);

      // адрес для подключения + копирование
      const addrRow = document.createElement('div');
      addrRow.className = 'srv-card-addr';
      const host = (state.lanIps && state.lanIps.length ? state.lanIps[0] : 'localhost');
      const address = host + ':' + server.port;
      const code = document.createElement('code');
      code.textContent = address;
      addrRow.appendChild(code);
      const copyBtn = document.createElement('button');
      copyBtn.className = 'mc-btn sm copy-btn';
      copyBtn.title = 'Скопировать адрес';
      copyBtn.appendChild(picon('copy'));
      copyBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        if (navigator.clipboard) navigator.clipboard.writeText(address);
        const old = copyBtn.querySelector('.pi');
        copyBtn.replaceChild(picon('check'), old);
        showToast('Адрес скопирован: ' + address, 'ok');
        setTimeout(() => { const c = copyBtn.querySelector('.pi'); if (c) copyBtn.replaceChild(picon('copy'), c); }, 1200);
      });
      addrRow.appendChild(copyBtn);

      const line = document.createElement('div');
      line.className = 'srv-card-line';
      const st = document.createElement('span');
      st.className = 'st-' + server.status;
      const dot = document.createElement('span');
      dot.className = 'status-dot' + statusDotClass(server.status);
      st.appendChild(dot);
      st.appendChild(document.createTextNode(statusText(server)));
      const right = document.createElement('span');
      right.className = 'right';
      right.textContent = server.status === 'running' ? 'Игроки: ' + server.players.length : '';
      line.appendChild(st);
      line.appendChild(right);

      const actions = document.createElement('div');
      actions.className = 'srv-card-actions';
      const processAlive = ['starting', 'running', 'stopping'].includes(server.status);
      const power = document.createElement('button');
      power.className = 'mc-btn sm ' + (processAlive ? '' : 'primary');
      power.appendChild(picon(processAlive ? 'pause' : 'play'));
      power.appendChild(document.createTextNode(processAlive ? ' Остановить' : ' Запустить'));
      power.disabled = !processAlive && (!server.jarReady || server.status === 'downloading' || server.status === 'orphaned');
      power.addEventListener('click', async (event) => {
        event.stopPropagation();
        if (processAlive) {
          if (await confirmDialog('Остановить сервер «' + server.name + '»?' +
                (server.players.length ? '\nОнлайн: ' + server.players.length + ' игрок(ов).' : ''),
                { title: 'Остановка сервера', yesText: 'Остановить' })) {
            await guard(() => API.stop(server.id));
            guard(loadServers);
          }
        } else {
          await guard(() => API.start(server.id));
          guard(loadServers);
        }
      });
      const open = document.createElement('button');
      open.className = 'mc-btn sm';
      open.appendChild(picon('arrow-right'));
      open.appendChild(document.createTextNode(' Открыть'));
      open.addEventListener('click', (event) => { event.stopPropagation(); openServer(server.id); });
      actions.appendChild(power);
      actions.appendChild(open);

      card.appendChild(top);
      card.appendChild(addrRow);
      card.appendChild(line);
      card.appendChild(actions);
      card.addEventListener('click', () => openServer(server.id));
      panel.appendChild(card);
    }
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
    if (type === 'custom') return; // у своего ядра версии не из репозитория
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
    const type = $('#core-select').value;
    const isCustom = type === 'custom';
    const coreFile = $('#custom-core-file').files[0];
    const body = {
      name: form.name.value,
      motd: form.motd.value,
      type: type,
      version: isCustom ? '-' : form.version.value,
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
    if (isCustom && !coreFile) { showToast('Выберите файл ядра (.jar)'); return; }
    if (!isCustom && !body.version) { showToast('Выберите версию'); return; }
    $('#btn-create').disabled = true;
    try {
      const created = await API.create(body);
      if (isCustom) {
        showToast('Сервер создан, загружаю ваше ядро…', 'ok');
        await API.coreUpload(created.id, coreFile);
        showToast('Своё ядро загружено.', 'ok');
      } else {
        showToast('Сервер «' + created.name + '» создан, устанавливаю ядро...', 'ok');
      }
      form.reset();
      $('#custom-core-file').value = '';
      onCoreChange();
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

  function firstAllowedTab() {
    const order = [
      ['console', () => can('console.view')], ['settings', () => can('settings.edit')],
      ['files', () => can('files.read')],
      ['players', () => canAny(['players.kick', 'players.ban', 'players.whitelist', 'players.delete'])],
      ['logs', () => can('console.view')],
      ['backups', () => canAny(['backups.create', 'backups.restore', 'backups.delete'])],
      ['info', () => true],
    ];
    for (const [tab, ok] of order) { if (ok()) return tab; }
    return 'info';
  }

  function openServer(id) {
    state.currentId = id;
    state.current = state.servers.find((s) => s.id === id) || null;
    state.filesPath = '';
    state.editorPath = null;
    state.playTimes = {};
    showScreen('server');
    applyPermissions();
    switchTab(firstAllowedTab());
    renderServerHead();
    if (can('console.view')) connectConsole(id);
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
    applyPermissions();
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
      ['#stat-cpu', '#stat-ram', '#stat-read', '#stat-write', '#stat-players'].forEach((id) => { $(id).textContent = '—'; });
      ['#graph-cpu', '#graph-ram', '#graph-read', '#graph-write', '#graph-players'].forEach((id) => sparkline(id, [], 1));
      return;
    }
    try {
      const data = await API.stats(state.currentId);
      const pts = data.points || [];
      const last = pts[pts.length - 1];
      const online = server.players.length;
      $('#stat-players').textContent = online + (state.maxPlayers ? ' / ' + state.maxPlayers : '');
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
      sparkline('#graph-players', pts.map((p) => p.players || 0), Math.max(state.maxPlayers || 0, 5));
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
    const bannedSet = new Set((server.banned || []).map((n) => n.toLowerCase()));
    // забаненные, которых нет в списке — показываем, чтобы можно было разбанить
    for (const bn of server.banned || []) {
      if (!players.some((p) => p.name.toLowerCase() === bn.toLowerCase())) {
        players.push({ name: bn, uuid: null, ip: null, online: false, joinedAt: null, lastSeen: null, advancements: 0 });
      }
    }
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
      const banned = bannedSet.has(p.name.toLowerCase());
      const nameEl = document.createElement('div');
      nameEl.className = 'player-name';
      const dot = document.createElement('span');
      dot.className = 'dot' + (p.online ? ' on' : '');
      dot.title = p.online ? 'В сети' : 'Не в сети';
      nameEl.appendChild(dot);
      nameEl.appendChild(document.createTextNode(p.name));
      if (banned) {
        const badge = document.createElement('span');
        badge.className = 'pl-banned';
        badge.textContent = 'ЗАБАНЕН';
        nameEl.appendChild(badge);
      }
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

      const running = server.status === 'running';
      const actions = document.createElement('div');
      actions.className = 'player-actions';

      const invBtn = document.createElement('button');
      invBtn.className = 'mc-btn sm';
      invBtn.appendChild(picon('info-box'));
      invBtn.appendChild(document.createTextNode(' Информация'));
      invBtn.addEventListener('click', () => openInventory(p.name));
      actions.appendChild(invBtn);

      if (can('players.kick')) {
        const kickBtn = document.createElement('button');
        kickBtn.className = 'mc-btn sm';
        kickBtn.appendChild(picon('close'));
        kickBtn.appendChild(document.createTextNode(' Кик'));
        kickBtn.disabled = !(p.online && running);
        kickBtn.title = kickBtn.disabled ? 'Игрок не в сети' : 'Выгнать с сервера';
        kickBtn.addEventListener('click', async () => {
          if (await confirmDialog('Кикнуть игрока «' + p.name + '»?', { title: 'Кик', yesText: 'Кикнуть' })) {
            await guard(() => API.moderate(state.currentId, 'kick', p.name));
            showToast('Игрок «' + p.name + '» кикнут.', 'ok');
            setTimeout(refreshServer, 800);
          }
        });
        actions.appendChild(kickBtn);
      }

      if (can('players.ban')) {
        if (banned) {
          const pardonBtn = document.createElement('button');
          pardonBtn.className = 'mc-btn sm primary';
          pardonBtn.appendChild(picon('check'));
          pardonBtn.appendChild(document.createTextNode(' Разбан'));
          pardonBtn.addEventListener('click', async () => {
            if (await confirmDialog('Разбанить игрока «' + p.name + '»?', { title: 'Разбан', yesText: 'Разбанить', danger: false })) {
              await guard(() => API.moderate(state.currentId, 'pardon', p.name));
              showToast('Игрок «' + p.name + '» разбанен.', 'ok');
              setTimeout(refreshServer, 800);
            }
          });
          actions.appendChild(pardonBtn);
        } else {
          const banBtn = document.createElement('button');
          banBtn.className = 'mc-btn sm danger';
          banBtn.appendChild(picon('close-box'));
          banBtn.appendChild(document.createTextNode(' Бан'));
          banBtn.addEventListener('click', async () => {
            if (await confirmDialog('Забанить игрока «' + p.name + '»?\nОн не сможет зайти, пока не разбанят.', { title: 'Бан' })) {
              await guard(() => API.moderate(state.currentId, 'ban', p.name));
              showToast('Игрок «' + p.name + '» забанен.', 'ok');
              setTimeout(refreshServer, 800);
            }
          });
          actions.appendChild(banBtn);
        }
      }

      const delBtn = can('players.delete') ? document.createElement('button') : null;
      if (delBtn) {
      delBtn.className = 'mc-btn sm danger';
      delBtn.appendChild(picon('trash'));
      delBtn.disabled = p.online;
      delBtn.title = p.online ? 'Игрок в сети — сначала кикните' : 'Стереть все данные игрока';
      delBtn.addEventListener('click', async () => {
        if (await confirmDialog('Стереть ВСЕ данные игрока «' + p.name + '»?\nИнвентарь, позиция, статистика, достижения и история входов будут удалены безвозвратно.', { title: 'Удаление данных игрока' })) {
          await guard(async () => {
            await API.playerDelete(state.currentId, p.name);
            showToast('Данные игрока «' + p.name + '» стёрты.', 'ok');
            delete state.playTimes[p.name];
            setTimeout(refreshServer, 400);
          });
        }
      });
      actions.appendChild(delBtn);
      }

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
    if (state.currentTab === 'players') renderPlayers(server);
  }

  // ---------- инвентарь (широкая раскладка, иконки предметов) ----------

  const ARMOR_SLOTS = [[103, 'Шлем'], [102, 'Нагрудник'], [101, 'Поножи'], [100, 'Ботинки'], [-106, 'Левая рука']];

  function invCell(item, label, bases) {
    const cell = document.createElement('div');
    cell.className = 'inv-cell' + (item ? '' : ' empty');
    if (item) {
      cell.title = item.id.replace(/_/g, ' ') + (item.count > 1 ? ' ×' + item.count : '');
      const img = document.createElement('img');
      img.className = 'it-img';
      img.alt = '';
      img.loading = 'lazy';
      // основной источник — игровой рендер нужной версии; затем плоские
      // текстуры (и грани составных блоков); в самом конце — текст
      const candidates = [];
      if (bases && bases.render) candidates.push(bases.render + 'minecraft_' + item.id + '.png');
      const tex = (bases && bases.tex) || (ICON_TEX_HOST + '1.21.4/assets/minecraft/textures/');
      candidates.push(
        tex + 'item/' + item.id + '.png',
        tex + 'block/' + item.id + '.png',
        tex + 'block/' + item.id + '_front.png',
        tex + 'block/' + item.id + '_top.png',
        tex + 'block/' + item.id + '_side.png'
      );
      let attempt = 0;
      img.src = candidates[attempt];
      img.onerror = () => {
        attempt++;
        if (attempt < candidates.length) {
          img.src = candidates[attempt];
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

  function closeInventory() {
    $('#inv-root').classList.add('hidden');
    if (state.invTimer) { clearInterval(state.invTimer); state.invTimer = null; }
    state.invSnapshot = null;
  }

  /* снимок значимых данных: модалка перерисовывается ТОЛЬКО при изменении
     (lastPlayed/время сессии в снимок не входят — они меняются всегда) */
  function playerSnapshot(d) {
    return JSON.stringify({
      online: d.online, realtime: d.realtime, hp: d.health, food: d.food,
      xp: d.xpLevel, pos: d.pos, dim: d.dimension, inv: d.inventory,
      time: d.playTimeTicks, fj: d.firstJoinAt, lj: d.lastJoinAt, ips: d.ips, uuid: d.uuid,
    });
  }

  async function openInventory(name) {
    if (state.invTimer) { clearInterval(state.invTimer); state.invTimer = null; }
    await guard(async () => {
      const data = await API.player(state.currentId, name);
      const bases = await resolveIconBases(state.current ? state.current.version : '');
      buildPlayerModal(name, data, bases);
      state.invSnapshot = playerSnapshot(data);
      $('#inv-root').classList.remove('hidden');
      // онлайн-игрок: тихо опрашиваем, но DOM трогаем только при изменениях
      if (data.online) {
        state.invTimer = setInterval(async () => {
          if ($('#inv-root').classList.contains('hidden')) { closeInventory(); return; }
          try {
            const fresh = await API.player(state.currentId, name);
            const snap = playerSnapshot(fresh);
            if (snap !== state.invSnapshot) {
              state.invSnapshot = snap;
              buildPlayerModal(name, fresh, bases);
            }
          } catch (e) { /* пропускаем такт */ }
        }, 3000);
      }
    });
  }

  function buildPlayerModal(name, data, bases) {
    {
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
      metaRow(meta, 'check', 'Статус', data.online
        ? (data.realtime ? 'В сети · реальное время' : 'В сети')
        : 'Не в сети');
      metaRow(meta, 'clock', 'Всего в игре', data.playTimeTicks != null ? fmtTicks(data.playTimeTicks) : 'нет данных');
      if (data.firstJoinAt) metaRow(meta, 'clock', 'Первый вход', new Date(data.firstJoinAt).toLocaleString('ru-RU'));
      if (data.lastJoinAt) metaRow(meta, 'clock', 'Последний вход', new Date(data.lastJoinAt).toLocaleString('ru-RU'));
      if (data.ips && data.ips.length) metaRow(meta, 'server', 'IP-адреса', data.ips.join(', '));
      if (!data.realtime && data.lastPlayed) metaRow(meta, 'save', 'Сохранение', new Date(data.lastPlayed).toLocaleString('ru-RU'));
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
        for (const [slot, label] of ARMOR_SLOTS) armorGrid.appendChild(invCell(bySlot.get(slot), label, bases));
        main.appendChild(armorGrid);

        main.appendChild(mkSec('folder', 'Инвентарь'));
        const mainGrid = document.createElement('div');
        mainGrid.className = 'inv-grid';
        for (let slot = 9; slot <= 35; slot++) mainGrid.appendChild(invCell(bySlot.get(slot), null, bases));
        main.appendChild(mainGrid);

        main.appendChild(mkSec('command', 'Хотбар'));
        const hotGrid = document.createElement('div');
        hotGrid.className = 'inv-grid';
        for (let slot = 0; slot <= 8; slot++) hotGrid.appendChild(invCell(bySlot.get(slot), null, bases));
        main.appendChild(hotGrid);

        const hint = document.createElement('div');
        hint.className = 'inv-empty-note';
        hint.textContent = data.realtime
          ? 'Данные в реальном времени — обновляются каждые 3 секунды.'
          : 'Данные из сохранения мира — для игрока в сети обновляются при автосохранении.';
        main.appendChild(hint);
      }

      flex.appendChild(side);
      flex.appendChild(main);
      body.appendChild(flex);

      if (data.playTimeTicks != null) state.playTimes[name] = data.playTimeTicks;
    }
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

  /* Переводы и типы всех штатных ключей server.properties.
     Неизвестные ключи получают тип автоматически (true/false -> свитч,
     число -> числовое поле, иначе текст). */
  const PROPERTY_DEFS = {
    'motd': { label: 'MOTD (описание в списке)', type: 'text' },
    'server-port': { label: 'Порт сервера', type: 'number' },
    'gamemode': { label: 'Режим игры', type: 'select', options: [['survival', 'Выживание'], ['creative', 'Творческий'], ['adventure', 'Приключение'], ['spectator', 'Наблюдатель']] },
    'difficulty': { label: 'Сложность', type: 'select', options: [['peaceful', 'Мирная'], ['easy', 'Лёгкая'], ['normal', 'Нормальная'], ['hard', 'Сложная']] },
    'max-players': { label: 'Максимум игроков', type: 'number' },
    'online-mode': { label: 'Лицензия (online-mode)', type: 'bool' },
    'pvp': { label: 'PVP', type: 'bool' },
    'hardcore': { label: 'Хардкор', type: 'bool' },
    'white-list': { label: 'Белый список', type: 'bool' },
    'enforce-whitelist': { label: 'Принудительный белый список', type: 'bool' },
    'view-distance': { label: 'Дальность прорисовки, чанки', type: 'number' },
    'simulation-distance': { label: 'Дистанция симуляции, чанки', type: 'number' },
    'spawn-protection': { label: 'Защита спавна, блоки', type: 'number' },
    'enable-command-block': { label: 'Командные блоки', type: 'bool' },
    'allow-flight': { label: 'Разрешить полёт', type: 'bool' },
    'allow-nether': { label: 'Нижний мир (Незер)', type: 'bool' },
    'accepts-transfers': { label: 'Приём transfer-подключений', type: 'bool' },
    'broadcast-console-to-ops': { label: 'Вывод консоли операторам', type: 'bool' },
    'broadcast-rcon-to-ops': { label: 'Вывод RCON операторам', type: 'bool' },
    'bug-report-link': { label: 'Ссылка для баг-репортов', type: 'text' },
    'enable-jmx-monitoring': { label: 'JMX-мониторинг', type: 'bool' },
    'enable-query': { label: 'Query-протокол (статистика)', type: 'bool' },
    'enable-rcon': { label: 'RCON (удалённая консоль)', type: 'bool' },
    'enable-status': { label: 'Показывать статус в списке серверов', type: 'bool' },
    'enforce-secure-profile': { label: 'Требовать подписанный профиль', type: 'bool' },
    'entity-broadcast-range-percentage': { label: 'Дальность видимости сущностей, %', type: 'number' },
    'force-gamemode': { label: 'Принудительный режим игры', type: 'bool' },
    'function-permission-level': { label: 'Уровень прав функций (1–4)', type: 'number' },
    'generate-structures': { label: 'Генерация структур', type: 'bool' },
    'generator-settings': { label: 'Настройки генератора (JSON)', type: 'text' },
    'hide-online-players': { label: 'Скрывать список игроков', type: 'bool' },
    'initial-disabled-packs': { label: 'Отключённые датапаки', type: 'text' },
    'initial-enabled-packs': { label: 'Включённые датапаки', type: 'text' },
    'level-name': { label: 'Имя папки мира', type: 'text' },
    'level-seed': { label: 'Сид мира', type: 'text' },
    'level-type': { label: 'Тип мира', type: 'text' },
    'log-ips': { label: 'Логировать IP игроков', type: 'bool' },
    'max-chained-neighbor-updates': { label: 'Лимит цепочек обновлений', type: 'number' },
    'max-tick-time': { label: 'Макс. время тика, мс (−1 — выкл)', type: 'number' },
    'max-world-size': { label: 'Макс. радиус мира, блоки', type: 'number' },
    'network-compression-threshold': { label: 'Порог сжатия пакетов, байт', type: 'number' },
    'op-permission-level': { label: 'Уровень прав операторов (1–4)', type: 'number' },
    'pause-when-empty-seconds': { label: 'Пауза мира без игроков, сек', type: 'number' },
    'player-idle-timeout': { label: 'Кик AFK, минут (0 — выкл)', type: 'number' },
    'prevent-proxy-connections': { label: 'Блокировать прокси-подключения', type: 'bool' },
    'query.port': { label: 'Порт Query', type: 'number' },
    'rate-limit': { label: 'Лимит пакетов (0 — выкл)', type: 'number' },
    'rcon.password': { label: 'Пароль RCON', type: 'text' },
    'rcon.port': { label: 'Порт RCON', type: 'number' },
    'region-file-compression': { label: 'Сжатие файлов регионов', type: 'text' },
    'require-resource-pack': { label: 'Обязательный ресурспак', type: 'bool' },
    'resource-pack': { label: 'Ссылка на ресурспак', type: 'text' },
    'resource-pack-id': { label: 'UUID ресурспака', type: 'text' },
    'resource-pack-prompt': { label: 'Текст запроса ресурспака', type: 'text' },
    'resource-pack-sha1': { label: 'SHA1 ресурспака', type: 'text' },
    'server-ip': { label: 'IP для привязки (пусто — все)', type: 'text' },
    'spawn-monsters': { label: 'Спавн монстров', type: 'bool' },
    'spawn-animals': { label: 'Спавн животных', type: 'bool' },
    'spawn-npcs': { label: 'Спавн жителей', type: 'bool' },
    'status-heartbeat-interval': { label: 'Интервал heartbeat, сек', type: 'number' },
    'sync-chunk-writes': { label: 'Синхронная запись чанков', type: 'bool' },
    'text-filtering-config': { label: 'Конфиг фильтра чата', type: 'text' },
    'text-filtering-version': { label: 'Версия фильтра чата', type: 'number' },
    'use-native-transport': { label: 'Нативный транспорт (Linux)', type: 'bool' },
  };

  function autoDef(key, value) {
    if (value === 'true' || value === 'false') return { label: key, type: 'bool' };
    if (/^-?\d+$/.test(value)) return { label: key, type: 'number' };
    return { label: key, type: 'text' };
  }

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
    state.maxPlayers = parseInt(properties['max-players'], 10) || null;

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

    // известные ключи в порядке словаря, затем остальные по алфавиту
    const knownKeys = Object.keys(PROPERTY_DEFS).filter((k) => k in properties);
    const unknownKeys = Object.keys(properties).filter((k) => !(k in PROPERTY_DEFS)).sort();
    for (const key of knownKeys.concat(unknownKeys)) {
      const def = PROPERTY_DEFS[key] || autoDef(key, properties[key]);
      const field = makeField(def.label, def.type, key, properties[key], def.options);
      field.title = key + '=' + properties[key];
      grid.appendChild(field);
    }

    // белый список: показать карточку и повесить реакцию на свитч
    const wlRow = grid.querySelector('[data-prop-key="white-list"]');
    if (wlRow) wlRow.addEventListener('click', () => setTimeout(updateWlVisibility, 0));
    updateWlVisibility();
  }

  // ---------- белый список ----------

  function updateWlVisibility() {
    const row = $('#settings-known [data-prop-key="white-list"]');
    const on = row && row._getValue && row._getValue() === 'true';
    $('#wl-card').classList.toggle('hidden', !on);
    if (on) guard(loadWhitelist);
  }

  async function loadWhitelist() {
    if (!state.currentId) return;
    const data = await API.whitelist(state.currentId);
    const chips = $('#wl-chips');
    chips.innerHTML = '';
    if (!data.entries.length) {
      const empty = document.createElement('span');
      empty.className = 'label-dim';
      empty.textContent = 'Список пуст — добавьте первый ник.';
      chips.appendChild(empty);
      return;
    }
    for (const name of data.entries) {
      const chip = document.createElement('span');
      chip.className = 'wl-chip';
      const img = document.createElement('img');
      img.src = 'https://mc-heads.net/avatar/' + encodeURIComponent(name) + '/16';
      img.alt = '';
      img.onerror = () => img.remove();
      chip.appendChild(img);
      chip.appendChild(document.createTextNode(name));
      const x = picon('close');
      x.title = 'Убрать из белого списка';
      x.addEventListener('click', async () => {
        if (await confirmDialog('Убрать «' + name + '» из белого списка?', { title: 'Белый список', yesText: 'Убрать' })) {
          await guard(async () => {
            await API.whitelistChange(state.currentId, 'remove', name);
            setTimeout(() => guard(loadWhitelist), 600);
          });
        }
      });
      chip.appendChild(x);
      chips.appendChild(chip);
    }
  }

  async function addToWhitelist() {
    const input = $('#wl-input');
    const name = input.value.trim();
    if (!name) return;
    await guard(async () => {
      const res = await API.whitelistChange(state.currentId, 'add', name);
      showToast(res.via === 'command'
        ? 'Команда whitelist add отправлена серверу.'
        : '«' + name + '» добавлен в whitelist.json.', 'ok');
      input.value = '';
      setTimeout(() => guard(loadWhitelist), 600);
    });
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
      if (can('files.write')) actions.appendChild(mkBtn('edit', 'Переименовать', '', () => renameEntry(entry)));
      if (can('files.delete')) actions.appendChild(mkBtn('trash', 'Удалить', 'danger', () => deleteEntry(entry)));

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

  /* Скользящая черта под активной вкладкой. Ведущий край движется быстрее
     (раздельные транзишены left/right с задержкой) — полоска растягивается
     в сторону цели и плавно сжимается, скорость нелинейная. */
  function moveTabIndicator(animate) {
    const bar = $('#tab-ind');
    const active = document.querySelector('.mc-tab.sel');
    if (!bar || !active) return;
    const inset = 10; // отступ черты от краёв кнопки (как у кита)
    const barParentWidth = bar.parentElement.scrollWidth;
    const left = active.offsetLeft + inset;
    const right = barParentWidth - (active.offsetLeft + active.offsetWidth - inset);

    bar.style.width = 'auto';
    const prevLeft = parseFloat(bar.style.left) || 0;
    const movingRight = left >= prevLeft;
    const ease = 'cubic-bezier(.3, 0, .2, 1)';
    if (animate === false) {
      bar.style.transition = 'none';
    } else if (movingRight) {
      // вправо: правый край стартует сразу, левый догоняет
      bar.style.transition = 'right .26s ' + ease + ', left .26s ' + ease + ' .08s';
    } else {
      bar.style.transition = 'left .26s ' + ease + ', right .26s ' + ease + ' .08s';
    }
    bar.style.left = left + 'px';
    bar.style.right = right + 'px';
  }

  function switchTab(tab) {
    state.currentTab = tab;
    if (state.currentId) {
      history.replaceState(null, '', '#server=' + state.currentId + '/tab/' + tab);
    }
    $$('.mc-tab').forEach((btn) => btn.classList.toggle('sel', btn.dataset.tab === tab));
    moveTabIndicator(state.tabIndReady === true);
    state.tabIndReady = true;
    $('#tab-console').classList.toggle('hidden', tab !== 'console');
    $('#tab-settings').classList.toggle('hidden', tab !== 'settings');
    $('#tab-files').classList.toggle('hidden', tab !== 'files');
    $('#tab-players').classList.toggle('hidden', tab !== 'players');
    $('#tab-logs').classList.toggle('hidden', tab !== 'logs');
    $('#tab-backups').classList.toggle('hidden', tab !== 'backups');
    $('#tab-info').classList.toggle('hidden', tab !== 'info');
    if (tab !== 'logs') stopLogLive();
    if (tab === 'settings') loadSettings();
    if (tab === 'console') loadStats();
    if (tab === 'players') fetchPlayTimes();
    if (tab === 'backups') loadBackups();
    if (tab === 'logs') {
      loadLogs();
      if ($('#logs-live').classList.contains('on')) startLogLive();
    }
    if (tab === 'files') {
      $('#file-editor').classList.add('hidden');
      $('#files-browser').classList.remove('hidden');
      loadFiles();
    }
  }

  // ---------- бэкапы ----------

  async function loadBackups() {
    if (!state.currentId) return;
    await guard(async () => {
      const data = await API.backups(state.currentId);
      renderBackups(data.backups || []);
    });
  }

  function renderBackups(list) {
    const box = $('#bk-list');
    box.innerHTML = '';
    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'files-empty';
      empty.textContent = 'Бэкапов пока нет — создайте первый.';
      box.appendChild(empty);
      return;
    }
    for (const b of list) {
      const row = document.createElement('div');
      row.className = 'mc-row bk-row';
      const ic = document.createElement('span');
      ic.className = 'file-ic';
      ic.appendChild(picon('save', 'var(--accent-bright)'));
      const name = document.createElement('span');
      name.className = 'file-name';
      name.textContent = b.name.replace(/\.tar\.gz$/, '');
      const meta = document.createElement('span');
      meta.className = 'file-meta';
      meta.textContent = fmtBytes(b.size) + ' · ' + new Date(b.mtime).toLocaleString('ru-RU');
      const actions = document.createElement('span');
      actions.className = 'file-actions';
      const dl = document.createElement('a');
      dl.className = 'mc-btn sm';
      dl.href = API.backupDownloadUrl(state.currentId, b.name);
      dl.title = 'Скачать';
      dl.appendChild(picon('download'));
      actions.appendChild(dl);
      if (can('backups.restore')) {
        const rest = document.createElement('button');
        rest.className = 'mc-btn sm accent';
        rest.title = 'Восстановить';
        rest.appendChild(picon('reload'));
        rest.addEventListener('click', () => restoreBackup(b));
        actions.appendChild(rest);
      }
      if (can('backups.delete')) {
        const del = document.createElement('button');
        del.className = 'mc-btn sm danger';
        del.title = 'Удалить';
        del.appendChild(picon('trash'));
        del.addEventListener('click', () => deleteBackup(b));
        actions.appendChild(del);
      }
      row.appendChild(ic);
      row.appendChild(name);
      row.appendChild(meta);
      row.appendChild(actions);
      box.appendChild(row);
    }
  }

  async function createBackup() {
    if (!state.currentId) return;
    const btn = $('#bk-create-btn');
    btn.disabled = true;
    const label = $('#bk-label').value.trim();
    try {
      showToast('Создаю бэкап…', 'ok');
      await API.backupCreate(state.currentId, label);
      $('#bk-label').value = '';
      showToast('Бэкап создан.', 'ok');
      loadBackups();
    } catch (e) {
      showToast(e.message);
    } finally {
      btn.disabled = false;
    }
  }

  async function restoreBackup(b) {
    const server = state.current || {};
    if (server.status === 'running' || server.status === 'starting' || server.status === 'stopping') {
      showToast('Сначала остановите сервер — восстановление только на остановленном.');
      return;
    }
    const ok = await confirmDialog(
      'Восстановить бэкап «' + b.name.replace(/\.tar\.gz$/, '') + '»?\nТекущие файлы сервера будут заменены. ' +
      'Перед заменой панель сделает авто-бэкап текущего состояния.',
      { title: 'Восстановление бэкапа', yesText: 'Восстановить' }
    );
    if (!ok) return;
    await guard(async () => {
      showToast('Восстанавливаю…', 'ok');
      await API.backupRestore(state.currentId, b.name);
      showToast('Бэкап восстановлен.', 'ok');
      loadBackups();
      refreshServer();
    });
  }

  async function deleteBackup(b) {
    const ok = await confirmDialog('Удалить бэкап «' + b.name.replace(/\.tar\.gz$/, '') + '»? Это действие необратимо.',
      { title: 'Удаление бэкапа' });
    if (!ok) return;
    await guard(async () => {
      await API.backupDelete(state.currentId, b.name);
      showToast('Бэкап удалён.', 'ok');
      loadBackups();
    });
  }

  // ---------- пользователи ----------

  function buildPermsForm() {
    const box = $('#u-perms');
    box.innerHTML = '';
    let currentGroup = null;
    let grid = null;
    for (const p of state.permissions) {
      if (p.group !== currentGroup) {
        currentGroup = p.group;
        const head = document.createElement('div');
        head.className = 'perm-group';
        head.textContent = p.group || 'Права';
        box.appendChild(head);
        grid = document.createElement('div');
        grid.className = 'perms-grid';
        box.appendChild(grid);
      }
      const row = document.createElement('label');
      row.className = 'perm-row';
      const chk = document.createElement('span');
      chk.className = 'mc-check';
      chk.dataset.perm = p.key;
      const tick = document.createElement('span');
      tick.className = 'tick';
      chk.appendChild(tick);
      chk.addEventListener('click', () => chk.classList.toggle('on'));
      const lbl = document.createElement('span');
      lbl.textContent = p.label;
      row.appendChild(chk);
      row.appendChild(lbl);
      grid.appendChild(row);
    }
  }

  function collectPerms() {
    const perms = {};
    for (const chk of $$('#u-perms .mc-check')) perms[chk.dataset.perm] = chk.classList.contains('on');
    return perms;
  }

  function openUsers() {
    showScreen('users');
    $('#users-open-note').classList.toggle('hidden', !state.openMode);
    resetUserForm();
    if (state.openMode) { $('#u-admin').classList.add('on'); $('#u-perms').classList.add('hidden'); }
    loadUsers();
  }

  async function loadUsers() {
    if (state.openMode) { $('#users-list').innerHTML = ''; return; }
    await guard(async () => {
      const data = await API.usersList();
      renderUsers(data.users || []);
    });
  }

  function renderUsers(list) {
    const box = $('#users-list');
    box.innerHTML = '';
    if (!list.length) {
      const e = document.createElement('div');
      e.className = 'files-empty';
      e.textContent = 'Пользователей нет.';
      box.appendChild(e);
      return;
    }
    for (const u of list) {
      const row = document.createElement('div');
      row.className = 'mc-row user-row';
      const main = document.createElement('div');
      main.className = 'user-main';
      const name = document.createElement('div');
      name.className = 'user-name';
      name.appendChild(document.createTextNode(u.username));
      if (u.admin) {
        const crown = picon('crown', '#ffd24a'); // жёлтая пиксельная корона оператора
        crown.classList.add('op-crown');
        crown.title = 'Администратор (оператор)';
        name.appendChild(crown);
      }
      const sub = document.createElement('div');
      sub.className = 'user-sub';
      sub.textContent = u.admin ? 'Все права' : (state.permissions.filter((p) => u.perms[p.key]).map((p) => p.label).join(', ') || 'Без прав');
      main.appendChild(name);
      main.appendChild(sub);
      const actions = document.createElement('div');
      actions.className = 'file-actions';

      const edit = document.createElement('button');
      edit.className = 'mc-btn sm';
      edit.appendChild(picon('edit'));
      edit.appendChild(document.createTextNode(' Права'));
      edit.title = 'Изменить права и пароль';
      edit.addEventListener('click', () => startEditUser(u));
      actions.appendChild(edit);

      const del = document.createElement('button');
      del.className = 'mc-btn sm danger';
      del.appendChild(picon('trash'));
      del.title = 'Удалить';
      const self = state.me && state.me.username && state.me.username.toLowerCase() === u.username.toLowerCase();
      del.disabled = self;
      del.addEventListener('click', async () => {
        if (await confirmDialog('Удалить пользователя «' + u.username + '»?', { title: 'Удаление пользователя' })) {
          await guard(async () => { await API.userDelete(u.username); showToast('Удалён.', 'ok'); loadUsers(); });
        }
      });
      actions.appendChild(del);
      row.appendChild(main);
      row.appendChild(actions);
      box.appendChild(row);
    }
  }

  function startEditUser(u) {
    state.editUser = u.username;
    $('#users-form-title').textContent = 'Изменение прав: ' + u.username;
    $('#u-name').value = u.username;
    $('#u-name').disabled = true;
    $('#u-pass').value = '';
    $('#u-pass').placeholder = 'оставьте пустым — пароль не меняется';
    $('#u-admin').classList.toggle('on', !!u.admin);
    $('#u-perms').classList.toggle('hidden', !!u.admin);
    buildPermsForm();
    for (const chk of $$('#u-perms .mc-check')) {
      chk.classList.toggle('on', !!(u.perms && u.perms[chk.dataset.perm]));
    }
    $('#u-create').innerHTML = '';
    $('#u-create').appendChild(picon('save'));
    $('#u-create').appendChild(document.createTextNode(' Сохранить изменения'));
    $('#u-cancel-edit').classList.remove('hidden');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function resetUserForm() {
    state.editUser = null;
    $('#users-form-title').textContent = 'Новый пользователь';
    $('#u-name').value = '';
    $('#u-name').disabled = false;
    $('#u-pass').value = '';
    $('#u-pass').placeholder = 'минимум 4 символа';
    $('#u-admin').classList.remove('on');
    $('#u-perms').classList.remove('hidden');
    buildPermsForm();
    $('#u-create').innerHTML = '';
    $('#u-create').appendChild(picon('check'));
    $('#u-create').appendChild(document.createTextNode(' Создать пользователя'));
    $('#u-cancel-edit').classList.add('hidden');
  }

  async function submitUserForm() {
    const password = $('#u-pass').value;
    const admin = $('#u-admin').classList.contains('on');
    const perms = collectPerms();
    if (state.editUser) {
      // редактирование: пароль необязателен
      await guard(async () => {
        await API.userUpdate(state.editUser, { password: password || undefined, admin, perms });
        showToast('Права пользователя «' + state.editUser + '» обновлены.', 'ok');
        resetUserForm();
        loadUsers();
      });
      return;
    }
    const username = $('#u-name').value.trim();
    if (!username || !password) { showToast('Введите логин и пароль'); return; }
    await guard(async () => {
      const res = await API.userCreate({ username, password, admin, perms });
      showToast('Пользователь «' + username + '» создан.', 'ok');
      if (res && res.loggedIn) {
        await loadMe();
        state.openMode = false;
      }
      resetUserForm();
      openUsers();
    });
  }

  async function doLogout() {
    if (!(await confirmDialog('Выйти из панели?', { title: 'Выход', yesText: 'Выйти' }))) return;
    try { await API.logout(); } catch (e) { /* всё равно уходим */ }
    location.href = '/login';
  }

  // ---------- своё ядро при создании ----------

  function onCoreChange() {
    const custom = $('#core-select').value === 'custom';
    $('#version-label').classList.toggle('hidden', custom);
    $('#custom-core-label').classList.toggle('hidden', !custom);
    $('#version-select').required = !custom;
    if (!custom) loadVersions();
  }

  // ---------- логи ----------

  async function loadLogs() {
    if (!state.currentId) return;
    await guard(async () => {
      const data = await API.logs(state.currentId);
      const sel = $('#logs-file');
      const prev = sel.value;
      sel.innerHTML = '';
      if (!data.logs.length) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'Логов пока нет';
        sel.appendChild(opt);
        $('#logs-view').textContent = '';
        $('#logs-meta').textContent = '';
        return;
      }
      for (const l of data.logs) {
        const opt = document.createElement('option');
        opt.value = l.name;
        opt.textContent = l.name + (l.live ? ' (активный)' : '') + ' · ' + fmtBytes(l.size);
        sel.appendChild(opt);
      }
      sel.value = data.logs.some((l) => l.name === prev) ? prev : data.logs[0].name;
      loadLogContent();
    });
  }

  async function loadLogContent() {
    const name = $('#logs-file').value;
    if (!name) return;
    state.logName = name;
    await guard(async () => {
      const data = await API.log(state.currentId, name);
      state.logContent = data.content || '';
      $('#logs-meta').textContent = (data.truncated ? 'Показаны последние 5 МБ · ' : '') +
        state.logContent.split('\n').length + ' строк';
      renderLogView();
    });
  }

  function renderLogView() {
    const view = $('#logs-view');
    const q = $('#logs-query').value.trim().toLowerCase();
    const atBottom = view.scrollTop + view.clientHeight >= view.scrollHeight - 40;
    const lines = state.logContent.split('\n');
    const shown = q ? lines.filter((l) => l.toLowerCase().includes(q)) : lines;
    view.innerHTML = '';
    const frag = document.createDocumentFragment();
    const MAX = 4000;
    const slice = shown.slice(-MAX);
    for (const line of slice) {
      const el = document.createElement('span');
      el.className = 'ln';
      if (/ERROR|SEVERE|Exception|FAILED/i.test(line)) el.classList.add('ln-error');
      else if (/WARN/.test(line)) el.classList.add('ln-warn');
      else if (q && line.toLowerCase().includes(q)) el.classList.add('ln-cmd');
      el.textContent = line;
      frag.appendChild(el);
    }
    view.appendChild(frag);
    if (q) $('#logs-meta').textContent = 'Найдено строк: ' + shown.length + (shown.length > MAX ? ' (показаны последние ' + MAX + ')' : '');
    if (atBottom || q) view.scrollTop = view.scrollHeight;
  }

  function startLogLive() {
    stopLogLive();
    state.logTimer = setInterval(() => {
      if (state.screen !== 'server' || state.currentTab !== 'logs') { stopLogLive(); return; }
      // обновляем только активный лог
      if (state.logName === 'latest.log') loadLogContent();
    }, 3000);
  }
  function stopLogLive() {
    if (state.logTimer) { clearInterval(state.logTimer); state.logTimer = null; }
  }

  // ---------- перетаскивание файлов (drag & drop) ----------

  function setupFileDrop() {
    const overlay = $('#drop-overlay');
    let depth = 0;
    const onFilesTab = () => state.screen === 'server' && state.currentTab === 'files' &&
      !$('#files-browser').classList.contains('hidden');

    window.addEventListener('dragenter', (e) => {
      if (!onFilesTab() || !can('files.upload')) return;
      if (!e.dataTransfer || Array.from(e.dataTransfer.types || []).indexOf('Files') < 0) return;
      e.preventDefault();
      depth++;
      $('#drop-sub').textContent = 'в папку: ' + (state.filesPath || 'корень');
      overlay.classList.remove('hidden');
    });
    window.addEventListener('dragover', (e) => {
      if (!overlay.classList.contains('hidden')) e.preventDefault();
    });
    window.addEventListener('dragleave', (e) => {
      if (overlay.classList.contains('hidden')) return;
      depth--;
      if (depth <= 0) { depth = 0; overlay.classList.add('hidden'); }
    });
    window.addEventListener('drop', (e) => {
      if (overlay.classList.contains('hidden')) return;
      e.preventDefault();
      depth = 0;
      overlay.classList.add('hidden');
      const files = e.dataTransfer && e.dataTransfer.files ? Array.from(e.dataTransfer.files) : [];
      if (files.length) openDropConfirm(files);
    });
  }

  function openDropConfirm(files) {
    $('#dropconfirm-path').textContent = 'Папка назначения: ' + (state.filesPath || 'корень');
    const box = $('#dropconfirm-list');
    box.innerHTML = '';
    for (const f of files) {
      const row = document.createElement('div');
      row.className = 'drop-file';
      row.appendChild(picon('file', 'var(--accent-bright)'));
      const nm = document.createElement('span');
      nm.className = 'drop-file-name';
      nm.textContent = f.name;
      const sz = document.createElement('span');
      sz.className = 'drop-file-size';
      sz.textContent = fmtBytes(f.size);
      row.appendChild(nm);
      row.appendChild(sz);
      box.appendChild(row);
    }
    $('#dropconfirm-root').classList.remove('hidden');
    $('#dropconfirm-ok').onclick = async () => {
      $('#dropconfirm-root').classList.add('hidden');
      for (const f of files) await uploadFile(f);
    };
    $('#dropconfirm-cancel').onclick = () => $('#dropconfirm-root').classList.add('hidden');
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

    // бургер-меню
    const menuToggle = (open) => {
      const want = open != null ? open : !$('#app-menu').classList.contains('open');
      $('#app-menu').classList.toggle('open', want);
      $('#app-scrim').classList.toggle('open', want);
      $('#burger-ic').classList.toggle('open', want);
    };
    $('#btn-burger').addEventListener('click', () => menuToggle());
    $('#app-scrim').addEventListener('click', () => menuToggle(false));
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') menuToggle(false);
    });
    $$('#app-menu .menu-item[data-menu]').forEach((item) => item.addEventListener('click', () => {
      menuToggle(false);
      const action = item.dataset.menu;
      if (action === 'home') { showScreen('list'); guard(loadServers); }
      if (action === 'create') {
        showScreen('create');
        suggestPort();
        loadVersions();
        if (state.memCreateSlider) state.memCreateSlider.refresh();
      }
      if (action === 'settings') openAppSettings();
      if (action === 'about') $('#about-root').classList.remove('hidden');
      if (action === 'users') openUsers();
      if (action === 'logout') doLogout();
    }));
    Array.from(document.querySelectorAll('#app-menu a.menu-item')).forEach((a) =>
      a.addEventListener('click', () => menuToggle(false)));

    // экран пользователей
    $('#users-back').addEventListener('click', () => { showScreen('list'); guard(loadServers); });
    $('#u-admin').addEventListener('click', () => {
      const adminOn = $('#u-admin').classList.contains('on');
      $('#u-perms').classList.toggle('hidden', adminOn);
    });
    $('#u-create').addEventListener('click', submitUserForm);
    $('#u-cancel-edit').addEventListener('click', resetUserForm);

    // бэкапы
    $('#bk-create-btn').addEventListener('click', createBackup);

    // логи
    $('#logs-file').addEventListener('change', () => loadLogContent());
    $('#logs-query').addEventListener('input', renderLogView);
    $('#logs-refresh').addEventListener('click', () => loadLogs());
    mkToggle($('#logs-live'), false);
    $('#logs-live').addEventListener('click', () => {
      if ($('#logs-live').classList.contains('on')) startLogLive(); else stopLogLive();
    });

    // создание сервера: переключение «своё ядро»
    $('#core-select').addEventListener('change', onCoreChange);

    // перетаскивание файлов из проводника на вкладке «Файлы»
    setupFileDrop();

    $('#about-close').addEventListener('click', () => $('#about-root').classList.add('hidden'));
    $('#about-root').addEventListener('click', (event) => {
      if (event.target === $('#about-root')) $('#about-root').classList.add('hidden');
    });

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

    $('#inv-close').addEventListener('click', closeInventory);
    $('#inv-root').addEventListener('click', (event) => {
      if (event.target === $('#inv-root')) closeInventory();
    });

    $('#wl-add-btn').addEventListener('click', addToWhitelist);
    $('#wl-input').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); addToWhitelist(); }
    });

    // настройки панели
    $('#appset-close').addEventListener('click', () => $('#appset-root').classList.add('hidden'));
    $('#appset-root').addEventListener('click', (event) => {
      if (event.target === $('#appset-root')) $('#appset-root').classList.add('hidden');
    });
    $('#set-theme').addEventListener('change', () => changeAppSettings({ theme: $('#set-theme').value }));
    mkToggle($('#set-bganim'), appSettings.bgAnim !== false);
    $('#set-bganim').addEventListener('click', () =>
      changeAppSettings({ bgAnim: $('#set-bganim').classList.contains('on') }));
    mkToggle($('#set-graphs'), appSettings.graphs !== false);
    $('#set-graphs').addEventListener('click', () =>
      changeAppSettings({ graphs: $('#set-graphs').classList.contains('on') }));

    // при изменении размера окна перерисовываем графики и черту вкладок
    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (state.screen === 'server') {
          moveTabIndicator(false);
          if (state.currentTab === 'console') loadStats();
        }
      }, 200);
    });
    // после загрузки пиксельного шрифта ширины вкладок меняются — поправляем черту
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => {
        if (state.screen === 'server') moveTabIndicator(false);
      });
    }
  }

  applyAppSettings(appSettings);
  applyIcons(document);
  initCycleButtons(document);
  mkToggle($('#toggle-online'), true);
  mkToggle($('#toggle-pvp'), true);
  mkToggle($('#u-admin'), false);
  state.memCreateSlider = mkSlider($('#mem-create'), {
    min: 1024, max: state.maxMemMb, step: 512, value: 2048,
    format: fmtMem, labelEl: $('#mem-create-val'),
  });

  bind();
  loadMe();
  loadStatus();
  guard(loadServers);
  startPolling();

  // прямые ссылки: #create — мастер создания, #server=<id> — экран сервера
  if (location.hash === '#create') {
    showScreen('create');
    loadVersions();
    guard(loadServers).then(suggestPort);
  } else if (location.hash.startsWith('#server=')) {
    // форматы: #server=<id>, #server=<id>/player/<ник>, #server=<id>/tab/<вкладка>
    const rest = location.hash.slice(8);
    const playerSplit = rest.split('/player/');
    const tabSplit = playerSplit[0].split('/tab/');
    const id = tabSplit[0];
    guard(loadServers).then(() => {
      if (state.servers.some((s) => s.id === id)) {
        openServer(id);
        if (tabSplit[1]) switchTab(tabSplit[1]);
        if (playerSplit[1]) setTimeout(() => openInventory(decodeURIComponent(playerSplit[1])), 400);
      }
    });
  }
})();
