#!/bin/sh
# Сборка CONTROLGUI.app + .dmg для macOS (запускать НА macOS).
# Использование: sh mac/build-dmg.sh [версия]
# Бандлит встроенный node-darwin + панель; режим открытия — браузер
# (поднимает локальную панель и открывает её в браузере/приложении-окне).
# Нужны: curl, tar, hdiutil (есть в macOS). sips/iconutil — для иконки (необязательно).
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
VERSION="${1:-1.3.0}"
NODE_VER="v20.18.1"

# архитектура раннера/машины: Apple Silicon (arm64) или Intel (x64)
case "$(uname -m)" in
  arm64) NARCH=arm64 ;;
  x86_64) NARCH=x64 ;;
  *) NARCH=x64 ;;
esac

CACHE="$HERE/.dmg-cache"
mkdir -p "$CACHE"
NODE_DIR="$CACHE/node-$NODE_VER-darwin-$NARCH"
if [ ! -x "$NODE_DIR/bin/node" ]; then
  echo "Скачиваю Node $NODE_VER (darwin-$NARCH)…"
  curl -fsSL "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-darwin-$NARCH.tar.gz" -o "$CACHE/node.tar.gz"
  tar -xzf "$CACHE/node.tar.gz" -C "$CACHE"
fi

echo "=== Сборка CONTROLGUI.app $VERSION ($NARCH) ==="
APP="$HERE/CONTROLGUI.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/opt/controlgui" "$APP/Contents/Resources/bin"

# панель (как в .deb/AppImage): server.js + lib + public
cp "$ROOT/server.js" "$APP/Contents/Resources/opt/controlgui/"
cp -R "$ROOT/lib" "$ROOT/public" "$APP/Contents/Resources/opt/controlgui/"
for extra in package.json LICENSE README.md; do
  [ -f "$ROOT/$extra" ] && cp "$ROOT/$extra" "$APP/Contents/Resources/opt/controlgui/" || true
done

# встроенный node — пользователю Node ставить не нужно
cp "$NODE_DIR/bin/node" "$APP/Contents/Resources/bin/node"
chmod 0755 "$APP/Contents/Resources/bin/node"

# лаунчер (точка входа .app)
cp "$HERE/launcher.sh" "$APP/Contents/MacOS/controlgui"
chmod 0755 "$APP/Contents/MacOS/controlgui"

# Info.plist (подставляем версию)
sed "s/__VERSION__/$VERSION/g" "$HERE/Info.plist" > "$APP/Contents/Info.plist"

# иконка .icns из public/assets/controlgui.png (если доступны sips/iconutil)
ICON_PNG="$ROOT/public/assets/controlgui.png"
if [ -f "$ICON_PNG" ] && command -v sips >/dev/null 2>&1 && command -v iconutil >/dev/null 2>&1; then
  TMPICON="$(mktemp -d)/controlgui.iconset"
  mkdir -p "$TMPICON"
  for sz in 16 32 64 128 256 512; do
    sips -z $sz $sz "$ICON_PNG" --out "$TMPICON/icon_${sz}x${sz}.png" >/dev/null 2>&1 || true
    d2=$((sz * 2))
    sips -z $d2 $d2 "$ICON_PNG" --out "$TMPICON/icon_${sz}x${sz}@2x.png" >/dev/null 2>&1 || true
  done
  iconutil -c icns "$TMPICON" -o "$APP/Contents/Resources/controlgui.icns" 2>/dev/null || true
fi

# ad-hoc подпись: без неё приложение из интернета может не запускаться вовсе;
# с ней Gatekeeper всё равно попросит «Открыть» вручную при первом запуске.
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true

# .dmg с ярлыком на /Applications (перетащить для установки)
OUT="$HERE/CONTROLGUI-${VERSION}-macos-${NARCH}.dmg"
rm -f "$OUT"
STAGE="$(mktemp -d)"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "CONTROLGUI" -srcfolder "$STAGE" -ov -format UDZO "$OUT" >/dev/null
rm -rf "$STAGE"
echo "Готово: $OUT ($(du -h "$OUT" | cut -f1))"
