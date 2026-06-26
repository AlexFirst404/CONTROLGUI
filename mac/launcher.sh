#!/bin/sh
# Точка входа CONTROLGUI.app: поднимает локальную панель (встроенный node) и
# открывает её в браузере (или в окне-приложении Chrome/Edge, если они есть).
# Данные (серверы/настройки) — в ~/Library/Application Support/CONTROLGUI, не в .app.
set -u

RES="$(cd "$(dirname "$0")/../Resources" && pwd)"
NODE="$RES/bin/node"
[ -x "$NODE" ] || NODE="node"
APPSRC="$RES/opt/controlgui"

export CONTROLGUI_DATA="${CONTROLGUI_DATA:-$HOME/Library/Application Support/CONTROLGUI}"
mkdir -p "$CONTROLGUI_DATA"

PORT="${CONTROLGUI_PORT:-8400}"
URL="http://127.0.0.1:$PORT"

panel_up() {
  "$NODE" -e "require('http').get('$URL/',function(r){process.exit(0)}).on('error',function(){process.exit(1)})" >/dev/null 2>&1
}
if ! panel_up; then
  ( cd "$APPSRC" && PORT="$PORT" CONTROLGUI_DATA="$CONTROLGUI_DATA" "$NODE" server.js >"$CONTROLGUI_DATA/panel.log" 2>&1 & )
  i=0
  while [ "$i" -lt 80 ]; do panel_up && break; sleep 0.25; i=$((i + 1)); done
fi

# отдельное окно-приложение, если есть Chromium-браузер; иначе — браузер по умолчанию
for B in "Google Chrome" "Chromium" "Brave Browser" "Microsoft Edge"; do
  if [ -d "/Applications/$B.app" ]; then
    open -na "$B" --args --app="$URL" --class=CONTROLGUI --window-size=1380,900
    exit 0
  fi
done
open "$URL"
