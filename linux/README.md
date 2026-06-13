# CONTROLGUI для Linux (.deb)

Та же панель, что и на Windows (Node.js без зависимостей), упакованная в `.deb`.
Два варианта пакета:

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
