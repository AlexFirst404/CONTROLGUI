# CONTROLGUI v1.4 — Account-gate, Profile page, Movable endpoint

**Date:** 2026-06-27
**Scope:** Central server (`central/`) + desktop wrappers (Win/Linux/Mac, shared `public/` + `server.js` + `lib/`).
**Status:** approved-in-principle via AskUserQuestion answers (2026-06-27); this doc is the technical record.

## Decisions already made (user, via AskUserQuestion)
- **Discord:** user will create the Discord application and provide Client ID + Secret + register the redirect URI. Until then, the "Привязать Discord" button is built but shows "скоро" / disabled.
- **Registration:** auto-approve — account works instantly after register (no admin approval wait).
- **Offline:** desktop runs on a cached account when central is unreachable; re-validates + syncs when connectivity returns.
- **Movable endpoint:** central server address (IP/host) is editable from the admin panel and propagates to all clients.

---

## 1. Mandatory central account at first launch (#3)

**Behavior:** On first desktop launch, the user must register or log into a central account (login+password, tied to the central DB). Auto-approved → usable immediately. A fresh account sees no servers until it creates a local one or an admin assigns a remote one — so open registration is safe.

**Central:**
- `accounts.register()` sets `approved: true`.
- `POST /api/register` creates a session + sets cookie on success → returns `{ ok, user }` (register == logged in).
- Anti-flood: keep per-IP `apiRegLimit` (10/min); replace the now-moot pending cap with a total-account cap.

**Desktop:**
- On boot the frontend calls `centralState()`. Gate logic:
  - cached session valid (`/api/me` 200) → **online**, proceed.
  - no cached account at all → show **gate** screen (login/register), block the app until done.
  - cached account present but central unreachable (network error) → **offline**: proceed with cached identity; local servers work, remote servers show offline; banner "Нет связи с сервером — работаете офлайн".
  - cached account but `/api/me` 401 while online → session expired → prompt re-login (allow local-only with banner if user dismisses).
- The gate reuses the existing `#screen-remote` login/register UI, promoted to a launch screen. Burger "Подключить сервер" stays for linking servers by code.
- "Sync when online": a reconnect check; on offline→online transition, re-validate session + refetch `/api/endpoint`. Profile edits (rename/Discord) require online (no offline mutation queue in v1.4).

## 2. Profile page (#4)

**Behavior:** Burger username button (`#menu-account-name`) → `#screen-profile`: shows current nick, a rename form, and Discord link status/button.

**Central:**
- `POST /api/account/rename {newName}` (session): validate name free → `accounts.rename(old,new)` + `servers.renameAccount(old,new)` (cascade `ownerAccount` and `access[].username`) + update in-memory sessions' username. Returns new user.
- Discord OAuth2 (`scope=identify`):
  - `GET /api/account/discord/start` → 302 to Discord authorize (state = CSRF bound to session).
  - `GET /api/account/discord/callback?code&state` → exchange code → `GET /users/@me` → store `{discordId, discordName, avatar}` on account → redirect to profile.
  - `POST /api/account/discord/unlink`.
  - Config from env/settings: `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, redirect = `https://<endpoint>/api/account/discord/callback`. **BLOCKED on user creds.**

**Desktop:**
- New `#screen-profile`; burger username → `openProfileScreen()`.
- Panel proxies new central routes: `/api/central/account/*` → centralclient → central. Discord link opens the system browser to central `/api/account/discord/start`; after callback the desktop re-fetches `/api/me`.

## 3. Movable endpoint (#5)

**Key insight:** the client pins the cert by **fingerprint256**, not hostname. So the admin can move the VPS to a new IP/host **reusing the same cert+key**, and fingerprint-pinned clients still connect. No new cert-trust (TOFU) needed for the common case.

**Central:**
- `data/settings.json` → `endpoint: { host, port }` (default = current host:443).
- `GET /api/endpoint` (PUBLIC) → `{ host, port }` (advertise canonical address; served over the trusted pinned connection).
- `POST /api/admin/endpoint {host,port}` (admin) → validate + persist.
- Admin UI: a field on the central dashboard to edit host:port.

**Desktop (centralclient + remote.js):**
- `data/central-account.json` gains `endpoint:{host,port}`.
- On each successful connect, client `GET /api/endpoint`; if it differs from stored, persist it (trusted — learned over the pinned channel). Subsequent connects use the new host. Cert pinning unchanged (embedded fingerprint; same cert on the new host → matches).
- **Bootstrap caveat (documented limitation):** if the central fully moves and the old address goes dark *before* a client ever fetched the new endpoint, that client can't auto-discover the move (raw IPs, no stable DNS anchor). Mitigation: keep the old IP reachable until clients migrate, or front the central with a domain name. Acceptable for v1.4.

---

## Release (#2)
Bump 1.3 → 1.4: `lib/api.js:899`, `lib/download.js:5`, `linux/build-deb.js` default, local `CONTROLGUI.Desktop.csproj` Version, local `controlgui.iss` AppVersion/OutputBaseFilename. Rebuild Win `.exe` (publish + ISCC), `.deb`, AppImage, Mac `.pkg`. Tag + upload.

## Constraints (carried)
- No npm deps; built-in Node modules only.
- Do NOT restart the panel `node` while the user's MC servers run (it kills them). Desktop rebuilds use separate processes; central deploy restarts only `cgremote`.
- Preserve `alex`/`fff` panel users and existing central accounts.
- The full multi-platform v1.4 **release** (heavy, externally visible) is the one step that gets an explicit go-ahead before publishing.
