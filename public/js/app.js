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
    folia: 'Folia', mohist: 'Mohist', forge: 'Forge', custom: 'Своё ядро',
    velocity: 'Velocity (прокси)', bungeecord: 'BungeeCord (прокси)',
  };
  const PROXY_TYPES = ['velocity', 'bungeecord'];
  // ядра, которые можно поставить за прокси (понимают форвардинг)
  const BACKEND_OK = ['paper', 'purpur', 'folia', 'mohist', 'custom'];

  /* Иконки предметов «как в игре»:
     1) mc.nerothe.com — пре-рендеренные иконки инвентаря (блоки — изометрия),
        версия совпадает с версией сервера, с откатом к ближайшей доступной;
     2) плоские текстуры из InventivetalentDev/minecraft-assets той же версии;
     3) текстовое имя. */
  const ICON_RENDER_HOST = 'https://mc.nerothe.com/img/';
  const ICON_TEX_HOST = 'https://raw.githubusercontent.com/InventivetalentDev/minecraft-assets/';
  const ICON_VERSION_FALLBACKS = ['1.21.8', '1.21.6', '1.21.5', '1.21.4'];
  const iconBaseCache = new Map(); // версия сервера -> Promise<{render, render2, tex}>

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
      let render2 = null;
      let tex = null;
      /* на nerothe встречаются «пустые» папки версий (есть stone.png, но нет
         новых блоков) — поэтому требуем ДВЕ канарейки: stone + resin_block
         (полные папки >=1.21.4). Если ни одна папка не прошла двойную проверку
         (старый сервер) — вторым проходом берём папку хотя бы со stone. */
      for (const v of candidates) {
        if (await probeImage(ICON_RENDER_HOST + v + '/minecraft_stone.png') &&
            await probeImage(ICON_RENDER_HOST + v + '/minecraft_resin_block.png')) {
          render = ICON_RENDER_HOST + v + '/';
          break;
        }
      }
      if (!render) {
        for (const v of candidates) {
          if (await probeImage(ICON_RENDER_HOST + v + '/minecraft_stone.png')) {
            render = ICON_RENDER_HOST + v + '/';
            break;
          }
        }
        // папка своей версии неполная — запасной полный рендер-каталог
        for (const v of ICON_VERSION_FALLBACKS) {
          const base = ICON_RENDER_HOST + v + '/';
          if (base === render) continue;
          if (await probeImage(base + 'minecraft_resin_block.png')) { render2 = base; break; }
        }
      }
      for (const v of candidates) {
        if (await probeImage(ICON_TEX_HOST + v + '/assets/minecraft/textures/item/diamond.png')) {
          tex = ICON_TEX_HOST + v + '/assets/minecraft/textures/';
          break;
        }
      }
      if (!tex) tex = ICON_TEX_HOST + '1.21.4/assets/minecraft/textures/';
      return { render, render2, tex };
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

  /* Режим «окна» рабочего стола внутри игры (desktop.html): страница живёт
     в iframe и показывает один раздел.
     go: home|server/<id>|settings|profile|gate|editor/<id>/<путь> */
  const EMBED = (() => {
    const q = new URLSearchParams(location.search);
    if (q.get('embed') !== '1') return null;
    const go = q.get('go') || 'home';
    document.documentElement.classList.add('embed');
    if (go === 'gate') document.documentElement.classList.add('embed-gate');
    if (go === 'settings') document.documentElement.classList.add('embed-settings');
    if (go === 'profile') document.documentElement.classList.add('embed-profile');
    if (go.startsWith('editor/')) document.documentElement.classList.add('embed-editor');
    if (go.startsWith('files/')) document.documentElement.classList.add('embed-files');
    const m = go.match(/^server\/(.+)$/);
    if (m) history.replaceState(null, '', '#server=' + m[1]);
    else if (go === 'profile') history.replaceState(null, '', '#profile');
    return go;
  })();
  /* Окно-редактор файла: go=editor/<serverId>/<encodeURIComponent(путь)> */
  const EMBED_EDITOR = (() => {
    if (!EMBED || !EMBED.startsWith('editor/')) return null;
    const m = EMBED.match(/^editor\/([^/]+)\/(.+)$/);
    if (!m) return null;
    try { return { id: m[1], path: decodeURIComponent(m[2]) }; }
    catch (e) { return null; }
  })();
  /* Окно-проводник файлов сервера: go=files/<serverId> */
  const EMBED_FILES = (() => {
    if (!EMBED || !EMBED.startsWith('files/')) return null;
    const m = EMBED.match(/^files\/(.+)$/);
    return m ? { id: m[1] } : null;
  })();

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
    cores: 0,
    totalMemMb: 0,
    javaAvailable: true,
    filesPath: '',
    editorPath: null,
    memCreateSlider: null,
    memSettingsSlider: null,
    playTimes: {},
    sugItems: [],
    sugIndex: -1,
    cm: null, // CodeMirror instance
    me: null,            // текущий принципал {username, admin, perms}
    openMode: true,      // полный доступ (локально или после пароля удалёнки)
    remoteSession: false,// открыто через удалённый HTTPS-доступ
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

  async function loadMe() {
    try {
      const data = await API.me();
      state.me = data.user;
      state.remoteSession = !!data.remote; // открыто через удалённый HTTPS-доступ
      state.openMode = !!data.openMode;
      // «Выйти» имеет смысл только в удалённой сессии (локально входа нет)
      const lo = $('#menu-logout'); if (lo) lo.classList.toggle('hidden', !state.remoteSession);
      applyPermissions();
    } catch (e) { /* при 401 клиент сам уведёт на /login */ }
  }

  /* Прячем вкладки/кнопки/пункты меню, недоступные пользователю. */
  function applyPermissions() {
    // создание сервера
    $('#btn-goto-create').classList.toggle('hidden', !can('server.create'));
    // вкладки сервера (по любому из соответствующих прав)
    const tabPerm = {
      console: ['console.view'],
      settings: ['settings.edit'],
      files: ['files.read'],
      plugins: ['files.read'],
      mods: ['files.read'],
      players: ['players.kick', 'players.ban', 'players.op', 'players.whitelist', 'players.delete'],
      logs: ['logs.view'],
      backups: ['backups.create', 'backups.restore', 'backups.delete'],
    };
    $$('.mc-tab').forEach((btn) => {
      const tab = btn.dataset.tab;
      const p = tabPerm[tab];
      let hide = p ? !canAny(p) : false;
      // вкладки «Плагины»/«Моды» — только для ядер с их поддержкой
      if (tab === 'plugins' && !(state.current && state.current.plugins)) hide = true;
      if (tab === 'mods' && !(state.current && state.current.mods)) hide = true;
      btn.classList.toggle('hidden', hide);
    });
    // файловый тулбар по правам
    const fb = (sel, ok) => { const el = $(sel); if (el) el.classList.toggle('perm-hidden', !ok); };
    fb('#btn-new-file', can('files.write'));
    fb('#btn-new-dir', can('files.write'));
    fb('#btn-upload', can('files.upload'));
    fb('#btn-upload-dir', can('files.upload'));
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

  const notifHistory = []; // последние уведомления (для колокольчика, до 10)
  let notifPopupOpen = false;
  function showToast(message, type) {
    const el = document.createElement('div');
    el.className = 'toast ' + (type === 'ok' ? 'toast-ok' : 'toast-error');
    el.textContent = message;
    $('#toast-root').appendChild(el);
    setTimeout(() => el.remove(), 6000);
    notifHistory.unshift({ message: String(message), type: type === 'ok' ? 'ok' : 'err', at: Date.now() });
    if (notifHistory.length > 10) notifHistory.length = 10;
    if (notifPopupOpen) renderNotifHistory();
  }
  function renderNotifHistory() {
    const list = $('#notif-list'); if (!list) return;
    if (!notifHistory.length) { list.innerHTML = '<div class="muted" style="padding:8px;font-size:12px">Пока нет уведомлений.</div>'; return; }
    list.innerHTML = '';
    for (const n of notifHistory) {
      const d = document.createElement('div'); d.className = 'notif-item ' + (n.type === 'ok' ? 'ok' : 'err');
      const t = document.createElement('span'); t.className = 'nt-time'; t.textContent = new Date(n.at).toLocaleTimeString('ru-RU');
      const m = document.createElement('span'); m.textContent = n.message;
      d.appendChild(t); d.appendChild(m); list.appendChild(d);
    }
  }
  function toggleNotifPopup(open) {
    notifPopupOpen = open != null ? open : !notifPopupOpen;
    const pop = $('#notif-pop'); if (!pop) return;
    if (notifPopupOpen) { renderNotifHistory(); pop.classList.remove('hidden'); }
    else pop.classList.add('hidden');
  }

  // ---- скачивание файла/папки на ПК: свой тост вместо «шторки» браузера/WebView2 ----
  // В десктоп-приложении C#-обёртка прячет стандартное окно загрузок WebView2 и присылает
  // сообщение «готово», а панель показывает тост в стиле кита. В обычном браузере качает
  // сам браузер — тогда просто коротко подсвечиваем начало.
  const pendingDownloads = [];
  const inWebView = !!(window.chrome && window.chrome.webview);
  function beginDownloadFeedback(name) {
    name = name || 'файл';
    const el = document.createElement('div');
    el.className = 'toast toast-ok dl-toast';
    const spin = document.createElement('span'); spin.className = 'dl-spin';
    const msg = document.createElement('span'); msg.className = 'dl-msg';
    msg.textContent = 'Скачивание: ' + name;
    el.appendChild(spin); el.appendChild(msg);
    const root = $('#toast-root'); if (root) root.appendChild(el);
    const entry = { name: name, el: el, msg: msg };
    pendingDownloads.push(entry);
    // в приложении ждём сигнал обёртки (страховка 45с); в браузере тихо гасим через ~3.5с
    entry.timer = setTimeout(() => finishDownloadFeedback(name, true, true), inWebView ? 45000 : 3500);
  }
  function finishDownloadFeedback(name, ok, quiet) {
    if (!pendingDownloads.length) return;
    let i = pendingDownloads.findIndex((d) => d.name === name);
    if (i < 0) i = 0; // имя не совпало (коллизия/переименование) — закрываем самый старый ожидающий
    const entry = pendingDownloads.splice(i, 1)[0];
    if (!entry) return;
    clearTimeout(entry.timer);
    const spin = entry.el.querySelector('.dl-spin');
    if (spin) spin.remove();
    if (quiet) { setTimeout(() => entry.el.remove(), 2500); return; }
    if (ok) { entry.el.className = 'toast toast-ok'; entry.msg.textContent = 'Сохранено в «Загрузки»: ' + name; }
    else { entry.el.className = 'toast toast-error'; entry.msg.textContent = 'Не удалось скачать: ' + name; }
    setTimeout(() => entry.el.remove(), 5000);
  }
  if (inWebView && window.chrome.webview.addEventListener) {
    window.chrome.webview.addEventListener('message', (e) => {
      const d = e.data;
      if (!d || d.type !== 'cg-download') return;
      finishDownloadFeedback(d.name, d.state === 'completed', false);
    });
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

  function fmtCpu(v) {
    if (v >= 100) return 'без лимита (все ядра)';
    // ядра берём с бэкенда (os.cpus()) — в WebKitGTK navigator.hardwareConcurrency бывает 0
    const cores = state.cores || navigator.hardwareConcurrency || 0;
    const k = cores ? Math.max(1, Math.round(cores * v / 100)) : 0;
    return v + '%' + (k ? ' (≈ ' + k + ' из ' + cores + ' ядер)' : '');
  }

  // подсказка по объёму ОЗУ при создании сервера (много/мало/норма)
  function updateMemHint(mb) {
    const el = document.getElementById('mem-create-hint');
    if (!el) return;
    const total = state.totalMemMb || 0;
    const totalGb = total ? (total / 1024).toFixed(total >= 10240 ? 0 : 1).replace(/\.0$/, '') : null;
    let msg, cls;
    if (mb < 1536) {
      msg = 'Маловато — серверу может не хватить, возможны лаги и вылеты'; cls = 'bad';
    } else if (mb < 2048) {
      msg = 'Минимум для небольшого ванильного сервера на пару игроков'; cls = 'ok';
    } else if (total && mb > total - 1536) {
      msg = 'Перебор — системе почти не остаётся памяти, возможны зависания ОС'; cls = 'bad';
    } else if (total && mb > total * 0.6) {
      msg = 'Много — хорошо для модов и большого онлайна, но следите за остатком'; cls = 'warn';
    } else {
      msg = 'Оптимально для большинства серверов'; cls = 'good';
    }
    el.textContent = (totalGb ? 'В системе ' + totalGb + ' ГБ. ' : '') + msg;
    el.className = 'hint mem-hint ' + cls;
  }

  // Превращает нативный <select> в стилизованную выпадашку (нативный список
  // WebKitGTK на Linux — бел-на-бел). Сам <select> остаётся в DOM (значение/форма
  // и события change работают), мы лишь рисуем поверх своё.
  function enhanceSelect(sel) {
    if (!sel || sel.dataset.enhanced) return;
    sel.dataset.enhanced = '1';
    sel.removeAttribute('required'); // валидируем вручную (submitCreate)

    const wrap = document.createElement('div');
    wrap.className = 'mc-sel';
    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);
    sel.classList.add('mc-sel-native');

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'fld mc-sel-btn';
    btn.innerHTML = '<span class="mc-sel-label"></span><span class="mc-sel-arrow"></span>';
    wrap.appendChild(btn);
    const labelEl = btn.querySelector('.mc-sel-label');

    const pop = document.createElement('div');
    pop.className = 'mc-sel-pop hidden';
    wrap.appendChild(pop);

    function syncLabel() {
      const o = sel.options[sel.selectedIndex];
      labelEl.textContent = o ? o.textContent : '';
      btn.classList.toggle('placeholder', !sel.value);
    }
    function buildPop() {
      pop.innerHTML = '';
      Array.prototype.forEach.call(sel.options, (o, i) => {
        const item = document.createElement('div');
        item.className = 'mc-sel-opt' + (i === sel.selectedIndex ? ' sel' : '') + (o.disabled ? ' disabled' : '');
        item.textContent = o.textContent;
        if (!o.disabled) {
          item.addEventListener('click', () => {
            sel.selectedIndex = i;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            syncLabel();
            close();
          });
        }
        pop.appendChild(item);
      });
    }
    function open() {
      if (!pop.classList.contains('hidden')) return;
      buildPop();
      pop.classList.remove('hidden');
      wrap.classList.add('open');
      const cur = pop.querySelector('.mc-sel-opt.sel');
      if (cur) cur.scrollIntoView({ block: 'nearest' });
      setTimeout(() => document.addEventListener('pointerdown', outside), 0);
    }
    function close() {
      pop.classList.add('hidden');
      wrap.classList.remove('open');
      document.removeEventListener('pointerdown', outside);
    }
    function outside(e) { if (!wrap.contains(e.target)) close(); }

    btn.addEventListener('click', () => (pop.classList.contains('hidden') ? open() : close()));
    // версии и т.п. подгружаются асинхронно — следим за изменением <option>
    new MutationObserver(syncLabel).observe(sel, { childList: true });
    sel.addEventListener('change', syncLabel);
    sel._mcSync = syncLabel; // вызвать после программной установки .value
    syncLabel();
  }

  function enhanceSelectsIn(root) {
    (root || document).querySelectorAll('select:not([data-enhanced])').forEach(enhanceSelect);
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
    // сырой прогресс во время перетаскивания: кноб следует ровно за курсором,
    // а не прыгает по шагам (иначе он «отстаёт» от курсора до полушага)
    let dragRatio = null;

    function clamp(v) {
      v = Math.round(v / opts.step) * opts.step;
      return Math.max(opts.min, Math.min(opts.max, v));
    }
    function render() {
      const w = el.clientWidth;
      const knobW = knob.offsetWidth || 32;
      const ratio = dragRatio != null ? dragRatio : ((value - opts.min) / (opts.max - opts.min || 1));
      const x = ratio * (w - knobW);
      knob.style.left = x + 'px';
      fill.style.width = Math.max(0, x + knobW / 2 - 3) + 'px';
      if (opts.labelEl) opts.labelEl.textContent = opts.format ? opts.format(value) : String(value);
      if (opts.onChange) opts.onChange(value);
    }
    function fromPointer(event) {
      const rect = el.getBoundingClientRect();
      // ширина кноба в координатах viewport: offsetWidth не учитывает zoom
      // страницы и давал смещение кноба от курсора при масштабе != 100%
      const knobW = knob.getBoundingClientRect().width || 32;
      const r = (event.clientX - rect.left - knobW / 2) / Math.max(1, rect.width - knobW);
      dragRatio = Math.max(0, Math.min(1, r));
      value = clamp(opts.min + dragRatio * (opts.max - opts.min));
      render();
    }
    el.addEventListener('pointerdown', (event) => {
      el.setPointerCapture(event.pointerId);
      fromPointer(event);
      const move = (ev) => fromPointer(ev);
      const up = () => {
        dragRatio = null;
        render(); // кноб «доезжает» до квантованного значения
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
    document.body.classList.toggle('no-bganim', settings.bgAnim === false);
    document.body.classList.toggle('hide-graphs', settings.graphs === false);
    if (EMBED) {
      // В моде масштаб интерфейса нельзя применять зумом body окна-настроек —
      // это масштабирует только саму страницу настроек внутри iframe, а не весь
      // рабочий стол. Передаём значение окну рабочего стола, оно зумит десктоп.
      document.body.style.zoom = '';
      if (window.parent !== window) {
        try { window.parent.postMessage({ cg: 'set-scale', scale: settings.scale }, location.origin); } catch (e) { /* */ }
      }
    } else {
      document.body.style.zoom = settings.scale === 100 ? '' : settings.scale + '%';
    }
  }

  let appSettings = loadAppSettings();
  let scaleSlider = null;

  function changeAppSettings(patch) {
    appSettings = Object.assign({}, appSettings, patch);
    saveAppSettings(appSettings);
    applyAppSettings(appSettings);
  }

  function setLaunchModeBtns(mode) {
    $$('#launchmode-btns .seg').forEach((b) => b.classList.toggle('sel', b.dataset.mode === mode));
  }

  function openAppSettings() {
    // текущий режим открытия (читается лаунчером при следующем старте)
    API.launchMode().then((r) => setLaunchModeBtns(r && r.mode ? r.mode : 'app')).catch(() => {});
    if (!scaleSlider) {
      scaleSlider = mkSlider($('#set-scale'), {
        min: 80, max: 140, step: 5, value: appSettings.scale,
        format: (v) => v + '%', labelEl: $('#set-scale-val'),
        // живое применение прямо во время перетаскивания (раньше — только по
        // отпусканию, и pointercancel вовсе терял значение); гард от циклов
        onChange: (v) => { if (v !== appSettings.scale) changeAppSettings({ scale: v }); },
      });
    } else {
      scaleSlider.set(appSettings.scale);
    }
    $('#set-graphs').classList.toggle('on', appSettings.graphs !== false);
    API.trayMinimize().then((r) => $('#set-tray').classList.toggle('on', !!(r && r.enabled))).catch(() => {});
    refreshRemoteAccessCard();
    $('#appset-root').classList.remove('hidden');
    setTimeout(() => scaleSlider.refresh(), 30);
  }

  // ---------- удалённый доступ (HTTPS + пароль) ----------

  // ---------- удалённый доступ: статус, пользователи, права по серверам ----------
  let raStatus = null;
  const RA_PRESET_OPTS = [['none', 'Нет доступа'], ['full', 'Полный'], ['manage', 'Управление + консоль'], ['view', 'Только просмотр'], ['custom', 'Настроить…']];

  async function refreshRemoteAccessCard() {
    const card = $('#ra-card');
    if (!card) return;
    try { raStatus = await API.remoteAccess(); } catch (e) { card.classList.add('hidden'); return; }
    card.classList.remove('hidden');
    $('#ra-toggle').classList.toggle('on', !!raStatus.enabled);
    const portEl = $('#ra-port');
    if (portEl && document.activeElement !== portEl) portEl.value = raStatus.port;
    $('#ra-info').classList.toggle('hidden', !raStatus.enabled);
    $('#ra-state').textContent = raStatus.enabled
      ? (raStatus.running ? 'Работает: HTTPS-порт ' + raStatus.port + ' открыт для подключений.' : 'Включён, но листенер не запущен (порт занят?) — смотрите консоль панели.')
      : '';
    const ips = (raStatus.lanIps || []).filter((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip));
    $('#ra-addr').innerHTML = ips.length
      ? 'В локальной сети: <code>https://' + ips[0] + ':' + raStatus.port + '</code>. Из интернета — пробросьте порт <b>' + raStatus.port + '</b> на роутере на этот компьютер и используйте внешний IP.'
      : 'Пробросьте порт <b>' + raStatus.port + '</b> на роутере на этот компьютер.';
    $('#ra-fp').textContent = raStatus.fingerprint
      ? 'Отпечаток сертификата (SHA-256): ' + raStatus.fingerprint.replace(/(..)(?=.)/g, '$1:').toUpperCase()
      : '';
    renderRemoteUsers();
  }

  function renderRemoteUsers() {
    const box = $('#ra-users');
    if (!box) return;
    box.innerHTML = '';
    const list = (raStatus && raStatus.users) || [];
    if (!list.length) {
      const e = document.createElement('div');
      e.className = 'ra-users-empty';
      e.textContent = 'Пользователей нет. Добавьте первого — тогда можно включить доступ.';
      box.appendChild(e);
      return;
    }
    for (const u of list) {
      const keys = Object.keys(u.access || {});
      const summary = keys.indexOf('*') >= 0 ? 'все серверы' : ('серверов: ' + keys.length);
      const row = document.createElement('div'); row.className = 'ra-user';
      const nm = document.createElement('span'); nm.className = 'ra-user-name'; nm.textContent = u.username;
      const sub = document.createElement('span'); sub.className = 'ra-user-sub'; sub.textContent = '· ' + summary;
      const acts = document.createElement('span'); acts.className = 'ra-user-acts';
      const edit = document.createElement('button'); edit.className = 'mc-btn sm'; edit.title = 'Изменить';
      edit.appendChild(picon('edit')); edit.addEventListener('click', () => openRemoteUserEditor(u));
      const del = document.createElement('button'); del.className = 'mc-btn sm danger'; del.title = 'Удалить';
      del.appendChild(picon('trash')); del.addEventListener('click', () => deleteRemoteUser(u.username));
      acts.appendChild(edit); acts.appendChild(del);
      row.appendChild(nm); row.appendChild(sub); row.appendChild(acts);
      box.appendChild(row);
    }
  }

  async function raAction(action, extra, okMsg) {
    $('#ra-err').textContent = '';
    try {
      await API.remoteAccessAction(action, extra);
      if (okMsg) showToast(okMsg, 'ok');
      await refreshRemoteAccessCard();
      return true;
    } catch (e) { $('#ra-err').textContent = e.message; await refreshRemoteAccessCard(); return false; }
  }

  // --- редактор пользователя (права по каждому серверу) ---
  function raPresetPerms(name) { const out = {}; for (const k of ((raStatus.presets || {})[name] || [])) out[k] = true; return out; }
  function raPresetOf(perms) {
    const keys = (raStatus.permissions || []).map((p) => p.key);
    const on = keys.filter((k) => perms && perms[k]);
    if (!on.length) return 'none';
    for (const name of ['full', 'manage', 'view']) {
      const set = (raStatus.presets || {})[name] || [];
      if (set.length === on.length && set.every((k) => perms[k])) return name;
    }
    return 'custom';
  }
  function buildPermGrid(grid, perms) {
    grid.innerHTML = '';
    const groups = [];
    const byGroup = {};
    for (const p of (raStatus.permissions || [])) {
      if (!byGroup[p.group]) { byGroup[p.group] = []; groups.push(p.group); }
      byGroup[p.group].push(p);
    }
    for (const g of groups) {
      const gd = document.createElement('div'); gd.className = 'ruser-perm-grp';
      const t = document.createElement('div'); t.className = 'ruser-perm-grp-title'; t.textContent = g; gd.appendChild(t);
      for (const p of byGroup[g]) {
        const lab = document.createElement('label'); lab.className = 'ruser-perm';
        const cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = p.key; cb.checked = !!(perms && perms[p.key]);
        lab.appendChild(cb); lab.appendChild(document.createTextNode(' ' + p.label));
        gd.appendChild(lab);
      }
      grid.appendChild(gd);
    }
  }
  function setGrid(grid, perms) { Array.from(grid.querySelectorAll('input[type=checkbox]')).forEach((cb) => { cb.checked = !!(perms && perms[cb.value]); }); }
  function makeSrvRow(sid, label, wildcard, perms) {
    const row = document.createElement('div'); row.className = 'ruser-srv'; row.dataset.sid = sid;
    const head = document.createElement('div'); head.className = 'ruser-srv-head';
    const name = document.createElement('div'); name.className = 'ruser-srv-name'; name.textContent = label;
    if (wildcard) { const d = document.createElement('span'); d.className = 'dim'; d.textContent = ' — для серверов без своей настройки'; name.appendChild(d); }
    const sel = document.createElement('select'); sel.className = 'fld ruser-preset';
    for (const [v, t] of RA_PRESET_OPTS) { const o = document.createElement('option'); o.value = v; o.textContent = t; sel.appendChild(o); }
    sel.value = perms ? raPresetOf(perms) : 'none';
    head.appendChild(name); head.appendChild(sel);
    row.appendChild(head);
    const grid = document.createElement('div'); grid.className = 'ruser-perms' + (sel.value === 'custom' ? '' : ' hidden');
    buildPermGrid(grid, perms || {});
    row.appendChild(grid);
    sel.addEventListener('change', () => {
      if (sel.value === 'custom') { grid.classList.remove('hidden'); }
      else { grid.classList.add('hidden'); setGrid(grid, sel.value === 'none' ? {} : raPresetPerms(sel.value)); }
    });
    grid.addEventListener('change', () => { sel.value = 'custom'; }); // ручная галочка → «Настроить»
    return row;
  }
  async function openRemoteUserEditor(user) {
    if (!raStatus) return;
    const isEdit = !!user;
    // свежий список серверов для матрицы прав; без него редактор собирал бы неполную
    // матрицу и молча срезал доступ к серверам, которых нет в списке — тогда не открываем
    try { const d = await API.servers(); state.servers = d.servers || []; }
    catch (e) { if (!(state.servers && state.servers.length)) { showToast('Не удалось получить список серверов: ' + e.message); return; } }
    state.ruserEditing = isEdit ? user.username : null;
    $('#ruser-title').textContent = isEdit ? 'Пользователь «' + user.username + '»' : 'Новый пользователь';
    const nameEl = $('#ruser-name');
    nameEl.value = isEdit ? user.username : '';
    nameEl.disabled = isEdit; // ник менять нельзя (иначе создастся новый) — удалите и создайте заново
    $('#ruser-pass').value = '';
    $('#ruser-pass').type = 'password';
    $('#ruser-pass').placeholder = isEdit ? 'оставьте пустым — пароль не меняется' : 'минимум 6 символов';
    $('#ruser-pass-eye').style.setProperty('--i', "url('/icons/eye.svg')"); // сброс «глаза» при повторном открытии
    $('#ruser-pass-eye').title = 'Показать пароль';
    $('#ruser-err').textContent = '';
    const box = $('#ruser-servers'); box.innerHTML = '';
    const access = (user && user.access) || {};
    box.appendChild(makeSrvRow('*', 'Все серверы (включая будущие)', true, access['*']));
    for (const s of (state.servers || [])) box.appendChild(makeSrvRow(s.id, s.name, false, access[s.id]));
    $('#ruser-modal').classList.remove('hidden');
    setTimeout(() => { if (!isEdit) nameEl.focus(); }, 40);
  }
  function collectRuserAccess() {
    const access = {};
    Array.from($('#ruser-servers').querySelectorAll('.ruser-srv')).forEach((row) => {
      const sid = row.dataset.sid;
      const sel = row.querySelector('.ruser-preset');
      if (sel.value === 'none') return;
      let perms;
      if (sel.value === 'custom') { perms = {}; Array.from(row.querySelectorAll('.ruser-perms input:checked')).forEach((cb) => { perms[cb.value] = true; }); }
      else perms = raPresetPerms(sel.value);
      if (Object.keys(perms).length) access[sid] = perms;
    });
    return access;
  }
  async function saveRemoteUser() {
    const name = $('#ruser-name').value.trim();
    const pass = $('#ruser-pass').value;
    const access = collectRuserAccess();
    $('#ruser-err').textContent = '';
    if (!state.ruserEditing && !name) { $('#ruser-err').textContent = 'Введите логин.'; return; }
    if (!state.ruserEditing && pass.length < 6) { $('#ruser-err').textContent = 'Пароль: минимум 6 символов.'; return; }
    if (!state.ruserEditing && (raStatus.users || []).some((u) => u.username.toLowerCase() === name.toLowerCase())) {
      $('#ruser-err').textContent = 'Пользователь с таким ником уже есть — откройте его «Изменить».'; return;
    }
    if (!Object.keys(access).length) { $('#ruser-err').textContent = 'Дайте доступ хотя бы к одному серверу (выберите уровень).'; return; }
    try {
      await API.remoteAccessAction('user-save', { username: state.ruserEditing || name, password: pass || undefined, access: access });
      $('#ruser-modal').classList.add('hidden');
      showToast('Пользователь сохранён.', 'ok');
      await refreshRemoteAccessCard();
    } catch (e) { $('#ruser-err').textContent = e.message; }
  }
  async function deleteRemoteUser(username) {
    if (!await confirmDialog('Удалить пользователя «' + username + '»? Его удалённый доступ прекратится.',
      { title: 'Удаление пользователя', yesText: 'Удалить', danger: true })) return;
    try { await API.remoteAccessAction('user-remove', { username: username }); showToast('Пользователь удалён.', 'ok'); await refreshRemoteAccessCard(); }
    catch (e) { showToast(e.message); }
  }

  function bindRemoteAccessCard() {
    const t = $('#ra-toggle');
    if (!t) return;
    mkToggle(t); // переключатель кита: ползунок + оптимистичный флип по клику
    t.addEventListener('click', async () => {
      const wantOn = t.classList.contains('on'); // mkToggle уже перевернул визуальное состояние
      if (wantOn) {
        if (!raStatus || !raStatus.userCount) {
          t.classList.remove('on');
          $('#ra-err').textContent = 'Сначала добавьте хотя бы одного пользователя.';
          return;
        }
        if (!await raAction('enable', null, 'Удалённый доступ включён.')) t.classList.remove('on');
      } else {
        const ok = await confirmDialog('Выключить удалённый доступ? Все удалённые сессии будут разорваны.',
          { title: 'Удалённый доступ', yesText: 'Выключить', danger: true });
        if (!ok) { t.classList.add('on'); return; }
        raAction('disable', null, 'Удалённый доступ выключен.');
      }
    });
    $('#ra-port-save').addEventListener('click', () => raAction('set-port', { port: parseInt($('#ra-port').value, 10) }, 'Порт применён.'));
    $('#ra-cert-regen').addEventListener('click', async () => {
      if (!await confirmDialog('Перевыпустить сертификат? Браузеры и приложения один раз переспросят про новый сертификат.',
        { title: 'Сертификат', yesText: 'Перевыпустить' })) return;
      raAction('regen-cert', null, 'Сертификат перевыпущен.');
    });
    $('#ra-user-add').addEventListener('click', () => openRemoteUserEditor(null));
    // модалка редактора пользователя
    $('#ruser-close').addEventListener('click', () => $('#ruser-modal').classList.add('hidden'));
    $('#ruser-cancel').addEventListener('click', () => $('#ruser-modal').classList.add('hidden'));
    $('#ruser-modal').addEventListener('click', (e) => { if (e.target.id === 'ruser-modal') $('#ruser-modal').classList.add('hidden'); });
    $('#ruser-save').addEventListener('click', saveRemoteUser);
    $('#ruser-pass-eye').addEventListener('click', () => {
      const p = $('#ruser-pass');
      p.type = p.type === 'password' ? 'text' : 'password';
      $('#ruser-pass-eye').style.setProperty('--i', "url('/icons/" + (p.type === 'text' ? 'eye-closed' : 'eye') + ".svg')");
    });
  }

  // ---------- удалённые панели: менеджер подключений к CONTROLGUI на других машинах ----------
  let rcConns = [];      // список подключений (без паролей)
  const rcChecks = {};   // id -> { online, certChanged, reason } | undefined (идёт проверка)
  let rcEditing = null;  // id редактируемого подключения | null (новое)
  let rcProbedFp = null; // отпечаток, подтверждённый шагом «Проверить»

  function fmtFingerprint(fp) { return String(fp || '').replace(/(..)(?=.)/g, '$1:').toUpperCase(); }

  /* Загрузка списка подключений: рендер экрана-менеджера + компактного входа на главной. */
  async function loadRemoteConns() {
    if (!$('#rc-list')) return;
    if (state.remoteSession) { updateRcHomeEntry(); return; } // удалённый гость подключений не имеет
    try { const d = await API.remoteConns(); rcConns = d.connections || []; }
    catch (e) { rcConns = []; updateRcHomeEntry(); return; } // 403 (удалёнка) — вход прячем
    renderRemoteConns();
    updateRcHomeEntry();
    for (const c of rcConns) {
      rcChecks[c.id] = undefined;
      API.remoteConnAction('check', { id: c.id })
        .then((r) => { rcChecks[c.id] = r; })
        .catch(() => { rcChecks[c.id] = { online: false, reason: 'нет ответа' }; })
        .then(() => { updateRcState(c.id); updateRcHomeEntry(); });
    }
  }

  /* Компактный вход «Удалённые панели» на главном экране (и пункт меню). */
  function updateRcHomeEntry() {
    const entry = $('#rc-home-entry');
    if (!entry) return;
    const menu = $('#menu-remote');
    if (state.remoteSession) { entry.classList.add('hidden'); if (menu) menu.classList.add('hidden'); return; }
    entry.classList.remove('hidden');
    if (menu) menu.classList.remove('hidden');
    const n = rcConns.length;
    const online = rcConns.filter((c) => rcChecks[c.id] && rcChecks[c.id].online && !rcChecks[c.id].certChanged).length;
    $('#rc-home-sub').textContent = n
      ? ('Подключений: ' + n + (online ? ' · в сети: ' + online : ''))
      : 'Подключитесь к CONTROLGUI на другом ПК или сервере';
  }

  function rcStateView(id) {
    const st = rcChecks[id];
    if (st === undefined) return { dot: '', text: 'Проверка…' };
    if (!st.online) return { dot: '', text: 'Не в сети', title: st.reason || '' };
    if (st.certChanged) return { dot: ' err', text: 'Сертификат изменился' };
    return { dot: ' on', text: 'В сети' };
  }
  function fillRcState(stEl, id) {
    const v = rcStateView(id);
    stEl.innerHTML = '';
    const dot = document.createElement('span');
    dot.className = 'status-dot' + v.dot;
    stEl.appendChild(dot);
    stEl.appendChild(document.createTextNode(v.text));
    stEl.title = v.title || '';
  }
  /* Обновить статус-строку и предупреждение о смене серта на карточке. */
  function refreshRcCard(card, id) {
    const stEl = card.querySelector('.rc-state');
    if (stEl) fillRcState(stEl, id);
    const warn = card.querySelector('.rc-warn');
    const st = rcChecks[id];
    if (warn) warn.classList.toggle('hidden', !(st && st.certChanged));
  }
  function updateRcState(id) {
    const card = document.querySelector('.rc-card[data-rcid="' + id + '"]');
    if (card) refreshRcCard(card, id);
  }

  function renderRemoteConns() {
    const box = $('#rc-list');
    if (!box) return;
    box.innerHTML = '';
    box.classList.toggle('cols3', rcConns.length > 3);
    if (!rcConns.length) {
      const e = document.createElement('div');
      e.className = 'rc-empty';
      e.innerHTML = 'Пока нет ни одного подключения.<br>Нажмите «Добавить», чтобы подключиться к CONTROLGUI на другой машине.';
      box.appendChild(e);
      return;
    }
    for (const c of rcConns) box.appendChild(makeRcCard(c));
  }

  function makeRcCard(c) {
    const card = document.createElement('div');
    card.className = 'srv-card rc-card';
    card.dataset.rcid = c.id;

    const top = document.createElement('div');
    top.className = 'srv-card-top';
    const icon = document.createElement('div');
    icon.className = 'rc-icon';
    icon.appendChild(picon('monitor'));
    const idBox = document.createElement('div');
    idBox.className = 'srv-card-id';
    const nameEl = document.createElement('div');
    nameEl.className = 'srv-card-name';
    nameEl.textContent = c.name;
    const subEl = document.createElement('div');
    subEl.className = 'srv-card-sub';
    subEl.textContent = c.host + ':' + c.port + ' · ' + c.username;
    idBox.appendChild(nameEl);
    idBox.appendChild(subEl);
    top.appendChild(icon);
    top.appendChild(idBox);

    const line = document.createElement('div');
    line.className = 'srv-card-line';
    const stEl = document.createElement('span');
    stEl.className = 'rc-state';
    line.appendChild(stEl);

    // предупреждение о смене сертификата (скрыто, показывается по результату проверки)
    const warn = document.createElement('div');
    warn.className = 'rc-warn hidden';
    warn.appendChild(picon('lock'));
    const warnT = document.createElement('span');
    warnT.textContent = 'Сертификат изменился — откройте «Изменить» и сверьте заново.';
    warn.appendChild(warnT);

    const actions = document.createElement('div');
    actions.className = 'srv-card-actions';
    const openBtn = document.createElement('button');
    openBtn.className = 'mc-btn sm primary';
    openBtn.appendChild(picon('arrow-right'));
    openBtn.appendChild(document.createTextNode(' Открыть'));
    openBtn.addEventListener('click', (ev) => { ev.stopPropagation(); openRemoteConn(c.id, openBtn); });
    const edit = document.createElement('button');
    edit.className = 'mc-btn sm';
    edit.title = 'Изменить';
    edit.appendChild(picon('edit'));
    edit.addEventListener('click', (ev) => { ev.stopPropagation(); openRcEditor(c); });
    const del = document.createElement('button');
    del.className = 'mc-btn sm danger';
    del.title = 'Удалить';
    del.appendChild(picon('trash'));
    del.addEventListener('click', (ev) => { ev.stopPropagation(); deleteRemoteConn(c); });
    actions.appendChild(openBtn);
    actions.appendChild(edit);
    actions.appendChild(del);

    card.appendChild(top);
    card.appendChild(line);
    card.appendChild(warn);
    card.appendChild(actions);
    card.addEventListener('click', () => openRemoteConn(c.id, openBtn));
    refreshRcCard(card, c.id);
    return card;
  }

  async function openRemoteConn(id, btn) {
    const st = rcChecks[id];
    if (st && st.certChanged) {
      showToast('Сертификат удалённой панели изменился — откройте «Изменить» и сверьте новый отпечаток.');
      const c = rcConns.find((x) => x.id === id);
      if (c) openRcEditor(c);
      return;
    }
    const prev = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Подключение…'; }
    const restore = () => { if (btn) { btn.disabled = false; btn.innerHTML = prev; } };
    try {
      const r = await API.remoteConnAction('open', { id: id }); // поднимает прокси, проверяет вход
      if (!r || !r.url) { showToast('Не удалось открыть подключение.'); restore(); return; }
      // к скольким серверам есть доступ на той панели: 1 — сразу его, много — выбор, 0 — на корень
      let servers = [];
      try { const sr = await API.remoteConnAction('servers', { id: id }); servers = (sr && sr.servers) || []; }
      catch (e) { /* не удалось узнать — откроем корень удалённой панели */ }
      if (servers.length === 1) { location.href = r.url + '#server=' + servers[0].id; return; }
      if (servers.length > 1) { rcServerChooser(r.url, servers); restore(); return; }
      location.href = r.url; // 0 доступных или список недоступен — корень удалённой панели
    } catch (e) { showToast(e.message); restore(); }
  }

  /* Модалка выбора сервера, когда на удалённой панели доступно несколько. */
  function rcServerChooser(url, servers) {
    const box = $('#rc-srv-list');
    box.innerHTML = '';
    for (const s of servers) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'rc-srv-row';
      const ic = document.createElement('span');
      ic.className = 'rc-srv-ic';
      ic.appendChild(picon('server'));
      const mid = document.createElement('div');
      mid.className = 'rc-srv-mid';
      const nm = document.createElement('div');
      nm.className = 'rc-srv-name';
      nm.textContent = s.name;
      const sub = document.createElement('div');
      sub.className = 'rc-srv-sub';
      sub.textContent = (CORE_NAMES[s.type] || s.type) + ' ' + (s.version || '') +
        ' · ' + (STATUS_LABEL[s.status] || s.status) + (s.status === 'running' ? ' · игроков ' + s.players : '');
      mid.appendChild(nm);
      mid.appendChild(sub);
      row.appendChild(ic);
      row.appendChild(mid);
      row.appendChild(picon('arrow-right'));
      row.addEventListener('click', () => { location.href = url + '#server=' + s.id; });
      box.appendChild(row);
    }
    $('#rc-srv-modal').classList.remove('hidden');
  }

  async function deleteRemoteConn(c) {
    if (!await confirmDialog('Удалить подключение «' + c.name + '»?\nСама удалённая панель и её серверы не пострадают.',
      { title: 'Удаление подключения', yesText: 'Удалить', danger: true })) return;
    try {
      await API.remoteConnAction('remove', { id: c.id });
      showToast('Подключение удалено.', 'ok');
      await loadRemoteConns();
    } catch (e) { showToast(e.message); }
  }

  // --- мастер добавления: шаг 1 (данные) → шаг 2 (сверка отпечатка) ---
  function rcShowStep(n) {
    $('#rc-step1').classList.toggle('hidden', n !== 1);
    $('#rc-step2').classList.toggle('hidden', n !== 2);
    const d1 = $('#rc-steps').querySelector('[data-step="1"]');
    const d2 = $('#rc-steps').querySelector('[data-step="2"]');
    d1.classList.toggle('sel', n === 1);
    d1.classList.toggle('done', n === 2);
    d2.classList.toggle('sel', n === 2);
  }
  function openRcEditor(conn) {
    rcEditing = conn ? conn.id : null;
    rcProbedFp = null;
    $('#rc-title').textContent = conn ? 'Подключение «' + conn.name + '»' : 'Новое подключение';
    $('#rc-name').value = conn ? conn.name : '';
    $('#rc-host').value = conn ? conn.host : '';
    $('#rc-portf').value = conn ? conn.port : 8433;
    $('#rc-user').value = conn ? conn.username : '';
    const pass = $('#rc-pass');
    pass.value = '';
    pass.type = 'password';
    pass.placeholder = conn ? 'оставьте пустым — пароль не меняется' : 'пароль пользователя удалённой панели';
    $('#rc-pass-eye').style.setProperty('--i', "url('/icons/eye.svg')");
    $('#rc-pass-eye').title = 'Показать пароль';
    $('#rc-err').textContent = '';
    $('#rc-err2').textContent = '';
    rcShowStep(1);
    $('#rc-modal').classList.remove('hidden');
    setTimeout(() => { if (!conn) $('#rc-name').focus(); }, 40);
  }
  async function rcProbe() {
    $('#rc-err').textContent = '';
    if (!$('#rc-host').value.trim()) { $('#rc-err').textContent = 'Введите адрес.'; return; }
    if (!rcEditing && !$('#rc-pass').value) { $('#rc-err').textContent = 'Введите пароль.'; return; }
    const btn = $('#rc-probe');
    const prev = btn.innerHTML;
    btn.disabled = true; btn.textContent = 'Проверяю…';
    try {
      const r = await API.remoteConnAction('probe', {
        host: $('#rc-host').value.trim(),
        port: parseInt($('#rc-portf').value, 10),
      });
      rcProbedFp = r.fingerprint;
      $('#rc-fp').textContent = fmtFingerprint(r.fingerprint);
      $('#rc-verify-host').textContent = $('#rc-host').value.trim() + ':' + (parseInt($('#rc-portf').value, 10) || 8433);
      $('#rc-err2').textContent = '';
      rcShowStep(2);
    } catch (e) { $('#rc-err').textContent = e.message; }
    finally { btn.disabled = false; btn.innerHTML = prev; }
  }
  async function rcSave() {
    $('#rc-err2').textContent = '';
    if (!rcProbedFp) { rcShowStep(1); $('#rc-err').textContent = 'Сначала нажмите «Проверить».'; return; }
    const btn = $('#rc-save');
    const prev = btn.innerHTML;
    btn.disabled = true; btn.textContent = 'Сохраняю…';
    try {
      await API.remoteConnAction('save', {
        id: rcEditing || undefined,
        name: $('#rc-name').value.trim(),
        host: $('#rc-host').value.trim(),
        port: parseInt($('#rc-portf').value, 10),
        username: $('#rc-user').value.trim(),
        password: $('#rc-pass').value || undefined,
        fingerprint: rcProbedFp,
      });
      $('#rc-modal').classList.add('hidden');
      showToast('Подключение сохранено.', 'ok');
      await loadRemoteConns();
    } catch (e) { $('#rc-err2').textContent = e.message; }
    finally { btn.disabled = false; btn.innerHTML = prev; }
  }
  function bindRemoteConns() {
    if (!$('#rc-list')) return;
    // навигация экрана-менеджера
    $('#rc-home-entry').addEventListener('click', () => { showScreen('remote'); loadRemoteConns(); });
    $('#rc-goto-servers').addEventListener('click', () => { showScreen('list'); guard(loadServers); });
    $('#rc-refresh').addEventListener('click', () => loadRemoteConns());
    $('#rc-add').addEventListener('click', () => openRcEditor(null));
    // мастер
    $('#rc-close').addEventListener('click', () => $('#rc-modal').classList.add('hidden'));
    $('#rc-cancel').addEventListener('click', () => $('#rc-modal').classList.add('hidden'));
    $('#rc-modal').addEventListener('click', (e) => { if (e.target.id === 'rc-modal') $('#rc-modal').classList.add('hidden'); });
    $('#rc-probe').addEventListener('click', rcProbe);
    $('#rc-save').addEventListener('click', rcSave);
    $('#rc-back-step').addEventListener('click', () => rcShowStep(1));
    // модалка выбора сервера удалённой панели
    $('#rc-srv-close').addEventListener('click', () => $('#rc-srv-modal').classList.add('hidden'));
    $('#rc-srv-modal').addEventListener('click', (e) => { if (e.target.id === 'rc-srv-modal') $('#rc-srv-modal').classList.add('hidden'); });
    // смена адреса/порта на шаге 1 обнуляет сверку — пин ставится только по свежему отпечатку
    $('#rc-host').addEventListener('input', () => { rcProbedFp = null; });
    $('#rc-portf').addEventListener('input', () => { rcProbedFp = null; });
    $('#rc-pass-eye').addEventListener('click', () => {
      const p = $('#rc-pass');
      p.type = p.type === 'password' ? 'text' : 'password';
      $('#rc-pass-eye').style.setProperty('--i', "url('/icons/" + (p.type === 'text' ? 'eye-closed' : 'eye') + ".svg')");
    });
  }

  // ---------- экраны ----------

  /* Добавляем запись в историю браузера, чтобы кнопка «назад» переключала
     экраны/вкладки ВНУТРИ панели, а не выкидывала из аккаунта. */
  function pushHash(hash) {
    if (EMBED) return; // окна рабочего стола не трогают общую историю
    if (state.navLock) return;
    const target = hash || location.pathname;
    const cur = (location.hash || '') ? location.hash : location.pathname;
    if (cur === target) return;
    history.pushState(null, '', target);
  }

  function showScreen(name) {
    state.screen = name;
    $('#screen-list').classList.toggle('hidden', name !== 'list');
    $('#screen-create').classList.toggle('hidden', name !== 'create');
    $('#screen-server').classList.toggle('hidden', name !== 'server');
    $('#screen-proxy').classList.toggle('hidden', name !== 'proxy');
    $('#screen-remote').classList.toggle('hidden', name !== 'remote');
    // бургер-меню — на всех экранах
    $('#btn-burger').classList.remove('hidden');
    if (name === 'create') updateJavaInstallUI();
    $('#app-menu').classList.remove('open');
    $('#app-scrim').classList.remove('open');
    $('#burger-ic').classList.remove('open');
    if (name !== 'server' && state.sse) {
      state.sse.close();
      state.sse = null;
    }
    // адрес отражает экран — каждый экран отдельная запись истории
    // (вкладки сервера пушит switchTab)
    if (name === 'list') pushHash('');
    else if (name === 'create') pushHash('#create');
    else if (name === 'proxy') pushHash('#proxy');
    else if (name === 'remote') pushHash('#remote');
  }

  /* Применяем состояние из адреса при нажатии «назад/вперёд» — без выхода из SPA. */
  function routeFromHash() {
    state.navLock = true;
    try {
      const hash = location.hash || '';
      if (hash === '#create') {
        if (state.screen !== 'create') { showScreen('create'); suggestPort(); loadVersions(); }
      } else if (hash === '#proxy') {
        if (state.screen !== 'proxy') { showScreen('proxy'); renderProxyViz(); }
      } else if (hash === '#remote') {
        if (state.screen !== 'remote') { showScreen('remote'); loadRemoteConns(); }
      } else if (hash.indexOf('#server=') === 0) {
        const rest = hash.slice(8);
        const id = rest.split('/tab/')[0].split('/player/')[0];
        const tab = (rest.split('/tab/')[1] || '').split('/')[0] || null;
        if ((state.servers || []).some((s) => s.id === id)) {
          if (state.screen !== 'server' || state.currentId !== id) openServer(id);
          if (tab && tab !== state.currentTab) switchTab(tab);
        } else {
          showScreen('list'); guard(loadServers);
        }
      } else if (state.screen !== 'list') {
        showScreen('list'); guard(loadServers);
      }
    } finally {
      state.navLock = false;
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
      state.externalIp = st.externalIp || null;      // внешний (WAN) IP для подключения друзей
      state.cpuModel = st.cpuModel || null;
      state.platform = st.platform || '';
      state.javaVersion = (st.java && st.java.version) || null;
      state.rootPath = st.root || '';
      if (st.cores) state.cores = st.cores;          // os.cpus() с бэкенда (надёжно и на Linux)
      if (st.totalMemMb) {
        state.totalMemMb = st.totalMemMb;            // реальный объём ОЗУ для подсказок
        state.maxMemMb = Math.max(2048, Math.min(32768, Math.floor((st.totalMemMb - 2048) / 512) * 512));
        if (state.memCreateSlider) state.memCreateSlider.setRange(1024, state.maxMemMb);
      }
      if (state.cpuCreateSlider) state.cpuCreateSlider.refresh(); // обновить «N ядер» в подписи
      $('#about-version').textContent = String(st.app || '').replace('CONTROLGUI', '').trim();
      state.javaAvailable = !!(st.java && st.java.available);
      const alert = $('#java-alert');
      if (state.javaAvailable) {
        alert.classList.add('hidden');
      } else {
        alert.classList.remove('hidden');
        alert.innerHTML = 'Java не найдена! Серверы не запустятся. Скачайте её кнопкой при создании сервера или вручную с <a href="https://adoptium.net" target="_blank" rel="noopener">adoptium.net</a>.';
      }
      updateJavaInstallUI();
    } catch (e) {
      showToast(e.message);
    }
  }

  // ---------- список серверов ----------

  async function loadServers() {
    const data = await API.servers();
    state.servers = data.servers || [];
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

  /* Загрузка приложения. */
  async function bootApp() {
    // окно-редактор: минимальный запуск — только сам редактор, без опросов
    // окно-проводник: файловый менеджер сервера без шапки и вкладок
    if (EMBED_FILES) {
      state.currentId = EMBED_FILES.id;
      $('#screen-server').classList.remove('hidden');
      $('#tab-files').classList.remove('hidden');
      document.title = 'Проводник';
      loadMe();
      loadStatus();
      loadFiles();
      return;
    }
    if (EMBED_EDITOR) {
      state.currentId = EMBED_EDITOR.id;
      $('#screen-server').classList.remove('hidden');
      $('#tab-files').classList.remove('hidden');
      document.title = EMBED_EDITOR.path.split('/').pop() + ' — редактор';
      loadMe();
      await openFileEditor(EMBED_EDITOR.path);
      // файл исчез/стал недоступен (например окно восстановлено из прошлой
      // сессии) — редактор не открылся; просим рабочий стол закрыть окно,
      // иначе останется мёртвое пустое
      if ($('#file-editor').classList.contains('hidden') && window.parent !== window) {
        window.parent.postMessage({ cg: 'close-win', reason: 'editor-failed' }, location.origin);
      }
      return;
    }
    loadMe();
    loadStatus();
    guard(loadServers);
    loadRemoteConns();
    startPolling();
    setInterval(renderConsoleMeta, 1000); // аптайм тикает раз в секунду
    setInterval(syncFiles, 4000);         // автосинхронизация вкладки «Файлы»
    routeInitialHash();
    if (EMBED === 'settings') openAppSettings(); // окно настроек панели
  }
  function routeInitialHash() {
    if (location.hash === '#create') {
      showScreen('create'); loadVersions(); guard(loadServers).then(suggestPort);
    } else if (location.hash === '#remote') {
      showScreen('remote'); loadRemoteConns(); // экран-менеджер удалённых панелей
    } else if (location.hash === '#rc-add') {
      showScreen('remote'); loadRemoteConns(); openRcEditor(null); // диплинк «добавить панель»
    } else if (location.hash === '#proxy') {
      showScreen('proxy'); guard(loadServers).then(() => renderProxyViz());
    } else if (location.hash.startsWith('#server=')) {
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
  }

  // предпочитаемый адрес подключения: внешний (WAN) IP для друзей → LAN → localhost
  function bestHost() {
    return state.externalIp || (state.lanIps && state.lanIps[0]) || 'localhost';
  }

  function renderList() {
    const panel = $('#server-list');
    Array.from(panel.querySelectorAll('.srv-card')).forEach((el) => el.remove());
    $('#list-empty').classList.toggle('hidden', state.servers.length > 0);
    panel.classList.toggle('cols3', state.servers.length > 3);
    renderHomeStats();

    for (const server of state.servers) {
      const card = document.createElement('div');
      card.className = 'srv-card';

      const top = document.createElement('div');
      top.className = 'srv-card-top';
      const icon = document.createElement('img');
      icon.className = 'server-icon';
      icon.src = server.hasIcon ? API.iconUrl(server.id, server.hasIcon) : iconFor(server.id);
      icon.alt = '';
      icon.onerror = () => { icon.onerror = null; icon.src = iconFor(server.id); };
      const id = document.createElement('div');
      id.className = 'srv-card-id';
      const nameEl = document.createElement('div');
      nameEl.className = 'srv-card-name';
      nameEl.textContent = server.name;
      const subEl = document.createElement('div');
      subEl.className = 'srv-card-sub';
      subEl.textContent = (CORE_NAMES[server.type] || server.type) + ' ' + verLabel(server);
      id.appendChild(nameEl);
      id.appendChild(subEl);
      top.appendChild(icon);
      top.appendChild(id);

      // адрес для подключения + копирование
      const addrRow = document.createElement('div');
      addrRow.className = 'srv-card-addr';
      const address = bestHost() + ':' + server.port;
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
    // Без online-mode у игроков offline-UUID (version 3), который Mojang не знает —
    // голова не грузилась. По НИКУ mc-heads резолвит скин (а для неизвестных отдаёт
    // Steve), поэтому настоящий Mojang-UUID (version 4) берём только когда он есть,
    // иначе всегда ник — голова отображается и на пиратских серверах.
    const hex = String(player.uuid || '').replace(/-/g, '');
    const realUuid = hex.length === 32 && hex[12] === '4';
    const key = realUuid ? player.uuid : (player.name || player.uuid);
    return 'https://mc-heads.net/avatar/' + encodeURIComponent(key) + '/' + (size || 36);
  }

  // версия ядра для подписи: реальная версия, иначе аккуратный плейсхолдер
  // (своё ядро / импорт до первого запуска, либо ядро ещё качается)
  function verLabel(server) {
    const v = server && server.version;
    if (v && v !== '-') return v;
    return server && server.status === 'downloading' ? 'загрузка ядра…' : 'версия определится';
  }

  function statusText(server) {
    if (server.status === 'downloading' && server.download) {
      if (server.download.phase === 'installing') return 'Установка ядра...';
      if (server.download.phase === 'downloading') {
        const d = server.download;
        return d.totalBytes ? 'Загрузка ' + Math.round((d.progress || 0) * 100) + '%'
                            : 'Загрузка ' + fmtBytes(d.doneBytes || 0);
      }
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
    const form = $('#create-form');
    const type = $('#core-select').value;
    const isCustom = type === 'custom';
    const isProxy = PROXY_TYPES.includes(type);
    const isImport = isImportOn() && !isProxy && !isCustom;
    if (!isProxy && !isImport && !$('#eula-check').classList.contains('on')) {
      showToast('Нужно принять Minecraft EULA');
      return;
    }
    const coreFile = $('#custom-core-file').files[0];
    const body = {
      name: form.name.value,
      motd: form.motd.value,
      type: type,
      version: isCustom ? '-' : form.version.value,
      port: form.port.value,
      memoryMb: state.memCreateSlider.value,
      cpuPercent: state.cpuCreateSlider ? state.cpuCreateSlider.value : 100,
      gamemode: $('#cycle-gamemode').dataset.value,
      difficulty: $('#cycle-difficulty').dataset.value,
      maxPlayers: form.maxPlayers.value,
      levelSeed: form.levelSeed.value,
      onlineMode: $('#toggle-online').classList.contains('on'),
      pvp: $('#toggle-pvp').classList.contains('on'),
      eulaAccepted: true,
    };
    if (isProxy) {
      body.backends = Array.from($('#backends-list').querySelectorAll('.mc-check.on'))
        .map((c) => c.dataset.id).filter(Boolean);
    }
    if (isImport) {
      if (!$('#import-path').value) { showToast('Выберите папку сервера (кнопка «Обзор»)'); return; }
      body.import = true;
      body.importPath = $('#import-path').value;
      body.importMode = state.importMode === 'inplace' ? 'inplace' : 'copy'; // копировать / на месте
      // выбранный .jar для запуска (если в папке нашлись jar-файлы)
      if (!$('#import-jar-label').classList.contains('hidden') && $('#import-jar').value) {
        body.importJarFile = $('#import-jar').value;
      }
      // авто-определённая версия (иначе определится при первом запуске)
      if (state.importDetected && state.importDetected.version) body.version = state.importDetected.version;
    }
    if (isCustom && !coreFile) { showToast('Выберите файл ядра (.jar)'); return; }
    if (!isCustom && !isImport && !body.version) { showToast('Выберите версию'); return; }
    $('#btn-create').disabled = true;
    try {
      const created = await API.create(body);
      if (isCustom) {
        showToast('Сервер создан, загружаю ваше ядро…', 'ok');
        await API.coreUpload(created.id, coreFile);
        showToast('Своё ядро загружено.', 'ok');
      } else if (isImport) {
        showToast('Сервер «' + created.name + '» импортирован.', 'ok');
      } else {
        showToast('Сервер «' + created.name + '» создан, устанавливаю ядро...', 'ok');
      }
      form.reset();
      $('#custom-core-file').value = '';
      $('#toggle-import').classList.remove('on');
      $('#import-path').value = '';
      $('#import-label').classList.add('hidden');
      $('#import-jar-label').classList.add('hidden');
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
      ['players', () => canAny(['players.kick', 'players.ban', 'players.op', 'players.whitelist', 'players.delete'])],
      ['logs', () => can('logs.view')],
      ['backups', () => canAny(['backups.create', 'backups.restore', 'backups.delete'])],
      ['info', () => true],
    ];
    for (const [tab, ok] of order) { if (ok()) return tab; }
    return 'info';
  }

  function openServer(id) {
    // на рабочем столе сервер открывается ОТДЕЛЬНЫМ окном; собственное окно
    // сервера (go=server/<id>) навигирует как обычно
    if (EMBED && !EMBED.startsWith('server/') && window.parent !== window) {
      const srv = (state.servers || []).find((s) => s.id === id);
      window.parent.postMessage({ cg: 'open', what: 'server', id: id, title: srv ? srv.name : null }, location.origin);
      return;
    }
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
      // перерисовываем вкладку игроков — иначе OP/бан/вайтлист показывают старое состояние после действия
      if (state.currentTab === 'players') renderPlayers(state.current);
    } catch (e) {
      // сервер удалён (строго 404) — убираем из списка, чтобы не висел
      if (e.status === 404) {
        state.servers = (state.servers || []).filter((s) => s.id !== state.currentId);
      }
      showScreen('list');
      showToast(e.message);
      renderList();
    }
  }

  function renderServerHead() {
    const server = state.current;
    if (!server) return;
    $('#server-title').textContent = server.name;
    const headIcon = $('#server-head-icon');
    if (server.hasIcon) { headIcon.src = API.iconUrl(server.id, server.hasIcon); headIcon.classList.remove('hidden'); }
    else { headIcon.classList.add('hidden'); }
    const st = $('#server-status');
    st.className = 'status-badge st-' + server.status;
    st.textContent = statusText(server);
    $('#server-addr').textContent = (CORE_NAMES[server.type] || server.type) + ' ' + verLabel(server) + ' · ' + bestHost() + ':' + server.port;

    const dlWrap = $('#download-wrap');
    const dl = server.download;
    const fill = $('#download-fill');
    if (dl && (dl.phase === 'resolving' || dl.phase === 'downloading' || dl.phase === 'installing')) {
      dlWrap.classList.remove('hidden');
      fill.classList.toggle('indeterminate', dl.phase !== 'downloading' || !dl.totalBytes);
      if (dl.phase === 'downloading') {
        $('#download-label').textContent = dl.totalBytes
          ? 'Загрузка: ' + fmtBytes(dl.doneBytes) + ' / ' + fmtBytes(dl.totalBytes)
          : 'Загрузка: ' + fmtBytes(dl.doneBytes) + ' (размер неизвестен)';
        if (dl.totalBytes) fill.style.width = Math.round((dl.progress || 0) * 100) + '%';
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
    renderConsoleMeta();
    renderPlayers(server);
    applyPermissions();
  }

  function renderInfo(server) {
    const grid = $('#info-grid');
    const running = server.status === 'running' || server.status === 'starting';
    const uptime = (running && server.startedAt) ? fmtDuration(Date.now() - server.startedAt) : '—';
    const ramLine = fmtMem(server.memoryMb) + ' выделено' + (state.totalMemMb ? ' · всего в системе ' + fmtMem(state.totalMemMb) : '');
    const cpuLine = (state.cpuModel ? state.cpuModel : 'CPU') + (state.cores ? ' · ' + state.cores + ' ' + coreWord(state.cores) : '') +
      (server.cpuPercent != null && server.cpuPercent < 100 ? ' · лимит ' + server.cpuPercent + '%' : '');
    const rows = [
      ['Адрес (внешний)', state.externalIp ? state.externalIp + ':' + server.port : '— (не определён)'],
      ['Адрес (локальная сеть)', state.lanIps.length ? state.lanIps.map((ip) => ip + ':' + server.port).join('  ') : '—'],
      ['Адрес (этот ПК)', 'localhost:' + server.port],
      ['Ядро', (CORE_NAMES[server.type] || server.type) + ' ' + verLabel(server)],
      ['Статус', statusText(server) + (running ? ' · аптайм ' + uptime : '') + (server.tps ? ' · TPS ' + server.tps : '')],
      ['Память', ramLine],
      ['Процессор', cpuLine],
      ['Java', server.javaPath ? server.javaPath : (state.javaVersion ? state.javaVersion + ' (авто)' : '—')],
      ['Система', platformName(state.platform)],
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
  function coreWord(n) { const d = n % 10, dd = n % 100; if (d === 1 && dd !== 11) return 'ядро'; if (d >= 2 && d <= 4 && (dd < 12 || dd > 14)) return 'ядра'; return 'ядер'; }
  function platformName(p) { return ({ win32: 'Windows', darwin: 'macOS', linux: 'Linux' })[p] || (p || '—'); }

  // строка над консолью: только аптайм (тикает раз в секунду); TPS и игроки — в графиках
  function renderConsoleMeta() {
    const el = $('#console-meta');
    if (!el) return;
    const s = state.current;
    const live = s && (s.status === 'running' || s.status === 'starting');
    if (!live || !s.startedAt) { el.classList.add('hidden'); el.textContent = ''; return; }
    el.classList.remove('hidden');
    el.textContent = 'Аптайм: ' + fmtDuration(Date.now() - s.startedAt);
  }

  // ---------- метрики процесса (чёткие графики с учётом DPI) ----------

  // accent-цвет графиков почти не меняется — читаем getComputedStyle один раз,
  // а не на каждой перерисовке каждого спарклайна (это форсировало layout-чтения)
  let _accentBright = null;
  function accentBright() {
    if (_accentBright == null) {
      _accentBright = getComputedStyle(document.body).getPropertyValue('--accent-bright').trim() || '#80da5b';
    }
    return _accentBright;
  }

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
    const accent = accentBright();

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
    // TPS-карточку показываем только у ядер, поддерживающих команду tps (Paper-совместимые)
    const paperTps = ['paper', 'purpur', 'folia', 'mohist'].includes(server.type);
    if ($('#stat-card-tps')) $('#stat-card-tps').classList.toggle('hidden', !paperTps);
    if (!active) {
      ['#stat-cpu', '#stat-ram', '#stat-read', '#stat-write', '#stat-players', '#stat-tps'].forEach((id) => { $(id).textContent = '—'; });
      ['#graph-cpu', '#graph-ram', '#graph-read', '#graph-write', '#graph-players', '#graph-tps'].forEach((id) => sparkline(id, [], 1));
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
      if (paperTps) {
        const curTps = (last && last.tps != null) ? last.tps : (server.tps != null ? parseFloat(server.tps) : null);
        $('#stat-tps').textContent = curTps != null ? curTps.toFixed(1) + ' / 20' : 'сбор…';
        // null-точки (до первого замера) заполняем последним известным — линия непрерывна
        let lk = null;
        const tvals = pts.map((p) => { if (p.tps != null) lk = p.tps; return lk; }).filter((v) => v != null);
        sparkline('#graph-tps', tvals, 20);
      }
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

  // оптимистичные оверрайды OP: имя(lc) -> { val:bool, at }. Держим до подтверждения
  // в ops.json или истечения 12 c — чтобы кнопка не «откатывалась» из-за гонки записи
  // ops.json сервером (особенно заметно на загруженных/прокси-серверах).
  function opIsSet(opsSet, nameLc) {
    const o = state.opOverrides && state.opOverrides[nameLc];
    if (o) {
      if (opsSet.has(nameLc) === o.val || Date.now() - o.at > 12000) { delete state.opOverrides[nameLc]; }
      else return o.val;
    }
    return opsSet.has(nameLc);
  }
  // те же оптимистичные оверрайды для бана (banned-players.json пишется сервером с задержкой,
  // без оверрайда бейдж «ЗАБАНЕН»/кнопка «Разбан» мигают из-за гонки чтения файла)
  function bannedIsSet(bannedSet, nameLc) {
    const o = state.banOverrides && state.banOverrides[nameLc];
    if (o) {
      if (bannedSet.has(nameLc) === o.val || Date.now() - o.at > 12000) { delete state.banOverrides[nameLc]; }
      else return o.val;
    }
    return bannedSet.has(nameLc);
  }
  /* Оптимистичное действие над игроком: мгновенно перерисовать + два «догоняющих» рефреша
     (сервер пишет ops/banned/usercache с задержкой — один рефреш часто ловит старый файл). */
  function afterPlayerAction() {
    if (state.current && state.currentTab === 'players') renderPlayers(state.current);
    setTimeout(refreshServer, 600);
    setTimeout(refreshServer, 1800);
  }

  function renderPlayers(server) {
    const panel = $('#players-list');
    const players = mergedPlayers(server.playersInfo);
    const bannedSet = new Set((server.banned || []).map((n) => n.toLowerCase()));
    const opsSet = new Set((server.ops || []).map((n) => n.toLowerCase()));
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
      const banned = bannedIsSet(bannedSet, p.name.toLowerCase());
      const isOp = opIsSet(opsSet, p.name.toLowerCase());
      const nameEl = document.createElement('div');
      nameEl.className = 'player-name';
      const dot = document.createElement('span');
      dot.className = 'dot' + (p.online ? ' on' : '');
      dot.title = p.online ? 'В сети' : 'Не в сети';
      nameEl.appendChild(dot);
      nameEl.appendChild(document.createTextNode(p.name));
      if (isOp) {
        const opBadge = document.createElement('span');
        opBadge.className = 'pl-op';
        opBadge.textContent = 'OP';
        opBadge.title = 'Оператор сервера';
        nameEl.appendChild(opBadge);
      }
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
            const r = await guard(() => API.moderate(state.currentId, 'kick', p.name));
            if (!r) return;
            showToast('Игрок «' + p.name + '» кикнут.', 'ok');
            afterPlayerAction();
          }
        });
        actions.appendChild(kickBtn);
      }

      if (can('players.op')) {
        const opBtn = document.createElement('button');
        opBtn.className = 'mc-btn sm' + (isOp ? '' : ' accent');
        opBtn.appendChild(picon(isOp ? 'user' : 'crown'));
        opBtn.appendChild(document.createTextNode(isOp ? ' Снять OP' : ' Выдать OP'));
        opBtn.title = isOp ? 'Забрать права оператора' : 'Выдать права оператора (op)';
        opBtn.addEventListener('click', async () => {
          const act = isOp ? 'deop' : 'op';
          const q = isOp
            ? 'Снять OP с игрока «' + p.name + '»?'
            : 'Выдать OP игроку «' + p.name + '»?\nОператор получает доступ к админ-командам сервера.';
          if (await confirmDialog(q, { title: isOp ? 'Снять OP' : 'Выдать OP', yesText: isOp ? 'Снять' : 'Выдать', danger: false })) {
            const r = await guard(() => API.moderate(state.currentId, act, p.name));
            if (!r) return; // ошибка уже показана тостом
            showToast(isOp ? 'OP снят с «' + p.name + '».' : '«' + p.name + '» теперь оператор.', 'ok');
            // ставим «липкий» оверрайд: кнопка сразу отражает действие и держится,
            // пока сервер не запишет ops.json (а не откатывается из-за гонки чтения)
            if (!state.opOverrides) state.opOverrides = {};
            state.opOverrides[p.name.toLowerCase()] = { val: act === 'op', at: Date.now() };
            if (state.current && state.currentTab === 'players') renderPlayers(state.current);
            setTimeout(refreshServer, 1500); // подтянуть реальный ops.json (оверрайд снимется при совпадении)
          }
        });
        actions.appendChild(opBtn);
      }

      if (can('players.ban')) {
        if (banned) {
          const pardonBtn = document.createElement('button');
          pardonBtn.className = 'mc-btn sm primary';
          pardonBtn.appendChild(picon('check'));
          pardonBtn.appendChild(document.createTextNode(' Разбан'));
          pardonBtn.addEventListener('click', async () => {
            if (await confirmDialog('Разбанить игрока «' + p.name + '»?', { title: 'Разбан', yesText: 'Разбанить', danger: false })) {
              const r = await guard(() => API.moderate(state.currentId, 'pardon', p.name));
              if (!r) return;
              showToast('Игрок «' + p.name + '» разбанен.', 'ok');
              if (!state.banOverrides) state.banOverrides = {};
              state.banOverrides[p.name.toLowerCase()] = { val: false, at: Date.now() };
              afterPlayerAction();
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
              const r = await guard(() => API.moderate(state.currentId, 'ban', p.name));
              if (!r) return;
              showToast('Игрок «' + p.name + '» забанен.', 'ok');
              if (!state.banOverrides) state.banOverrides = {};
              state.banOverrides[p.name.toLowerCase()] = { val: true, at: Date.now() };
              afterPlayerAction();
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
            if (state.banOverrides) delete state.banOverrides[p.name.toLowerCase()];
            if (state.opOverrides) delete state.opOverrides[p.name.toLowerCase()];
            afterPlayerAction();
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

  function invCell(item, label, bases, slot) {
    const cell = document.createElement('div');
    cell.className = 'inv-cell' + (item ? '' : ' empty');
    if (slot !== undefined && state.invEdit && state.invEdit.editable) {
      cell.dataset.slot = slot;
      cell.classList.add('editable');
      if (state.invEdit.selected === slot) cell.classList.add('sel');
      cell.addEventListener('click', () => onInvCellClick(slot));
    }
    if (item) {
      cell.title = item.id.replace(/_/g, ' ') + (item.count > 1 ? ' ×' + item.count : '');
      const img = document.createElement('img');
      img.className = 'it-img';
      img.alt = '';
      img.loading = 'lazy';
      // основной источник — игровой рендер нужной версии (затем полный
      // рендер-каталог, если папка версии неполная); дальше плоские
      // текстуры (и грани составных блоков); в самом конце — текст
      const candidates = [];
      if (bases && bases.render) candidates.push(bases.render + 'minecraft_' + item.id + '.png');
      if (bases && bases.render2) candidates.push(bases.render2 + 'minecraft_' + item.id + '.png');
      const texStart = candidates.length; // с этого индекса идут пиксельные 16x16-текстуры
      const tex = (bases && bases.tex) || (ICON_TEX_HOST + '1.21.4/assets/minecraft/textures/');
      candidates.push(
        tex + 'item/' + item.id + '.png',
        tex + 'block/' + item.id + '.png',
        tex + 'block/' + item.id + '_front.png',
        tex + 'block/' + item.id + '_top.png',
        tex + 'block/' + item.id + '_side.png'
      );
      let attempt = 0;
      // рендеры 64x64 уменьшаем со сглаживанием, пиксель-арт 16x16 — без него
      const applyMode = () => img.classList.toggle('pix', attempt >= texStart);
      applyMode();
      img.src = candidates[attempt];
      img.onerror = () => {
        attempt++;
        if (attempt < candidates.length) {
          applyMode();
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
      // подсказка о предмете показывается ПРИ НАВЕДЕНИИ (как в Minecraft), следует за курсором
      cell.removeAttribute('title');
      cell.addEventListener('mouseenter', (event) => showItemTooltip(item, event.clientX, event.clientY));
      cell.addEventListener('mousemove', (event) => moveItemTooltip(event.clientX, event.clientY));
      cell.addEventListener('mouseleave', hideItemTooltip);
    } else if (label) {
      cell.title = label;
    }
    return cell;
  }

  // ---------- всплывающая карточка предмета (Minecraft-стиль) ----------

  const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
  function roman(n) { return (n >= 1 && n <= 10) ? ROMAN[n] : String(n); }

  function prettyItemName(id) {
    // официальное русское название предмета/блока (ru_ru), иначе — из id
    const ru = window.ITEM_NAMES_RU && window.ITEM_NAMES_RU[id];
    if (ru) return ru;
    return String(id).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  let itemTip = null;
  function hideItemTooltip() { if (itemTip) { itemTip.remove(); itemTip = null; } }

  function showItemTooltip(item, x, y) {
    hideItemTooltip();
    if (!item) return;
    const tip = document.createElement('div');
    tip.className = 'item-tip';

    const nameEl = document.createElement('div');
    nameEl.className = 'it-name' + (item.name ? ' custom' : '');
    nameEl.textContent = item.name || prettyItemName(item.id);
    tip.appendChild(nameEl);

    for (const e of item.enchants || []) {
      const en = document.createElement('div');
      en.className = 'it-ench' + (e.stored ? ' stored' : '');
      en.textContent = e.name + (e.level ? ' ' + roman(e.level) : '');
      tip.appendChild(en);
    }

    for (const l of item.lore || []) {
      const lo = document.createElement('div');
      lo.className = 'it-lore';
      lo.textContent = l;
      tip.appendChild(lo);
    }

    if (item.unbreakable) {
      const u = document.createElement('div');
      u.className = 'it-attr';
      u.textContent = 'Неразрушимый';
      tip.appendChild(u);
    }
    if (item.damage != null) {
      const d = document.createElement('div');
      d.className = 'it-attr';
      d.textContent = 'Повреждение: ' + item.damage;
      tip.appendChild(d);
    }
    if (item.count > 1) {
      const c = document.createElement('div');
      c.className = 'it-attr';
      c.textContent = 'Количество: ' + item.count;
      tip.appendChild(c);
    }

    const idEl = document.createElement('div');
    idEl.className = 'it-id';
    idEl.textContent = 'minecraft:' + item.id;
    tip.appendChild(idEl);

    if (item.nbt) {
      const nb = document.createElement('div');
      nb.className = 'it-nbt';
      nb.textContent = 'NBT: ' + item.nbt;
      tip.appendChild(nb);
    }

    document.body.appendChild(tip);
    itemTip = tip;
    moveItemTooltip(x, y);
  }
  // позиционируем подсказку у курсора, не вылезая за экран
  function moveItemTooltip(x, y) {
    if (!itemTip) return;
    const pad = 12;
    const rect = itemTip.getBoundingClientRect();
    let left = x + 14;
    let top = y + 14;
    if (left + rect.width + pad > window.innerWidth) left = Math.max(pad, x - rect.width - 14);
    if (top + rect.height + pad > window.innerHeight) top = Math.max(pad, window.innerHeight - rect.height - pad);
    itemTip.style.left = left + 'px';
    itemTip.style.top = top + 'px';
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
    if (state.invEdit) { state.invEdit.selected = null; state.invEdit.statOpen = false; }
    hideItemTooltip();
  }

  /* снимок значимых данных: модалка перерисовывается ТОЛЬКО при изменении
     (lastPlayed/время сессии в снимок не входят — они меняются всегда) */
  function playerSnapshot(d) {
    return JSON.stringify({
      online: d.online, realtime: d.realtime, hp: d.health, hpMax: d.maxHealth, food: d.food,
      xp: d.xpLevel, pos: d.pos, dim: d.dimension, inv: d.inventory,
      time: d.playTimeTicks, fj: d.firstJoinAt, lj: d.lastJoinAt, ips: d.ips, uuid: d.uuid,
    });
  }

  async function openInventory(name) {
    if (state.invTimer) { clearInterval(state.invTimer); state.invTimer = null; }
    state.invEdit = { name: name, editable: can('console.command'), selected: null, busy: false, statOpen: false, data: null };
    const seq = (state.invSeq = (state.invSeq || 0) + 1);
    // каркас модалки с лоадером показываем сразу — данные могут идти секунды
    $('#inv-title').textContent = 'Игрок: ' + name;
    const body = $('#inv-body');
    body.innerHTML = '';
    const load = document.createElement('div');
    load.className = 'inv-loading';
    const sq = document.createElement('div');
    sq.className = 'mc-loader';
    const note = document.createElement('div');
    note.className = 'load-note';
    note.textContent = 'Загружаем данные игрока…';
    load.appendChild(sq);
    load.appendChild(note);
    body.appendChild(load);
    $('#inv-root').classList.remove('hidden');
    await guard(async () => {
      const data = await API.player(state.currentId, name);
      const bases = await resolveIconBases(state.current ? state.current.version : '');
      // пока грузились, модалку закрыли или открыли другого игрока
      if (seq !== state.invSeq || $('#inv-root').classList.contains('hidden')) return;
      buildPlayerModal(name, data, bases);
      state.invSnapshot = playerSnapshot(data);
      // онлайн-игрок: тихо опрашиваем, но DOM трогаем только при изменениях
      if (data.online) {
        state.invTimer = setInterval(async () => {
          if ($('#inv-root').classList.contains('hidden')) { closeInventory(); return; }
          const ed = state.invEdit;
          if (ed && (ed.selected != null || ed.statOpen || ed.busy)) return; // идёт редактирование — не перерисовываем
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
    // guard проглотил ошибку в тост — не оставляем модалку с вечным лоадером
    if (seq === state.invSeq && $('#inv-body .inv-loading')) closeInventory();
  }

  /* перезапрашивает данные и перестраивает модалку (после успешной правки) */
  async function refreshPlayerModal() {
    const ed = state.invEdit;
    if (!ed || !ed.name) return;
    const data = await API.player(state.currentId, ed.name);
    const bases = await resolveIconBases(state.current ? state.current.version : '');
    if ($('#inv-root').classList.contains('hidden')) return;
    state.invSnapshot = playerSnapshot(data);
    buildPlayerModal(ed.name, data, bases);
  }

  function updateSelectionUi() {
    const sel = state.invEdit ? state.invEdit.selected : null;
    document.querySelectorAll('#inv-body .inv-cell').forEach((c) => {
      c.classList.toggle('sel', c.dataset.slot != null && sel != null && Number(c.dataset.slot) === sel);
    });
    const bar = $('#inv-editbar');
    if (bar) bar.classList.toggle('hidden', sel == null);
  }

  /* клик по слоту: выбрать предмет -> кликнуть слот-назначение (перемещение/обмен) */
  async function onInvCellClick(slot) {
    const ed = state.invEdit;
    if (!ed || ed.busy || !ed.data) return;
    const bySlot = new Map();
    for (const it of (ed.data.inventory || [])) bySlot.set(it.slot, it);
    if (ed.selected == null) {
      if (!bySlot.has(slot)) return; // пустой слот выбирать нечего
      ed.selected = slot;
      updateSelectionUi();
      return;
    }
    if (ed.selected === slot) { ed.selected = null; updateSelectionUi(); return; }
    const from = ed.selected;
    if (bySlot.has(slot) && ed.data.online) {
      showToast('Слот занят: поменять предметы местами можно только когда игрок оффлайн');
      return;
    }
    ed.busy = true;
    try {
      await API.playerEdit(state.currentId, { name: ed.name, op: 'move', from: from, to: slot });
    } catch (e) {
      showToast(e.message);
      ed.busy = false;
      updateSelectionUi();
      return;
    }
    ed.selected = null;
    // правка применена; если обновление данных сорвалось — честно скажем об этом
    try { await refreshPlayerModal(); }
    catch (e) { showToast('Изменение применено, но обновить окно не удалось — переоткройте его'); }
    ed.busy = false;
    updateSelectionUi();
  }

  async function deleteSelectedItem() {
    const ed = state.invEdit;
    if (!ed || ed.busy || ed.selected == null) return;
    ed.busy = true;
    try {
      await API.playerEdit(state.currentId, { name: ed.name, op: 'delete', slot: ed.selected });
    } catch (e) {
      showToast(e.message);
      ed.busy = false;
      updateSelectionUi();
      return;
    }
    ed.selected = null;
    try { await refreshPlayerModal(); }
    catch (e) { showToast('Изменение применено, но обновить окно не удалось — переоткройте его'); }
    ed.busy = false;
    updateSelectionUi();
  }

  /* строка карточки со значением и карандашом; клик — инлайн-ввод числа */
  function editRow(grid, iconName, key, valueText, edit) {
    const kEl = document.createElement('div');
    kEl.className = 'k';
    kEl.appendChild(picon(iconName));
    kEl.appendChild(document.createTextNode(key));
    const vEl = document.createElement('div');
    vEl.className = 'v-edit';
    const span = document.createElement('span');
    span.textContent = valueText;
    vEl.appendChild(span);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'inv-editbtn';
    btn.appendChild(picon('edit'));
    if (edit.disabledReason) { btn.disabled = true; btn.title = edit.disabledReason; }
    else btn.title = edit.title || 'Изменить';
    btn.addEventListener('click', () => openStatInput(vEl, span, btn, edit));
    vEl.appendChild(btn);
    grid.appendChild(kEl);
    grid.appendChild(vEl);
  }

  function openStatInput(vEl, span, btn, edit) {
    const ed = state.invEdit;
    if (!ed || ed.busy || ed.statOpen) return;
    ed.statOpen = true;
    span.classList.add('hidden');
    btn.classList.add('hidden');
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'inv-statinput';
    input.min = edit.min; input.max = edit.max; input.step = edit.step || 1;
    input.value = edit.value != null ? edit.value : '';
    const ok = document.createElement('button');
    ok.type = 'button'; ok.className = 'inv-editbtn ok'; ok.title = 'Сохранить';
    ok.appendChild(picon('check'));
    const cancel = document.createElement('button');
    cancel.type = 'button'; cancel.className = 'inv-editbtn'; cancel.title = 'Отмена';
    cancel.appendChild(picon('close'));
    const closeInput = () => {
      input.remove(); ok.remove(); cancel.remove();
      span.classList.remove('hidden'); btn.classList.remove('hidden');
      ed.statOpen = false;
    };
    cancel.addEventListener('click', closeInput);
    ok.addEventListener('click', async () => {
      // пустое поле нельзя пропускать: Number('') === 0 — так можно
      // нечаянно обнулить игроку опыт или сытость
      const v = Number(input.value);
      if (String(input.value).trim() === '' || !isFinite(v)) { showToast('Введите число'); return; }
      ed.busy = true;
      try {
        await API.playerEdit(state.currentId, Object.assign({ name: ed.name, op: 'stats' }, edit.payload(v)));
      } catch (e) {
        showToast(e.message);
        ed.busy = false;
        return;
      }
      closeInput();
      try { await refreshPlayerModal(); }
      catch (e) { showToast('Изменение применено, но обновить окно не удалось — переоткройте его'); }
      ed.busy = false;
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') ok.click();
      if (e.key === 'Escape') cancel.click();
    });
    vEl.appendChild(input);
    vEl.appendChild(ok);
    vEl.appendChild(cancel);
    input.focus();
    input.select();
  }

  function buildPlayerModal(name, data, bases) {
    {
      if (state.invEdit) {
        state.invEdit.data = data;
        // перестройка уничтожает открытый инлайн-ввод — сбрасываем флаг,
        // иначе карандаши перестанут работать, а опрос замрёт
        state.invEdit.statOpen = false;
      }
      const editable = !!(state.invEdit && state.invEdit.editable);
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
      const maxHp = data.maxHealth != null ? data.maxHealth : 20;
      if (data.xpLevel != null) {
        if (editable) editRow(meta, 'chart-bar', 'Опыт', 'уровень ' + data.xpLevel, {
          value: data.xpLevel, min: 0, max: 24791, step: 1, title: 'Изменить уровень опыта',
          payload: (v) => ({ xpLevel: Math.round(v) }),
        });
        else metaRow(meta, 'chart-bar', 'Опыт', 'уровень ' + data.xpLevel);
      }
      if (data.health != null) {
        if (editable) editRow(meta, 'zap', 'Здоровье', data.health + ' / ' + maxHp, {
          value: maxHp, min: 1, max: 1024, step: 0.5, title: 'Изменить макс. здоровье',
          payload: (v) => ({ maxHealth: v }),
        });
        else metaRow(meta, 'zap', 'Здоровье', data.health + ' / ' + maxHp);
      }
      if (data.food != null) {
        if (editable) editRow(meta, 'minus', 'Сытость', data.food + ' / 20', {
          value: data.food, min: 0, max: 20, step: 1, title: 'Изменить сытость',
          disabledReason: data.online ? 'Сытость можно менять только когда игрок оффлайн' : null,
          payload: (v) => ({ food: Math.round(v) }),
        });
        else metaRow(meta, 'minus', 'Сытость', data.food + ' / 20');
      }
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
        for (const [slot, label] of ARMOR_SLOTS) armorGrid.appendChild(invCell(bySlot.get(slot), label, bases, slot));
        main.appendChild(armorGrid);

        main.appendChild(mkSec('folder', 'Инвентарь'));
        const mainGrid = document.createElement('div');
        mainGrid.className = 'inv-grid';
        for (let slot = 9; slot <= 35; slot++) mainGrid.appendChild(invCell(bySlot.get(slot), null, bases, slot));
        main.appendChild(mainGrid);

        main.appendChild(mkSec('command', 'Хотбар'));
        const hotGrid = document.createElement('div');
        hotGrid.className = 'inv-grid';
        for (let slot = 0; slot <= 8; slot++) hotGrid.appendChild(invCell(bySlot.get(slot), null, bases, slot));
        main.appendChild(hotGrid);

        if (editable) {
          // панель действий для выбранного предмета
          const bar = document.createElement('div');
          bar.id = 'inv-editbar';
          bar.className = 'inv-editbar' + (state.invEdit.selected == null ? ' hidden' : '');
          const txt = document.createElement('span');
          txt.className = 'inv-edithint';
          txt.textContent = 'Предмет выбран — кликните слот, куда его переложить';
          const del = document.createElement('button');
          del.className = 'mc-btn sm danger';
          del.appendChild(picon('trash'));
          del.appendChild(document.createTextNode('Удалить'));
          del.addEventListener('click', deleteSelectedItem);
          const cancelSel = document.createElement('button');
          cancelSel.className = 'mc-btn sm';
          cancelSel.textContent = 'Отмена';
          cancelSel.addEventListener('click', () => { state.invEdit.selected = null; updateSelectionUi(); });
          bar.appendChild(txt);
          bar.appendChild(del);
          bar.appendChild(cancelSel);
          main.appendChild(bar);
        }

        const hint = document.createElement('div');
        hint.className = 'inv-empty-note';
        hint.textContent = (data.realtime
          ? 'Данные в реальном времени — обновляются каждые 3 секунды.'
          : 'Данные из сохранения мира — для игрока в сети обновляются при автосохранении.')
          + (editable ? ' Клик по предмету — выбрать для перемещения или удаления.' : '');
        main.appendChild(hint);
      }

      flex.appendChild(side);
      flex.appendChild(main);
      body.appendChild(flex);

      if (data.playTimeTicks != null) state.playTimes[name] = data.playTimeTicks;
    }
  }

  // ---------- консоль ----------

  function updateConsoleJump() {
    const c = $('#console'); const btn = $('#console-jump');
    if (!c || !btn) return;
    // та же граница, что и авто-прокрутка в appendConsoleLine (порог 40px)
    const atBottom = c.scrollTop + c.clientHeight >= c.scrollHeight - 40;
    btn.classList.toggle('hidden', atBottom);
  }

  function connectConsole(id) {
    if (state.sse) state.sse.close();
    const consoleEl = $('#console');
    // однократно вешаем слушатель прокрутки и клик по кнопке «к последним»
    if (!consoleEl.dataset.jumpBound) {
      consoleEl.dataset.jumpBound = '1';
      consoleEl.addEventListener('scroll', updateConsoleJump);
      const jump = $('#console-jump');
      if (jump) jump.addEventListener('click', () => {
        consoleEl.scrollTop = consoleEl.scrollHeight; updateConsoleJump();
      });
    }
    consoleEl.innerHTML = '';
    updateConsoleJump();
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
    updateConsoleJump();
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
    // подсказываем имя команды и БЕЗ ведущего «/» (пишешь «sa» → предлагает say и т.п.);
    // только пока не введён пробел (дальше уже аргументы, а не имя команды)
    if (value.includes(' ')) { hideSuggest(); return; }
    let prefix = value.startsWith('/') ? value.slice(1) : value;
    prefix = prefix.toLowerCase();
    if (!prefix) { hideSuggest(); return; } // пусто — не вываливаем весь список
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
      name.textContent = cmd;
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
    // подставляем имя команды без «/» (команды и так отправляются без него)
    input.value = cmd + ' ';
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
        input.value = state.sugItems[state.sugIndex];
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

  /* Слепок редактируемых значений вкладки «Настройки» — для отслеживания
     несохранённых изменений (слайдеры/тоглы — кастомные виджеты без нативных
     input-событий, поэтому сравниваем снимки, а не слушаем input). */
  function snapshotSettings() {
    if ((state.propsMode || 'fields') === 'raw') {
      const ta = $('#settings-raw');
      return 'raw:' + (ta ? ta.value : '');
    }
    const parts = [];
    parts.push('mem:' + (state.memSettingsSlider ? state.memSettingsSlider.value : ''));
    parts.push('cpu:' + (state.cpuSettingsSlider ? state.cpuSettingsSlider.value : ''));
    parts.push('java:' + (state.javaSelectEl ? state.javaSelectEl.value : ''));
    for (const el of $$('#settings-known [data-prop-key]')) {
      parts.push(el.dataset.propKey + '=' + (el._getValue ? el._getValue() : ''));
    }
    return 'fields:' + parts.join('\n');
  }
  function markSettingsClean() { state.settingsBaseline = snapshotSettings(); }
  function isSettingsDirty() {
    return state.settingsBaseline != null && snapshotSettings() !== state.settingsBaseline;
  }

  async function loadSettings() {
    if (!state.currentId) return;
    try {
      const data = await API.properties(state.currentId);
      renderSettings(data);
      populateLaunchCard(data);
      applyPropsModeUI();
      if ((state.propsMode || 'fields') === 'raw') await loadRawProps();
      markSettingsClean(); // базовый снимок после заполнения редактируемой формы
      renderIconCard();
      loadRpCard();
      renderCoreCard();
      renderProxyCard();
    } catch (e) {
      showToast(e.message);
    }
  }

  // карточка «Подключение к прокси» в настройках backend-сервера
  async function renderProxyCard() {
    const card = $('#proxy-card');
    if (!card) return;
    const srv = state.current || {};
    // прокси/без прав — карточку прячем
    if (PROXY_TYPES.includes(srv.type) || !can('settings.edit')) { card.classList.add('hidden'); return; }
    const forId = state.currentId;
    let info;
    try { info = await API.proxyLinkGet(forId); } catch (e) { card.classList.add('hidden'); return; }
    if (forId !== state.currentId) return;
    if (!info.canBackend) { card.classList.add('hidden'); return; } // ядро нельзя за прокси
    card.classList.remove('hidden');
    $('#proxy-err').textContent = '';
    const sel = $('#proxy-select');
    sel.innerHTML = '';
    if (!info.proxies.length) {
      $('#proxy-info').textContent = 'Прокси-серверов пока нет. Создайте Velocity или BungeeCord, затем подключите к нему этот сервер.';
      sel.classList.add('hidden'); $('#proxy-attach').classList.add('hidden'); $('#proxy-detach').classList.add('hidden');
      $('#proxy-attached').classList.add('hidden');
      return;
    }
    sel.classList.remove('hidden');
    for (const p of info.proxies) {
      const o = document.createElement('option'); o.value = p.id;
      o.textContent = p.name + ' (' + (CORE_NAMES[p.type] || p.type) + ')';
      sel.appendChild(o);
    }
    const attached = info.attachedTo;
    $('#proxy-attached').classList.toggle('hidden', !attached);
    if (attached) { $('#proxy-attached-name').textContent = info.attachedName || '—'; sel.value = attached; }
    $('#proxy-info').textContent = attached
      ? 'Этот сервер подключён к прокси. Можно сменить прокси (выбрать другой и «Подключить») или отключить.'
      : 'Подключите этот сервер к прокси, чтобы игроки заходили через него.';
    $('#proxy-attach').classList.remove('hidden');
    $('#proxy-attach').innerHTML = ''; $('#proxy-attach').appendChild(picon('check'));
    $('#proxy-attach').appendChild(document.createTextNode(attached ? ' Сменить/подключить' : ' Подключить'));
    $('#proxy-detach').classList.toggle('hidden', !attached);
  }
  async function proxyLink(action) {
    if (!state.currentId) return;
    const err = $('#proxy-err'); err.className = 'err'; err.textContent = '';
    const proxyId = action === 'attach' ? $('#proxy-select').value : null;
    if (action === 'attach' && !proxyId) { err.textContent = 'Выберите прокси.'; return; }
    const name = action === 'attach' ? ($('#proxy-select').selectedOptions[0] || {}).textContent : '';
    const q = action === 'attach'
      ? 'Подключить сервер «' + (state.current && state.current.name) + '» к прокси «' + name + '»?\nСервер перейдёт в proxy-режим (online-mode выключится).'
      : 'Отключить сервер от прокси? Вернётся обычный режим (online-mode включится).';
    if (!await confirmDialog(q, { title: 'Прокси', yesText: action === 'attach' ? 'Подключить' : 'Отключить', danger: action === 'detach' })) return;
    try {
      const r = await API.proxyLinkSet(state.currentId, proxyId, action);
      showToast(r.attachedTo ? 'Сервер подключён к прокси. Перезапустите сервер и прокси.' : 'Сервер отключён от прокси. Перезапустите сервер.', 'ok');
      renderProxyCard();
    } catch (e) { err.className = 'err'; err.textContent = e.message; showToast(e.message); }
  }

  // ---------- ядро сервера (повторное скачивание / своё ядро) ----------

  function renderCoreCard() {
    const card = $('#core-card');
    if (!card) return;
    const srv = state.current || {};
    const isCustom = srv.type === 'custom';
    // карточка доступна тем, кто может ставить ядро или создавать серверы
    const canManage = can('server.install') || can('server.create');
    card.classList.toggle('hidden', !canManage);
    $('#core-current').textContent = (CORE_NAMES[srv.type] || srv.type || '—') + ' ' + (srv.version || '–');
    // «скачать заново» — только для скачиваемых ядер (не для своего jar)
    $('#core-redownload').classList.toggle('hidden', isCustom || !can('server.install'));
    $('#core-upload-btn').classList.toggle('hidden', !can('server.create'));
  }

  async function redownloadCore() {
    if (!state.currentId) return;
    const srv = state.current || {};
    if (srv.status === 'running' || srv.status === 'starting') { showToast('Сначала остановите сервер'); return; }
    const ok = await confirmDialog(
      'Скачать ядро ' + (CORE_NAMES[srv.type] || srv.type) + ' ' + (srv.version || '') + ' заново? Текущий файл ядра будет заменён.',
      { title: 'Скачать ядро заново', yesText: 'Скачать', danger: false });
    if (!ok) return;
    await guard(async () => {
      state.current = await API.download(state.currentId);
      renderServerHead();
      renderCoreCard();
      showToast('Скачивание ядра началось — следите в консоли/шапке.', 'ok');
    });
  }

  async function uploadCore(file) {
    if (!file || !state.currentId) return;
    if (!/\.jar$/i.test(file.name)) { showToast('Нужен файл ядра .jar'); return; }
    const srv = state.current || {};
    if (srv.status === 'running' || srv.status === 'starting') { showToast('Сначала остановите сервер'); return; }
    if (!(await confirmDialog('Заменить ядро сервера файлом «' + file.name + '»? Версия определится автоматически.',
      { title: 'Своё ядро', yesText: 'Загрузить', danger: false }))) return;
    await guard(async () => {
      showToast('Загружаю ядро…', 'ok');
      state.current = await API.coreUpload(state.currentId, file);
      renderServerHead();
      renderCoreCard();
      loadServers();
      showToast('Своё ядро загружено.', 'ok');
    });
  }

  // ---------- иконка сервера ----------

  function renderIconCard() {
    const srv = state.current || {};
    const prev = $('#icon-preview');
    const has = !!srv.hasIcon;
    if (has) { prev.src = API.iconUrl(srv.id, srv.hasIcon); prev.classList.remove('empty'); }
    else { prev.removeAttribute('src'); prev.classList.add('empty'); }
    $('#icon-remove-btn').classList.toggle('hidden', !has);
    // только при праве на изменение настроек
    $('#icon-card').classList.toggle('hidden', !can('settings.edit'));
  }

  /* Сжать выбранную картинку до 64×64 PNG (формат server-icon.png) на canvas. */
  function resizeIcon(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        const canvas = document.createElement('canvas');
        canvas.width = 64; canvas.height = 64;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.clearRect(0, 0, 64, 64);
        // вписываем картинку целиком (contain) по центру
        const scale = Math.min(64 / img.width, 64 / img.height);
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        ctx.drawImage(img, (64 - w) / 2, (64 - h) / 2, w, h);
        canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Не удалось обработать картинку')), 'image/png');
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Не удалось прочитать картинку')); };
      img.src = url;
    });
  }

  async function uploadServerIcon(file) {
    if (!file || !state.currentId) return;
    await guard(async () => {
      const blob = await resizeIcon(file);
      await API.iconUpload(state.currentId, blob);
      showToast('Иконка сервера обновлена (64×64).', 'ok');
      state.current = await API.server(state.currentId);
      renderServerHead();
      renderIconCard();
      loadServers();
    });
  }

  async function removeServerIcon() {
    if (!state.currentId) return;
    if (!(await confirmDialog('Убрать иконку сервера?', { title: 'Иконка', yesText: 'Убрать' }))) return;
    await guard(async () => {
      await API.iconDelete(state.currentId);
      showToast('Иконка убрана.', 'ok');
      state.current = await API.server(state.currentId);
      renderServerHead();
      renderIconCard();
      loadServers();
    });
  }

  // ---------- текстурпак (ресурспак) ----------

  async function loadRpCard() {
    const card = $('#rp-card');
    if (!card) return;
    card.classList.toggle('hidden', !can('settings.edit'));
    if (!can('settings.edit') || !state.currentId) return;
    try {
      const info = await API.resourcePack(state.currentId);
      const stateEl = $('#rp-state');
      if (info.has) {
        stateEl.textContent = 'Текстурпак задан · ' + fmtBytes(info.size) +
          (info.url ? ' · раздаётся по ' + info.url : '');
        $('#rp-remove-btn').classList.remove('hidden');
        $('#rp-require').classList.toggle('on', !!info.required);
        $('#rp-drop-title').textContent = 'Перетащите другой .zip, чтобы заменить';
      } else {
        stateEl.textContent = 'Текстурпак не задан';
        $('#rp-remove-btn').classList.add('hidden');
        $('#rp-drop-title').textContent = 'Перетащите .zip сюда или нажмите, чтобы выбрать';
      }
    } catch (e) { /* статус не критичен */ }
  }

  async function uploadResourcePack(file) {
    if (!file || !state.currentId) return;
    if (!/\.zip$/i.test(file.name)) { showToast('Нужен .zip-архив текстурпака'); return; }
    const required = $('#rp-require').classList.contains('on');
    await guard(async () => {
      $('#rp-state').textContent = 'Загрузка текстурпака…';
      await API.resourcePackUpload(state.currentId, file, required);
      showToast('Текстурпак применён. Перезапустите сервер, чтобы он раздавался игрокам.', 'ok');
      loadRpCard();
      loadSettings();
    });
  }

  async function removeResourcePack() {
    if (!state.currentId) return;
    if (!(await confirmDialog('Убрать текстурпак с сервера?', { title: 'Текстурпак', yesText: 'Убрать' }))) return;
    await guard(async () => {
      await API.resourcePackDelete(state.currentId);
      showToast('Текстурпак убран.', 'ok');
      loadRpCard();
      loadSettings();
    });
  }

  // ---------- плагины и моды (Modrinth) ----------

  function fmtCount(n) {
    n = Number(n) || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace('.0', '') + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace('.0', '') + 'k';
    return String(n);
  }
  function cap(s) { return String(s).charAt(0).toUpperCase() + String(s).slice(1); }

  const CONTENT = {
    plugins: {
      word: 'плагин', wordGen: 'плагинов', folder: 'plugins',
      els: { q: '#pl-query', cat: '#pl-category', sort: '#pl-sort', results: '#pl-results',
        pager: '#pl-pager', prev: '#pl-prev', next: '#pl-next', count: '#pl-count', pages: '#pl-pages',
        installed: '#pl-installed', info: '#pl-info', body: '#pl-body', collapse: '#pl-collapse',
        collapseHint: '#pl-collapse-hint' },
      collapseKey: 'cg-collapse-plugins',
      api: {
        search: (id, opts) => API.pluginsSearch(id, opts),
        install: (id, pid) => API.pluginInstall(id, pid),
        details: (id, pid) => API.pluginDetails(id, pid),
        list: (id) => API.pluginsList(id),
        del: (id, f) => API.pluginDelete(id, f),
        toggle: (id, f) => API.pluginToggle(id, f),
      },
    },
    mods: {
      word: 'мод', wordGen: 'модов', folder: 'mods',
      els: { q: '#md-query', cat: '#md-category', sort: '#md-sort', results: '#md-results',
        pager: '#md-pager', prev: '#md-prev', next: '#md-next', count: '#md-count', pages: '#md-pages',
        installed: '#md-installed', info: '#md-info', body: '#md-body', collapse: '#md-collapse',
        collapseHint: '#md-collapse-hint' },
      collapseKey: 'cg-collapse-mods',
      api: {
        search: (id, opts) => API.modsSearch(id, opts),
        install: (id, pid) => API.modInstall(id, pid),
        details: (id, pid) => API.modDetails(id, pid),
        list: (id) => API.modsList(id),
        del: (id, f) => API.modDelete(id, f),
        toggle: (id, f) => API.modToggle(id, f),
      },
    },
  };
  const contentNav = { plugins: { offset: 0, limit: 20, total: 0, seq: 0, hits: [], baseNames: [] }, mods: { offset: 0, limit: 20, total: 0, seq: 0, hits: [], baseNames: [] } };

  function setContentCollapsed(kind, collapsed) {
    const cfg = CONTENT[kind];
    $(cfg.els.body).classList.toggle('hidden', collapsed);
    $(cfg.els.collapse).classList.toggle('collapsed', collapsed);
    const hint = $(cfg.els.collapseHint);
    if (hint) hint.textContent = collapsed ? 'развернуть' : '';
    try { localStorage.setItem(cfg.collapseKey, collapsed ? '1' : '0'); } catch (e) { /* приватный режим */ }
  }
  function isContentCollapsed(kind) {
    try { return localStorage.getItem(CONTENT[kind].collapseKey) === '1'; } catch (e) { return false; }
  }

  function loadContent(kind) {
    const cfg = CONTENT[kind];
    const srv = state.current || {};
    const info = $(cfg.els.info);
    if (info) {
      info.textContent = 'Листайте каталог или ищите ' + cfg.wordGen + ' под ' + (CORE_NAMES[srv.type] || srv.type) +
        ' ' + (srv.version || '–') + ' — файл скачивается с Modrinth прямо в папку ' + cfg.folder + '/. Применяется после перезапуска.';
    }
    setContentCollapsed(kind, isContentCollapsed(kind));
    contentNav[kind].offset = 0;
    // установленные грузим первыми (нужны их имена, чтобы помечать «Установлена» в каталоге)
    loadInstalledContent(kind).then(() => doContentSearch(kind, true));
  }

  async function doContentSearch(kind, reset) {
    if (!state.currentId) return;
    const cfg = CONTENT[kind];
    const nav = contentNav[kind];
    if (reset) nav.offset = 0;
    const box = $(cfg.els.results);
    box.innerHTML = '<div class="inv-loading"><div class="mc-loader"></div><div class="load-note">Загрузка ' + cfg.wordGen + ' с Modrinth…</div></div>';
    $(cfg.els.pager).classList.add('hidden');
    const seq = ++nav.seq;
    try {
      const data = await cfg.api.search(state.currentId, {
        q: $(cfg.els.q).value.trim(),
        category: $(cfg.els.cat).value,
        sort: $(cfg.els.sort).value,
        offset: nav.offset || 0,
      });
      if (seq !== nav.seq) return;
      renderContentResults(kind, data.hits || []);
      updateContentPager(kind, data);
    } catch (e) {
      if (seq !== nav.seq) return;
      nav.hits = [];
      box.innerHTML = '';
      const er = document.createElement('div');
      er.className = 'pl-empty';
      er.textContent = e.message;
      box.appendChild(er);
      $(cfg.els.pager).classList.add('hidden');
    }
  }

  function baseFileName(n) { return String(n).replace(/\.disabled$/i, ''); }

  /* установлен ли уже этот проект (эвристика: slug содержится в имени jar). */
  function isHitInstalled(kind, hit) {
    const bn = contentNav[kind].baseNames || [];
    const slug = (hit.slug || '').toLowerCase();
    return slug.length >= 3 && bn.some((b) => b.indexOf(slug) >= 0);
  }

  function updateContentPager(kind, data) {
    const cfg = CONTENT[kind];
    const nav = contentNav[kind];
    const pager = $(cfg.els.pager);
    const total = data.total || 0;
    const offset = data.offset || 0;
    const limit = data.limit || 20;
    const shown = data.hits ? data.hits.length : 0;
    nav.offset = offset; nav.limit = limit; nav.total = total;
    if (!shown || total <= limit) { pager.classList.add('hidden'); return; }
    pager.classList.remove('hidden');
    $(cfg.els.count).textContent = (offset + 1) + '–' + (offset + shown) + ' из ' + total;
    $(cfg.els.prev).disabled = offset <= 0;
    $(cfg.els.next).disabled = offset + limit >= total;
    renderPageButtons(kind);
  }

  // кнопки страниц (окно из 10) для выбора нужной страницы
  function renderPageButtons(kind) {
    const cfg = CONTENT[kind];
    const nav = contentNav[kind];
    const el = $(cfg.els.pages);
    if (!el) return;
    const limit = nav.limit || 20;
    const pages = Math.max(1, Math.ceil((nav.total || 0) / limit));
    const cur = Math.floor((nav.offset || 0) / limit); // 0-based
    const WIN = 10;
    let start = Math.max(0, cur - Math.floor(WIN / 2));
    let end = Math.min(pages, start + WIN);
    start = Math.max(0, end - WIN);
    el.innerHTML = '';
    for (let p = start; p < end; p++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'mc-btn sm pg' + (p === cur ? ' sel' : '');
      b.textContent = String(p + 1);
      b.addEventListener('click', () => contentGoToPage(kind, p));
      el.appendChild(b);
    }
  }

  function contentGoToPage(kind, page) {
    const nav = contentNav[kind];
    nav.offset = page * (nav.limit || 20);
    doContentSearch(kind, false);
    const res = $(CONTENT[kind].els.results);
    if (res && res.scrollIntoView) res.scrollIntoView({ block: 'nearest' });
  }

  function contentPage(kind, dir) {
    const cfg = CONTENT[kind];
    const nav = contentNav[kind];
    const limit = nav.limit || 20;
    let next = (nav.offset || 0) + dir * limit;
    if (next < 0) next = 0;
    if (nav.total != null && next >= nav.total) return;
    nav.offset = next;
    doContentSearch(kind, false);
    const res = $(cfg.els.results);
    if (res && res.scrollIntoView) res.scrollIntoView({ block: 'nearest' });
  }

  function renderContentResults(kind, hits) {
    const cfg = CONTENT[kind];
    contentNav[kind].hits = hits;
    const box = $(cfg.els.results);
    box.innerHTML = '';
    if (!hits.length) {
      const e = document.createElement('div');
      e.className = 'pl-empty';
      e.textContent = 'Ничего не найдено под версию вашего сервера.';
      box.appendChild(e);
      return;
    }
    const canInstall = can('files.upload');
    for (const h of hits) {
      const card = document.createElement('div');
      card.className = 'pl-card';
      card.style.cursor = 'pointer';
      card.title = 'Открыть описание';
      card.addEventListener('click', () => openContentModal(kind, h));

      const icon = document.createElement('img');
      icon.className = 'pl-icon';
      icon.alt = '';
      icon.loading = 'lazy';
      if (h.iconUrl) icon.src = h.iconUrl; else icon.classList.add('empty');
      icon.onerror = () => { icon.onerror = null; icon.classList.add('empty'); icon.removeAttribute('src'); };
      card.appendChild(icon);

      const mid = document.createElement('div');
      mid.className = 'pl-mid';
      const title = document.createElement('div');
      title.className = 'pl-title';
      title.textContent = h.title;
      if (h.author) {
        const by = document.createElement('span');
        by.className = 'pl-by';
        by.textContent = ' · ' + h.author;
        title.appendChild(by);
      }
      const desc = document.createElement('div');
      desc.className = 'pl-desc';
      desc.textContent = h.description || '';
      const meta = document.createElement('div');
      meta.className = 'pl-meta';
      meta.textContent = fmtCount(h.downloads) + ' загрузок' +
        (h.categories && h.categories.length ? ' · ' + h.categories.join(', ') : '');
      mid.appendChild(title);
      mid.appendChild(desc);
      mid.appendChild(meta);
      card.appendChild(mid);

      if (isHitInstalled(kind, h)) {
        // уже установлен — серая неактивная кнопка «Установлен»
        const btn = document.createElement('button');
        btn.className = 'mc-btn sm pl-install installed';
        btn.disabled = true;
        btn.appendChild(picon('check'));
        btn.appendChild(document.createTextNode(' Установлен'));
        card.appendChild(btn);
      } else if (canInstall) {
        const btn = document.createElement('button');
        btn.className = 'mc-btn sm primary pl-install';
        btn.appendChild(picon('download'));
        btn.appendChild(document.createTextNode(' Установить'));
        btn.addEventListener('click', (ev) => { ev.stopPropagation(); installContent(kind, h, btn); });
        card.appendChild(btn);
      }

      box.appendChild(card);
    }
  }

  function stripMarkdown(md) {
    return String(md || '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')        // картинки
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')       // ссылки -> текст
      .replace(/^#{1,6}\s*/gm, '')                    // заголовки
      .replace(/[*_`>|]/g, '')                        // акценты/код/цитаты/таблицы
      .replace(/<[^>]+>/g, '')                        // html-теги
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  // модалка каталога: полное описание + картинки (Modrinth)
  async function openContentModal(kind, hit) {
    const cfg = CONTENT[kind];
    $('#cm-title').textContent = hit.title || '';
    $('#cm-body').innerHTML = '<div class="muted">Загрузка…</div>';
    $('#content-modal').classList.remove('hidden');
    let d = null;
    try { d = await cfg.api.details(state.currentId, hit.projectId); } catch (e) { /* */ }
    if (!d) { $('#cm-body').innerHTML = '<div class="muted">Не удалось загрузить описание.</div>'; return; }
    const wrap = document.createElement('div');
    if (d.iconUrl) { const ic = document.createElement('img'); ic.src = d.iconUrl; ic.alt = ''; ic.style.cssText = 'width:56px;height:56px;border-radius:8px;float:left;margin:0 12px 8px 0'; wrap.appendChild(ic); }
    const short = document.createElement('div'); short.className = 'hint'; short.style.margin = '0 0 10px'; short.textContent = d.description || ''; wrap.appendChild(short);
    const dlc = document.createElement('div'); dlc.className = 'label-dim'; dlc.style.cssText = 'clear:both;font-size:12px;margin:0 0 12px'; dlc.textContent = fmtCount(d.downloads) + ' загрузок'; wrap.appendChild(dlc);
    if (d.gallery && d.gallery.length) {
      const gal = document.createElement('div'); gal.style.cssText = 'display:flex;gap:8px;overflow-x:auto;padding-bottom:8px;margin:0 0 12px';
      for (const g of d.gallery.slice(0, 12)) {
        const im = document.createElement('img'); im.src = g.url; im.alt = g.title || ''; im.loading = 'lazy';
        im.style.cssText = 'height:150px;border-radius:6px;border:1px solid #3a3a3a;cursor:zoom-in'; im.onclick = () => window.open(g.url, '_blank', 'noopener');
        gal.appendChild(im);
      }
      wrap.appendChild(gal);
    }
    if (d.body) {
      const body = document.createElement('div'); body.style.cssText = 'white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:1.5;max-height:42vh;overflow:auto;color:#cfcfcf';
      body.textContent = stripMarkdown(d.body);
      wrap.appendChild(body);
    }
    if (can('files.upload') && !isHitInstalled(kind, hit)) {
      const ib = document.createElement('button'); ib.className = 'mc-btn primary'; ib.style.marginTop = '14px';
      ib.appendChild(picon('download')); ib.appendChild(document.createTextNode(' Установить'));
      ib.addEventListener('click', async () => {
        ib.disabled = true; ib.textContent = 'Скачиваю…';
        try { await cfg.api.install(state.currentId, hit.projectId); showToast(cap(cfg.word) + ' установлен. Перезапустите сервер.', 'ok'); $('#content-modal').classList.add('hidden'); loadInstalledContent(kind); }
        catch (e) { showToast(e.message); ib.disabled = false; ib.textContent = 'Установить'; }
      });
      wrap.appendChild(ib);
    }
    $('#cm-body').innerHTML = ''; $('#cm-body').appendChild(wrap);
  }

  async function installContent(kind, hit, btn) {
    const cfg = CONTENT[kind];
    btn.disabled = true;
    btn.textContent = 'Скачиваю…';
    try {
      const r = await cfg.api.install(state.currentId, hit.projectId);
      showToast(cap(cfg.word) + ' «' + hit.title + '» установлен (' + r.version + '). Перезапустите сервер.', 'ok');
      loadInstalledContent(kind);
    } catch (e) {
      showToast(e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '';
      btn.appendChild(picon('download'));
      btn.appendChild(document.createTextNode(' Установить'));
    }
  }

  async function loadInstalledContent(kind) {
    if (!state.currentId) return;
    const cfg = CONTENT[kind];
    const box = $(cfg.els.installed);
    try {
      const data = await cfg.api.list(state.currentId);
      contentNav[kind].baseNames = data.baseNames || [];
      renderInstalledContent(kind, data.installed || []);
      // обновляем пометки «Установлен» в открытом каталоге
      if (contentNav[kind].hits && contentNav[kind].hits.length) renderContentResults(kind, contentNav[kind].hits);
    } catch (e) {
      box.innerHTML = '';
      const er = document.createElement('div');
      er.className = 'files-empty';
      er.textContent = e.message;
      box.appendChild(er);
    }
  }

  function renderInstalledContent(kind, list) {
    const cfg = CONTENT[kind];
    const box = $(cfg.els.installed);
    box.innerHTML = '';
    if (!list.length) {
      const e = document.createElement('div');
      e.className = 'files-empty';
      e.textContent = cap(cfg.wordGen) + ' пока нет — найдите и установите их выше.';
      box.appendChild(e);
      return;
    }
    const canDelete = can('files.delete');
    const canEdit = can('files.read');
    const canToggle = can('files.write');
    for (const p of list) {
      const row = document.createElement('div');
      row.className = 'mc-row file-row pl-inst-row' + (p.disabled ? ' off' : '');
      const ic = document.createElement('span');
      ic.className = 'file-ic';
      ic.appendChild(picon('box', p.disabled ? '#6e7a70' : 'var(--accent-bright)'));
      const name = document.createElement('span');
      name.className = 'file-name';
      name.textContent = baseFileName(p.name);
      if (p.disabled) {
        const badge = document.createElement('span');
        badge.className = 'pl-off-badge';
        badge.textContent = 'выключен';
        name.appendChild(badge);
      }
      const meta = document.createElement('span');
      meta.className = 'file-meta';
      meta.textContent = fmtBytes(p.size) + ' · ' + new Date(p.mtime).toLocaleString('ru-RU');
      row.appendChild(ic);
      row.appendChild(name);
      row.appendChild(meta);

      const actions = document.createElement('span');
      actions.className = 'pl-inst-actions';
      // корзина — удалить
      if (canDelete) {
        const del = document.createElement('button');
        del.className = 'mc-btn sm danger';
        del.title = 'Удалить ' + cfg.word + ' и его настройки';
        del.appendChild(picon('trash'));
        del.addEventListener('click', () => deleteContent(kind, p));
        actions.appendChild(del);
      }
      // переключатель вкл/выкл, справа от корзины
      if (canToggle) {
        const tog = document.createElement('div');
        tog.className = 'mc-toggle pl-tog' + (p.disabled ? '' : ' on');
        tog.innerHTML = '<div class="fill"></div><div class="knob"><div class="face"></div></div>';
        tog.title = p.disabled ? 'Включить ' + cfg.word : 'Выключить ' + cfg.word;
        tog.addEventListener('click', () => toggleContent(kind, p));
        actions.appendChild(tog);
      }
      row.appendChild(actions);
      box.appendChild(row);
    }
  }

  async function editContent(kind, item) {
    const cfg = CONTENT[kind];
    const ok = await confirmDialog(
      'Сейчас откроется вкладка «Файлы» в папке ' + cfg.folder + '/ — там лежит ' + cfg.word + ' «' + baseFileName(item.name) + '» и его настройки' +
      (kind === 'mods' ? ' (конфиги модов обычно в папке config/).' : ' (папка с конфигом плагина появляется после первого запуска сервера).'),
      { title: 'Редактировать ' + cfg.word, yesText: 'Открыть в файлах', danger: false }
    );
    if (!ok) return;
    state.filesPath = cfg.folder;
    switchTab('files');
  }

  async function toggleContent(kind, item) {
    const cfg = CONTENT[kind];
    const disabling = !item.disabled;
    const nm = baseFileName(item.name);
    const ok = await confirmDialog(
      disabling
        ? cap(cfg.word) + ' «' + nm + '» будет ВЫКЛЮЧЕН (переименуется в .disabled) и перестанет работать на сервере. Применится после перезапуска. Продолжить?'
        : cap(cfg.word) + ' «' + nm + '» снова будет ВКЛЮЧЁН. Применится после перезапуска. Продолжить?',
      { title: disabling ? 'Выключить ' + cfg.word : 'Включить ' + cfg.word,
        yesText: disabling ? 'Выключить' : 'Включить', danger: disabling }
    );
    if (!ok) return;
    await guard(async () => {
      await cfg.api.toggle(state.currentId, item.name);
      showToast(cap(cfg.word) + (disabling ? ' выключен.' : ' включён.') + ' Перезапустите сервер.', 'ok');
      loadInstalledContent(kind);
    });
  }

  async function deleteContent(kind, item) {
    const cfg = CONTENT[kind];
    const name = typeof item === 'string' ? item : item.name;
    if (!(await confirmDialog('Удалить ' + cfg.word + ' «' + baseFileName(name) + '»?\nБудут стёрты сам файл и его директория с настройками. Это необратимо.',
      { title: 'Удаление', yesText: 'Удалить' }))) return;
    await guard(async () => {
      await cfg.api.del(state.currentId, name);
      showToast(cap(cfg.word) + ' удалён. Перезапустите сервер.', 'ok');
      loadInstalledContent(kind);
    });
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

    const cpuWrap = document.createElement('div');
    cpuWrap.className = 'opt-card slider-block';
    const cpuLabel = document.createElement('span');
    cpuLabel.className = 'opt-label';
    const cpuVal = document.createElement('span');
    cpuVal.className = 'slider-val';
    cpuLabel.appendChild(document.createTextNode('Макс. нагрузка на CPU: '));
    cpuLabel.appendChild(cpuVal);
    const cpuSlider = document.createElement('div');
    cpuSlider.className = 'mc-slider';
    cpuWrap.appendChild(cpuLabel);
    cpuWrap.appendChild(cpuSlider);
    grid.appendChild(cpuWrap);
    state.cpuSettingsSlider = mkSlider(cpuSlider, {
      min: 10, max: 100, step: 5,
      value: parseInt(data.cpuPercent, 10) || 100,
      format: fmtCpu, labelEl: cpuVal,
    });

    // выбор версии Java (старые ядра/Forge 1.12.2 требуют Java 8)
    const javaWrap = document.createElement('label');
    javaWrap.className = 'mc-label';
    javaWrap.appendChild(document.createTextNode('Java для запуска'));
    const javaSel = document.createElement('select');
    javaSel.className = 'fld';
    const autoOpt = document.createElement('option');
    autoOpt.value = '';
    autoOpt.textContent = 'Авто — под версию сервера (рекомендуется)';
    javaSel.appendChild(autoOpt);
    for (const j of (data.javas || [])) {
      const o = document.createElement('option');
      o.value = j.path;
      o.textContent = 'Java ' + j.major + ' (' + j.version + ')';
      javaSel.appendChild(o);
    }
    if (data.javaPath && !(data.javas || []).some((j) => j.path === data.javaPath)) {
      const o = document.createElement('option');
      o.value = data.javaPath;
      o.textContent = data.javaPath;
      javaSel.appendChild(o);
    }
    javaSel.value = data.javaPath || '';
    javaWrap.appendChild(javaSel);
    grid.appendChild(javaWrap);
    state.javaSelectEl = javaSel;
    enhanceSelect(javaSel);

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

  // ---------- карточка «Команда запуска»: jar-файл, пресеты флагов, свой шаблон ----------
  function populateLaunchCard(data) {
    state.launchPresets = data.launchPresets || [];
    const jarSel = $('#launch-jar');
    if (jarSel) {
      jarSel.innerHTML = '';
      const jars = (data.jars && data.jars.length) ? data.jars : [data.jarFile || 'server.jar'];
      for (const j of jars) { const o = document.createElement('option'); o.value = j; o.textContent = j; jarSel.appendChild(o); }
      jarSel.value = data.jarFile || jars[0] || 'server.jar';
      $('#launch-jar-label').classList.toggle('hidden', jars.length <= 1); // один jar — выбор не нужен
      enhanceSelect(jarSel);
      if (jarSel._mcSync) jarSel._mcSync();
    }
    const presetSel = $('#launch-preset');
    if (presetSel) {
      presetSel.innerHTML = '';
      (data.launchPresets || []).forEach((p, i) => { const o = document.createElement('option'); o.value = String(i); o.textContent = p.name; presetSel.appendChild(o); });
      const co = document.createElement('option'); co.value = 'custom'; co.textContent = 'Своя команда (в поле ниже)'; presetSel.appendChild(co);
      presetSel.value = 'custom';
      enhanceSelect(presetSel);
      if (presetSel._mcSync) presetSel._mcSync();
    }
    $('#launch-cmd').value = data.launchCmd || '';
    const note = $('#launch-forge-note');
    if (note) {
      const forgeArgs = data.forgeArgs && !data.launchCmd;
      note.classList.toggle('hidden', !forgeArgs);
      if (forgeArgs) note.textContent = 'Это Forge-сервер (запуск через @unix_args.txt/@win_args.txt). Выбор .jar или своя команда перекроют его — меняйте, только если понимаете, что делаете.';
    }
  }

  // ---------- server.properties: режим «Поля» (перевод) / «Файл» (как есть) ----------

  function applyPropsModeUI() {
    const mode = state.propsMode || 'fields';
    const raw = mode === 'raw';
    document.querySelectorAll('#settings-form .props-mode-btn').forEach((b) => {
      b.classList.toggle('primary', b.dataset.pm === mode);
    });
    $('#settings-known').classList.toggle('hidden', raw);
    $('#settings-raw-wrap').classList.toggle('hidden', !raw);
    if (raw) $('#wl-card').classList.add('hidden');
  }

  async function loadRawProps() {
    if (!state.currentId) return;
    try {
      const data = await API.fileGet(state.currentId, 'server.properties');
      $('#settings-raw').value = (data && typeof data.content === 'string') ? data.content : '';
    } catch (e) {
      $('#settings-raw').value = '';
      showToast('server.properties пока нет — создастся при первом запуске сервера.');
    }
  }

  // переключение по кнопкам «Поля» / «Файл»
  function switchPropsMode(mode) {
    if ((state.propsMode || 'fields') === mode) return;
    state.propsMode = mode;
    if (mode === 'fields') {
      loadSettings(); // перечитать актуальные значения из файла и перерисовать поля (сбросит baseline)
    } else {
      applyPropsModeUI();
      Promise.resolve(loadRawProps()).then(markSettingsClean); // baseline после загрузки текста
    }
  }

  async function saveSettingsRaw() {
    const server = state.current || {};
    const isRunning = server.status === 'running' || server.status === 'starting';
    const ok = await confirmDialog(
      'Сохранить server.properties сервера «' + (server.name || '') + '»?' +
      (isRunning ? '\nСервер сейчас работает — изменения применятся после перезапуска.' : ''),
      { title: 'Сохранение server.properties', yesText: 'Сохранить', danger: false });
    if (!ok) return;
    const content = $('#settings-raw').value;
    await guard(async () => {
      await API.fileSave(state.currentId, 'server.properties', content);
      // бэкенд синхронизирует порт панели из server.properties — обновим карточку и список
      state.current = await API.server(state.currentId);
      renderServerHead();
      showToast(isRunning
        ? 'server.properties сохранён. Перезапустите сервер, чтобы применить.'
        : 'server.properties сохранён.', 'ok');
      loadServers();
      Promise.resolve(loadRawProps()).then(markSettingsClean); // перечитать + сброс baseline
    });
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
    if (type === 'select') enhanceSelect(input);
    wrap._getValue = () => input.value;
    return wrap;
  }

  async function saveSettings(event) {
    event.preventDefault();
    if (!state.currentId) return;
    if ((state.propsMode || 'fields') === 'raw') return saveSettingsRaw();

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
    const cpuPercent = state.cpuSettingsSlider ? state.cpuSettingsSlider.value : 100;
    const javaPath = state.javaSelectEl ? state.javaSelectEl.value : '';
    const jarFile = $('#launch-jar') ? $('#launch-jar').value : undefined;   // файл .jar для запуска
    const launchCmd = $('#launch-cmd') ? $('#launch-cmd').value : undefined; // кастомная команда/пресет

    for (const el of $$('#settings-known [data-prop-key]')) {
      const key = el.dataset.propKey;
      const value = el._getValue ? el._getValue() : '';
      if (key === '__name') name = value;
      else properties[key] = value;
    }

    await guard(async () => {
      state.current = await API.saveProperties(state.currentId, { properties, name, memoryMb, cpuPercent, javaPath, jarFile, launchCmd });
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

  let filesSig = ''; // сигнатура последнего листинга — чтобы авто-синк не дёргал DOM зря
  async function loadFiles() {
    if (!state.currentId) return;
    await guard(async () => {
      const data = await API.files(state.currentId, state.filesPath);
      const entries = data.entries || [];
      filesSig = JSON.stringify(entries);
      renderFiles(entries);
    });
  }
  /* Автосинхронизация списка файлов: пока открыта вкладка «Файлы» (браузер, не редактор),
     тихо перечитываем текущую папку и перерисовываем ТОЛЬКО при изменениях (с сохранением
     прокрутки) — чтобы не перезагружать вкладку вручную. */
  async function syncFiles() {
    if (state.screen !== 'server' || state.currentTab !== 'files' || state.editorPath || !state.currentId) return;
    if ($('#files-browser').classList.contains('hidden')) return;
    try {
      const data = await API.files(state.currentId, state.filesPath);
      const entries = data.entries || [];
      const sig = JSON.stringify(entries);
      if (sig === filesSig) return; // ничего не поменялось
      filesSig = sig;
      const list = $('#files-list');
      const scroll = list ? list.scrollTop : 0;
      renderFiles(entries);
      if (list) list.scrollTop = scroll;
    } catch (e) { /* авто-синк молчит: не спамим тостами */ }
  }

  function renderFiles(entries) {
    $('#files-path').textContent =
      (state.rootPath ? state.rootPath + '\\' : '') + 'servers\\' + state.currentId +
      (state.filesPath ? '\\' + state.filesPath.replace(/\//g, '\\') : '');

    // кнопка «Скачать» в тулбаре — текущая папка целиком архивом (ZIP)
    const dlFolder = $('#btn-download-folder');
    if (dlFolder) {
      dlFolder.classList.toggle('perm-hidden', !can('files.read'));
      dlFolder.href = API.folderDownloadUrl(state.currentId, state.filesPath);
      const segs = state.filesPath ? state.filesPath.split('/') : [];
      const folderName = (segs.length ? segs[segs.length - 1]
        : ((state.current && state.current.name) || 'server')) + '.zip';
      dlFolder.setAttribute('download', folderName);
      dlFolder.onclick = () => beginDownloadFeedback(folderName);
    }

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
      // скачать на ПК: файл — как есть, папка — архивом ZIP (ссылка, чтобы браузер скачал)
      if (can('files.read')) {
        const rel = joinPath(state.filesPath, entry.name);
        const dlName = entry.dir ? entry.name + '.zip' : entry.name;
        const dl = document.createElement('a');
        dl.className = 'mc-btn sm';
        dl.href = entry.dir ? API.folderDownloadUrl(state.currentId, rel) : API.fileDownloadUrl(state.currentId, rel);
        dl.title = entry.dir ? 'Скачать папку архивом (ZIP)' : 'Скачать файл на ПК';
        dl.setAttribute('download', dlName);
        dl.appendChild(picon('download'));
        // не открывать файл/папку по клику + показать свой тост вместо «шторки» загрузок
        dl.addEventListener('click', (event) => { event.stopPropagation(); beginDownloadFeedback(dlName); });
        actions.appendChild(dl);
      }
      if (!entry.dir && /\.(zip|jar)$/i.test(entry.name) && can('files.write')) {
        actions.appendChild(mkBtn('box', 'Распаковать архив', 'accent', () => extractEntry(entry)));
      }
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

  // CodeMirror грузится лениво — только при первом открытии редактора файлов,
  // чтобы не тянуть ~17 CDN-файлов на старте панели у тех, кто его не открывает
  let _cmPromise = null;
  function loadCodeMirror() {
    if (window.CodeMirror) return Promise.resolve(true);
    if (_cmPromise) return _cmPromise;
    const BASE = 'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/';
    const css = [
      'codemirror.min.css',
      'theme/material-darker.min.css',
      'addon/dialog/dialog.min.css',
      'addon/hint/show-hint.min.css',
    ];
    const js = [
      'mode/javascript/javascript.min.js',
      'mode/xml/xml.min.js',
      'mode/yaml/yaml.min.js',
      'mode/properties/properties.min.js',
      'addon/search/searchcursor.min.js',
      'addon/search/search.min.js',
      'addon/search/jump-to-line.min.js',
      'addon/dialog/dialog.min.js',
      'addon/edit/matchbrackets.min.js',
      'addon/edit/closebrackets.min.js',
      'addon/selection/active-line.min.js',
      'addon/hint/show-hint.min.js',
      'addon/hint/anyword-hint.min.js',
    ];
    const loadCss = (href) => new Promise((resolve) => {
      const l = document.createElement('link');
      l.rel = 'stylesheet'; l.href = href;
      l.onload = l.onerror = () => resolve();
      document.head.appendChild(l);
    });
    const loadJs = (src) => new Promise((resolve, reject) => {
      const sc = document.createElement('script');
      sc.src = src; sc.onload = () => resolve(); sc.onerror = () => reject(new Error('load ' + src));
      document.head.appendChild(sc);
    });
    _cmPromise = (async () => {
      css.forEach((f) => loadCss(BASE + f));          // стили не блокируют
      await loadJs(BASE + 'codemirror.min.js');       // ядро — первым
      await Promise.all(js.map((f) => loadJs(BASE + f))); // режимы и аддоны зависят только от ядра
      return !!window.CodeMirror;
    })().catch(() => { _cmPromise = null; return false; });
    return _cmPromise;
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
    // на рабочем столе в игре редактор — отдельное окно; но сначала проверяем,
    // что файл вообще редактируем — иначе породим мёртвое пустое окно
    if (EMBED && !EMBED_EDITOR && window.parent !== window) {
      await guard(async () => {
        const data = await API.fileGet(state.currentId, relPath);
        if (data.binary) {
          showToast('Этот файл нельзя открыть в редакторе: ' + (data.reason || 'двоичный') + ' (' + fmtBytes(data.size) + ')');
          return;
        }
        window.parent.postMessage({
          cg: 'open', what: 'editor', id: state.currentId,
          path: relPath, title: relPath.split('/').pop(),
        }, location.origin);
      });
      return;
    }
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

      await loadCodeMirror(); // подтянуть CodeMirror при первом открытии (иначе fallback на textarea)
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
    // окно-редактор: «Закрыть» закрывает само окно рабочего стола
    if (EMBED_EDITOR && window.parent !== window) {
      window.parent.postMessage({ cg: 'close-win' }, location.origin);
      return;
    }
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

  // загрузка набора файлов (в т.ч. с вложенными путями папки) — один итог, одно обновление
  async function uploadMany(items) {
    // items: [{ file, rel }] — rel относительно текущей папки (может содержать '/')
    if (!items || !items.length) return;
    let ok = 0;
    let failName = null;
    await guard(async () => {
      for (const it of items) {
        try {
          await API.upload(state.currentId, joinPath(state.filesPath, it.rel), it.file);
          ok++;
        } catch (e) { if (!failName) failName = it.rel; }
      }
      if (ok === items.length) {
        showToast(ok === 1 ? 'Файл загружен.' : ('Загружено файлов: ' + ok + '.'), 'ok');
      } else if (ok) {
        showToast('Загружено ' + ok + ' из ' + items.length + '. Не удалось: «' + failName + '».');
      } else {
        showToast('Не удалось загрузить: «' + failName + '».');
      }
      loadFiles();
    });
  }

  async function extractEntry(entry) {
    const ok = await confirmDialog(
      'Распаковать архив «' + entry.name + '»?\nСодержимое появится в новой папке рядом с архивом.',
      { title: 'Распаковка архива', yesText: 'Распаковать', danger: false });
    if (!ok) return;
    await guard(async () => {
      const r = await API.filesExtract(state.currentId, joinPath(state.filesPath, entry.name));
      let msg = 'Архив распакован в папку «' + (r.folder || '') + '» (файлов: ' + (r.count || 0) + ').';
      if (r.skipped) msg += ' Пропущено записей: ' + r.skipped + '.';
      if (r.tooLarge) msg += ' Из них слишком больших (> 512 МБ): ' + r.tooLarge + '.';
      showToast(msg, r.tooLarge ? '' : 'ok');
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

  async function switchTab(tab) {
    // предупреждение о несохранённых изменениях при уходе со вкладки «Настройки»
    if (state.currentTab === 'settings' && tab !== 'settings' && isSettingsDirty()) {
      const leave = await confirmDialog(
        'На вкладке «Настройки» есть несохранённые изменения. Выйти без сохранения?',
        { title: 'Несохранённые изменения', yesText: 'Выйти без сохранения', danger: true });
      if (!leave) return; // остаёмся на вкладке настроек, подсветка не менялась
    }
    state.currentTab = tab;
    if (state.currentId) {
      pushHash('#server=' + state.currentId + '/tab/' + tab);
    }
    $$('.mc-tab').forEach((btn) => btn.classList.toggle('sel', btn.dataset.tab === tab));
    moveTabIndicator(state.tabIndReady === true);
    state.tabIndReady = true;
    $('#tab-console').classList.toggle('hidden', tab !== 'console');
    $('#tab-settings').classList.toggle('hidden', tab !== 'settings');
    $('#tab-files').classList.toggle('hidden', tab !== 'files');
    $('#tab-plugins').classList.toggle('hidden', tab !== 'plugins');
    $('#tab-mods').classList.toggle('hidden', tab !== 'mods');
    $('#tab-players').classList.toggle('hidden', tab !== 'players');
    $('#tab-logs').classList.toggle('hidden', tab !== 'logs');
    $('#tab-backups').classList.toggle('hidden', tab !== 'backups');
    $('#tab-info').classList.toggle('hidden', tab !== 'info');
    if (tab !== 'logs') stopLogLive();
    if (tab === 'settings') loadSettings();
    if (tab === 'console') loadStats();
    if (tab === 'plugins') loadContent('plugins');
    if (tab === 'mods') loadContent('mods');
    if (tab === 'players') fetchPlayTimes();
    if (tab === 'backups') loadBackups();
    if (tab === 'logs') {
      loadLogs();
      if ($('#logs-live').classList.contains('on')) startLogLive();
    }
    if (tab === 'files') {
      // не теряем активное (несохранённое) редактирование при возврате на вкладку «Файлы»
      if (state.editorPath) {
        $('#file-editor').classList.remove('hidden');
        $('#files-browser').classList.add('hidden');
        if (state.cm) setTimeout(() => state.cm.refresh(), 0); // CodeMirror перерисовать после показа
      } else {
        $('#file-editor').classList.add('hidden');
        $('#files-browser').classList.remove('hidden');
        loadFiles();
      }
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

  async function doLogout() {
    // выход имеет смысл только в удалённой HTTPS-сессии (локально входа нет)
    if (!(await confirmDialog('Выйти из панели?', { title: 'Выход', yesText: 'Выйти' }))) return;
    try { await API.logout(); } catch (e) { /* всё равно уходим */ }
    location.href = '/login';
  }

  // ---------- своё ядро при создании ----------

  // какая Java нужна для версии (зеркало lib/javas.js requiredJavaMajor)
  function requiredJavaMajor(version) {
    const m = String(version || '').match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
    if (!m) return 21;
    const maj = +m[1], min = +m[2], patch = +(m[3] || 0);
    if (maj !== 1) return 21;
    if (min <= 16) return 8;
    if (min < 20) return 17;
    if (min === 20) return patch >= 5 ? 21 : 17;
    return 21;
  }
  function selectedJavaMajor() {
    const type = $('#core-select').value;
    if (PROXY_TYPES.includes(type)) return 21;
    return requiredJavaMajor($('#version-select') ? $('#version-select').value : '');
  }

  // предложение скачать Java на экране создания, если её нет
  function updateJavaInstallUI() {
    const box = document.getElementById('java-install');
    if (!box) return;
    const busy = state.javaInstallPhase === 'downloading' || state.javaInstallPhase === 'extracting';
    const show = state.screen === 'create' && !state.javaAvailable;
    box.classList.toggle('hidden', !show);
    if (show && !busy && state.javaInstallPhase !== 'done') {
      const major = selectedJavaMajor();
      box.classList.remove('ok');
      $('#java-install-text').textContent = 'Java ' + major + ' не найдена — без неё сервер не запустится.';
      $('#java-install-btn').innerHTML = '<i class="pi" data-ic="download"></i> Скачать Java ' + major;
      applyIcons($('#java-install-btn'));
      $('#java-install-btn').disabled = false;
      $('#java-install-btn').classList.remove('hidden');
      $('#java-install-prog').classList.add('hidden');
    }
  }

  async function startJavaInstall() {
    const major = selectedJavaMajor();
    const btn = $('#java-install-btn');
    const prog = $('#java-install-prog');
    btn.disabled = true;
    prog.classList.remove('hidden');
    prog.textContent = 'Скачиваю Java ' + major + '…';
    state.javaInstallPhase = 'downloading';
    try { await API.javaInstall(major); } catch (e) { showToast(e.message); }
    const poll = setInterval(async () => {
      let s;
      try { s = await API.javaInstallState(); } catch (e) { return; }
      state.javaInstallPhase = s.phase;
      if (s.phase === 'downloading') {
        prog.textContent = s.totalBytes
          ? 'Скачиваю Java ' + s.major + ': ' + Math.round((s.progress || 0) * 100) + '%'
          : 'Скачиваю Java ' + s.major + ': ' + fmtBytes(s.doneBytes || 0);
      } else if (s.phase === 'extracting') {
        prog.textContent = 'Распаковываю Java ' + s.major + '…';
      } else if (s.phase === 'done') {
        clearInterval(poll);
        $('#java-install').classList.add('ok');
        $('#java-install-text').textContent = 'Java ' + s.major + ' установлена ✓';
        prog.classList.add('hidden');
        btn.classList.add('hidden');
        showToast('Java установлена — можно создавать сервер', 'ok');
        loadStatus();
      } else if (s.phase === 'error') {
        clearInterval(poll);
        prog.textContent = 'Ошибка: ' + (s.error || 'не удалось установить');
        btn.disabled = false;
      }
    }, 1500);
  }

  // ---------- визуализация прокси-сети ----------
  function pvStatusClass(st) {
    if (st === 'running') return 'on';
    if (st === 'error') return 'err';
    if (st === 'starting' || st === 'stopping' || st === 'downloading') return 'warn';
    return 'off';
  }
  function pvNode(icon, title, sub, cls) {
    const n = document.createElement('div');
    n.className = 'pv-node ' + (cls || '');
    const i = document.createElement('div'); i.className = 'pv-ic'; i.textContent = icon;
    const t = document.createElement('div'); t.className = 'pv-t'; t.textContent = title;
    const s = document.createElement('div'); s.className = 'pv-s'; s.textContent = sub;
    n.append(i, t, s);
    return n;
  }
  function pvArrow() {
    const a = document.createElement('div'); a.className = 'pv-arrow'; a.textContent = '▶'; return a;
  }
  function renderProxyViz() {
    const box = $('#proxy-viz');
    if (!box) return;
    box.innerHTML = '';
    const proxies = (state.servers || []).filter((s) => PROXY_TYPES.includes(s.type));
    if (!proxies.length) {
      const e = document.createElement('div');
      e.className = 'pv-empty';
      e.textContent = 'Прокси-серверов пока нет. Создайте BungeeCord или Velocity и привяжите серверы — здесь появится схема маршрутизации.';
      box.appendChild(e);
      return;
    }
    for (const px of proxies) {
      const card = document.createElement('div');
      card.className = 'pv-card';
      const head = document.createElement('div');
      head.className = 'pv-head';
      const dot = document.createElement('span'); dot.className = 'pv-dot ' + pvStatusClass(px.status);
      const nm = document.createElement('b'); nm.textContent = px.name;
      const meta = document.createElement('span'); meta.className = 'pv-meta';
      meta.textContent = (CORE_NAMES[px.type] || px.type) + ' · :' + px.port + ' · ' + (STATUS_LABEL[px.status] || px.status);
      head.append(dot, nm, meta);
      card.appendChild(head);

      const flow = document.createElement('div');
      flow.className = 'pv-flow';
      flow.appendChild(pvNode('👥', 'Игроки', 'заходят на :' + px.port, 'pv-players'));
      flow.appendChild(pvArrow());
      flow.appendChild(pvNode('🔀', px.name, 'прокси :' + px.port, 'pv-proxy ' + pvStatusClass(px.status)));
      flow.appendChild(pvArrow());

      const col = document.createElement('div');
      col.className = 'pv-backends';
      const backs = px.proxyServers || [];
      if (!backs.length) {
        const n = document.createElement('div'); n.className = 'pv-node off'; n.textContent = 'нет привязанных серверов';
        col.appendChild(n);
      }
      for (const b of backs) {
        const srv = (state.servers || []).find((s) => s.id === b.id);
        const st = srv ? srv.status : 'unknown';
        const sub = ':' + b.port + ' · ' + (srv ? (STATUS_LABEL[st] || st) : 'удалён');
        col.appendChild(pvNode('🟦', b.name || (srv && srv.name) || b.slug, sub, 'pv-back ' + pvStatusClass(st)));
      }
      flow.appendChild(col);
      card.appendChild(flow);
      box.appendChild(card);
    }
  }

  // ---------- импорт существующего сервера ----------
  function isImportOn() { const t = $('#toggle-import'); return t && t.classList.contains('on'); }
  function updateImportMode() {
    const on = isImportOn();
    $('#import-label').classList.toggle('hidden', !on);
    $('#import-mode-label').classList.toggle('hidden', !on);
    if (!on) $('#import-jar-label').classList.add('hidden'); // выбор jar скрываем, пока папка не выбрана
    onCoreChange(); // пересчитать видимость версии/EULA с учётом импорта
  }
  // режим импорта: 'copy' (скопировать в панель) | 'inplace' (управлять папкой на месте)
  function setImportMode(mode) {
    state.importMode = mode === 'inplace' ? 'inplace' : 'copy';
    $$('#import-mode-btns .seg').forEach((b) => b.classList.toggle('sel', b.dataset.mode === state.importMode));
    const hint = $('#import-mode-hint');
    if (hint) hint.textContent = state.importMode === 'inplace'
      ? 'Папка останется на месте, панель будет управлять ей напрямую (без копии). При удалении сервера из панели файлы НЕ удаляются.'
      : 'Папка скопируется в данные панели — оригинал останется нетронутым.';
  }

  // список .jar из выбранной папки импорта: даём выбрать, какой запускать
  function populateImportJars(jars) {
    const label = $('#import-jar-label');
    const sel = $('#import-jar');
    sel.innerHTML = '';
    const list = (jars || []).filter((f) => /\.jar$/i.test(f));
    if (!list.length) { label.classList.add('hidden'); return; }
    const def = list.find((f) => /^server\.jar$/i.test(f))
      || list.find((f) => !/installer/i.test(f))
      || list[0];
    for (const f of list) {
      const o = document.createElement('option');
      o.value = f;
      o.textContent = f;
      sel.appendChild(o);
    }
    sel.value = def;
    if (sel._mcSync) sel._mcSync(); // обновить подпись своей выпадашки
    label.classList.remove('hidden');
  }
  let browseParent = null;
  let browseCurPath = '';
  let browseCurJars = [];
  async function loadBrowse(p) {
    try {
      const d = await API.browse(p);
      const isDrives = d.path === '::drives';
      browseParent = d.parent;
      browseCurPath = isDrives ? '' : (d.path || '');
      browseCurJars = d.jars || [];
      const inp = $('#browse-cur');
      // не затираем путь, пока пользователь его правит вручную
      if (document.activeElement !== inp) inp.value = (isDrives || !d.path) ? '' : d.path;
      inp.placeholder = (isDrives || !d.path) ? 'Этот компьютер (диски) — вставьте путь и Enter' : 'Путь к папке — можно вставить и нажать Enter';
      const bh = $('#browse-hint');
      bh.textContent = d.isServer ? '✓ похоже на сервер' : '';
      bh.style.color = d.isServer ? 'var(--accent-bright)' : '';
      $('#browse-pick').disabled = isDrives || !d.path;
      $('#browse-up').disabled = d.parent == null;
      const list = $('#browse-list');
      list.innerHTML = '';
      for (const name of (d.dirs || [])) {
        const full = (isDrives || !d.path) ? name : (d.path.replace(/[\\/]+$/, '') + '/' + name);
        const row = document.createElement('div');
        row.className = 'browse-item';
        row.textContent = '📁 ' + name;
        row.addEventListener('click', () => loadBrowse(full));
        list.appendChild(row);
      }
    } catch (e) { showToast(e.message); }
  }

  function onCoreChange() {
    const type = $('#core-select').value;
    const custom = type === 'custom';
    const isProxy = PROXY_TYPES.includes(type);
    // у BungeeCord одна сборка — версию не показываем; у Velocity версии есть
    $('#version-label').classList.toggle('hidden', custom || type === 'bungeecord');
    $('#custom-core-label').classList.toggle('hidden', !custom);
    // обычные MC-поля прокси не нужны
    ['cycle-gamemode', 'cycle-difficulty', 'seed-label', 'online-row', 'pvp-row', 'eula-row'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.classList.toggle('hidden', isProxy);
    });
    $('#backends-label').classList.toggle('hidden', !isProxy);
    // required не ставим: <select> скрыт под своей выпадашкой, проверяем версию вручную в submitCreate
    if (isProxy) buildBackendsList();
    if (type === 'bungeecord') {
      $('#version-select').innerHTML = '<option value="latest">latest</option>';
    } else if (!custom) {
      loadVersions();
    }
    // импорт существующего сервера: всё, что определится автоматически из его файлов
    // (ядро, версия, сид, макс. игроков, режим игры, сложность) — скрываем; EULA/привязку тоже.
    const importOn = isImportOn();
    const importHide = importOn && !isProxy && !custom;
    $('#import-row').classList.toggle('hidden', isProxy || custom);
    // импорт недоступен для прокси/своего ядра — прячем его поля целиком
    $('#import-label').classList.toggle('hidden', !importOn || isProxy || custom);
    $('#import-mode-label').classList.toggle('hidden', !importOn || isProxy || custom);
    if (isProxy || custom) $('#import-jar-label').classList.add('hidden');
    // у «Ядро» и «Макс. игроков» нет своего тоггла — задаём явно (иначе не вернутся при выключении импорта)
    $('#core-label').classList.toggle('hidden', importHide);
    $('#maxplayers-label').classList.toggle('hidden', importHide);
    // остальные имеют собственную базовую видимость выше — при импорте просто доскрываем
    if (importHide) {
      for (const id of ['version-label', 'cycle-gamemode', 'cycle-difficulty', 'seed-label', 'eula-row', 'backends-label']) {
        const el = document.getElementById(id); if (el) el.classList.add('hidden');
      }
    }
    updateJavaInstallUI(); // нужная мажорная java зависит от ядра/версии
  }

  // список серверов с галочками (все включены) для привязки к прокси
  function buildBackendsList() {
    const box = $('#backends-list');
    box.innerHTML = '';
    const compat = (state.servers || []).filter((s) => BACKEND_OK.includes(s.type));
    if (!compat.length) {
      const e = document.createElement('span');
      e.className = 'hint';
      e.textContent = 'Нет подходящих серверов. Сначала создайте Paper/Purpur/Folia/Mohist — потом прокси.';
      box.appendChild(e);
      return;
    }
    for (const s of compat) {
      const row = document.createElement('label');
      row.className = 'backend-row';
      const chk = document.createElement('span');
      chk.className = 'mc-check on';
      chk.dataset.id = s.id;
      chk.innerHTML = '<span class="tick"></span>';
      chk.addEventListener('click', () => chk.classList.toggle('on'));
      const nm = document.createElement('span');
      nm.className = 'backend-name';
      nm.textContent = s.name;
      const meta = document.createElement('span');
      meta.className = 'backend-meta';
      meta.textContent = (CORE_NAMES[s.type] || s.type) + ' · :' + s.port;
      row.append(chk, nm, meta);
      box.appendChild(row);
    }
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

  // поиск сразу по всем лог-файлам сервера (latest.log + архивные .log.gz)
  async function searchAllLogs() {
    if (!state.currentId) return;
    const q = $('#logs-query').value.trim();
    if (q.length < 2) { showToast('Введите минимум 2 символа для поиска по всем логам'); return; }
    // выключаем live — иначе автообновление активного лога каждые 3 с затирает
    // результаты поиска по всем логам (это и выглядело как «ничего не найдено»)
    stopLogLive();
    if ($('#logs-live')) $('#logs-live').classList.remove('on');
    await guard(async () => {
      let data;
      try {
        data = await API.logsSearch(state.currentId, q);
      } catch (e) {
        $('#logs-meta').textContent = '';
        $('#logs-view').textContent = 'Поиск по всем логам недоступен: ' + e.message +
          (e.status === 404 ? ' (обновите панель этого сервера до свежей версии).' : '');
        return;
      }
      const matches = (data && data.matches) || [];
      const view = $('#logs-view');
      view.innerHTML = '';
      $('#logs-meta').textContent = 'По всем логам: найдено ' + matches.length + (data && data.truncated ? '+ (первые 500)' : '') + ' для «' + q + '»';
      if (!matches.length) { view.textContent = 'Ничего не найдено по всем логам.'; return; }
      const frag = document.createDocumentFragment();
      for (const m of matches) {
        const el = document.createElement('span'); el.className = 'log-line';
        const f = document.createElement('b'); f.style.color = 'var(--accent-bright,#80da5b)'; f.textContent = m.file + ':' + m.line + '  ';
        el.appendChild(f); el.appendChild(document.createTextNode(m.text)); el.appendChild(document.createTextNode('\n'));
        frag.appendChild(el);
      }
      view.appendChild(frag);
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

  // контекст перетаскивания: вкладка «Файлы» — в текущую папку; «Плагины»/«Моды» — авто-установка .jar
  function dropContext() {
    if (state.screen !== 'server' || !can('files.upload')) return null;
    if (state.currentTab === 'files' && !$('#files-browser').classList.contains('hidden'))
      return { kind: 'files', folder: state.filesPath, label: 'в папку: ' + (state.filesPath || 'корень') };
    if (state.currentTab === 'plugins' && state.current && state.current.plugins)
      return { kind: 'plugins', folder: 'plugins', label: 'установить плагин — перетащите .jar' };
    if (state.currentTab === 'mods' && state.current && state.current.mods)
      return { kind: 'mods', folder: 'mods', label: 'установить мод — перетащите .jar' };
    return null;
  }

  // Собрать перетащенные файлы, включая содержимое папок (webkitGetAsEntry).
  // Возвращает промис со списком [{ file, rel }] (rel — путь с '/' для вложенных).
  // ВАЖНО: webkitGetAsEntry() читается синхронно, пока жив объект события.
  function collectDropEntries(dt) {
    const items = dt.items ? Array.from(dt.items) : [];
    const roots = [];
    for (const it of items) {
      if (it.kind !== 'file') continue;
      const entry = it.webkitGetAsEntry ? it.webkitGetAsEntry() : null;
      if (entry) roots.push(entry);
    }
    if (!roots.length) {
      // старый путь (нет entry-API) — без структуры папок
      const flat = dt.files ? Array.from(dt.files) : [];
      return Promise.resolve(flat.map((f) => ({ file: f, rel: f.name })));
    }
    const MAX_FILES = 5000;
    const MAX_DEPTH = 48; // защита от циклов симлинков/джанкшенов (out.length не растёт в пустых ветках)
    const out = [];
    let capped = false;
    function walk(entry, prefix, depth) {
      return new Promise((resolve) => {
        if (out.length >= MAX_FILES || depth > MAX_DEPTH) { capped = true; return resolve(); }
        if (entry.isFile) {
          entry.file((f) => { out.push({ file: f, rel: prefix + entry.name }); resolve(); }, () => resolve());
        } else if (entry.isDirectory) {
          const reader = entry.createReader();
          const acc = [];
          const readBatch = () => {
            reader.readEntries((batch) => {
              if (!batch.length) {
                // readEntries отдаёт максимум ~100 за раз — читали, пока не пусто
                let chain = Promise.resolve();
                for (const child of acc) chain = chain.then(() => walk(child, prefix + entry.name + '/', depth + 1));
                chain.then(resolve);
              } else {
                for (const b of batch) acc.push(b);
                readBatch();
              }
            }, () => resolve());
          };
          readBatch();
        } else resolve();
      });
    }
    let chain = Promise.resolve();
    for (const r of roots) chain = chain.then(() => walk(r, '', 0));
    return chain.then(() => {
      if (capped) showToast('Слишком много файлов или слишком глубокая вложенность — взяты первые ' + MAX_FILES + '.');
      return out;
    });
  }

  function setupFileDrop() {
    const overlay = $('#drop-overlay');
    let depth = 0;

    window.addEventListener('dragenter', (e) => {
      const ctx = dropContext();
      if (!ctx) return;
      if (!e.dataTransfer || Array.from(e.dataTransfer.types || []).indexOf('Files') < 0) return;
      e.preventDefault();
      depth++;
      $('#drop-sub').textContent = ctx.label;
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
      const ctx = dropContext();
      if (!ctx) return;
      if (ctx.kind === 'files') {
        // читаем структуру папок синхронно из живого события, затем показываем подтверждение
        collectDropEntries(e.dataTransfer).then((items) => { if (items.length) openDropConfirm(items); });
      } else {
        const files = e.dataTransfer && e.dataTransfer.files ? Array.from(e.dataTransfer.files) : [];
        if (files.length) dropContentJars(ctx, files);
      }
    });
  }

  // авто-установка .jar в plugins/ или mods/ перетаскиванием — без захода в «Файлы»
  async function dropContentJars(ctx, files) {
    const jars = files.filter((f) => /\.jar$/i.test(f.name));
    if (!jars.length) { showToast('Перетащите файл .jar'); return; }
    let ok = 0;
    for (const f of jars) {
      try { await API.upload(state.currentId, ctx.folder + '/' + f.name, f); ok++; }
      catch (e) { showToast('Не удалось добавить ' + f.name + ': ' + e.message); }
    }
    if (ok) showToast((ok > 1 ? ok + ' файла(ов) добавлено' : 'Добавлено: ' + jars[0].name) + '. Перезапустите сервер, чтобы применить.', 'ok');
    loadContent(ctx.kind); // обновить список установленных
  }

  function openDropConfirm(items) {
    // items: [{ file, rel }] — rel может содержать '/' для файлов из вложенных папок
    const folderCount = items.filter((it) => it.rel.indexOf('/') >= 0).length;
    $('#dropconfirm-path').textContent = 'Папка назначения: ' + (state.filesPath || 'корень') +
      (folderCount ? ' · с сохранением структуры папок' : '');
    const box = $('#dropconfirm-list');
    box.innerHTML = '';
    for (const it of items) {
      const nested = it.rel.indexOf('/') >= 0;
      const row = document.createElement('div');
      row.className = 'drop-file';
      row.appendChild(picon(nested ? 'folder' : 'file', 'var(--accent-bright)'));
      const nm = document.createElement('span');
      nm.className = 'drop-file-name';
      nm.textContent = it.rel;
      const sz = document.createElement('span');
      sz.className = 'drop-file-size';
      sz.textContent = fmtBytes(it.file.size);
      row.appendChild(nm);
      row.appendChild(sz);
      box.appendChild(row);
    }
    $('#dropconfirm-root').classList.remove('hidden');
    $('#dropconfirm-ok').onclick = async () => {
      $('#dropconfirm-root').classList.add('hidden');
      await uploadMany(items);
    };
    $('#dropconfirm-cancel').onclick = () => $('#dropconfirm-root').classList.add('hidden');
  }

  // ---------- удаление сервера ----------

  async function deleteServer(id) {
    const server = state.servers.find((s) => s.id === id) || state.current;
    if (!server) return;
    const ok = await confirmDialog(
      server.inPlace
        ? 'Убрать сервер «' + server.name + '» из панели?\nЭто импорт «на месте» — файлы в вашей папке НЕ удаляются, панель лишь перестанет им управлять.'
        : 'Удалить сервер «' + server.name + '»?\nБудут стёрты ВСЕ файлы, включая мир. Это действие необратимо.',
      { title: server.inPlace ? 'Убрать сервер' : 'Удаление сервера' }
    );
    if (!ok) return;
    // повторное подтверждение (ввести название) — только для реального удаления файлов;
    // для импорта «на месте» файлы не трогаются, второй гейт не нужен
    if (!server.inPlace) {
      const typed = await promptDialog('Окончательное подтверждение. Введите название сервера, чтобы удалить его навсегда:', '', server.name);
      if (typed == null) return;
      if (typed.trim() !== server.name) { showToast('Название не совпало — удаление отменено.'); return; }
    }
    await guard(async () => {
      await API.remove(id);
      showToast(server.inPlace ? 'Сервер «' + server.name + '» убран из панели (файлы на месте).' : 'Сервер «' + server.name + '» удалён.', 'ok');
      if (state.currentId === id) {
        state.currentId = null;
        showScreen('list');
      }
      state.selectedId = null;
      await loadServers();
    });
  }

  // ---------- опрос ----------

  function pollOnce() {
    if (state.screen === 'list') guard(loadServers);
    else if (state.screen === 'server') refreshServer();
  }

  function startPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = setInterval(() => {
      // окно свёрнуто/вкладка скрыта — не опрашиваем и не перерисовываем DOM
      if (document.hidden) return;
      pollOnce();
    }, 2500);
  }

  // при возврате видимости сразу обновляем данные, чтобы они не выглядели застывшими
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.pollTimer) pollOnce();
  });

  // ---------- инициализация ----------

  function bind() {
    $('#btn-goto-create').addEventListener('click', () => {
      showScreen('create');
      suggestPort();
      loadVersions();
      if (state.memCreateSlider) state.memCreateSlider.refresh();
    });
    $('#btn-refresh').addEventListener('click', () => { guard(loadServers); loadRemoteConns(); });

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
      if (action === 'proxy') { showScreen('proxy'); guard(loadServers).then(() => renderProxyViz()); }
      if (action === 'remote') { showScreen('remote'); loadRemoteConns(); }
      if (action === 'settings') openAppSettings();
      if (action === 'about') $('#about-root').classList.remove('hidden');
      if (action === 'logout') doLogout();
    }));
    $('#proxy-back').addEventListener('click', () => { showScreen('list'); guard(loadServers); });
    $('#proxy-refresh').addEventListener('click', () => guard(loadServers).then(() => renderProxyViz()));
    Array.from(document.querySelectorAll('#app-menu a.menu-item')).forEach((a) =>
      a.addEventListener('click', () => menuToggle(false)));

    // иконка сервера (настройки)
    $('#icon-upload-btn').addEventListener('click', () => $('#icon-file').click());
    $('#icon-file').addEventListener('change', (event) => {
      const f = event.target.files[0];
      event.target.value = '';
      uploadServerIcon(f);
    });
    $('#icon-remove-btn').addEventListener('click', removeServerIcon);

    // ядро сервера (повторное скачивание / своё ядро)
    $('#core-redownload').addEventListener('click', redownloadCore);
    $('#core-upload-btn').addEventListener('click', () => $('#core-file').click());

    // подключение/отключение прокси (Velocity/BungeeCord) из настроек backend-сервера
    $('#proxy-attach').addEventListener('click', () => proxyLink('attach'));
    $('#proxy-detach').addEventListener('click', () => proxyLink('detach'));
    $('#core-file').addEventListener('change', (event) => {
      const f = event.target.files[0];
      event.target.value = '';
      uploadCore(f);
    });

    // текстурпак (ресурспак)
    $('#rp-upload-btn').addEventListener('click', () => $('#rp-file').click());
    $('#rp-file').addEventListener('change', (event) => {
      const f = event.target.files[0];
      event.target.value = '';
      uploadResourcePack(f);
    });
    $('#rp-remove-btn').addEventListener('click', removeResourcePack);
    $('#rp-require').addEventListener('click', () => $('#rp-require').classList.toggle('on'));
    const rpDrop = $('#rp-drop');
    rpDrop.addEventListener('click', () => $('#rp-file').click());
    ['dragenter', 'dragover'].forEach((ev) => rpDrop.addEventListener(ev, (e) => {
      e.preventDefault(); e.stopPropagation(); rpDrop.classList.add('drag');
    }));
    ['dragleave', 'dragend'].forEach((ev) => rpDrop.addEventListener(ev, (e) => {
      e.stopPropagation(); rpDrop.classList.remove('drag');
    }));
    rpDrop.addEventListener('drop', (e) => {
      e.preventDefault(); e.stopPropagation();
      rpDrop.classList.remove('drag');
      const f = e.dataTransfer && e.dataTransfer.files ? e.dataTransfer.files[0] : null;
      if (f) uploadResourcePack(f);
    });

    // вынос консоли в отдельное окно
    const pop = $('#console-pop');
    if (pop) pop.addEventListener('click', () => {
      if (!state.currentId) return;
      // в браузере '_blank' без параметров окна → новая вкладка; в десктоп-обёртке
      // WebView2 перехватывает window.open и открывает отдельное окно приложения
      window.open('/console.html?server=' + encodeURIComponent(state.currentId), '_blank', 'noopener');
    });

    // плагины и моды (Modrinth) — поиск, фильтры, листание
    ['plugins', 'mods'].forEach((kind) => {
      const e = CONTENT[kind].els;
      $(e.q.replace('-query', '-search-btn')).addEventListener('click', () => doContentSearch(kind, true));
      $(e.q).addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); doContentSearch(kind, true); }
      });
      $(e.cat).addEventListener('change', () => doContentSearch(kind, true));
      $(e.sort).addEventListener('change', () => doContentSearch(kind, true));
      $(e.prev).addEventListener('click', () => contentPage(kind, -1));
      $(e.next).addEventListener('click', () => contentPage(kind, 1));
      $(e.installed.replace('-installed', '-refresh')).addEventListener('click', () => loadInstalledContent(kind));
      // сворачивание/разворачивание каталога Modrinth
      $(e.collapse).addEventListener('click', () => setContentCollapsed(kind, !$(e.collapse).classList.contains('collapsed')));
    });

    // бэкапы
    $('#bk-create-btn').addEventListener('click', createBackup);

    // логи
    $('#logs-file').addEventListener('change', () => loadLogContent());
    $('#logs-query').addEventListener('input', renderLogView);
    if ($('#logs-search-all')) $('#logs-search-all').addEventListener('click', searchAllLogs);
    $('#logs-query').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); searchAllLogs(); } });
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
    $('#version-select').addEventListener('change', updateJavaInstallUI);
    $('#java-install-btn').addEventListener('click', startJavaInstall);
    // импорт существующего сервера
    mkToggle($('#toggle-import'), false);
    $('#toggle-import').addEventListener('click', updateImportMode);
    $('#import-browse').addEventListener('click', () => {
      $('#browse-root').classList.remove('hidden');
      loadBrowse($('#import-path').value || '');
    });
    $('#browse-close').addEventListener('click', () => $('#browse-root').classList.add('hidden'));
    $('#browse-root').addEventListener('click', (ev) => { if (ev.target === $('#browse-root')) $('#browse-root').classList.add('hidden'); });
    $('#browse-up').addEventListener('click', () => loadBrowse(browseParent || ''));
    // путь можно вписать/вставить вручную и перейти по Enter
    $('#browse-cur').addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); loadBrowse($('#browse-cur').value.trim()); }
    });
    // открыть НАТИВНЫЙ системный проводник (Windows/macOS/Linux) и перейти к выбранной папке
    const nb = $('#browse-native');
    if (nb) nb.addEventListener('click', async () => {
      nb.disabled = true;
      try {
        const r = await API.pickFolder();
        if (r && r.path) loadBrowse(r.path);
      } catch (e) { showToast(e.message); }
      finally { nb.disabled = false; }
    });
    // выбор режима импорта (копировать / на месте)
    $$('#import-mode-btns .seg').forEach((b) => b.addEventListener('click', () => setImportMode(b.dataset.mode)));
    setImportMode('copy'); // по умолчанию — копировать в панель
    $('#browse-pick').addEventListener('click', async () => {
      if (!browseCurPath) return;
      const picked = browseCurPath;
      $('#import-path').value = picked;
      populateImportJars(browseCurJars); // показать выбор .jar для запуска
      $('#browse-root').classList.add('hidden');
      // автоопределение: имя, ядро, версия, launch-jar — пользователю ничего вводить не нужно
      try {
        const d = await API.importDetect(picked);
        state.importDetected = d;
        const nf = $('#create-form [name=name]'); if (nf && !nf.value.trim() && d.name) nf.value = d.name;
        if (d.type) { const cs = $('#core-select'); if (cs && cs.value !== d.type) { cs.value = d.type; if (cs._mcSync) cs._mcSync(); onCoreChange(); } }
        if (d.jar) { const ij = $('#import-jar'); if (ij && Array.from(ij.options).some((o) => o.value === d.jar)) { ij.value = d.jar; if (ij._mcSync) ij._mcSync(); } }
        const sum = $('#import-detected');
        if (sum) { sum.textContent = 'Определено: ' + (CORE_NAMES[d.type] || d.type) + (d.version ? ' ' + d.version : '') + ' · запуск: ' + (d.jar || 'server.jar'); sum.classList.remove('hidden'); }
      } catch (e) { /* определение не критично — поля можно заполнить вручную */ }
    });
    $('#eula-row').addEventListener('click', (event) => {
      if (event.target.tagName !== 'A') $('#eula-check').classList.toggle('on');
    });

    $('#btn-back').addEventListener('click', async () => {
      // предупреждение о несохранённых изменениях настроек при выходе к списку
      if (state.currentTab === 'settings' && isSettingsDirty()) {
        const leave = await confirmDialog(
          'На вкладке «Настройки» есть несохранённые изменения. Выйти без сохранения?',
          { title: 'Несохранённые изменения', yesText: 'Выйти без сохранения', danger: true });
        if (!leave) return;
      }
      showScreen('list');
      guard(loadServers);
    });

    // кнопка «назад» браузера/окна — навигация внутри панели, без выхода из аккаунта
    window.addEventListener('popstate', routeFromHash);

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
    document.querySelectorAll('#settings-form .props-mode-btn').forEach((b) => {
      b.addEventListener('click', () => switchPropsMode(b.dataset.pm));
    });
    // пресет команды запуска → подставить его шаблон в поле
    if ($('#launch-preset')) $('#launch-preset').addEventListener('change', () => {
      const v = $('#launch-preset').value;
      if (v === 'custom') return;
      const p = (state.launchPresets || [])[parseInt(v, 10)];
      if (p) $('#launch-cmd').value = p.cmd || '';
    });
    // ручная правка команды сбрасывает выбор пресета на «Своя команда»
    if ($('#launch-cmd')) $('#launch-cmd').addEventListener('input', () => {
      const ps = $('#launch-preset'); if (ps && ps.value !== 'custom') { ps.value = 'custom'; if (ps._mcSync) ps._mcSync(); }
    });
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
    $('#btn-upload-dir').addEventListener('click', () => $('#upload-dir-input').click());
    $('#upload-dir-input').addEventListener('change', (event) => {
      // при webkitdirectory каждый File несёт webkitRelativePath (папка/подпапка/файл)
      let items = Array.from(event.target.files).map((f) => ({
        file: f,
        rel: (f.webkitRelativePath || f.name).replace(/\\/g, '/'),
      }));
      event.target.value = '';
      // тот же кап, что и у перетаскивания — иначе огромная папка (мир на десятки
      // тысяч файлов) синхронно построит столько же DOM-строк и подвесит вкладку
      if (items.length > 5000) {
        showToast('Слишком много файлов — загружаются первые 5000.');
        items = items.slice(0, 5000);
      }
      if (items.length) openDropConfirm(items);
    });
    $('#btn-editor-save').addEventListener('click', saveFileEditor);
    $('#btn-editor-close').addEventListener('click', closeFileEditor);

    $('#inv-close').addEventListener('click', closeInventory);
    $('#inv-root').addEventListener('click', (event) => {
      if (event.target === $('#inv-root')) closeInventory();
    });
    // карточка предмета закрывается по клику/прокрутке/Esc
    document.addEventListener('click', hideItemTooltip);
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') hideItemTooltip(); });
    $('#inv-body').addEventListener('scroll', hideItemTooltip, true);

    $('#wl-add-btn').addEventListener('click', addToWhitelist);
    $('#wl-input').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); addToWhitelist(); }
    });

    // настройки панели
    $('#appset-close').addEventListener('click', () => $('#appset-root').classList.add('hidden'));
    $('#appset-root').addEventListener('click', (event) => {
      if (event.target === $('#appset-root')) $('#appset-root').classList.add('hidden');
    });
    // колокол уведомлений: история последних 10
    if ($('#notif-bell')) $('#notif-bell').addEventListener('click', (e) => { e.stopPropagation(); toggleNotifPopup(); });
    document.addEventListener('click', (e) => {
      const pop = $('#notif-pop'); const bell = $('#notif-bell');
      if (notifPopupOpen && pop && !pop.contains(e.target) && bell && !bell.contains(e.target)) toggleNotifPopup(false);
    });
    // модалка описания плагина/мода: закрытие по крестику / клику вне / Esc
    if ($('#cm-close')) $('#cm-close').addEventListener('click', () => $('#content-modal').classList.add('hidden'));
    if ($('#content-modal')) $('#content-modal').addEventListener('click', (e) => { if (e.target.id === 'content-modal') $('#content-modal').classList.add('hidden'); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { const cm = $('#content-modal'); if (cm) cm.classList.add('hidden'); const pw = $('#pw-modal'); if (pw) pw.classList.add('hidden'); } });
    $$('#launchmode-btns .seg').forEach((b) => b.addEventListener('click', async () => {
      const mode = b.dataset.mode;
      const cur = $('#launchmode-btns .seg.sel');
      if (cur && cur.dataset.mode === mode) return; // режим уже выбран
      const label = mode === 'app' ? 'Приложение' : 'Браузер';
      const ok = await confirmDialog(
        'Переключить открытие на «' + label + '»?\nЕсли панель открыта как приложение — оно закроется и сразу откроется заново в новом режиме.',
        { title: 'Смена режима открытия', yesText: 'Переключить', danger: false });
      if (!ok) return;
      setLaunchModeBtns(mode);
      try {
        await API.setLaunchMode(mode);
        showToast('Режим переключён на «' + label + '»…', 'ok');
      } catch (e) { showToast(e.message); }
    }));
    mkToggle($('#set-graphs'), appSettings.graphs !== false);
    $('#set-graphs').addEventListener('click', () =>
      changeAppSettings({ graphs: $('#set-graphs').classList.contains('on') }));
    mkToggle($('#set-tray'), false);
    $('#set-tray').addEventListener('click', () => {
      const on = $('#set-tray').classList.contains('on');
      API.setTrayMinimize(on).catch((e) => { $('#set-tray').classList.toggle('on', !on); showToast(e.message); });
    });
    // карточка удалённого доступа в настройках панели
    bindRemoteAccessCard();
    // удалённые панели на главном экране
    bindRemoteConns();

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

  // macOS: курсор WebKit рисует крупнее — переключаем на меньший вариант (см. --cursor в CSS)
  try { if (/Mac/i.test((navigator.platform || '') + ' ' + (navigator.userAgent || ''))) document.documentElement.classList.add('is-mac'); } catch (e) { /* */ }
  applyAppSettings(appSettings);
  applyIcons(document);
  initCycleButtons(document);
  mkToggle($('#toggle-online'), true);
  mkToggle($('#toggle-pvp'), true);
  state.memCreateSlider = mkSlider($('#mem-create'), {
    min: 1024, max: state.maxMemMb, step: 512, value: 2048,
    format: fmtMem, labelEl: $('#mem-create-val'), onChange: updateMemHint,
  });
  state.cpuCreateSlider = mkSlider($('#cpu-create'), {
    min: 10, max: 100, step: 5, value: 100,
    format: fmtCpu, labelEl: $('#cpu-create-val'),
  });
  enhanceSelectsIn(document); // свои выпадашки для статичных <select> (ядро, версия, тема, категория)

  bind();
  bootApp(); // старт: loadMe/loadStatus/loadServers/polling + диплинки
})();
