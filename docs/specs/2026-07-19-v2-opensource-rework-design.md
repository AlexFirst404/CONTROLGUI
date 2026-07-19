# CONTROLGUI v2.0.0 — опенсорс-реворк (дизайн)

Дата: 2026-07-19. Утверждён пользователем (лицензия GPL-3.0).

## Цель

Полностью убрать центральный сервер, аккаунты и Discord; проект становится опенсорсом.
Вместо центра — прямой удалённый доступ через проброшенный порт роутера. Добавить
CLI-режим для Linux-серверов и TUI. Одинаковое качество на Windows/Linux/macOS.

## Решения (из диалога с пользователем)

- Защита удалённого доступа: единый пароль панели; localhost — без пароля.
- Протокол: HTTPS с самоподписанным сертом (генерация чисто на JS, без openssl).
- CurseForge: удалить полностью (остаётся Modrinth). Вшитый ключ уходит из кода.
- CLI: демон + веб с другого ПК, «Подключиться к удалённой панели» в десктоп-приложениях, базовый TUI.
- TUI: список серверов + статус + CPU/RAM, старт/стоп/рестарт, живая консоль с вводом.
- Публикация: коммит в текущий приватный репо, публикует пользователь сам.
- Старый VPS-центр: стереть насовсем.
- README: EN (README.md) + RU (README.ru.md). Лицензия GPL-3.0.

## Архитектура

### Удаляется
- `central/` целиком (88 файлов), `site/`, `lib/centralclient.js`, `lib/remote.js`,
  `lib/central-cert.pem`, `lib/curseforge.js`, `test_deflate.dat*`,
  устаревшие спеки центра в `docs/superpowers/specs/` (4 шт.).
- Из `server.js`: handleCentralRoutes, internalUserFor, cc.proxy, /api/central*,
  remote.initAll, /api/openurl (использовался только удалённым модовым режимом).
- Из `lib/api.js`: isRemoteReq/redactView/remoteWriteBlocked/normalizeSeg/requireAllPerm,
  remoteServerView, autoEnableRemote, route action==='remote', слияние listRemote,
  provider-ветки CurseForge (~30 точек).
- Из UI: аккаунт-гейт, профиль/Discord, экран «Подключить удалённый сервер»,
  карточка «Удалённое управление», селекты «Источник» в маркетплейсе,
  методы central*/remote*/provider в public/js/api.js.

### Новый удалённый доступ (lib/remoteaccess.js + lib/selfsigned.js)
- HTTP-листенер: как раньше — 0.0.0.0:8400, loopback-гейт, `/rp/` публичен (клиенты MC).
- Второй HTTPS-листенер (порт по умолчанию 8433): включается из настроек UI или CLI.
  Общий request-хендлер; ветвление по `req.socket.encrypted`.
- Самоподписанный серт: чистый JS (ASN.1/DER + crypto), RSA-2048/SHA-256, SAN по IP,
  срок 10 лет; генерируется при первом включении, хранится в `data/remote/`.
- Пароль: pbkdf2 (120k, sha256), хранится в `data/remote/access.json`.
  Вход — страница пароля (переработанный login.html), cookie-сессии (7 дней),
  анти-брутфорс 5 попыток → блок 5 минут по адресу СОКЕТА (не XFF).
- Локальные-only операции (quit, pick-folder) остаются loopback-only.
- Панель следит за конфигом удалёнки (правки из CLI подхватываются без рестарта).

### CLI (`cli.js`, точка входа /usr/bin/controlgui)
- `controlgui` — GUI-запуск (как раньше), `serve` — форграунд, `start|stop|status` — фон,
  `remote enable|disable|password|port|show` — управление удалёнкой,
  `service install` — systemd-юнит, `tui [url]`, `connect <url>` — клиент-режим GUI.
- Работает на headless Linux без GUI-зависимостей. Тарболл для не-Debian.

### TUI (`tui.js`)
- Чистый Node + ANSI. Экран списка (статус/CPU/RAM/игроки), экран консоли (SSE + ввод).
- Подключение локально (http) или удалённо (https + пароль + TOFU-пин отпечатка серта).

### Клиент-режим обёрток
- Windows (WPF): диалог «Подключиться к удалённой панели», ServerCertificateErrorDetected
  + TOFU-подтверждение отпечатка, вайтлист навигации, в клиент-режиме не глушить node.
- Linux: `controlgui connect <url>` / `--local`; WebKitGTK — точечный allow по отпечатку.
- macOS: файл remote-url в Application Support, challenge-handler в Swift, isLocal() расширить.

### Опенсорс
- README.md (EN) + README.ru.md, LICENSE GPL-3.0, версия 2.0.0 всюду,
  «О панели» → ссылка на GitHub-репо. Коммит в приватный репо; публикация — за пользователем.
- VPS-центр стирается (сервис, каталог, пользователь cgremote).

## Верификация
- Панель локально: список/создание/старт/консоль работают без ссылок на центр (grep чист).
- Удалёнка: с другого интерфейса https://IP:8433 → вход по паролю → полная панель;
  неверный пароль ×5 → блок; /rp/ качается по http из LAN; quit/pick-folder извне — 403.
- CLI на Linux (VPS): установка, serve/start/status, remote enable, вход с Windows-браузера.
- TUI: локально и удалённо, консоль живая, ввод работает.
- Сборки: setup.exe, deb, AppImage, pkg — v2.0.0; adversarial-ревью перед релизом.
