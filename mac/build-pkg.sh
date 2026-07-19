#!/bin/sh
# Сборка CONTROLGUI.app + .pkg-установщика для macOS (запускать НА macOS).
# Использование: sh mac/build-pkg.sh [версия]
# Бандлит встроенный node-darwin + панель. Окно — НАТИВНОЕ (Swift + WKWebView),
# не вкладка браузера. .pkg ставит приложение в /Applications.
# Нужны: curl, tar, pkgbuild, swiftc (Xcode CLT). sips/iconutil — для иконки.
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
VERSION="${1:-1.4.0}"
NODE_VER="v20.18.1"

case "$(uname -m)" in
  arm64) NARCH=arm64 ;;
  x86_64) NARCH=x64 ;;
  *) NARCH=x64 ;;
esac

CACHE="$HERE/.pkg-cache"
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

# панель (как в .deb/AppImage): server.js + cli/tui + lib + public
cp "$ROOT/server.js" "$ROOT/cli.js" "$ROOT/tui.js" "$APP/Contents/Resources/opt/controlgui/"
cp -R "$ROOT/lib" "$ROOT/public" "$APP/Contents/Resources/opt/controlgui/"
for extra in package.json LICENSE README.md README.ru.md; do
  [ -f "$ROOT/$extra" ] && cp "$ROOT/$extra" "$APP/Contents/Resources/opt/controlgui/" || true
done

# встроенный node — пользователю Node ставить не нужно
cp "$NODE_DIR/bin/node" "$APP/Contents/Resources/bin/node"
chmod 0755 "$APP/Contents/Resources/bin/node"

# точка входа .app: нативное окно (Swift), иначе запасной лаунчер в браузере
if command -v swiftc >/dev/null 2>&1; then
  echo "Компилирую нативное окно (Swift + WKWebView)…"
  swiftc -O -o "$APP/Contents/MacOS/controlgui" "$HERE/AppMain.swift" \
    -framework Cocoa -framework WebKit
  chmod 0755 "$APP/Contents/MacOS/controlgui"
else
  echo "swiftc не найден — ставлю запасной лаунчер (откроется в браузере)."
  cp "$HERE/launcher.sh" "$APP/Contents/MacOS/controlgui"
  chmod 0755 "$APP/Contents/MacOS/controlgui"
fi

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

# ad-hoc подпись inside-out (вложенный node первым, потом бандл) — --deep устарел.
# Вывод НЕ глушим (чтобы сбой был виден); сборку не валим (node/swiftc уже ad-hoc подписаны).
codesign --force --sign - "$APP/Contents/Resources/bin/node" || echo "WARN: codesign node не удался"
codesign --force --sign - "$APP/Contents/MacOS/controlgui" || echo "WARN: codesign бинаря не удался"
codesign --force --sign - "$APP" || echo "WARN: codesign бандла не удался"

# .pkg: установщик кладёт CONTROLGUI.app в /Applications
OUT="$HERE/CONTROLGUI-${VERSION}-macos-${NARCH}.pkg"
rm -f "$OUT"
PKGROOT="$(mktemp -d)"
cp -R "$APP" "$PKGROOT/"
pkgbuild \
  --root "$PKGROOT" \
  --install-location /Applications \
  --identifier com.alexfirst.controlgui \
  --version "$VERSION" \
  "$OUT"
rm -rf "$PKGROOT"
echo "Готово: $OUT ($(du -h "$OUT" | cut -f1))"
