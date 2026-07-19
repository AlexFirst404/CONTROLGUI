# CONTROLGUI

**Настоящая панель управления Minecraft-серверами, которая работает на вашем компьютере.** Без облаков, без аккаунтов, без npm-зависимостей — один процесс Node.js, веб-интерфейс в стиле Minecraft и полный контроль над серверами.

[English version → README.md](README.md)

## Возможности

- **Сервер в два клика** — Vanilla, Paper, Purpur, Folia, Mohist, Forge, а также прокси Velocity / BungeeCord. Ядра качаются с официальных источников; нужная Java ставится автоматически на всех трёх ОС.
- **Живая консоль** с вводом команд и автоподсказками, поиск по логам, графики CPU / RAM / диска по каждому серверу.
- **Файловый менеджер** со встроенным редактором кода, загрузкой файлов и целых папок, распаковкой zip/jar.
- **Игроки** — кто онлайн, просмотр и правка инвентаря и статов (свой NBT-парсер), кик / бан / OP / вайтлист.
- **Моды и плагины** — встроенный каталог [Modrinth](https://modrinth.com): поиск, установка в один клик вместе с зависимостями, вкл/выкл.
- **Бэкапы** — создание, восстановление, скачивание.
- **Ресурспаки** — загрузите пак, и панель сама раздаст его игровым клиентам по локальной сети.
- **Удалённый доступ** — включите переключатель, задайте пароль, пробросьте один порт на роутере — и управляйте серверами откуда угодно по HTTPS (самоподписанный сертификат генерируется локально, на чистом JS). Никаких сторонних серверов — сервером является только ваша машина.
- **Режим без GUI / CLI** — поставьте на Linux-VPS и управляйте с другого компьютера через браузер или встроенный текстовый интерфейс (TUI).

## Установка

Скачайте инсталлятор из [Releases](https://github.com/AlexFirst404/CONTROLGUI/releases):

| Платформа | Файл | Примечание |
|---|---|---|
| Windows | `CONTROLGUI-<v>-windows-setup.exe` | Node.js встроен — ничего доустанавливать не нужно |
| Linux (Debian/Ubuntu) | `controlgui_<v>_all.deb` | Нужен системный `nodejs` (>= 18) |
| Linux (любой дистрибутив) | `CONTROLGUI-<v>-x86_64.AppImage` | Node.js встроен |
| Linux-сервер (без GUI) | `controlgui-<v>-linux.tar.gz` | `tar -xzf … && sudo controlgui/install.sh` |
| macOS (Apple Silicon) | `CONTROLGUI-<v>-macos-arm64.pkg` | Node.js встроен |

Либо из исходников (любая ОС, Node.js >= 18, ноль npm-зависимостей):

```bash
git clone https://github.com/AlexFirst404/CONTROLGUI.git
cd CONTROLGUI
node server.js          # откройте http://localhost:8400
```

## Удалённый доступ через интернет

1. В панели: **Меню → Настройки панели → Удалённый доступ** — задайте пароль; доступ включится (HTTPS-порт **8433** по умолчанию).
2. Пробросьте порт 8433 на роутере на этот компьютер.
3. Откуда угодно: `https://ваш-ip:8433` → браузер один раз предупредит о самоподписанном сертификате (это ожидаемо — сверьте SHA-256-отпечаток, показанный в панели) → введите пароль → полная панель.

Десктоп-приложения умеют подключаться напрямую: Windows — пункт трея **«Удалённая панель…»**; Linux/macOS — `controlgui connect https://ip:8433` (вернуть локальную: `controlgui connect --local`). Отпечаток сертификата запоминается при первом подключении (TOFU) и сверяется при каждом следующем.

## CLI и Linux-сервер без GUI

```bash
controlgui serve                  # панель в этом терминале
controlgui start | stop | status  # панель фоном
controlgui remote password        # задать пароль удалённого доступа
controlgui remote enable          # включить HTTPS-листенер (порт 8433)
sudo controlgui service install   # systemd-сервис с автозапуском
controlgui tui                    # текстовый интерфейс (работает и по HTTPS: controlgui tui https://ip:8433)
```

TUI показывает серверы со статусом и CPU/RAM, умеет старт/стоп/рестарт и живую консоль с вводом команд — прямо в SSH-сессии.

## Модель безопасности

- Обычный HTTP (порт 8400) отвечает **только на localhost** — из локальной сети доступна лишь раздача ресурспаков (`/rp/`).
- Удалённый доступ — отдельный HTTPS-листенер: пароль хешируется PBKDF2, сессии в HttpOnly-куках, защита от перебора (5 попыток → блок 5 минут), сертификат генерируется локально — приватный ключ не покидает вашу машину.
- Действия над самой машиной (закрыть приложение, системный выбор папки) для удалённых сессий запрещены.

## Устройство проекта

```
server.js          — входная точка (порт 8400; сменить: переменная PORT)
cli.js / tui.js    — CLI и текстовый интерфейс
lib/               — бэкенд: API, менеджер java-процессов, загрузчик, удалённый доступ
public/            — фронтенд: index.html, css/minecraft.css, js/
linux/ mac/        — сборка .deb / тарболла / AppImage / .pkg
```

## Сборка инсталляторов

- **Windows** — `dotnet publish` WPF-обёртки (WebView2) + скрипт Inno Setup.
- **Linux deb** — `node linux/build-deb.js` (сборщик .deb на чистом Node, без dpkg).
- **Linux тарболл** — `node linux/build-tarball.js`.
- **AppImage** — `linux/build-appimage.sh` (или workflow GitHub Actions).
- **macOS pkg** — `mac/build-pkg.sh` (или workflow GitHub Actions).

## Лицензия

[GPL-3.0](LICENSE) © AlexFirst

Интерфейс использует шрифты в стиле Minecraft, [Pixelarticons](https://pixelarticons.com/) (MIT), [Modrinth API](https://docs.modrinth.com/) для каталога модов, [mc-heads.net](https://mc-heads.net/) для голов игроков, текстуры предметов из [InventivetalentDev/minecraft-assets](https://github.com/InventivetalentDev/minecraft-assets) и [CodeMirror 5](https://codemirror.net/5/) (MIT) для редактора файлов.
