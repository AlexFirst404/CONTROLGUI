#!/usr/bin/env bash
# Установка CONTROLGUI Remote на чистый VPS (Debian/Ubuntu). Запускать от root.
#   scp -r central root@IP:/opt/controlgui-remote && ssh root@IP 'bash /opt/controlgui-remote/deploy/setup.sh'
set -euo pipefail

APP_DIR=/opt/controlgui-remote
DATA_DIR="$APP_DIR/data"
CERT_DIR="$APP_DIR/cert"

# 1. Node LTS, если ещё нет
if ! command -v node >/dev/null 2>&1; then
  echo ">> Ставлю Node.js 20.x"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
echo ">> Node: $(node -v)"

# 2. Самоподписанный сертификат на IP (3650 дней)
mkdir -p "$CERT_DIR"
if [ ! -f "$CERT_DIR/cert.pem" ]; then
  IP="$(curl -s --max-time 5 ifconfig.me || true)"; [ -n "$IP" ] || IP=89.125.169.61
  echo ">> Генерирую серт для IP=$IP"
  openssl req -x509 -newkey rsa:2048 -keyout "$CERT_DIR/key.pem" -out "$CERT_DIR/cert.pem" \
    -days 3650 -nodes -subj "/CN=$IP" -addext "subjectAltName=IP:$IP"
  chmod 600 "$CERT_DIR/key.pem"
fi

# 3. systemd-сервис (порт 443, автоперезапуск)
cat >/etc/systemd/system/controlgui-remote.service <<EOF
[Unit]
Description=CONTROLGUI Remote (control plane)
After=network.target

[Service]
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/node $APP_DIR/server.js
Environment=PORT=443
Environment=CGR_DATA=$DATA_DIR
Restart=always
RestartSec=3
User=root

[Install]
WantedBy=multi-user.target
EOF

# 4. firewall (если ufw активен)
if command -v ufw >/dev/null 2>&1; then ufw allow 80/tcp || true; ufw allow 443/tcp || true; fi

systemctl daemon-reload
systemctl enable controlgui-remote >/dev/null 2>&1 || true
systemctl restart controlgui-remote
sleep 2
systemctl --no-pager status controlgui-remote | head -12 || true
echo
echo ">> Готово. Логи:   journalctl -u controlgui-remote -f"
echo ">> Пароль админа:  cat $DATA_DIR/ADMIN-CREDENTIALS.txt"
