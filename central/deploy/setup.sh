#!/bin/sh
# Установка CONTROLGUI Remote на чистый VPS (Debian/Ubuntu). Запускать от root.
#   scp -r central root@IP:/opt/controlgui-remote && ssh root@IP 'sh /opt/controlgui-remote/deploy/setup.sh'
set -eu

APP_DIR=/opt/controlgui-remote
DATA_DIR="$APP_DIR/data"
CERT_DIR="$APP_DIR/cert"
SVC_USER=cgremote

# 1. Node 20.x, если ещё нет. Скрипт nodesource качаем в файл (а не в пайп) —
#    иначе при сбое curl в POSIX sh пайп всё равно выходит 0 (нет pipefail).
if ! command -v node >/dev/null 2>&1; then
  echo ">> Ставлю Node.js 20.x"
  curl -fsSL https://deb.nodesource.com/setup_20.x -o /tmp/nodesource_setup.sh
  bash /tmp/nodesource_setup.sh
  apt-get install -y nodejs
  rm -f /tmp/nodesource_setup.sh
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
echo ">> Node: $(node -v)"
if [ "$NODE_MAJOR" -lt 18 ]; then echo "!! Нужен Node >= 18 (стоит $NODE_MAJOR)"; exit 1; fi

# 2. Выделенный непривилегированный пользователь сервиса
if ! id "$SVC_USER" >/dev/null 2>&1; then
  echo ">> Создаю системного пользователя $SVC_USER"
  useradd --system --no-create-home --shell /usr/sbin/nologin "$SVC_USER"
fi

# 3. Самоподписанный сертификат на IP (3650 дней). НЕ регенерируем, если уже есть
#    (иначе сломается пиннинг серта в уже выпущенных панелях).
mkdir -p "$CERT_DIR"
if [ ! -f "$CERT_DIR/cert.pem" ]; then
  IP="$(curl -s --max-time 5 ifconfig.me || true)"; [ -n "$IP" ] || IP=89.125.169.61
  echo ">> Генерирую серт для IP=$IP"
  openssl req -x509 -newkey rsa:2048 -keyout "$CERT_DIR/key.pem" -out "$CERT_DIR/cert.pem" \
    -days 3650 -nodes -subj "/CN=$IP" -addext "subjectAltName=IP:$IP"
fi
chmod 600 "$CERT_DIR/key.pem" 2>/dev/null || true

# 4. Права: код читаем сервису, секреты/данные — только ему
mkdir -p "$DATA_DIR"
chown -R "$SVC_USER":"$SVC_USER" "$APP_DIR"
chmod 700 "$DATA_DIR" "$CERT_DIR" 2>/dev/null || true
chmod 600 "$DATA_DIR"/*.json "$DATA_DIR"/ADMIN-CREDENTIALS.txt 2>/dev/null || true

# 5. systemd-сервис: непривилегированный юзер + CAP_NET_BIND_SERVICE для :443 + песочница
cat >/etc/systemd/system/controlgui-remote.service <<EOF
[Unit]
Description=CONTROLGUI Remote (control plane)
After=network.target

[Service]
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/node $APP_DIR/server.js
Environment=PORT=443
Environment=CGR_DATA=$DATA_DIR
User=$SVC_USER
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=$DATA_DIR
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

# 6. firewall. ВНИМАНИЕ: не включаем ufw сами (default-deny без allow SSH = локаут).
#    Добавляем правила; если ufw уже активен — они применятся, иначе настройте
#    firewall хостинга/облака вручную (открыть 80 и 443).
if command -v ufw >/dev/null 2>&1; then
  ufw allow OpenSSH >/dev/null 2>&1 || ufw allow 22/tcp >/dev/null 2>&1 || true
  ufw allow 80/tcp  >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
  if ufw status 2>/dev/null | grep -q "Status: active"; then
    echo ">> ufw активен — правила 22/80/443 добавлены."
  else
    echo ">> ufw НЕ активен: правила записаны, но не применяются. Включите вручную:"
    echo "     ufw allow OpenSSH && ufw allow 80,443/tcp && ufw enable"
    echo "   ЛИБО откройте 80/443 в firewall вашего хостинга."
  fi
fi

systemctl daemon-reload
systemctl enable controlgui-remote >/dev/null 2>&1 || true
systemctl restart controlgui-remote
sleep 2
systemctl --no-pager status controlgui-remote | head -12 || true
echo
echo ">> Готово. Логи:   journalctl -u controlgui-remote -f"
echo ">> Пароль админа:  cat $DATA_DIR/ADMIN-CREDENTIALS.txt"
echo ">> Бэкап данных:   cp $DATA_DIR/*.json <куда-то off-box> (атомарная запись -> копия всегда целая)"
