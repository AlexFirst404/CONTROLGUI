'use strict';
const dl = require('./download');

/* Поиск и установка плагинов/модов с CurseForge (Core API, api.curseforge.com/v1).
   Интерфейс намеренно повторяет lib/modrinth.js, чтобы маршруты подменяли провайдера.
   Сетевые запросы идут через download.js; CurseForge требует заголовок x-api-key. */

const API = 'https://api.curseforge.com/v1';
const GAME_ID = 432;                 // Minecraft
const CLASS_PLUGINS = 5;             // Bukkit Plugins
const CLASS_MODS = 6;                // Mc-Mods
const LOADER_FORGE = 1;              // modLoaderType: Forge (наш сервер грузит forge-моды)
const REL_REQUIRED = 3;              // relationType: обязательная зависимость

// Ключ приложения. Репозиторий приватный (для друзей) — ключ вшит, но его можно
// переопределить переменной окружения CURSEFORGE_API_KEY.
const API_KEY = process.env.CURSEFORGE_API_KEY
  || '$2a$10$44gMV/Ck5luw0khW2Y8gY.ZwpdrO0zGDzPDF7O63DqOw8m6sDdGl6';

function headers() { return { 'x-api-key': API_KEY, Accept: 'application/json' }; }

// relevance/downloads/... -> sortField CurseForge (1 Featured, 2 Popularity, 3 LastUpdated, 6 TotalDownloads)
const SORT_FIELD = { relevance: 1, downloads: 6, follows: 2, newest: 3, updated: 3 };

/* Поиск/листание. opts: { query, isMod, mcVersion, sort, offset, limit }.
   Возвращает { hits, total, offset, limit } — как у modrinth.search. */
async function search(opts) {
  opts = opts || {};
  const limit = Math.min(50, Math.max(1, parseInt(opts.limit, 10) || 20));
  const offset = Math.max(0, parseInt(opts.offset, 10) || 0);
  const classId = opts.isMod ? CLASS_MODS : CLASS_PLUGINS;
  const sortField = SORT_FIELD[opts.sort] || 1;
  const params = [
    'gameId=' + GAME_ID,
    'classId=' + classId,
    'searchFilter=' + encodeURIComponent(opts.query || ''),
    'sortField=' + sortField,
    'sortOrder=desc',
    'index=' + offset,
    'pageSize=' + limit,
  ];
  if (opts.mcVersion && opts.mcVersion !== '-') params.push('gameVersion=' + encodeURIComponent(opts.mcVersion));
  if (opts.isMod) params.push('modLoaderType=' + LOADER_FORGE);
  const data = await dl.fetchJson(API + '/mods/search?' + params.join('&'), headers());
  const pg = data.pagination || {};
  // CurseForge ограничивает пагинацию первыми 10000 результатами
  const total = Math.min(pg.totalCount != null ? pg.totalCount : 0, 10000);
  return {
    hits: (data.data || []).map(mapHit),
    total,
    offset: pg.index != null ? pg.index : offset,
    limit: pg.pageSize != null ? pg.pageSize : limit,
  };
}

function mapHit(m) {
  return {
    projectId: String(m.id),
    slug: m.slug || '',
    title: m.name || '',
    description: m.summary || '',
    author: (m.authors && m.authors[0] && m.authors[0].name) || '',
    downloads: m.downloadCount || 0,
    iconUrl: (m.logo && m.logo.url) || '',
    categories: (m.categories || []).map((c) => c.name).filter(Boolean).slice(0, 4),
    provider: 'curseforge',
  };
}

/* Полное описание для модалки: краткое + тело (HTML) + галерея скриншотов. */
async function projectDetails(id) {
  const modId = String(id || '').replace(/[^0-9]/g, '');
  if (!modId) return null;
  let mod;
  try { mod = (await dl.fetchJson(API + '/mods/' + modId, headers())).data; } catch (e) { return null; }
  if (!mod || !mod.id) return null;
  let body = '';
  try { body = (await dl.fetchJson(API + '/mods/' + modId + '/description', headers())).data || ''; } catch (e) { /* без тела */ }
  const links = mod.links || {};
  return {
    projectId: String(mod.id), slug: mod.slug || '', title: mod.name || '',
    description: mod.summary || '', body,
    iconUrl: (mod.logo && mod.logo.url) || '', downloads: mod.downloadCount || 0,
    source: links.sourceUrl || links.websiteUrl || null,
    gallery: (mod.screenshots || []).map((g) => ({ url: g.url, title: g.title || '', featured: false })),
  };
}

/* Подобрать файл строго под версию MC и (для модов) forge-лоадер. */
async function fetchFiles(modId, mcVersion, isMod) {
  const params = ['pageSize=50'];
  if (mcVersion && mcVersion !== '-') params.push('gameVersion=' + encodeURIComponent(mcVersion));
  if (isMod) params.push('modLoaderType=' + LOADER_FORGE);
  const data = await dl.fetchJson(API + '/mods/' + encodeURIComponent(modId) + '/files?' + params.join('&'), headers());
  return Array.isArray(data.data) ? data.data : [];
}

function pickFile(files) {
  // CurseForge отдаёт файлы от новых к старым — берём первый с прямой ссылкой
  return files.find((f) => f && f.downloadUrl) || files[0] || null;
}

async function resolveVersion(projectId, mcVersion, isMod) {
  const modId = String(projectId).replace(/[^0-9]/g, '');
  const files = await fetchFiles(modId, mcVersion, isMod);
  const file = pickFile(files);
  if (!file) {
    throw Object.assign(new Error('У проекта нет сборки под версию ' + (mcVersion || 'этого ядра') + ' на CurseForge'), { status: 404 });
  }
  if (!file.downloadUrl) {
    throw Object.assign(new Error('Автор запретил скачивание этого файла через API CurseForge — установите вручную'), { status: 409 });
  }

  // обязательные зависимости — докачиваем рекурсивно (как делает сам CurseForge)
  const deps = [];
  const seen = new Set([String(modId)]);
  async function collect(f, depth) {
    for (const d of (f.dependencies || [])) {
      if (d.relationType !== REL_REQUIRED) continue;
      const depId = String(d.modId);
      if (seen.has(depId)) continue;
      seen.add(depId);
      try {
        const dfiles = await fetchFiles(depId, mcVersion, isMod);
        const df = pickFile(dfiles);
        if (df && df.downloadUrl) {
          deps.push({ url: df.downloadUrl, filename: df.fileName, versionNumber: String(df.id), projectId: depId });
          if (depth < 3) await collect(df, depth + 1);
        }
      } catch (e) { /* зависимость не нашлась под эту версию — пропускаем */ }
    }
  }
  await collect(file, 1);

  return {
    url: file.downloadUrl,
    filename: file.fileName,
    versionNumber: file.displayName || file.fileName,
    gameVersions: file.gameVersions || [],
    loaders: isMod ? ['forge'] : [],
    dependencies: deps,
  };
}

module.exports = { search, projectDetails, resolveVersion };
