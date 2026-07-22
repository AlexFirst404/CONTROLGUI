<div align="center">

<img src="public/assets/controlgui.png" width="120" alt="CONTROLGUI">

# CONTROLGUI

### A real Minecraft server admin panel — on your own computer

No cloud, no accounts, no npm dependencies. One Node.js process, a Minecraft-styled UI, and full control over your servers.

<br>

[![License](https://img.shields.io/badge/license-GPL--3.0-3b8526?style=flat-square)](LICENSE)
![Release](https://img.shields.io/badge/release-2.2.0-6cc04a?style=flat-square)
![Platforms](https://img.shields.io/badge/Windows%20·%20macOS%20·%20Linux-2b2b2b?style=flat-square)
![Dependencies](https://img.shields.io/badge/npm%20deps-0-3b8526?style=flat-square)
![Node](https://img.shields.io/badge/Node.js-%E2%89%A518-2b2b2b?style=flat-square)

**Русская версия → [README.md](README.md)**

</div>

<br>

<div align="center">
<img src="docs/screenshots/home.png" width="880" alt="CONTROLGUI home screen">
</div>

<br>

CONTROLGUI creates and runs **real** Minecraft servers — Vanilla, Paper, Purpur, Folia, Mohist, Forge, plus Velocity / BungeeCord proxies. Cores and the right Java are downloaded automatically, and everything — console, files, players, mods, backups — lives in a clean web UI you can open as an app or in a browser. Your machine is the only server — no third parties involved.

---

## ✨ Features

- 🚀 **Create real servers in two clicks** — Vanilla, Paper, Purpur, Folia, Mohist, Forge + Velocity / BungeeCord proxies. Cores come from official sources; the right Java is installed automatically on all three OSes.
- 🖥️ **Live console** with command input and autocomplete, per-server CPU / RAM / disk graphs, and log search.
- 📂 **File manager** with a built-in code editor, uploads (files and whole folders), zip/jar extraction.
- 👥 **Players** — online list, inventory and stats viewer/editor (own NBT parser), kick / ban / OP / whitelist.
- 🧩 **Mods & plugins** — built-in [Modrinth](https://modrinth.com) catalog: search, one-click install with dependencies, enable/disable.
- 💾 **Backups** — create, restore, download.
- 🎨 **Resource packs** — upload a pack and the panel serves it to game clients over LAN.
- 🌐 **Remote access** — multiple users, each with their own servers and permissions. HTTPS + password, one forwarded port, manage from anywhere.
- 🪟 **Remote panels** *(new in 2.2.0)* — connect to CONTROLGUI on other machines right from the app.
- ⌨️ **Headless / CLI mode** — install on a Linux VPS and manage it from a browser or the built-in terminal UI (TUI) over SSH.

---

## 🚀 Create servers

Fill in the form — the core and Java are fetched for you. Memory and CPU limits are sliders, game mode and difficulty are one-click cycles. You can also import an existing server folder in place.

<div align="center">
<img src="docs/screenshots/create.png" width="820" alt="Create a server">
</div>

---

## 🖥️ Console, logs & graphs

A live console with command input and autocomplete, load graphs per server, and full log viewing with highlighting and search — including across all files at once.

<div align="center">
<img src="docs/screenshots/logs.png" width="820" alt="Server logs with highlighting">
</div>

---

## 👥 Players & 📂 files

Everyone who has joined, with heads, IPs and one-click moderation — kick, ban, OP, whitelist, inventory and stats editing. Next to it, a file manager with a built-in code editor.

<table>
<tr>
<td width="50%"><img src="docs/screenshots/players.png" alt="Players"></td>
<td width="50%"><img src="docs/screenshots/files.png" alt="File manager"></td>
</tr>
</table>

---

## 🧩 Mods & plugins from the catalog

Built-in [Modrinth](https://modrinth.com) catalog: search by name and category for your server's version and core, install with one click alongside dependencies straight into `mods/` or `plugins/`.

<div align="center">
<img src="docs/screenshots/mods.png" width="820" alt="Mods and plugins catalog">
</div>

---

## 🌐 Remote access

Flip a switch, add users (each with their own servers and permissions), forward one port on your router — and manage your servers from anywhere over HTTPS. The self-signed certificate is generated locally in pure JS; the private key never leaves your machine.

<div align="center">
<img src="docs/screenshots/remoteacc.png" width="820" alt="Remote access settings">
</div>

**How to enable:**

1. **Menu → Panel settings → Remote access** — add a user, turn access on (HTTPS port **8433** by default).
2. Forward that port on your router to this computer.
3. From anywhere: `https://your-ip:8433` → the browser warns once about the self-signed certificate (verify the SHA-256 fingerprint shown in the panel) → enter your login and password.

---

## 🪟 Remote panels *(new in 2.2.0)*

Connect to CONTROLGUI panels on **other computers and servers right from the app** — no browser. Add the address, port, login and password, verify the certificate fingerprint — and the remote panel opens in the same window with automatic login. The connection is protected by certificate pinning; the password never reaches the browser.

<div align="center">
<img src="docs/screenshots/rcadd.png" width="520" alt="Add a remote panel">
</div>

---

## 📦 Install

Grab an installer from [Releases](https://github.com/AlexFirst404/CONTROLGUI/releases):

| Platform | File | Notes |
|---|---|---|
| 🪟 **Windows** | `CONTROLGUI-<v>-windows-setup.exe` | Bundles Node.js — nothing else to install |
| 🍎 **macOS** (Apple Silicon) | `CONTROLGUI-<v>-macos-arm64.pkg` | Bundles Node.js |
| 🐧 **Linux** (Debian/Ubuntu) | `controlgui_<v>_all.deb` | Uses system `nodejs` (≥ 18) |
| 🐧 **Linux** (any distro) | `CONTROLGUI-<v>-x86_64.AppImage` | Bundles Node.js |
| 🖥️ **Linux server** (headless) | `controlgui-<v>-linux.tar.gz` | `tar -xzf … && sudo controlgui/install.sh` |

Or run from source (any OS, Node.js ≥ 18, zero npm dependencies):

```bash
git clone https://github.com/AlexFirst404/CONTROLGUI.git
cd CONTROLGUI
node server.js          # open http://localhost:8400
```

---

<details>
<summary><b>⌨️ CLI & headless Linux server</b></summary>

<br>

```bash
controlgui serve                    # run the panel in this terminal
controlgui start | stop | status    # run it in the background
controlgui remote user add <name>   # add a remote-access user
controlgui remote enable            # start the HTTPS listener (port 8433)
sudo controlgui service install     # systemd service with autostart
controlgui tui                      # terminal UI (works over HTTPS too)
```

The TUI shows your servers with status and CPU/RAM, supports start/stop/restart, and gives a live console with command input — right in an SSH session. Connect to a remote panel with `controlgui tui https://ip:8433` (the certificate fingerprint is pinned on first use and verified afterwards).

</details>

<details>
<summary><b>🔒 Security model</b></summary>

<br>

- Plain HTTP (port 8400) answers **only on localhost** — the LAN sees nothing but resource-pack downloads (`/rp/`).
- State-changing requests to the local panel are accepted only from its **own origin** (CSRF protection).
- Remote access is a separate HTTPS listener: PBKDF2-hashed passwords, HttpOnly session cookies, brute-force lockout (5 attempts → 5 minutes), **per-server** permissions, certificate generated locally.
- "Remote panels" reach the other side through a local proxy with **certificate pinning** and keep the session in memory — the password and cookie never reach the browser.
- Host-machine actions (quit app, native folder picker) refuse to run for remote sessions.

</details>

<details>
<summary><b>🛠️ Project layout & building</b></summary>

<br>

```
server.js          — entry point (port 8400; override with PORT env)
cli.js / tui.js    — CLI and terminal UI
lib/               — backend: API, java process manager, downloader, remote access
public/            — frontend: index.html, css/minecraft.css, js/
linux/ mac/        — .deb / tarball / AppImage / .pkg build scripts
```

- **Windows** — `dotnet publish` of the WPF wrapper (WebView2) + Inno Setup script.
- **Linux deb** — `node linux/build-deb.js` (pure-Node .deb builder, no dpkg needed).
- **Linux tarball** — `node linux/build-tarball.js`.
- **AppImage** — `linux/build-appimage.sh` (or the GitHub Actions workflow).
- **macOS pkg** — `mac/build-pkg.sh` (or the GitHub Actions workflow).

</details>

---

## 📄 License

[GPL-3.0](LICENSE) © AlexFirst

<sub>The UI uses Minecraft-style fonts, [Pixelarticons](https://pixelarticons.com/) (MIT), the [Modrinth API](https://docs.modrinth.com/) for the mod catalog, [mc-heads.net](https://mc-heads.net/) for player heads, item textures from [InventivetalentDev/minecraft-assets](https://github.com/InventivetalentDev/minecraft-assets), and [CodeMirror 5](https://codemirror.net/5/) (MIT) for the file editor. Screenshots use demo data.</sub>
