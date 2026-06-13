# CONTROLGUI для Linux (.deb)

Та же панель, что и на Windows (Node.js без зависимостей), упакованная в `.deb`.
WPF-обёртки на Linux нет — вместо неё панель открывается **отдельным окном-приложением**
через Chromium в app-режиме (или в браузере по умолчанию).

## Сборка пакета

Любой ОС, нужен только Node.js (как и сама панель):

```sh
node linux/build-deb.js            # -> linux/controlgui_1.3.0_all.deb
node linux/build-deb.js 1.3.1      # своя версия
```

На Linux можно классически (нужен dpkg-deb):

```sh
sh linux/build-deb.sh
```

## Установка

```sh
sudo apt install ./controlgui_1.3.0_all.deb
```

Зависимости ставятся автоматически:
- **nodejs** (>= 16) — сама панель;
- **libarchive-tools** (bsdtar) — чтение метаданных .jar (версия ядра, конфиги
  плагинов/модов); на Linux обычный `tar` не умеет zip;
- **iproute2** (`ss`) — поиск процессов серверов по портам;
- **default-jre-headless** (Java) — для запуска Minecraft-серверов;
- **chromium** (рекомендуется) — окно-приложение.

## Запуск

- Меню приложений → **CONTROLGUI**, или команда `controlgui`.
- Панель поднимается на `http://localhost:8400` и открывается окном.

## Где данные

Серверы, настройки и бэкапы — в каталоге пользователя:
`~/.local/share/controlgui` (а не в `/opt`). Удаление пакета их не трогает.
Переопределяется переменной `CONTROLGUI_DATA`, порт — `CONTROLGUI_PORT`.

## Что внутри пакета

- `/opt/controlgui/` — код панели (`server.js`, `lib/`, `public/`);
- `/usr/bin/controlgui` — лаунчер;
- `/usr/share/applications/controlgui.desktop` — ярлык;
- `/usr/share/icons/hicolor/*/apps/controlgui.png` — иконка.
