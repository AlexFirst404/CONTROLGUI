#!/usr/bin/env bash
# CONTROLGUI — установщик для Linux-сервера без графики.
# Использование:  git clone https://github.com/AlexFirst404/CONTROLGUI.git
#                 cd CONTROLGUI && ./install.sh
# Скрипт: ставит Node.js (если нет), заводит команду `controlgui`, по желанию
# добавляет панель в автозапуск (systemd) и запускает мастер удалённого доступа.
# Зависимостей у панели нет — только Node.js (>= 18) в рантайме.
set -u

# ------------------------------------------------------------------ оформление
if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RST=$'\033[0m'
  G=$'\033[38;5;40m'; G2=$'\033[38;5;114m'; YEL=$'\033[38;5;220m'; RED=$'\033[38;5;203m'; CY=$'\033[38;5;80m'
else
  BOLD=''; DIM=''; RST=''; G=''; G2=''; YEL=''; RED=''; CY=''
fi

banner() {
  printf '\n%s%s' "$BOLD" "$G"
  cat <<'ART'
  ____ ___  _   _ _____ ____   ___  _     ____ _   _ ___
 / ___/ _ \| \ | |_   _|  _ \ / _ \| |   / ___| | | |_ _|
| |  | | | |  \| | | | | |_) | | | | |   | |  _| | | || |
| |__| |_| | |\  | | | |  _ <| |_| | |___| |_| | |_| || |
 \____\___/|_| \_| |_| |_| \_\\___/|_____|\____|\___/|___|
ART
  printf '%s' "$RST"
  printf '%s     Установщик для Linux-сервера без графики · headless setup%s\n\n' "$G2" "$RST"
}

say()  { printf '%s\n' "$*"; }
ok()   { printf '  %s✓%s %s\n' "$G"   "$RST" "$*"; }
warn() { printf '  %s!%s %s\n' "$YEL" "$RST" "$*"; }
err()  { printf '  %s✗%s %s\n' "$RED" "$RST" "$*" >&2; }
step() { printf '\n%s==>%s %s%s%s\n' "$CY" "$RST" "$BOLD" "$*" "$RST"; }
have() { command -v "$1" >/dev/null 2>&1; }

# ------------------------------------------------------------------ ввод
# Спрашиваем через /dev/tty — тогда вопросы работают и при запуске вида
# `curl … | bash`, где stdin занят самим скриптом. Проверяем терминал реальным
# открытием: файл /dev/tty может существовать, но не открываться (нет управляющего
# терминала) — тогда молча читали бы пустые ответы и брали значения по умолчанию.
if { : < /dev/tty; } 2>/dev/null; then _TTY_OK=1; else _TTY_OK=0; fi
ask() { # ask "приглашение" "по-умолчанию" -> печатает ОТВЕТ в stdout
  local p="$1" d="${2:-}" a=''
  # Приглашение печатаем в /dev/tty или в stderr — но НИКОГДА в stdout: вывод
  # функции забирается через $( ), и приглашение приклеилось бы к ответу
  # (тогда «д» превращалось бы в «Вопрос [д/Н] д» и не совпадало ни с чем).
  if [ "$_TTY_OK" = 1 ]; then
    printf '%s' "$p" > /dev/tty
    IFS= read -r a < /dev/tty || a=''
  else
    printf '%s' "$p" >&2
    IFS= read -r a || a=''
  fi
  printf '%s' "${a:-$d}"
}
askyn() { # askyn "вопрос" y|n(по умолчанию) -> код 0, если «да»
  local p="$1" def="${2:-n}" hint a
  if [ "$def" = y ]; then hint=' [Д/н] '; else hint=' [д/Н] '; fi
  a="$(ask "$p$hint" '')"
  [ -z "$a" ] && a="$def"
  # Регистр приводим перечислением: `tr '[:upper:]' '[:lower:]'` в локали C НЕ
  # трогает кириллицу, и ответ «Да» молча читался бы как «нет».
  case "$a" in
    y|Y|yes|YES|Yes|д|Д|да|ДА|Да|дА) return 0 ;;
    *) return 1 ;;
  esac
}

# ------------------------------------------------------------------ окружение
CUR_UID="$(id -u)"
if [ "$CUR_UID" -eq 0 ]; then TARGET_USER="${SUDO_USER:-root}"; else TARGET_USER="$(id -un)"; fi
PORT="${PORT:-8400}"
REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_BIN=""
SERVICE_ON=0
export DEBIAN_FRONTEND=noninteractive

run_root() { if [ "$CUR_UID" -eq 0 ]; then "$@"; else sudo "$@"; fi; }

# root-команда как выполнялась бы для systemd (нужны root + SUDO_USER для User=)
node_root_service() { run_root env PORT="$PORT" CONTROLGUI_DATA="$REPO_DIR" "$NODE_BIN" "$REPO_DIR/cli.js" service install; }

# Перед systemd ждём освобождения порта. PID-файл не используем: PID мог быть
# переиспользован, а на Windows-подобных окружениях kill по нему особенно опасен.
panel_port_busy() {
  env PORT="$PORT" "$NODE_BIN" -e 'const net=require("net"),p=Number(process.env.PORT);let d=false;const end=c=>{if(d)return;d=true;try{s.destroy()}catch(e){}process.exit(c)};const s=net.connect({host:"127.0.0.1",port:p},()=>end(0));s.on("error",()=>end(1));s.setTimeout(800,()=>end(0));' >/dev/null 2>&1
}
wait_panel_down() {
  local i=0
  while panel_port_busy; do
    i=$((i + 1))
    [ "$i" -ge 30 ] && return 1
    sleep 1
  done
  return 0
}

# Данные (data/, servers/) живут РЯДОМ с кодом (DATA_ROOT = каталог репозитория).
# Любой запуск cli.js от root создаёт эти каталоги от root — и панель, работающая
# под обычным пользователем, потом не может туда писать (сервис и мастер удалёнки
# падают с EACCES). Поэтому: создаём каталоги заранее от нужного пользователя и
# чиним владельца после каждой root-операции. chown зовём через run_root — он нужен
# и когда сам скрипт запущен БЕЗ sudo (root-действия делались через sudo точечно).
ensure_data_dirs() {
  local d
  for d in "$REPO_DIR/data" "$REPO_DIR/servers"; do
    [ -d "$d" ] && continue
    if [ "$CUR_UID" -eq 0 ] && [ "$TARGET_USER" != "root" ]; then
      run_root install -d -o "$TARGET_USER" -g "$TARGET_USER" "$d" 2>/dev/null || mkdir -p "$d" 2>/dev/null || true
    else
      mkdir -p "$d" 2>/dev/null || true
    fi
  done
}
ensure_data_owner() {
  [ "$TARGET_USER" = "root" ] && return 0
  local d
  for d in "$REPO_DIR/data" "$REPO_DIR/servers"; do
    if [ -e "$d" ]; then run_root chown -R "$TARGET_USER" "$d" >/dev/null 2>&1 || true; fi
  done
  return 0
}

# node от имени будущего владельца данных (чтобы файлы data/ принадлежали ему)
node_as_user() {
  if [ "$CUR_UID" -eq 0 ] && [ "$TARGET_USER" != "root" ]; then
    sudo -u "$TARGET_USER" -H env PORT="$PORT" "$NODE_BIN" "$REPO_DIR/cli.js" "$@"
  else
    env PORT="$PORT" "$NODE_BIN" "$REPO_DIR/cli.js" "$@"
  fi
}

# ------------------------------------------------------------------ Node.js
resolve_node() {
  if have node; then NODE_BIN="$(command -v node)"
  elif [ -n "${NVM_DIR:-}" ] && [ -s "${NVM_DIR:-}/nvm.sh" ]; then
    # shellcheck disable=SC1090
    . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true
    have node && NODE_BIN="$(command -v node)"
  fi
  [ -n "$NODE_BIN" ] || return 1
  local v maj; v="$("$NODE_BIN" -v 2>/dev/null | sed 's/^v//')"; maj="${v%%.*}"
  [ -n "$maj" ] && [ "$maj" -ge 18 ] 2>/dev/null
}

detect_pm() {
  local pm
  for pm in apt-get dnf yum pacman zypper apk; do have "$pm" && { printf '%s' "$pm"; return; }; done
  printf ''
}

# Официальный сборный tarball в /usr/local — годится, когда есть root: Node виден
# всем пользователям (в отличие от nvm в /root/.nvm с правами 0700, куда сервис под
# обычным пользователем не достучится: ExecStart упал бы с 203/EXEC).
install_node_tarball() {
  local ver="v22.14.0" arch tgz url tmp
  case "$(uname -m)" in
    x86_64|amd64) arch=linux-x64 ;;
    aarch64|arm64) arch=linux-arm64 ;;
    armv7l) arch=linux-armv7l ;;
    *) warn "Неизвестная архитектура $(uname -m) — официальный tarball не подойдёт."; return 1 ;;
  esac
  tgz="node-$ver-$arch.tar.xz"
  url="https://nodejs.org/dist/$ver/$tgz"
  tmp="$(mktemp -d)" || return 1
  step "Скачиваю официальный Node.js $ver ($arch) в /usr/local"
  if   have curl; then curl -fsSL "$url" -o "$tmp/$tgz" || { rm -rf "$tmp"; return 1; }
  elif have wget; then wget -qO "$tmp/$tgz" "$url" || { rm -rf "$tmp"; return 1; }
  else rm -rf "$tmp"; return 1; fi
  have tar || { rm -rf "$tmp"; return 1; }
  run_root tar -xJf "$tmp/$tgz" -C /usr/local --strip-components=1 \
    --exclude=CHANGELOG.md --exclude=LICENSE --exclude=README.md || { rm -rf "$tmp"; return 1; }
  rm -rf "$tmp"
  have node
}

# Без root ставить в систему некуда — тогда nvm в домашний каталог пользователя.
install_node_nvm() {
  step "Ставлю Node.js через nvm (в $HOME/.nvm, без root)"
  export NVM_DIR="$HOME/.nvm"
  if   have curl; then curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  elif have wget; then wget -qO- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  else err "Нужен curl или wget, чтобы скачать Node.js."; return 1; fi
  # shellcheck disable=SC1090
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  nvm install 22 && nvm use 22
}

install_node() {
  local pm; pm="$(detect_pm)"
  step "Устанавливаю Node.js 22 LTS (менеджер пакетов: ${pm:-нет})"
  # NodeSource-скрипт читает stdin, поэтому 'curl … | sudo bash -' не даст sudo
  # спросить пароль. Прогреваем sudo заранее (run_root true) — тогда пароль
  # спрашивается на нормальном терминале, а не «в пайп».
  [ "$CUR_UID" -ne 0 ] && have sudo && sudo -v 2>/dev/null || true
  case "$pm" in
    apt-get)
      run_root apt-get update -y || true
      run_root apt-get install -y ca-certificates curl gnupg xz-utils || true
      if have curl; then
        curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/cg-nodesource.sh 2>/dev/null &&
          run_root bash /tmp/cg-nodesource.sh && run_root apt-get install -y nodejs
        rm -f /tmp/cg-nodesource.sh
      fi
      resolve_node || run_root apt-get install -y nodejs npm || true
      ;;
    dnf|yum)
      if have curl; then
        curl -fsSL https://rpm.nodesource.com/setup_22.x -o /tmp/cg-nodesource.sh 2>/dev/null &&
          run_root bash /tmp/cg-nodesource.sh || true
        rm -f /tmp/cg-nodesource.sh
      fi
      run_root "$pm" install -y nodejs || true
      ;;
    # ВАЖНО: без -y. `pacman -Sy pkg` — это частичное обновление, официально
    # неподдерживаемое в Arch и ломающее систему. Ставим из текущей базы.
    pacman) run_root pacman -S --needed --noconfirm nodejs npm || true ;;
    zypper) run_root zypper --non-interactive install nodejs22 || run_root zypper --non-interactive install nodejs || true ;;
    apk)    run_root apk add --no-cache nodejs npm || true ;;
    *)      : ;;
  esac
  resolve_node && return 0
  # Пакетная установка не дала подходящую версию. С root — официальный tarball в
  # /usr/local (доступен всем), без root — nvm в домашний каталог.
  warn "Пакетный менеджер не дал Node.js >= 18 — ставлю официальную сборку."
  if [ "$CUR_UID" -eq 0 ] || have sudo; then
    install_node_tarball && resolve_node && return 0
  fi
  install_node_nvm || true
}

# Node должен быть доступен ИМЕННО тому пользователю, под которым поедет сервис.
# Классическая ловушка: node из nvm лежит в /root/.nvm (режим 0700) — команда
# controlgui и systemd-юнит (ExecStart=<этот node>) молча ломаются с Permission
# denied / 203-EXEC. Если путь недоступен — ставим общесистемную сборку.
verify_node_access() {
  [ "$TARGET_USER" = "root" ] && return 0
  [ "$CUR_UID" -eq 0 ] || return 0
  case "$NODE_BIN" in /root/*) : ;; *) sudo -u "$TARGET_USER" test -x "$NODE_BIN" 2>/dev/null && return 0 ;; esac
  warn "Node по пути $NODE_BIN недоступен пользователю $TARGET_USER — ставлю общесистемную сборку."
  install_node_tarball && resolve_node && return 0
  err "Node.js доступен только root. Поставьте его системно (apt/dnf install nodejs) и повторите."
  return 1
}

# ------------------------------------------------------------------ команда controlgui
install_launcher() {
  step "Устанавливаю команду controlgui"
  local content bindir
  content="#!/usr/bin/env bash
exec \"$NODE_BIN\" \"$REPO_DIR/cli.js\" \"\$@\"
"
  if [ "$CUR_UID" -eq 0 ] || have sudo; then
    bindir=/usr/local/bin
    if printf '%s' "$content" | run_root tee "$bindir/controlgui" >/dev/null && run_root chmod +x "$bindir/controlgui"; then
      ok "Команда доступна: ${BOLD}controlgui${RST}  ($bindir/controlgui)"
    else
      warn "Не удалось записать $bindir/controlgui — пропускаю (можно звать: node $REPO_DIR/cli.js)."
    fi
  else
    bindir="$HOME/.local/bin"; mkdir -p "$bindir"
    printf '%s' "$content" > "$bindir/controlgui" && chmod +x "$bindir/controlgui"
    ok "Команда: $bindir/controlgui"
    case ":$PATH:" in *":$bindir:"*) : ;; *) warn "Добавьте в PATH:  export PATH=\"$bindir:\$PATH\"" ;; esac
  fi
}

# ------------------------------------------------------------------ поехали
banner
say "Панель Minecraft-серверов. Управление через браузер (localhost) или удалённо по HTTPS."
say "${DIM}Каталог: $REPO_DIR · пользователь: $TARGET_USER · порт: $PORT${RST}"

case "$(uname -s)" in Linux) : ;; *) warn "Скрипт рассчитан на Linux — на других ОС может не сработать." ;; esac
[ -f "$REPO_DIR/server.js" ] || { err "Рядом с install.sh нет server.js. Запустите скрипт из папки клонированного репозитория CONTROLGUI."; exit 1; }
if [ "$CUR_UID" -ne 0 ] && ! have sudo; then
  warn "Вы не root и нет sudo: Node/сервис установить не смогу — будет только запуск от вашего пользователя."
fi

# 1) Node.js
step "Проверяю Node.js"
if resolve_node; then
  ok "Node.js $("$NODE_BIN" -v) — подходит"
else
  if have node; then warn "Node.js $(node -v 2>/dev/null) устарел (нужен >= 18) — обновлю."; fi
  install_node
  resolve_node || { err "Не удалось установить Node.js >= 18. Поставьте вручную (https://nodejs.org) и запустите ./install.sh снова."; exit 1; }
  ok "Node.js $("$NODE_BIN" -v) готов"
fi
verify_node_access || exit 1

# Сервис поедет под TARGET_USER — он должен видеть сам каталог с кодом. Классика:
# `sudo ./install.sh` из клона в /root (режим 0700) — юнит ставится «успешно», а
# стартовать не может. Лучше предупредить сразу, чем ловить рестарт-цикл.
if [ "$CUR_UID" -eq 0 ] && [ "$TARGET_USER" != "root" ]; then
  if ! sudo -u "$TARGET_USER" test -r "$REPO_DIR/server.js" 2>/dev/null; then
    warn "Каталог $REPO_DIR недоступен пользователю $TARGET_USER — сервис под ним не запустится."
    warn "Перенесите репозиторий в домашний каталог пользователя (например ~/CONTROLGUI) и повторите."
  fi
fi

# 2) каталоги данных — создаём ДО любых действий от root, иначе их создаст root
# и панель под обычным пользователем не сможет туда писать
ensure_data_dirs

# 3) команда controlgui
install_launcher

# 4) автозапуск (systemd)
step "Автозапуск"
if have systemctl; then
  if askyn "Добавить CONTROLGUI в автозапуск (systemd) и запустить сейчас?" y; then
    # панель, поднятая ранее фоном, заняла бы порт — сервис ушёл бы в рестарт-цикл
    node_as_user stop >/dev/null 2>&1 || true
    if ! wait_panel_down; then
      warn "Порт $PORT не освободился за 30 секунд — сервис не запущен рядом с прежней панелью. Остановите процесс вручную и повторите установку."
    elif node_root_service; then
      SERVICE_ON=1
      ensure_data_owner
      ok "Сервис ${BOLD}controlgui${RST} включён — стартует при загрузке. Логи: journalctl -u controlgui -f"
    else
      ensure_data_owner   # root мог успеть создать каталоги до падения
      warn "Не удалось установить сервис (нужен root). Позже: sudo controlgui service install"
    fi
  else
    say "  Пропущено. Включить позже: ${BOLD}sudo controlgui service install${RST}"
  fi
else
  warn "systemd (systemctl) не найден — автозапуск недоступен на этой системе."
fi

# 5) удалённый доступ (мастер в терминале)
step "Удалённый доступ (HTTPS)"
if askyn "Настроить удалённый доступ с других устройств сейчас?" n; then
  node_as_user remote setup || warn "Мастер удалённого доступа завершился с ошибкой."
else
  say "  Пропущено. Настроить в любой момент: ${BOLD}controlgui remote setup${RST}"
fi

# 6) если сервиса нет — предложить запустить панель фоном
if [ "$SERVICE_ON" != 1 ]; then
  step "Запуск панели"
  if askyn "Запустить панель сейчас (фоном)?" y; then
    node_as_user start || warn "Не удалось запустить панель — смотрите вывод выше."
  else
    say "  Запустить позже: ${BOLD}controlgui start${RST}"
  fi
fi

# 7) итог
step "Готово"
say "  Локально:   ${BOLD}http://localhost:$PORT${RST}  (браузер на самом сервере или через SSH-туннель)"
say ""
say "  Полезные команды:"
say "    controlgui status           состояние панели и удалённого доступа"
say "    controlgui remote setup     мастер удалённого доступа (создать пользователя, включить HTTPS)"
say "    controlgui start | stop     запустить / остановить панель фоном"
say "    controlgui tui              текстовый интерфейс прямо в терминале"
if [ "$SERVICE_ON" = 1 ]; then
  say ""
  say "  Обновление:  ${BOLD}git pull && sudo systemctl restart controlgui${RST}"
else
  say ""
  say "  Обновление:  ${BOLD}git pull && controlgui stop && controlgui start${RST}"
fi
say ""
