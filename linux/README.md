# CONTROLGUI для Linux (.deb и .AppImage)

Та же панель, что и на Windows (Node.js без зависимостей). Один пакет каждого
формата — **режим открытия выбирается при первом запуске**:

- **«Приложение»** — отдельное окно через WebKitGTK (как десктоп-обёртка на Windows);
- **«Браузер»** — открывает панель в браузере по умолчанию (Chromium в app-режиме).

Выбор спрашивается при первом старте (через `zenity`) и сохраняется. Поменять
можно в **настройках панели → «Как открывать панель»** — применится при следующем запуске.

Два формата на выбор:

- **`.deb`** — Debian/Ubuntu/Mint и совместимые (`apt`, использует системный Node.js);
- **`.AppImage`** — один файл для **любого** дистрибутива, **со встроенным Node.js** —
  ничего ставить не нужно: `chmod +x` и запуск.

## Установка .deb
```sh
sudo apt install ./controlgui_1.3.0_all.deb
```
Зависимости ставятся автоматически: **nodejs**; для режима «приложение» —
**python3-gi** + **WebKitGTK** + **zenity**; для серверов — **Java**;
**libarchive-tools** (чтение .jar), **iproute2** (порты).

## Запуск AppImage
```sh
chmod +x CONTROLGUI-1.3.0-x86_64.AppImage
./CONTROLGUI-1.3.0-x86_64.AppImage
```
Если ругается на FUSE: `--appimage-extract-and-run` (или `sudo apt install libfuse2`).
Для нативного окна нужны системные `python3-gi` + WebKitGTK (иначе откроется браузер).

## Где данные
Серверы, настройки и бэкапы — `~/.local/share/controlgui` (не в `/opt`).
Удаление пакета их не трогает. Порт — `CONTROLGUI_PORT`. Панель на `http://localhost:8400`.

## Сборка

`.deb` (любая ОС, нужен только Node.js):
```sh
node linux/build-deb.js 1.3.0
```

`.AppImage` (только Linux x86_64; node и appimagetool скачиваются сами):
```sh
sh linux/build-appimage.sh 1.3.0
```
Готовые `.AppImage` собираются в CI: вкладка **Actions → Build AppImage**.

## Что внутри
- `/opt/controlgui/` — код панели (`server.js`, `lib/`, `public/`, `controlgui-window.py`);
- `/usr/bin/controlgui` — единый лаунчер (режим приложение/браузер);
- `/usr/share/applications/controlgui.desktop` — ярлык; иконки в hicolor.

Разработчик: **AlexFirst**.
