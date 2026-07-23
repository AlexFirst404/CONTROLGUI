#!/bin/sh
# Сборка AppImage CONTROLGUI (запускать на Linux x86_64).
# Использование: sh linux/build-appimage.sh [версия]
# Один пакет: режим (приложение/браузер) выбирается при первом запуске.
# Нужны: curl, tar (с поддержкой xz). appimagetool и node скачиваются сами.
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
VERSION="${1:-2.3.1}"
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

echo "=== Сборка AppImage CONTROLGUI $VERSION ==="
APPDIR="$HERE/AppDir"
rm -rf "$APPDIR"
mkdir -p "$APPDIR/usr/bin" "$APPDIR/opt/controlgui" \
         "$APPDIR/usr/share/icons/hicolor/256x256/apps" \
         "$APPDIR/usr/share/applications"

# панель (как в .deb): server.js + cli/tui + lib + public
cp "$ROOT/server.js" "$ROOT/cli.js" "$ROOT/tui.js" "$APPDIR/opt/controlgui/"
cp -r "$ROOT/lib" "$ROOT/public" "$APPDIR/opt/controlgui/"
cp "$HERE/appimage/controlgui-window.py" "$APPDIR/opt/controlgui/"

# встроенный node — AppImage не требует установленного Node.js
cp "$NODE_DIR/bin/node" "$APPDIR/usr/bin/node"
chmod 0755 "$APPDIR/usr/bin/node"
# официальные сборки node обычно уже без символов, но снимаем на всякий случай
if command -v strip >/dev/null 2>&1; then
  strip --strip-all "$APPDIR/usr/bin/node" 2>/dev/null || true
fi

# точка входа + версия/id сборки
cp "$HERE/appimage/AppRun" "$APPDIR/AppRun"
chmod 0755 "$APPDIR/AppRun"
printf '%s' "$VERSION" > "$APPDIR/version"
# уникальный id сборки — чтобы AppRun переустанавливал копию панели при обновлении
printf '%s' "$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || date +%s)" > "$APPDIR/build"

# иконка (в корне для thumbnailer + в hicolor)
cp "$ROOT/public/assets/controlgui.png" "$APPDIR/controlgui.png"
cp "$ROOT/public/assets/controlgui.png" "$APPDIR/usr/share/icons/hicolor/256x256/apps/controlgui.png"

# .desktop
cat > "$APPDIR/controlgui.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=CONTROLGUI
Comment=Панель Minecraft-серверов (приложение или браузер — на выбор)
Exec=AppRun
Icon=controlgui
Categories=Game;Utility;
Terminal=false
StartupWMClass=CONTROLGUI
EOF
cp "$APPDIR/controlgui.desktop" "$APPDIR/usr/share/applications/controlgui.desktop"

OUT="$HERE/CONTROLGUI-${VERSION}-${ARCH}.AppImage"
rm -f "$OUT"
# zstd — единственный компрессор в mksquashfs у appimagetool; хороший баланс
# размера и скорости распаковки (xz этот mksquashfs не поддерживает)
ARCH="$ARCH" "$TOOL" --comp zstd --no-appstream "$APPDIR" "$OUT"
rm -rf "$APPDIR"
echo "Готово: $OUT ($(du -h "$OUT" | cut -f1))"
