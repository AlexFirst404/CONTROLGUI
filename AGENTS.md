# AGENTS.md — гид для ИИ-агентов по проекту CONTROLGUI

> Этот файл — **первое, что должен прочитать любой ИИ** (Claude Code, Cursor, Copilot, Gemini и др.), прежде чем менять код. Он описывает, что это за проект, и — главное — **незыблемые правила**, нарушать которые нельзя. Подробности: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (устройство) и [`docs/UI-KIT.md`](docs/UI-KIT.md) (дизайн-система).

## Что это

**CONTROLGUI** — настоящая панель управления Minecraft-серверами, работающая на компьютере пользователя. Один процесс Node.js поднимает и обслуживает реальные серверы (Vanilla/Paper/Purpur/Folia/Mohist/Forge + прокси Velocity/BungeeCord): консоль, файлы, игроки, моды, бэкапы, удалённый доступ. Никакого облака, аккаунтов и посредников — сервером является только машина пользователя.

- **Язык:** JavaScript (чистый vanilla Node, без сборки и транспиляции) + один CSS-файл. UI и весь текст — **на русском**.
- **Оболочки:** Windows (WPF+WebView2), macOS (Swift+WKWebView), Linux (.deb/AppImage/GTK+WebKit), плюс CLI и текстовый интерфейс (TUI) для серверов.
- **Лицензия:** GPL-3.0. Репозиторий приватный, публикует владелец сам.
- **Ветки:** рабочая `linux-deb`, дефолтная `main`. Коммиты идут в **обе**.

---

## 🚫 НЕЗЫБЛЕМЫЕ ПРАВИЛА (читать обязательно)

Эти правила — фундамент проекта. Их нарушение ломает философию проекта или создаёт дыры в безопасности.

### 1. Ноль npm-зависимостей
В репозитории **нет `package.json` и `node_modules`**, и не должно появиться. Весь код — на встроенных модулях Node: `http`, `https`, `tls`, `fs`, `path`, `crypto`, `zlib`, `os`, `child_process`. Своя реализация X.509-серта, tar/ar/gzip-писателей, ZIP-распаковщика, NBT-парсера, метрик. **Никогда не предлагай `npm install`, не добавляй зависимости, не создавай `package.json` со скриптами.** Любую задачу решай стандартной библиотекой.

### 2. Только компоненты UI-кита MinecraftUI
Весь визуал — самописный кит в `public/css/minecraft.css` (стиль Minecraft Ore UI). **Никогда не изобретай свои кнопки, поля, свитчи, чекбоксы, дропдауны, модалки, тосты, статус-индикаторы.** Бери готовые: `.mc-btn` (+`primary`/`accent`/`danger`/`sm`/`lg`/`sq`/`block`), `.fld`, `.mc-toggle`, `.mc-check`, `.mc-sel`, `.mc-slider`, `.modal-wrap`/`.modal`, `.toast`, `.status-dot`/`.st-*`, иконки `.pi`. Layout-обёртки (flex/grid вроде `.btn-row`, `.toggle-row`, `.form-grid`) добавлять можно; **визуальные примитивы — только из кита**. Не задавай инлайн-цвета/шрифты/бордеры примитивам — только классы кита и токены (`var(--accent)` и т.п.). Полный инвентарь и правила — в [`docs/UI-KIT.md`](docs/UI-KIT.md).

> Интерактивные примитивы кита — это **пара CSS + JS**. `<div class="mc-toggle">` без вызова `mkToggle(el)` — пустой нерабочий квадрат. Свитчи оживляй `mkToggle`, слайдеры `mkSlider`, `<select>` — `enhanceSelectsIn`. Состояние свитча/чекбокса читается по классу `.on` (`el.classList.contains('on')`), не через `checked`.

### 3. Всё на русском
Пользовательские строки (кнопки, подсказки, ошибки), сообщения консоли (с префиксом `[ПАНЕЛЬ] `) и **комментарии в коде** — на русском. Комментарии объясняют «почему» (подводные камни ОС/безопасности), а не «что».

### 4. Инварианты безопасности (НЕ ослаблять)
- **Loopback-only админка.** HTTP-панель (порт 8400) слушает на всех интерфейсах ради раздачи ресурспаков `/rp/`, но UI+API отдаёт **только с loopback** (`isLoopbackReq`). Управление по сети — только через отдельный HTTPS-листенер удалёнки. `/rp/*.zip` — единственное публичное на HTTP (без авторизации, для игровых клиентов).
- **Anti-CSRF `sameOriginRequest`** (server.js): мутирующий (не GET/HEAD/OPTIONS) `/api/`-запрос принимается, только если `Origin` отсутствует (не-браузер) ИЛИ `u.host === req.headers.host` (с портом). Не ослаблять; новые мутирующие пути класть под `/api/`.
- **Скоуп прав по КАНОНИЧЕСКОМУ id.** Права удалённого пользователя **нельзя** скоупить в server.js разбором сырого пути — только `api.js` после `store.get()` делает `req.cgUser.perms = permsForServer(cgRemoteUser, server.id)`. Двойной парсинг id = дыра path-traversal (`/api/servers/A/../B`). Это уже случавшийся баг.
- **Каждая мутация — с `requirePerm`/`requireAnyPerm`/`requirePermOn`** и правильным ключом из `users.PERMISSIONS`. `server.create` удалённым закрыт.
- **Пиннинг серта** («удалённые панели», TUI): `ca=[pem]` + `rejectUnauthorized:true` + сверка SHA-256 в `checkServerIdentity`. Пароль хранится в открытом виде и шлётся при автовходе — отключение пиннинга = кража пароля через MITM.
- **Куку удалённой панели не отдавать браузеру** (живёт только в памяти прокси), пароли/PEM/хэши не логировать и не отдавать наружу.
- **Файловые операции — только через `safePath(serverId, rel)`** (отсекает `..` и `:` для NTFS ADS на Windows).
- Пароли — `pbkdf2Sync(120000, sha256)` + 16-байт соль; вход постоянного времени (`timingSafeEqual` + dummy-хэш); анти-брутфорс по **`ip + username`** (не по XFF!).

### 5. Кроссплатформенность
Windows / Linux / macOS. Держи три ветки в коде работы с процессами. Не полагайся на локализуемый вывод утилит (`netstat` на Windows переводит «LISTENING»), на наличие `/proc` (нет на Win/macOS). На Windows для zip/jar форсь **`System32\tar.exe` (bsdtar)** — GNU/MSYS-tar из Git for Windows zip не читает. На POSIX `spawn` серверов **обязан** быть `detached:true` (иначе `kill(-pid)` не убьёт JVM); на Windows — нет.

### 6. Единый источник данных и версии
- Реестр серверов — `data/servers.json` формата `{ "servers": [...] }` (не голый массив). Формат верхнего ключа не менять.
- **Версия продублирована руками в ~10 местах** — при бампе править ВСЕ разом (см. ниже).

---

## Архитектура за 60 секунд

```
Запрос ──► server.js handleRequest  (ОДИН обработчик на ДВА листенера)
           │  различает listener'ы по req.socket.encrypted (viaRemote)
           ├─ /rp/<id>.zip ─────────► ресурспак игровым клиентам (без авторизации)
           ├─ HTTP 8400 (локальный) ─► гейт loopback → req.cgUser = владелец {admin:true}
           ├─ HTTPS (удалёнка)       ─► логин/пароль → сессия cg_remote → права по серверу
           │                            sameOriginRequest (anti-CSRF) на /api/
           ├─ /api/* ────────────────► lib/api.js handle()  (цепочка if по parts=path.split('/'))
           │                            requirePerm → manager/store/fs → json(res,...)
           └─ иначе ─────────────────► lib/static.js (public/, ETag+gzip)

lib/manager.js   — жизненный цикл java-серверов (spawn/kill), SSE-консоль, метрики, усыновление сирот
lib/remoteaccess.js — HTTPS-листенер удалёнки: мульти-юзер, права по серверу, сессии, ротация серта
lib/remoteclient.js — «удалённые панели» v2.2.0: локальный пиннинг-прокси к чужой CONTROLGUI + автовход
lib/users.js     — модель прав (PERMISSIONS/PRESETS, hasPerm/canAccessServer/permsForServer)
lib/store.js     — реестр servers.json ({servers:[...]}), кэш в памяти
lib/paths.js     — пути (DATA_ROOT / CONTROLGUI_DATA, serverDir(id))

public/index.html — ВСЕ экраны и модалки сразу (скрыты .hidden)
public/js/app.js  — вся логика в одном IIFE + приватный state; экраны через showScreen(name)
public/js/api.js  — тонкий REST-клиент window.API
public/css/minecraft.css — UI-кит (единственный визуальный слой)
```

Подробно — в [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Соглашения кода

- **Бэкенд:** маршрутизация — линейная цепочка `if` по `parts = url.pathname.split('/').filter(Boolean)` внутри одной функции `handle()` в api.js. Ошибки — `throw fail(status, 'русское сообщение')` (`fail = Object.assign(new Error(msg),{status})`); ответ — `json(res, status, data)`. Тело — `readBody(req)` (JSON, лимит 4МБ); загрузки — `receiveUpload` (256МБ, стрим). Не раскрывать сырые ошибки (пути) удалённо — они обобщаются, если у исключения нет `.status`.
- **Фронтенд:** без фреймворков. `$`=querySelector, `$$`=Array.from(querySelectorAll). Всё в `state`, реактивности нет — после мутации вручную зовут `render*`. DOM строят `createElement`+`appendChild` (не `innerHTML` для пользовательских данных). Скрытие — класс `.hidden` (или `.perm-hidden` по правам). Сеть — только через `window.API`. Иконки — `<i class="pi" data-ic="имя">` + `applyIcons(newEl)` после вставки. Асинхронщину оборачивать в `guard(fn)` / try-catch + `showToast(e.message)`.
- **Атомарная запись** файлов с секретами: уникальный `.tmp` (pid+random) + `rename`, `mode 0600`.

### Кулинарная книга «как сделать X»
- **Новый экран:** `<section id="screen-X" class="screen hidden">` в index.html → строка в `showScreen()` (toggle `.hidden`) → при нужде ветка в `routeInitialHash`/`routeFromHash` и `pushHash` в `showScreen`. Проверить, не надо ли учесть в `html.embed*`-правилах CSS. *(Пример — недавно добавленный экран «Удалённые панели» `#screen-remote`.)*
- **Новая вкладка сервера:** `<button class="mc-tab" data-tab="X">` + `<div class="tab-pane hidden" id="tab-X">` → строка в `switchTab()` (toggle + ленивый загрузчик) → права в `tabPerm` внутри `applyPermissions()`.
- **Новый эндпоинт:** ветка в `handle()` (api.js) с `requirePerm(...)` в начале → добавить однострочник в `window.API` (api.js фронта). Мутация автоматически под защитой `sameOriginRequest`.
- **Новый свитч/слайдер/селект:** пустой `<div class="mc-toggle" id="...">` → `mkToggle($('#...'))` в инициализации. Аналогично `mkSlider`/`enhanceSelectsIn`.

---

## Сборка и релиз

**Тело панели везде одинаково:** `server.js` + `cli.js` + `tui.js` + `lib/` + `public/`.

- **Linux:** `node linux/build-deb.js <версия>` → `.deb`; `node linux/build-tarball.js <версия>` → `.tar.gz` (оба — чистый Node, свои tar/ar/gzip).
- **AppImage / macOS pkg:** только вручную через CI — `gh workflow run appimage.yml/pkg.yml --ref linux-deb -f version=<v> -f release_tag=<tag>` (собирает и сам аплоадит в существующий релиз). На push НЕ запускаются.
- **Windows** (собирается локально в 3 шага, `.iss`/`.csproj` лежат в `C:\Users\alext\RiderProjects\CONTROLGUI.Desktop`, НЕ в git): пересобрать `panel.zip` (System32 tar: `tar -acf panel.zip server.js cli.js tui.js lib public`) → скопировать в проект → `dotnet publish -c Release -r win-x64 --self-contained true -o %TEMP%\cgapp_forge` → `ISCC controlgui.iss`. НЕ включать `PublishTrimmed`/`InvariantGlobalization` (краш WPF).
- Финал: `gh release create <тег>` + `gh release upload` для setup.exe/.deb/.tar.gz.

### ⚠️ Версия — в ~10 местах, править ВСЕ разом при бампе
`lib/download.js` (UA, стр. 5) · `lib/api.js` (`app:`, ~стр. 1114) · `linux/build-deb.js` · `linux/build-tarball.js` · `linux/build-appimage.sh` · `mac/build-pkg.sh` · `.github/workflows/pkg.yml` + `appimage.yml` (defaults) · `controlgui.iss` (`MyAppVersion`) · `CONTROLGUI.Desktop.csproj` (`<Version>`). Пропуск одного = рассинхрон версий между артефактами.

## Git

- Ветки: рабочая **`linux-deb`**, дефолтная **`main`**. Пушить в обе (`git push origin linux-deb` → `linux-deb:main` → `git branch -f main linux-deb`). Контрибьюшн-плитка считает коммиты на `main`.
- Перед коммитом — секрет-скан; **никогда не коммитить cert/key/пароли**. `data/` в `.gitignore`. `panel.zip` пересобирать при изменении тела панели.
- Сообщения коммитов на русском; завершать `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## Подробные документы
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — устройство всех подсистем (бэкенд, процессы, удалёнка/безопасность, фронтенд, сборка, CLI/TUI/либы), потоки данных, подводные камни.
- [`docs/UI-KIT.md`](docs/UI-KIT.md) — полный инвентарь компонентов кита, токены/темы, как оживлять свитчи/слайдеры/селекты, ловушки (`modal-body { white-space: pre-line }` и др.).
- [`README.md`](README.md) (рус) / [`README.en.md`](README.en.md) — для людей: возможности, установка, скриншоты.
