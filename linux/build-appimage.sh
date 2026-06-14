#!/bin/sh
# Сборка AppImage CONTROLGUI (запускать на Linux x86_64).
# Использование: sh linux/build-appimage.sh <browser|app|all> [версия]
# Нужны: curl, tar (с поддержкой xz). appimagetool и node скачиваются сами.
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
WHICH="${1:-all}"
VERSION="${2:-1.3.0}"
ARCH="x86_64"
NODE_VER="v20.18.1"
CACHE="$HERE/.appimage-cache"
mkdir -p "$CACHE"

# --- общие инструменты: node для Linux и appimagetool (кэшируются) ---
NODE_TARBALL="$CACHE/node-$NODE_VER-linux-x64.tar.xz"
NODE_DIR="$CACHE/node-$NODE_VER-linux-x64"
if [ ! -x "$NODE_DIR/bin/node" ]; then
  echo "Скачиваю Node $NODE_VER (linux-x64)…"
  curl -fsSL "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-linux-x64.tar.xz" -o "$NODE_TARBALL"
  tar -xJf "$NODE_TARBALL" -C "$CACHE"
fi

TOOL="$CACHE/appimagetool-$ARCH.AppImage"
if [ ! -x "$TOOL" ]; then
  echo "Скачиваю appimagetool…"
  curl -fsSL "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-$ARCH.AppImage" -o "$TOOL"
  chmod +x "$TOOL"
fi
# в CI обычно нет FUSE — запускаем appimagetool через распаковку
export APPIMAGE_EXTRACT_AND_RUN=1

build_flavor() {
  flavor="$1"
  echo "=== Сборка AppImage: $flavor ==="
  APPDIR="$HERE/AppDir-$flavor"
  rm -rf "$APPDIR"
  mkdir -p "$APPDIR/usr/bin" "$APPDIR/opt/controlgui" \
           "$APPDIR/usr/share/icons/hicolor/256x256/apps" \
           "$APPDIR/usr/share/applications"

  # панель (как в .deb): server.js + lib + public
  cp "$ROOT/server.js" "$APPDIR/opt/controlgui/"
  cp -r "$ROOT/lib" "$ROOT/public" "$APPDIR/opt/controlgui/"
  cp "$HERE/appimage/controlgui-window.py" "$APPDIR/opt/controlgui/"

  # встроенный node — AppImage не требует установленного Node.js
  cp "$NODE_DIR/bin/node" "$APPDIR/usr/bin/node"
  chmod 0755 "$APPDIR/usr/bin/node"

  # точка входа + маркер flavor
  cp "$HERE/appimage/AppRun" "$APPDIR/AppRun"
  chmod 0755 "$APPDIR/AppRun"
  printf '%s' "$flavor" > "$APPDIR/flavor"

  # иконка (в корне для thumbnailer + в hicolor)
  cp "$ROOT/public/assets/controlgui.png" "$APPDIR/controlgui.png"
  cp "$ROOT/public/assets/controlgui.png" "$APPDIR/usr/share/icons/hicolor/256x256/apps/controlgui.png"

  # .desktop
  name="CONTROLGUI"
  [ "$flavor" = "app" ] && comment="Панель Minecraft-серверов (нативное окно)" \
                        || comment="Панель Minecraft-серверов (в браузере)"
  cat > "$APPDIR/controlgui.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=$name
Comment=$comment
Exec=AppRun
Icon=controlgui
Categories=Game;Utility;
Terminal=false
StartupWMClass=CONTROLGUI
EOF
  cp "$APPDIR/controlgui.desktop" "$APPDIR/usr/share/applications/controlgui.desktop"

  OUT="$HERE/CONTROLGUI-${VERSION}-${flavor}-${ARCH}.AppImage"
  rm -f "$OUT"
  ARCH="$ARCH" "$TOOL" --no-appstream "$APPDIR" "$OUT"
  rm -rf "$APPDIR"
  echo "Готово: $OUT ($(du -h "$OUT" | cut -f1))"
}

case "$WHICH" in
  all)     build_flavor browser; build_flavor app ;;
  browser) build_flavor browser ;;
  app)     build_flavor app ;;
  *) echo "Неизвестный аргумент: $WHICH (нужно browser|app|all)" >&2; exit 2 ;;
esac
