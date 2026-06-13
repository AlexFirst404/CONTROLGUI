#!/bin/sh
# Сборка .deb через системный dpkg-deb (на Linux).
# Кроссплатформенная альтернатива: node linux/build-deb.js
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
VERSION="${1:-1.3.0}"

PKG=$(mktemp -d)
trap 'rm -rf "$PKG"' EXIT
mkdir -p "$PKG/DEBIAN" "$PKG/opt/controlgui" "$PKG/usr/bin" "$PKG/usr/share/applications"

cp "$ROOT/server.js" "$PKG/opt/controlgui/"
cp -r "$ROOT/lib" "$ROOT/public" "$PKG/opt/controlgui/"
[ -f "$ROOT/README.md" ] && cp "$ROOT/README.md" "$PKG/opt/controlgui/" || true

install -m 0755 "$HERE/controlgui" "$PKG/usr/bin/controlgui"
install -m 0644 "$HERE/controlgui.desktop" "$PKG/usr/share/applications/controlgui.desktop"
for sz in 16x16 32x32 48x48 256x256; do
  mkdir -p "$PKG/usr/share/icons/hicolor/$sz/apps"
  install -m 0644 "$ROOT/public/assets/controlgui.png" "$PKG/usr/share/icons/hicolor/$sz/apps/controlgui.png"
done

SIZE=$(du -sk "$PKG/opt" "$PKG/usr" | awk '{s+=$1} END {print s}')
sed -e "s/__VERSION__/$VERSION/" -e "s/__SIZE__/$SIZE/" "$HERE/DEBIAN/control" > "$PKG/DEBIAN/control"
install -m 0755 "$HERE/DEBIAN/postinst" "$PKG/DEBIAN/postinst"

dpkg-deb --build --root-owner-group "$PKG" "$HERE/controlgui_${VERSION}_all.deb"
echo "Готово: $HERE/controlgui_${VERSION}_all.deb"
