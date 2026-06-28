'use strict';
const https = require('https');
const fs = require('fs');

const UA = 'CONTROLGUI-MinecraftPanel/1.4.6 (local admin panel)';

const MOJANG_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const PAPER_BASE = 'https://api.papermc.io/v2/projects/';            // paper, folia
const PURPUR_API = 'https://api.purpurmc.org/v2/purpur';
const MOHIST_API = 'https://mohistmc.com/api/v2/projects/mohist';
const FORGE_PROMOS = 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json';
const FORGE_MAVEN = 'https://maven.minecraftforge.net/net/minecraftforge/forge/';
// BungeeCord — роллинг-сборка (версий нет), Velocity — через PaperMC API (projects/velocity)
const BUNGEE_JAR = 'https://ci.md-5.net/job/BungeeCord/lastSuccessfulBuild/artifact/bootstrap/target/BungeeCord.jar';

function fetchUrl(url, redirects = 5, extraHeaders) {
  return new Promise((resolve, reject) => {
    const headers = Object.assign({ 'User-Agent': UA }, extraHeaders || {});
    const req = https.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        const next = new URL(res.headers.location, url);
        // приватные заголовки (напр. x-api-key) не пробрасываем на другой хост
        let sameHost = false; try { sameHost = next.host === new URL(url).host; } catch (e) { /* */ }
        resolve(fetchUrl(next.toString(), redirects - 1, sameHost ? extraHeaders : undefined));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error('HTTP ' + res.statusCode + ' при запросе ' + url));
        return;
      }
      resolve(res);
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('Таймаут запроса: ' + url)));
  });
}

async function fetchJson(url, extraHeaders) {
  const res = await fetchUrl(url, 5, extraHeaders);
  const chunks = [];
  for await (const chunk of res) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function downloadFile(url, dest, onProgress) {
  const res = await fetchUrl(url);
  const total = parseInt(res.headers['content-length'] || '0', 10);
  let done = 0;
  const tmp = dest + '.part';
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(tmp);
    res.on('data', (chunk) => {
      done += chunk.length;
      if (onProgress) onProgress(done, total);
    });
    res.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
    res.pipe(out);
  });
  fs.renameSync(tmp, dest);
}

// ---- кэш ответов (10 минут) ----

const cache = new Map();
async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < 10 * 60 * 1000) return hit.v;
  const v = await fn();
  cache.set(key, { t: Date.now(), v });
  return v;
}

function cmpMcVersion(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pb[i] || 0) - (pa[i] || 0);
    if (d) return d;
  }
  return 0;
}

// ---- Vanilla (Mojang) ----

function getVanillaManifest() {
  return cached('vanilla', () => fetchJson(MOJANG_MANIFEST));
}

async function getVanillaVersions() {
  const manifest = await getVanillaManifest();
  return manifest.versions.filter((v) => v.type === 'release').map((v) => v.id);
}

async function resolveVanilla(version) {
  const manifest = await getVanillaManifest();
  const entry = manifest.versions.find((v) => v.id === version);
  if (!entry) throw new Error('Неизвестная версия Minecraft: ' + version);
  const detail = await fetchJson(entry.url);
  const dl = detail.downloads && detail.downloads.server;
  if (!dl || !dl.url) throw new Error('Для версии ' + version + ' нет серверного jar');
  return dl.url;
}

// ---- Paper / Folia (PaperMC) ----

function getPaperLikeVersions(project) {
  return cached('paperlike:' + project, async () => {
    const data = await fetchJson(PAPER_BASE + project);
    return (data.versions || []).slice().reverse();
  });
}

async function resolvePaperLike(project, version) {
  const data = await fetchJson(PAPER_BASE + project + '/versions/' + encodeURIComponent(version) + '/builds');
  const builds = data.builds || [];
  if (!builds.length) throw new Error('Нет сборок ' + project + ' для версии ' + version);
  const stable = builds.filter((b) => b.channel === 'default');
  const pool = stable.length ? stable : builds;
  const build = pool[pool.length - 1];
  const name = build.downloads && build.downloads.application && build.downloads.application.name;
  if (!name) throw new Error('У сборки ' + project + ' #' + build.build + ' нет файла application');
  return PAPER_BASE + project + '/versions/' + encodeURIComponent(version) + '/builds/' + build.build + '/downloads/' + name;
}

// ---- Purpur ----

function getPurpurVersions() {
  return cached('purpur', async () => {
    const data = await fetchJson(PURPUR_API);
    return (data.versions || []).slice().reverse();
  });
}

function resolvePurpur(version) {
  return PURPUR_API + '/' + encodeURIComponent(version) + '/latest/download';
}

// ---- Mohist ----

function getMohistVersions() {
  return cached('mohist', async () => {
    const data = await fetchJson(MOHIST_API);
    const versions = (data.versions || []).slice();
    versions.sort(cmpMcVersion);
    return versions;
  });
}

async function resolveMohist(version) {
  const data = await fetchJson(MOHIST_API + '/' + encodeURIComponent(version) + '/builds');
  const builds = data.builds || [];
  if (!builds.length) throw new Error('Нет сборок Mohist для версии ' + version);
  const build = builds[builds.length - 1];
  const url = build.url || build.originUrl;
  if (!url) throw new Error('У сборки Mohist нет ссылки на скачивание');
  return url;
}

// ---- Forge (через официальный installer) ----

function getForgeIndex() {
  return cached('forge', async () => {
    const data = await fetchJson(FORGE_PROMOS);
    const map = new Map(); // mcVersion -> {latest, recommended}
    for (const [key, value] of Object.entries(data.promos || {})) {
      const m = key.match(/^(.+)-(latest|recommended)$/);
      if (!m) continue;
      const entry = map.get(m[1]) || {};
      entry[m[2]] = value;
      map.set(m[1], entry);
    }
    return map;
  });
}

async function getForgeVersions() {
  const index = await getForgeIndex();
  return Array.from(index.keys()).sort(cmpMcVersion);
}

async function resolveForgeInstaller(version) {
  const index = await getForgeIndex();
  const entry = index.get(version);
  if (!entry) throw new Error('Forge для версии ' + version + ' не найден');
  const forgeVer = entry.recommended || entry.latest;
  const full = version + '-' + forgeVer;
  return FORGE_MAVEN + full + '/forge-' + full + '-installer.jar';
}

// ---- единые точки входа ----

async function getVersions(type) {
  switch (type) {
    case 'vanilla': return getVanillaVersions();
    case 'paper': return getPaperLikeVersions('paper');
    case 'folia': return getPaperLikeVersions('folia');
    case 'purpur': return getPurpurVersions();
    case 'mohist': return getMohistVersions();
    case 'forge': return getForgeVersions();
    case 'velocity': return getPaperLikeVersions('velocity');
    case 'bungeecord': return ['latest']; // роллинг-сборка, версия одна
    default: throw Object.assign(new Error('Неизвестный тип ядра: ' + type), { status: 404 });
  }
}

async function resolveServerUrl(type, version) {
  switch (type) {
    case 'vanilla': return resolveVanilla(version);
    case 'paper': return resolvePaperLike('paper', version);
    case 'folia': return resolvePaperLike('folia', version);
    case 'purpur': return resolvePurpur(version);
    case 'mohist': return resolveMohist(version);
    case 'forge': return resolveForgeInstaller(version);
    case 'velocity': return resolvePaperLike('velocity', version);
    case 'bungeecord': return BUNGEE_JAR;
    default: throw new Error('Неизвестный тип ядра: ' + type);
  }
}

module.exports = { getVersions, resolveServerUrl, downloadFile, fetchJson };
