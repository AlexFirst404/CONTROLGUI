# Архитектура CONTROLGUI

Детальное устройство проекта для ИИ-агентов и разработчиков. Верхнеуровневые правила и «что нельзя ломать» — в [`../AGENTS.md`](../AGENTS.md). Дизайн-система — в [`UI-KIT.md`](UI-KIT.md).

## Оглавление
1. [Принципы](#принципы)
2. [Точка входа и два листенера](#точка-входа)
3. [Модель прав и доступа](#модель-прав)
4. [REST API](#rest-api)
5. [Управление java-процессами](#процессы)
6. [Удалённый доступ (входящий)](#удалённый-доступ)
7. [Удалённые панели (исходящие)](#удалённые-панели)
8. [Хранилище и пути](#хранилище)
9. [Фронтенд SPA](#фронтенд)
10. [CLI и TUI](#cli-tui)
11. [Вспомогательные библиотеки](#библиотеки)
12. [Сборка и релиз](#сборка)
13. [Данные на диске](#данные)
14. [Каталог подводных камней](#подводные-камни)

---

## <a id="принципы"></a>1. Принципы
- **Ноль npm-зависимостей.** Только встроенные модули Node. Своя криптография, свои упаковщики, свой NBT/ZIP.
- **Vanilla всё.** Бэкенд без фреймворков, фронтенд без сборки/фреймворков (один IIFE), один CSS-кит.
- **Локально = доверие, по сети = пароль.** Владелец за клавиатурой имеет полный доступ без пароля (loopback); сетевой доступ — только через HTTPS-удалёнку с правами по каждому серверу.
- **Кроссплатформа.** Windows / Linux / macOS — три ветки в коде работы с процессами и упаковки.
- **Русский** во всех строках и комментариях.

## <a id="точка-входа"></a>2. Точка входа и два листенера — `server.js`
`http.createServer(handleRequest)` слушает `PORT` (по умолчанию 8400). `remoteaccess.init(handleRequest)` поднимает **второй**, HTTPS-листенер удалёнки с **тем же** обработчиком. Внутри `handleRequest` они различаются по `viaRemote = !!req.socket.encrypted`.

Порядок обработки в `handleRequest`:
1. **`/rp/<id>.zip`** → стрим `resourcepack.zip` игровым клиентам **без авторизации** (клиент MC не умеет куки/самоподписанный TLS). Единственное публичное на HTTP.
2. **viaRemote (HTTPS):** `remoteaccess.handleAuthRoutes` (логин/логаут) → `sessionUserFromReq` → если нет сессии, редирект на `/login` (кроме публичных ассетов страницы входа, перечислены whitelist'ом).
3. **не-remote (HTTP):** гейт `isLoopbackReq` (127.0.0.1/::1/::ffff:127.0.0.1) — иначе 403 (кроме `CONTROLGUI_ALLOW_LAN=1`).
4. **`/api/*`:** `sameOriginRequest` (anti-CSRF) → ставит `req.cgUser`/`req.cgRemote`/`req.cgRemoteUser` → спец-обработка `/api/quit` → `handleApi`.
5. **иначе** → `serveStatic` (public/, ETag + ленивый gzip-кэш).

**Принципал запроса** (ставит server.js, читает api.js):
- Локально: `req.cgUser = users.currentUser(req)` = `{admin:true, perms:{admin:true}}`.
- Удалённо: `req.cgUser = {remote:true, username, admin:false, access, perms:{}}` + `req.cgRemoteUser` (сырой юзер для последующего скоупа) + `req.cgRemote = true`.

Прочее: watchdog родителя (`CONTROLGUI_PARENT_PID` — если нативное окно умерло, выходим, java-серверы выживают), graceful shutdown (SIGINT/SIGTERM/SIGHUP), `process.on('uncaughtException')` не даёт единичному кривому запросу уронить процесс вместе с серверами.

**`/api/quit`** — штатное завершение: только loopback + заголовок `x-cg-local:1` + не-remote. `x-cg-stop-servers:1` (от CLI stop) останавливает MC перед выходом (на Windows SIGTERM = жёсткий kill, обработчики сигналов не срабатывают). Иначе 409 при `manager.anyActive()`.

## <a id="модель-прав"></a>3. Модель прав и доступа — `lib/users.js`
- `PERMISSIONS` / `PERM_KEYS` — 21 плоский булев ключ уровня сервера вида `group.action` (`console.view`, `console.command`, `server.stop`, `files.write`, `players.ban`, `backups.restore`, `settings.edit`, …). `PERM_KEYS` — единственный источник валидных ключей; `sanitizePerms` отбрасывает неизвестные.
- `PRESETS` — `full` / `manage` / `view` (наборы ключей).
- **access-карта** пользователя: `{ "<serverId>"|"*": { "console.view":true, ... } }`. `"*"` — доступ ко всем серверам (но **не** к глобальным операциям). `sanitizeAccess`: ключи `"*"` или `^[A-Za-z0-9_\-]{1,64}$`, лимит 500.
- `currentUser(req)` — локальный владелец `{admin:true, perms:{admin:true}}`.
- `hasPerm(user, key)` — admin → true, иначе `perms[key]`. `canAccessServer(user, id)` — admin → true; иначе `!!(access[id] || access['*'])`; нет access-карты → true (локальный). `permsForServer(user, id)` — `access[id]` или `access['*']` или `{}`.
- `server.create` (создание НОВЫХ серверов) — глобальная операция, удалённым **закрыта** (их `perms` пусты вне блока `/api/servers/<id>`).

## <a id="rest-api"></a>4. REST API — `lib/api.js`
`handle()` — большой диспетчер: `const parts = url.pathname.split('/').filter(Boolean)` (`parts[1]`=ресурс, `[2]`=id/подресурс, `[3]`=action, `[4]`=подкоманда) + ветвление по `method`. `handleApi` — обёртка с `try/catch`.

Хелперы прав: `requirePerm(req,key)` (throw `fail(403)` если `!hasPerm`), `requireAnyPerm(req,[keys])`, `requirePermOn(req,key,serverId)` (право на ДРУГОЙ сервер, напр. прокси при привязке backend — локально пропускает, удалённо проверяет).

**КРИТИЧНЫЙ паттерн скоупа прав.** Для `/api/servers/<id>/...`:
```js
const server = store.get(parts[2]);          // канонический объект
if (!server) throw fail(404, ...);
if (!users.canAccessServer(req.cgUser, server.id)) throw fail(403, ...);
if (req.cgRemoteUser) req.cgUser.perms = users.permsForServer(req.cgRemoteUser, server.id);
```
Скоуп прав по **каноническому `server.id`** (из `store.get`), а НЕ по сырому пути. Иначе `/api/servers/A/../B` (где `new URL()` нормализует `..` в api.js, а regex в server.js — нет) даст права A операциям над B. **Это реальный ловленный баг — не воспроизводить.**

Тело: `readBody(req)` (JSON, лимит 4МБ → 413). Загрузки: `receiveUpload` (стрим, 256МБ). Файлы: **всегда `safePath(serverId, rel)`** (нормализует, отсекает `..`, `:` на Windows). Ошибки: `fail(status,msg)` — с `.status` отдаётся текст как есть; без `.status` (500) удалённо обобщается в «Внутренняя ошибка сервера». `isRemoteReq(req)` скрывает чувствительное удалённо (путь `DATA_ROOT` и `lanIps` в `/api/status`, IP игрока без прав модерации, системный проводник).

## <a id="процессы"></a>5. Управление java-процессами — `lib/manager.js` (+ `download.js`, `javainstall.js`, `javas.js`, `coreinfo.js`)
Рантайм-состояние каждого сервера — в `Map states`, **НЕ персистится** (после рестарта панели всё `stopped`; связь с живым процессом — только через усыновление). `getState(id)` лениво создаёт запись: `proc`, `status` (stopped|starting|running|stopping|error), `console[]` (кольцо на 1000 строк), `clients` (Set SSE-ответов), `players/playersInfo`, `stats[]`, `orphanPid`, флаги.

**Запуск `start(server, retryAfterJava)`** — двухфазный:
1. Если под `server.version` нужен мажор Java (`requiredJavaMajor`) и его нет (`findJava`) — статус `starting`, качается Temurin (`javainstall.installJavaAndWait`) с прогрессом в консоль, затем рекурсивно `start(server, true)`. `retryAfterJava` защищает от бесконечного цикла.
2. `buildJavaArgs` + `pickJava` → `spawn(bin, args, {cwd, detached:!IS_WIN})` → `store.update(pid)` → `beginStats` + `applyCpuLimit`. Проверки перед запуском бросают `.status=409` (уже запущен, идёт установка Java, жив сирота, идёт скачивание, файлов нет).

`buildJavaArgs`: `-Xms512M -Xmx<mem>M` + **обязательные UTF-8 флаги** (`-Dfile.encoding=UTF-8`, `-Dstdout/stderr.encoding=UTF-8` — без них на Windows кириллица в консоли → `?`). Режим `jar` → `['-jar', target, 'nogui']`, режим `args` → `['@target','nogui']` (Forge 1.17+); `launchSpec` переключает `win_args.txt`↔`unix_args.txt` под ОС.

**Убийство `killPidTree`:** Windows — `taskkill /T /F`; POSIX — `kill(-pid)` по группе (поэтому `spawn` **обязан** быть `detached:true`) + запасной проход по `/proc`.

**Консоль:** `stdout/stderr` → буфер → split `\n` → `stripAnsi` (гасит `\x1b[..m` и §-коды Paper/Purpur, иначе ломают регэкспы и имена игроков) → детект `Done (..s)!` → `status=running`; регэкспами ловятся версия, UUID, вход с IP, joined/left, достижения. **SSE `attachConsole`:** `text/event-stream`, сразу шлёт `: connected\n\n` (флашит заголовки — иначе пустая консоль висит до heartbeat через прокси удалёнки), отдаёт буфер, добавляет `res` в `clients`; `pushLine` рассылает всем. Один heartbeat-таймер (25с) на все серверы.

**Метрики:** один `runStatsTick` (каждые 3с) на весь процесс. За «наблюдаемыми» серверами (открыта консоль / недавно звали getStats) — каждый тик, за остальными — раз в 5. Windows — ОДИН batch PowerShell на все PID; Linux — `/proc/<pid>/{stat,statm,io}`; macOS — `ps` (I/O недоступен). **`statsPid` verify/recover:** `java.exe` (JDK 21+) — лаунчер, реальная JVM — отдельный процесс, слушающий порт; метрики/лимит/убийство идут по тому, кто слушает `server.port` (`listeningPorts()`).

**Усыновление сирот `adoptOrphans`:** при старте панели ищет живой java-процесс каждого сервера (по сохранённому store `pid` или по слушаемому `server.port`). Найденный → `orphanPid`, консоль недоступна, можно только «Убить». `anyActive` учитывает сирот и `javaInstalling` для гейта `/api/quit`.

**CPU-лимит** через affinity (`cpuMaskFor`): Windows — PowerShell ProcessorAffinity, Linux — `taskset`, macOS — не поддерживается. Переприменяется по `Done` и таймерам (порт привязывается под конец загрузки).

**Загрузка ядер `download.js`:** `getVersions`/`resolveServerUrl` по провайдерам — vanilla(Mojang), paper/folia/velocity(**PaperMC Fill v3** — старый v2 отдаёт 410), purpur, mohist, forge(installer), bungeecord(роллинг). `downloadFile` в `.part` + `rename`, кэш 10 мин, приватные заголовки не пробрасываются при редиректе на другой хост.

## <a id="удалённый-доступ"></a>6. Удалённый доступ (входящий) — `lib/remoteaccess.js`
HTTPS-листенер с самоподписанным сертом (`lib/selfsigned.js` — чистый JS X.509 через ручной ASN.1/DER + RSA-SHA256, SAN с dnsNames+LAN-IP). Конфиг `data/remote-access.json` (mode 0600): `{enabled, port, generation, users:[{username, salt, hash, pwVersion, access}]}`.

- **Мульти-юзер**, у каждого — своя access-карта (права по каждому серверу).
- **Пароли:** `pbkdf2Sync(120000, sha256)` + 16-байт соль. `verify()` постоянного времени (dummy-pbkdf2 при отсутствии юзера + `timingSafeEqual`).
- **Сессии** `cg_remote` (HttpOnly/Secure/SameSite=Lax). Двухуровневая инвалидация: `pwVersion` (монотонный, привязан к юзеру — смена пароля/пересоздание ника рвёт его старые куки) + `generation` (глобальный — `disable()` делает `++`, убивая ВСЕ куки навсегда). `sessionUserFromReq` проверяет: `enabled`, `gen`, существование юзера, `pwVersion` **по файлу** (ловит смену из CLI/другого процесса).
- **Анти-брутфорс** по ключу `socketIp + '|' + username.toLowerCase()` (успех в своей учётке не сбрасывает блок за перебор чужой). 5 попыток → блок 5 мин, 429. IP — из сокета, **не** из X-Forwarded-For.
- При отзыве доступа (`removeUser`/смена прав) — `dropConnections()`/`closeAllConnections()` рвут живую SSE-консоль немедленно.
- `regenerateCert()` — после ротации все запиненные клиенты («удалённые панели», TUI) перестанут подключаться, нужен повторный «Проверить» + сверка отпечатка.

## <a id="удалённые-панели"></a>7. Удалённые панели (исходящие, v2.2.0) — `lib/remoteclient.js`
Подключение к CONTROLGUI на **других** машинах прямо из приложения. Конфиг `data/remote-connections.json` (mode 0600, хранит пароли и PEM открыто): `{connections:[{id,name,host,port,username,password,fingerprint,pem,addedAt}]}`. Управление — **только с локальной машины** (гейт `isRemoteReq` в api.js).

- **Пиннинг (TOFU):** `agentFor` = `ca:[conn.pem]` (self-signed сходится сам с собой) + `rejectUnauthorized:true` (рвёт при любом другом серте **до** отправки заголовков — иначе MITM крадёт пароль/куку) + `checkServerIdentity` сверяет `SHA-256(cert.raw) === conn.fingerprint` (SNI по IP запрещён Node → хост проверяем по отпечатку, не по SAN). `save()` пробит серт ещё раз и пинит, только если отпечаток тот же, что сверил юзер (TOCTOU). `pem` наружу в браузер не отдаётся.
- **Локальный прокси:** на клик «Открыть» поднимается http-сервер на `127.0.0.1:<эфемерный>`, `login()` получает `cg_remote` в память (`st.cookie`), браузер ходит на loopback-прокси. `proxyRequest` → `forward` стрипает hop-by-hop + `origin`/`referer` + `cookie`, подставляет `st.cookie` и host удалёнки → `https.request` через pinned agent. **Куку удалённой панели браузеру не отдаём** (set-cookie апстрима вырезается).
- **Host-guard от DNS-rebinding:** прокси слушает строго `127.0.0.1`, пропускает только loopback `remoteAddress` + Host ∈ {127.0.0.1, localhost, [::1]}.
- **Автовход/релогин:** при 401/302→/login — один дедуплицированный релогин (`ensureLogin`) + повтор, но только для **retryable** (буферизованное мелкое тело; chunked/тело >1МБ идут потоком и не повторяются — повтор дал бы пустое тело). `/api/auth/logout` не форвардится (прокси сам отвечает ok, `/login` редиректит на локальную панель — это и есть «выход»).
- В GET `/` инъектится кнопка «← Мои серверы» (форсит `accept-encoding: identity`, буфер HTML лимитирован 8МБ — защита от враждебной панели, съедающей память).

## <a id="хранилище"></a>8. Хранилище и пути — `lib/store.js`, `lib/paths.js`
- `store.js` — реестр `data/servers.json` формата `{servers:[...]}`, кэш в памяти. API: `all/get/add/update(id,patch)/remove`. `get()` возвращает **живой** объект из кэша (прямая мутация видна, но без `save()` не персистится — всегда через `update`).
- `paths.js` — `DATA_ROOT` = `env CONTROLGUI_DATA` или рядом с кодом; `DATA_DIR`, `SERVERS_DIR`, `REGISTRY_FILE`. `serverDir(id)` — для импортированных «на месте» серверов возвращает `server.dir` (внешняя папка — её содержимое при удалении сервера **не трогать**), иначе `SERVERS_DIR/id`. `launchMode`(app/browser) и `tray-minimize` — в фиксированном per-user каталоге (`%LOCALAPPDATA%\CONTROLGUI` / `~/.local/share/controlgui`). `migrateLegacyData()` — однократный перенос из старой раскладки `app/<версия>` (только при заданном `CONTROLGUI_DATA` и пустом реестре).

## <a id="фронтенд"></a>9. Фронтенд SPA — `public/`
Одностраничка без фреймворков. `index.html` содержит **ВСЕ экраны и модалки сразу** (скрыты `.hidden`). Порядок скриптов (не менять): `itemnames-ru.js` → `api.js` (объявляет `window.API`) → `app.js`.

- **`app.js`** — один IIFE, приватный `state`, хелперы `$`/`$$`. Внизу файла — императивная инициализация (`applyIcons`, `initCycleButtons`, `mkToggle`/`mkSlider`, `enhanceSelectsIn`), затем `bind()` и `bootApp()`.
- **Экраны:** `#screen-list`, `#screen-server`, `#screen-create`, `#screen-proxy`, `#screen-remote` (менеджер удалённых панелей). `showScreen(name)` тоггает `.hidden`, закрывает меню, при уходе с server закрывает SSE, зовёт `pushHash`. Вкладки сервера историю пушит `switchTab`.
- **Роутинг по hash:** `routeInitialHash()` (старт) и `routeFromHash()` (popstate, под `navLock` чтобы вложенные `pushHash` не плодили записи). Диплинки: `#create`, `#proxy`, `#remote`, `#rc-add`, `#server=<id>/tab/<tab>/player/<name>`.
- **Оживление компонентов кита** (см. [UI-KIT.md](UI-KIT.md)): `mkToggle(el,initialOn)` наполняет свитч и вешает click→toggle('on') — без вызова пустой квадрат. `mkSlider(el,opts)` → контроллер `{value,set,setRange,refresh}`. `enhanceSelect(sel)` рисует `.mc-sel` поверх нативного `<select>` (на WebKitGTK нативный список бел-на-бел). После **программной** установки `select.value` звать `sel._mcSync()`. Значения читаются из DOM: свитч/чекбокс — `classList.contains('on')`, селект — `.value`, слайдер — из контроллера.
- **Права:** `can(perm)` (до `loadMe()` возвращает true — не блокирует заранее; реальная защита на сервере), `applyPermissions()` прячет вкладки/кнопки классами по правам.
- **Удалённые панели** (после редизайна v2.2.x): экран-менеджер `#screen-remote` + компактный вход `#rc-home-entry` на главной + пункт меню `#menu-remote`. `loadRemoteConns` грузит `API.remoteConns()`, рендерит карточки `.srv-card.rc-card` в `#rc-list`, асинхронно проверяет статус каждого (`remoteConnAction('check')`). Мастер добавления `#rc-modal` — **2 шага**: шаг 1 (данные) → `rcProbe` (получает отпечаток) → шаг 2 (сверка отпечатка) → `rcSave` (пинит). Смена host/port на шаге 1 обнуляет отпечаток. «Открыть» → `remoteConnAction('open')` → `location.href` локального прокси.
- **Уведомления:** `showToast(msg, type)` (`'ok'` = зелёный, иначе красный), `confirmDialog`/`promptDialog` (Promise), `guard(fn)`.
- **EMBED** (`?embed=1&go=<цель>`): та же страница как окно рабочего стола внутри Minecraft-мода. Классы `html.embed*` на корне прячут/меняют секции — при добавлении экранов проверять эти CSS-правила.

## <a id="cli-tui"></a>10. CLI и TUI — `cli.js`, `tui.js`
- **`cli.js`** (`controlgui`): `serve`/`start`/`stop`/`status` (демон через pid-файл + HTTP, а **не** прямой kill — `cmdStop` шлёт `/api/quit` с `x-cg-stop-servers` чтобы MC сохранили миры, kill только фолбэк), `remote user/enable/disable/port/cert-reset` (делегирует в remoteaccess/users), `service install/uninstall` (systemd от `SUDO_USER`, дом из `getent`), `connect` (клиент-режим GUI), `tui`. `askHidden` — ввод пароля без эха; в не-TTY читает РОВНО одну строку (не до EOF — иначе второй промпт пароля зависнет).
- **`tui.js`** — текстовый интерфейс на чистом ANSI. Работает с локальной (http) и удалённой (https) панелью. **TOFU-пиннинг:** `probeCert` снимает отпечаток+PEM, сохраняет в `tui-known-hosts.json`; дальше `ca:[pem]` + `rejectUnauthorized:true` (рвёт до отправки пароля) + сверка отпечатка в `checkServerIdentity`. Свой ESC-парсер стрелок, консоль через SSE.

## <a id="библиотеки"></a>11. Вспомогательные библиотеки `lib/`
| Файл | Назначение |
|---|---|
| `proxy.js` | Velocity/BungeeCord: генерация конфигов, legacy-форвардинг, привязка/отвязка backend'ов (online-mode + `spigot.yml bungeecord`), транслит-slug имён |
| `backups.js` | Бэкапы каталога сервера в `.tar.gz` (системный bsdtar); save-all перед бэкапом, авто-бэкап перед restore, restore только на остановленном |
| `modrinth.js` | Поиск/установка плагинов и модов с api.modrinth.com; подбор версии под MC+лоадер, рекурсивная докачка обязательных зависимостей |
| `properties.js` | Парсер/сериализатор `server.properties` (key=value, `#`-комментарии) |
| `nbt.js` | Простой NBT-**читатель** → JS-значения (для отображения; long теряет точность за 2⁵³) |
| `nbtedit.js` | Типо-сохраняющий NBT-**редактор** playerdata (узлы `{t,v}`, compound в Map, long как BigInt, raw-байты строк) — правка инвентаря/статов **без потерь** |
| `snbt.js` | Парсер SNBT (вывод `data get entity`) → JS-объекты |
| `unzip.js` | ZIP-распаковщик без зависимостей (только zlib). **Вызывающий обязан** сам делать safePath (zip-slip) и лимиты (zip-bomb) |
| `selfsigned.js` | Чистый JS X.509 (ASN.1/DER + RSA-SHA256) |
| `static.js` | Раздача public/ (ETag/304, gzip-кэш, отсев NUL-байта) |
| `coreinfo.js` | Определение версии MC из server.jar (jar=zip) |
| `download.js` / `javainstall.js` / `javas.js` | Загрузка ядер / авто-Java Temurin / поиск установленных Java |

## <a id="сборка"></a>12. Сборка и релиз
См. раздел «Сборка и релиз» в [`../AGENTS.md`](../AGENTS.md) — тело панели, платформы, **список ~10 мест версии**, git-флоу. Ключевое: `.deb`/`.tar.gz` — чистый Node; AppImage/pkg — CI `workflow_dispatch`; Windows — локально (`panel.zip` → `dotnet publish` → ISCC), `.iss`/`.csproj` не в git. `CONTROLGUI.Browser.csproj` застрял на 1.3.0 (запасная обёртка, не синхронизируется). `Installer.cs` — мёртвый код.

## <a id="данные"></a>13. Данные на диске (`DATA_ROOT`)
```
data/
  servers.json            — реестр {servers:[{id,name,type,version,port,memoryMb,...}]}
  remote-access.json      — удалёнка (0600): {enabled,port,generation,users:[...]}
  remote-connections.json — удалённые панели (0600): {connections:[...]}  (пароли+PEM открыто)
  remote-cert.pem/.key    — самоподписанный серт удалёнки (0600 у ключа)  ← НИКОГДА не коммитить
  tui-known-hosts.json    — запиненные отпечатки для TUI (0600)
  panel.pid               — pid демона (cli start)
servers/<id>/             — рабочий каталог сервера: server.jar, server.properties,
                            whitelist.json, ops.json, banned-players.json, plugins/mods,
                            world/, server-icon.png, panel-players.json (история игроков), logs/
runtime/                  — авто-скачанная Java (Temurin)
backups/                  — .tar.gz бэкапы
```
Импортированный «на месте» сервер живёт в `server.dir` (внешняя папка пользователя) — не в `servers/`.

## <a id="подводные-камни"></a>14. Каталог подводных камней
- HTTP-сокет слушает `0.0.0.0` — loopback-защита реализована **логикой** (`isLoopbackReq`), а не bind-адресом (ресурспак нужен по LAN).
- `sameOriginRequest` пропускает запросы без `Origin` (не-браузеры Origin не шлют) — анти-CSRF полагается на то, что браузер ВСЕГДА шлёт Origin на cross-origin fetch.
- `req.cgUser.perms` у удалённого пуст `{}` до входа в блок `/api/servers/<id>` — не-серверные эндпоинты дают удалённому `hasPerm=false` для всего (кроме status/versions/auth.me без requirePerm).
- `static.js` явно отсекает NUL-байт — иначе `fs.stat` бросает синхронно и роняет весь процесс с серверами.
- На Windows SIGTERM = жёсткий TerminateProcess — корректная остановка серверов только через `/api/quit`, не через сигнал.
- `java.exe` (JDK 21+) — лаунчер; реальная JVM — отдельный процесс, слушающий порт (метрики/лимит/kill — по нему).
- POSIX `spawn` серверов обязан `detached:true` (иначе `kill(-pid)` = ESRCH, JVM выживает). Windows — не ставить.
- UTF-8 флаги JVM и `stripAnsi` — трогать нельзя (сломается кириллица и парсинг игроков).
- `netstat` на Windows локализует «LISTENING» — детект LISTEN по адресу-джокеру внешнего конца, не по слову.
- `modal-body { white-space: pre-line }` — многострочная разметка внутри модалок получает лишние переносы, пока не сброшено `white-space:normal`.
- `mkToggle`/`mkSlider`/`enhanceSelect` обязательны — без них компонент кита не работает.
- `--accent`/`--btn-*` определены только в `.theme-*`, не в `:root` — без класса темы на корне primary/accent-компоненты сломаны.
- Версия дублируется в ~10 местах — легко забыть одно.
- `PaperMC Fill v3` — старый v2 API отключён (410); URL скачивания брать из ответа, не собирать.
- `lib/nbt.js` теряет точность long — для записи данных игрока только `lib/nbtedit.js`.
