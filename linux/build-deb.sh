#!/bin/sh
# Сборка .deb через системный dpkg-deb (на Linux). Собирает оба пакета:
#   controlgui      — открытие в браузере / app-режиме
#   controlgui-app  — нативное окно WebKitGTK
# Кроссплатформенная альтернатива: node linux/build-deb.js
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
VERSION="${1:-2.4.0}"

build_flavor() {
  flavor="$1"           # browser | app
  PKG=$(mktemp -d)
  mkdir -p "$PKG/DEBIAN" "$PKG/opt/controlgui" "$PKG/usr/bin" "$PKG/usr/share/applications"

  cp "$ROOT/server.js" "$PKG/opt/controlgui/"
  cp -r "$ROOT/lib" "$ROOT/public" "$PKG/opt/controlgui/"
  [ -f "$ROOT/README.md" ] && cp "$ROOT/README.md" "$PKG/opt/controlgui/" || true

  install -m 0755 "$HERE/controlgui" "$PKG/usr/bin/controlgui"
  for sz in 16x16 32x32 48x48 256x256; do
    mkdir -p "$PKG/usr/share/icons/hicolor/$sz/apps"
    install -m 0644 "$ROOT/public/assets/controlgui.png" "$PKG/usr/share/icons/hicolor/$sz/apps/controlgui.png"
  done

  if [ "$flavor" = "app" ]; then
    name=controlgui-app
    ctl="$HERE/DEBIAN/control-app"
    install -m 0755 "$HERE/controlgui-app" "$PKG/usr/bin/controlgui-app"
    install -m 0644 "$HERE/controlgui-app.desktop" "$PKG/usr/share/applications/controlgui.desktop"
  else
    name=controlgui
    ctl="$HERE/DEBIAN/control"
    install -m 0644 "$HERE/controlgui.desktop" "$PKG/usr/share/applications/controlgui.desktop"
  fi

  SIZE=$(du -sk "$PKG/opt" "$PKG/usr" | awk '{s+=$1} END {print s}')
  sed -e "s/__VERSION__/$VERSION/" -e "s/__SIZE__/$SIZE/" "$ctl" > "$PKG/DEBIAN/control"
  install -m 0755 "$HERE/DEBIAN/postinst" "$PKG/DEBIAN/postinst"
  install -m 0755 "$HERE/DEBIAN/prerm" "$PKG/DEBIAN/prerm"
  install -m 0755 "$HERE/DEBIAN/postrm" "$PKG/DEBIAN/postrm"

  dpkg-deb --build --root-owner-group "$PKG" "$HERE/${name}_${VERSION}_all.deb"
  rm -rf "$PKG"
}

build_flavor browser
build_flavor app
echo "Готово: $HERE/controlgui_${VERSION}_all.deb и $HERE/controlgui-app_${VERSION}_all.deb"
