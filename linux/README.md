# CONTROLGUI для Linux (.deb и .AppImage)

Та же панель, что и на Windows (Node.js без зависимостей). Два формата:

- **`.deb`** — для Debian/Ubuntu/Mint и совместимых (ставится через `apt`, использует системный Node.js);
- **`.AppImage`** — один файл для **любого** дистрибутива, **со встроенным Node.js** —
  ничего ставить не нужно: `chmod +x` и запуск. См. раздел [AppImage](#appimage) ниже.

## .deb — два варианта пакета

- **`controlgui`** — открывает панель в браузере (Chromium в app-режиме или браузер по умолчанию);
- **`controlgui-app`** — открывает панель **нативным окном** через WebKitGTK
  (аналог десктоп-обёртки WebView2 на Windows), без браузера. Это отдельная запись
  среди приложений. Пакет включает и `controlgui` (браузерный режим тоже доступен).

Ставится один из них (они взаимозаменяемы: `controlgui-app` заменяет `controlgui`).

## Сборка пакетов

Любая ОС, нужен только Node.js (как и сама панель):

```sh
node linux/build-deb.js                 # оба: controlgui_*.deb и controlgui-app_*.deb
node linux/build-deb.js 1.3.0 app       # только нативное приложение
node linux/build-deb.js 1.3.0 browser   # только браузерный
```

На Linux можно классически (нужен dpkg-deb): `sh linux/build-deb.sh`

## Установка

Нативное приложение (рекомендуется):
```sh
sudo apt install ./controlgui-app_1.3.0_all.deb
```
Или браузерный вариант:
```sh
sudo apt install ./controlgui_1.3.0_all.deb
```

Зависимости ставятся автоматически:
- **nodejs** (>= 16) — сама панель;
- для `controlgui-app`: **python3-gi**, **gir1.2-gtk-3.0**, **gir1.2-webkit2-4.1** (или 4.0) — нативное окно;
- **libarchive-tools** (bsdtar) — чтение метаданных .jar; на Linux обычный `tar` не умеет zip;
- **iproute2** (`ss`) — поиск процессов серверов по портам;
- **default-jre-headless** (Java) — для запуска Minecraft-серверов;
- для `controlgui` — **chromium** (окно-приложение).

## Запуск

- Меню приложений → **CONTROLGUI**.
- Или команды: `controlgui-app` (нативное окно), `controlgui` (браузер).
- Панель поднимается на `http://localhost:8400`.

## Где данные

Серверы, настройки и бэкапы — в каталоге пользователя:
`~/.local/share/controlgui` (а не в `/opt`). Удаление пакета их не трогает.
Переопределяется переменной `CONTROLGUI_DATA`, порт — `CONTROLGUI_PORT`.

## Что внутри пакета

- `/opt/controlgui/` — код панели (`server.js`, `lib/`, `public/`);
- `/usr/bin/controlgui` — лаунчер;
- `/usr/share/applications/controlgui.desktop` — ярлык;
- `/usr/share/icons/hicolor/*/apps/controlgui.png` — иконка.

## AppImage

Один исполняемый файл для всех дистрибутивов. Внутри — панель **и Node.js**, поэтому
устанавливать Node не нужно. Тоже два варианта:

- **`CONTROLGUI-<версия>-app-x86_64.AppImage`** — нативное окно (WebKitGTK), с откатом
  в браузер, если в системе нет `python3-gi`/WebKitGTK;
- **`CONTROLGUI-<версия>-browser-x86_64.AppImage`** — открывает панель в браузере.

Запуск:
```sh
chmod +x CONTROLGUI-1.3.0-app-x86_64.AppImage
./CONTROLGUI-1.3.0-app-x86_64.AppImage
```
Если ругается на FUSE: `./CONTROLGUI-...AppImage --appimage-extract-and-run`
(или `sudo apt install libfuse2`). Данные — там же, `~/.local/share/controlgui`.

Зависимости минимальны (Node встроен): для нативного окна нужны системные
`python3-gi` + WebKitGTK (иначе откроется браузер); для серверов Minecraft — Java.

### Сборка AppImage

Только на Linux x86_64 (нужны `curl`, `tar` с xz; `appimagetool` и Node качаются сами):
```sh
sh linux/build-appimage.sh all 1.3.0      # оба: app + browser
sh linux/build-appimage.sh app 1.3.0      # только нативное окно
sh linux/build-appimage.sh browser 1.3.0  # только браузерный
```

Готовые `.AppImage` собираются автоматически в CI: вкладка **Actions →
Build AppImage → Run workflow** — они соберутся на Linux-раннере и прикрепятся к релизу.
