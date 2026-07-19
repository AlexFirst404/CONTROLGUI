# CONTROLGUI

**A real Minecraft server admin panel that runs on your own computer.** No cloud, no accounts, no npm dependencies — one Node.js process, a Minecraft-styled web UI, and full control over your servers.

[Русская версия / Russian version → README.ru.md](README.ru.md)

## Features

- **Create real servers in two clicks** — Vanilla, Paper, Purpur, Folia, Mohist, Forge, plus Velocity / BungeeCord proxies. Cores are downloaded from official sources; the right Java is installed automatically on all three OSes.
- **Live console** with command input and autocomplete, log search, per-server CPU / RAM / disk graphs.
- **File manager** with a built-in code editor, uploads (files and whole folders), zip/jar extraction.
- **Players** — online list, inventory and stats viewer/editor (own NBT parser), kick / ban / OP / whitelist.
- **Mods & plugins** — built-in [Modrinth](https://modrinth.com) catalog: search, one-click install with dependencies, enable/disable.
- **Backups** — create, restore, download.
- **Resource packs** — upload a pack and the panel serves it to game clients over LAN.
- **Remote access** — flip a switch, set a password, forward one port on your router: manage your servers from anywhere over HTTPS (self-signed certificate generated locally in pure JS). No third-party servers involved — your machine is the only server.
- **Headless / CLI mode** — install on a Linux VPS and manage it from another computer via browser or the built-in terminal UI (TUI).

## Install

Grab an installer from [Releases](https://github.com/AlexFirst404/CONTROLGUI/releases):

| Platform | File | Notes |
|---|---|---|
| Windows | `CONTROLGUI-<v>-windows-setup.exe` | Bundles Node.js — nothing else to install |
| Linux (Debian/Ubuntu) | `controlgui_<v>_all.deb` | Uses system `nodejs` (>= 18) |
| Linux (any distro) | `CONTROLGUI-<v>-x86_64.AppImage` | Bundles Node.js |
| Linux server (headless) | `controlgui-<v>-linux.tar.gz` | `tar -xzf … && sudo controlgui/install.sh` |
| macOS (Apple Silicon) | `CONTROLGUI-<v>-macos-arm64.pkg` | Bundles Node.js |

Or run from source (any OS, Node.js >= 18, zero npm dependencies):

```bash
git clone https://github.com/AlexFirst404/CONTROLGUI.git
cd CONTROLGUI
node server.js          # open http://localhost:8400
```

## Remote access over the internet

1. In the panel: **Menu → Panel settings → Remote access** — set a password; access turns on (HTTPS port **8433** by default).
2. Forward port 8433 on your router to this computer.
3. From anywhere: `https://your-ip:8433` → the browser warns about the self-signed certificate once (expected — verify the SHA-256 fingerprint shown in the panel) → enter the password → full panel.

The desktop apps can also connect directly: Windows — tray menu **"Remote panel…"**; Linux/macOS — `controlgui connect https://ip:8433` (back to local: `controlgui connect --local`). Certificate fingerprints are pinned on first use (TOFU) and verified on every connection.

## CLI & headless Linux server

```bash
controlgui serve                  # run the panel in this terminal
controlgui start | stop | status  # run it in the background
controlgui remote password        # set the remote-access password
controlgui remote enable          # start the HTTPS listener (port 8433)
sudo controlgui service install   # systemd service with autostart
controlgui tui                    # terminal UI (works over HTTPS too: controlgui tui https://ip:8433)
```

The TUI shows your servers with status and CPU/RAM, supports start/stop/restart, and gives you a live console with command input — right in an SSH session.

## Security model

- Plain HTTP (port 8400) answers **only on localhost** — the LAN sees nothing but resource-pack downloads (`/rp/`).
- Remote access is a separate HTTPS listener: PBKDF2-hashed password, HttpOnly session cookies, brute-force lockout (5 attempts → 5 minutes), certificate generated locally — the private key never leaves your machine.
- Host-machine actions (quit app, native folder picker) refuse to run for remote sessions.

## Project layout

```
server.js          — entry point (port 8400; override with PORT env)
cli.js / tui.js    — CLI and terminal UI
lib/               — backend: API, java process manager, downloader, remote access
public/            — frontend: index.html, css/minecraft.css, js/
linux/ mac/        — .deb / tarball / AppImage / .pkg build scripts
```

## Building installers

- **Windows** — `dotnet publish` of the WPF wrapper (WebView2) + Inno Setup script.
- **Linux deb** — `node linux/build-deb.js` (pure-Node .deb builder, no dpkg needed).
- **Linux tarball** — `node linux/build-tarball.js`.
- **AppImage** — `linux/build-appimage.sh` (or the GitHub Actions workflow).
- **macOS pkg** — `mac/build-pkg.sh` (or the GitHub Actions workflow).

## License

[GPL-3.0](LICENSE) © AlexFirst

The UI uses Minecraft-style fonts, [Pixelarticons](https://pixelarticons.com/) (MIT), the [Modrinth API](https://docs.modrinth.com/) for the mod catalog, [mc-heads.net](https://mc-heads.net/) for player heads, item textures from [InventivetalentDev/minecraft-assets](https://github.com/InventivetalentDev/minecraft-assets), and [CodeMirror 5](https://codemirror.net/5/) (MIT) for the file editor.
