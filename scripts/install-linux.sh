#!/usr/bin/env bash
# ============================================================
#  CONTROLGUI — установка на Ubuntu / Debian одним скриптом
#
#  Что делает:
#    1. Ставит Node.js 20, Java (21 или 17) и утилиты
#    2. Копирует панель в /opt/controlgui (или клонирует репозиторий)
#    3. Генерирует пароль и создаёт systemd-сервис (автозапуск)
#    4. Открывает порты в ufw (панель + диапазон Minecraft)
#    5. Печатает ссылку на сайт, логин и пароль
#
#  Запуск:   sudo bash install-linux.sh
#  Повторный запуск безопасен: обновляет файлы, пароль сохраняется.
# ============================================================
set -euo pipefail
trap 'printf "\033[1;31mОшибка на строке %s — установка прервана.\033[0m\n" "$LINENO"' ERR

REPO_URL="${CONTROLGUI_REPO:-https://github.com/AlexFirst404/CONTROLGUI.git}"
INSTALL_DIR="${CONTROLGUI_DIR:-/opt/controlgui}"
PANEL_PORT="${CONTROLGUI_PORT:-8400}"
MC_PORTS="25565:25600"
SERVICE_NAME="controlgui"
ENV_FILE="$INSTALL_DIR/data/panel.env"

c_green() { printf '\033[1;32m%s\033[0m\n' "$*"; }
c_red()   { printf '\033[1;31m%s\033[0m\n' "$*"; }
c_dim()   { printf '\033[2m%s\033[0m\n' "$*"; }

[ "$(id -u)" -eq 0 ] || { c_red "Запустите от root:  sudo bash $0"; exit 1; }

command -v apt-get >/dev/null 2>&1 || { c_red "Поддерживаются только Ubuntu/Debian (apt)."; exit 1; }

c_green "[1/6] Устанавливаю зависимости (curl, git, rsync)…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y -qq
apt-get install -y -qq curl ca-certificates git rsync >/dev/null

# ---------- Node.js 18+ ----------
node_ok=false
if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$major" -ge 18 ] && node_ok=true
fi
if [ "$node_ok" != true ]; then
  c_green "[2/6] Ставлю Node.js 20 (NodeSource)…"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
else
  c_green "[2/6] Node.js уже установлен: $(node -v)"
fi

# ---------- Java ----------
if command -v java >/dev/null 2>&1; then
  c_green "[3/6] Java уже установлена: $(java -version 2>&1 | head -n1)"
else
  c_green "[3/6] Ставлю Java (для современных версий Minecraft нужна 21)…"
  apt-get install -y -qq openjdk-21-jre-headless >/dev/null 2>&1 \
    || apt-get install -y -qq openjdk-17-jre-headless >/dev/null \
    || { c_red "Не удалось установить Java — поставьте вручную и перезапустите скрипт."; exit 1; }
fi

# ---------- файлы панели ----------
c_green "[4/6] Разворачиваю панель в $INSTALL_DIR…"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$INSTALL_DIR"
if [ -f "$SCRIPT_DIR/../server.js" ]; then
  # скрипт запущен из каталога репозитория — копируем локальные файлы
  # (слеш в конце источника обязателен: копируем содержимое, а не саму папку)
  rsync -a --delete \
    --exclude 'servers/' --exclude 'data/' --exclude '.git/' \
    --exclude 'desktop/' --exclude 'node_modules/' \
    "$SCRIPT_DIR/../" "$INSTALL_DIR/"
  # подчистка после старой версии скрипта, копировавшей папку внутрь папки
  for stray in "$INSTALL_DIR"/CONTROLGUI*; do
    if [ -d "$stray" ] && [ -f "$stray/server.js" ]; then rm -rf "$stray"; fi
  done
elif [ -d "$INSTALL_DIR/.git" ]; then
  git -C "$INSTALL_DIR" pull --ff-only
else
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR" || {
    c_red "Не удалось клонировать $REPO_URL (репозиторий приватный?)."
    c_red "Склонируйте репозиторий вручную и запустите: sudo bash scripts/install-linux.sh"
    exit 1
  }
fi
mkdir -p "$INSTALL_DIR/data" "$INSTALL_DIR/servers"

# внешний адрес — нужен и для panel.env (авто-привязка), и для финального вывода
IP="$(curl -fsS --max-time 5 https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')"
PUBLIC_URL="http://$IP:$PANEL_PORT"

# ---------- пароль ----------
# пароль сохраняется между запусками; читаем существующий или генерируем
if [ -f "$ENV_FILE" ] && grep -q '^CONTROLGUI_PASSWORD=' "$ENV_FILE"; then
  PASSWORD="$(grep '^CONTROLGUI_PASSWORD=' "$ENV_FILE" | head -n1 | cut -d= -f2- | tr -d '\r\n')"
  c_dim "Пароль уже задан — оставляю прежний ($ENV_FILE)."
fi
if [ -z "${PASSWORD:-}" ]; then
  # `|| true` обязателен: head обрывает пайп, tr ловит SIGPIPE (код 141),
  # и при set -o pipefail скрипт без этого молча умирает на этой строке
  PASSWORD="$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 16 || true)"
  if [ -z "$PASSWORD" ]; then PASSWORD="$(date +%s%N | sha256sum | head -c 16 || true)"; fi
fi

# ---------- авто-привязка к центральному дашборду (необязательно) ----------
# хаб должен быть доступен с этого сервера; секрет = CONTROLGUI_HUB_SECRET на хабе
HUB="${CONTROLGUI_HUB:-}"
HUB_SECRET="${CONTROLGUI_HUB_SECRET:-}"
if [ -z "$HUB" ] && [ -t 0 ]; then
  printf 'Адрес центральной админ-панели для авто-привязки (Enter — пропустить): '
  read -r HUB || HUB=""
  if [ -n "$HUB" ]; then
    printf 'Секрет привязки (CONTROLGUI_HUB_SECRET на дашборде): '
    read -r HUB_SECRET || HUB_SECRET=""
  fi
fi

# panel.env переписываем целиком (пароль сохранён выше), chmod 600
{
  echo "PORT=$PANEL_PORT"
  echo "CONTROLGUI_PASSWORD=$PASSWORD"
  echo "CONTROLGUI_PUBLIC_URL=$PUBLIC_URL"
  [ -n "$HUB" ] && echo "CONTROLGUI_HUB=$HUB"
  [ -n "$HUB_SECRET" ] && echo "CONTROLGUI_HUB_SECRET=$HUB_SECRET"
} > "$ENV_FILE"
chmod 600 "$ENV_FILE"

# ---------- systemd ----------
c_green "[5/6] Настраиваю systemd-сервис ($SERVICE_NAME)…"
NODE_BIN="$(command -v node)"
cat > "/etc/systemd/system/$SERVICE_NAME.service" <<EOF
[Unit]
Description=CONTROLGUI — панель управления Minecraft-серверами
After=network.target

[Service]
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN server.js
Restart=on-failure
RestartSec=5
# серверы Minecraft переживают мягкий рестарт панели как «осиротевшие»,
# но штатная остановка сервиса корректно гасит их через stop
KillMode=mixed
TimeoutStopSec=40

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null 2>&1
systemctl restart "$SERVICE_NAME"

# ---------- firewall ----------
c_green "[6/6] Открываю порты ($PANEL_PORT — панель, $MC_PORTS — серверы)…"
if command -v ufw >/dev/null 2>&1; then
  ufw allow "$PANEL_PORT/tcp"  >/dev/null 2>&1 || true
  ufw allow "$MC_PORTS/tcp"    >/dev/null 2>&1 || true
  c_dim "ufw: правила добавлены (если ufw выключен — они применятся при включении)."
else
  c_dim "ufw не найден — если используете другой firewall, откройте порты вручную."
fi

# ---------- готово ----------
sleep 2
STATUS="$(systemctl is-active "$SERVICE_NAME" || true)"

echo
c_green "============================================================"
c_green " CONTROLGUI установлен!  Статус сервиса: $STATUS"
c_green "============================================================"
echo
echo "  Сайт панели:   $PUBLIC_URL"
echo "  Логин:         admin (подойдёт любой)"
echo "  Пароль:        $PASSWORD"
echo
c_dim "  Пароль хранится в $ENV_FILE"
c_dim "  Логи:          journalctl -u $SERVICE_NAME -f"
c_dim "  Перезапуск:    systemctl restart $SERVICE_NAME"
c_dim "  Серверы Minecraft создавайте на сайте — файлы лягут в $INSTALL_DIR/servers"
echo
if [ -n "$HUB" ] && [ -n "$HUB_SECRET" ]; then
  c_green "  Авто-привязка: этот сервер сам зарегистрируется в дашборде $HUB"
  c_dim   "  (появится там в разделе «Удалённые панели» в течение минуты)."
else
  c_dim "  Чтобы видеть этот сервер в общей админ-панели, добавьте в разделе"
  c_dim "  «Удалённые панели» адрес  $PUBLIC_URL  и пароль выше — ИЛИ переустановите"
  c_dim "  с авто-привязкой:  sudo CONTROLGUI_HUB=http://ХАБ:8400 CONTROLGUI_HUB_SECRET=секрет bash scripts/install-linux.sh"
fi
echo
