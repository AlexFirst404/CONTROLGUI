'use strict';
/* Серверный тарболл CONTROLGUI для любого Linux (не-Debian): панель + CLI + TUI.
   Собирается на чистом Node (без tar):
     node linux/build-tarball.js [версия]
   Внутри: controlgui/{server.js,cli.js,tui.js,lib,public,install.sh}
   Установка на сервере:
     tar -xzf controlgui-<версия>-linux.tar.gz && sudo controlgui/install.sh */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const VERSION = process.argv[2] || '2.3.2';

// ---- минимальный ustar-писатель (как в build-deb.js) ----
function tarHeader(name, size, mode, type) {
  const buf = Buffer.alloc(512);
  buf.write(name, 0, 100, 'utf8');
  buf.write((mode || 0o644).toString(8).padStart(7, '0') + '\0', 100, 8);
  buf.write('0000000\0', 108, 8);
  buf.write('0000000\0', 116, 8);
  buf.write(size.toString(8).padStart(11, '0') + '\0', 124, 12);
  buf.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136, 12);
  buf.write('        ', 148, 8); // чексумма-заглушка
  buf.write(type || '0', 156, 1);
  buf.write('ustar', 257, 5);
  buf.write('00', 263, 2);
  let sum = 0;
  for (const b of buf) sum += b;
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return buf;
}
const chunks = [];
function addDir(name) { chunks.push(tarHeader(name.replace(/\/?$/, '/'), 0, 0o755, '5')); }
function addFile(name, data, mode) {
  const d = Buffer.isBuffer(data) ? data : Buffer.from(data);
  chunks.push(tarHeader(name, d.length, mode, '0'), d);
  const padLen = (512 - (d.length % 512)) % 512;
  if (padLen) chunks.push(Buffer.alloc(padLen));
}
function addTree(src, dst) {
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = dst + '/' + e.name;
    if (e.isDirectory()) { addDir(d); addTree(s, d); }
    else addFile(d, fs.readFileSync(s), 0o644);
  }
}

const INSTALL_SH = `#!/bin/sh
# Установка CONTROLGUI на Linux-сервер (запускать от root из распакованного каталога).
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
if ! command -v node >/dev/null 2>&1; then
  echo "Нужен Node.js >= 18 (например: apt install nodejs / dnf install nodejs)"; exit 1
fi
DEST=/opt/controlgui
mkdir -p "$DEST"
cp -a "$HERE/." "$DEST/"
rm -f "$DEST/install.sh"
cat > /usr/local/bin/controlgui <<'EOF'
#!/bin/sh
if [ -z "\${CONTROLGUI_DATA:-}" ]; then
  if [ "\${1:-}" = "service" ] && [ "\${2:-install}" = "install" ] && [ -n "\${SUDO_USER:-}" ] && [ "\$SUDO_USER" != "root" ]; then
    CG_SERVICE_HOME="\$(getent passwd "\$SUDO_USER" 2>/dev/null | cut -d: -f6)"
    [ -n "\$CG_SERVICE_HOME" ] || CG_SERVICE_HOME="/home/\$SUDO_USER"
    CONTROLGUI_DATA="\$CG_SERVICE_HOME/.local/share/controlgui"
  else
    CONTROLGUI_DATA="\${XDG_DATA_HOME:-\${HOME:-/root}/.local/share}/controlgui"
  fi
fi
export CONTROLGUI_DATA
export PORT="\${CONTROLGUI_PORT:-\${PORT:-8400}}"
exec node /opt/controlgui/cli.js "\$@"
EOF
chmod 755 /usr/local/bin/controlgui
echo "Готово. Дальше:"
echo "  controlgui remote setup          # мастер удалённого доступа (пользователь + HTTPS)"
echo "  sudo controlgui service install  # автозапуск через systemd"
echo "  controlgui start                 # запустить панель фоном"
echo "  controlgui tui                   # текстовый интерфейс"
`;

addDir('controlgui');
addFile('controlgui/server.js', fs.readFileSync(path.join(ROOT, 'server.js')), 0o644);
addFile('controlgui/cli.js', fs.readFileSync(path.join(ROOT, 'cli.js')), 0o755);
addFile('controlgui/tui.js', fs.readFileSync(path.join(ROOT, 'tui.js')), 0o755);
addFile('controlgui/install.sh', INSTALL_SH.replace(/\r\n?/g, '\n'), 0o755);
for (const extra of ['LICENSE', 'README.md', 'README.en.md']) {
  const p = path.join(ROOT, extra);
  if (fs.existsSync(p)) addFile('controlgui/' + extra, fs.readFileSync(p), 0o644);
}
addDir('controlgui/lib');
addTree(path.join(ROOT, 'lib'), 'controlgui/lib');
addDir('controlgui/public');
addTree(path.join(ROOT, 'public'), 'controlgui/public');

chunks.push(Buffer.alloc(1024)); // конец архива
const outName = 'controlgui-' + VERSION + '-linux.tar.gz';
fs.writeFileSync(path.join(__dirname, outName), zlib.gzipSync(Buffer.concat(chunks), { level: 9 }));
console.log('Собран ' + outName);
