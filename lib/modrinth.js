'use strict';
const dl = require('./download');

/* Поиск и установка плагинов с Modrinth (api.modrinth.com).
   Сетевые запросы идут через download.js (там корректный User-Agent). */

const API = 'https://api.modrinth.com/v2';

// какие лоадеры ПЛАГИНОВ совместимы с конкретным ядром
const LOADERS_BY_TYPE = {
  paper: ['paper', 'spigot', 'bukkit', 'folia', 'purpur'],
  purpur: ['purpur', 'paper', 'spigot', 'bukkit'],
  folia: ['folia', 'paper', 'spigot', 'bukkit'],
  mohist: ['paper', 'spigot', 'bukkit'],
};

// какие лоадеры МОДОВ совместимы с ядром (Forge и Mohist грузят forge-моды)
const MOD_LOADERS_BY_TYPE = {
  forge: ['forge'],
  mohist: ['forge'],
};

function supportsPlugins(type) {
  return Object.prototype.hasOwnProperty.call(LOADERS_BY_TYPE, type);
}

function supportsMods(type) {
  return Object.prototype.hasOwnProperty.call(MOD_LOADERS_BY_TYPE, type);
}

function loadersFor(type) {
  return LOADERS_BY_TYPE[type] || ['paper', 'spigot', 'bukkit'];
}

function modLoadersFor(type) {
  return MOD_LOADERS_BY_TYPE[type] || ['forge'];
}

const SORTS = ['relevance', 'downloads', 'follows', 'newest', 'updated'];
const LOADER_TAGS = ['paper', 'spigot', 'bukkit', 'folia', 'purpur', 'fabric', 'forge', 'neoforge', 'velocity', 'bungeecord', 'sponge', 'waterfall'];

/* Поиск/листание плагинов. opts: { query, mcVersion, loaders, category, sort, offset, limit }.
   Возвращает { hits, total, offset, limit } — для пагинации и фильтров. */
async function search(opts) {
  opts = opts || {};
  const limit = Math.min(50, Math.max(1, parseInt(opts.limit, 10) || 20));
  const offset = Math.max(0, parseInt(opts.offset, 10) || 0);
  const sort = SORTS.indexOf(opts.sort) >= 0 ? opts.sort : 'relevance';
  const projectType = opts.projectType === 'mod' ? 'mod' : 'plugin';
  const facets = [['project_type:' + projectType]];
  if (opts.mcVersion && opts.mcVersion !== '-') facets.push(['versions:' + opts.mcVersion]);
  if (opts.loaders && opts.loaders.length) facets.push(opts.loaders.map((l) => 'categories:' + l));
  if (opts.category && /^[a-z0-9\-]+$/.test(opts.category)) facets.push(['categories:' + opts.category]);
  const url = API + '/search?limit=' + limit + '&offset=' + offset + '&index=' + sort
    + '&query=' + encodeURIComponent(opts.query || '')
    + '&facets=' + encodeURIComponent(JSON.stringify(facets));
  const data = await dl.fetchJson(url);
  return {
    hits: (data.hits || []).map((h) => ({
      projectId: h.project_id,
      slug: h.slug,
      title: h.title,
      description: h.description,
      author: h.author,
      downloads: h.downloads,
      iconUrl: h.icon_url || '',
      categories: (h.display_categories || []).filter((c) => LOADER_TAGS.indexOf(c) < 0),
    })),
    total: data.total_hits || 0,
    offset: data.offset != null ? data.offset : offset,
    limit: data.limit != null ? data.limit : limit,
  };
}

/* Полное описание проекта для модалки: тело (markdown) + галерея картинок. */
async function projectDetails(id) {
  const safe = String(id || '').replace(/[^A-Za-z0-9_.\-]/g, '');
  if (!safe) return null;
  let data;
  try { data = await dl.fetchJson(API + '/project/' + safe); } catch (e) { return null; }
  if (!data || !data.id) return null;
  return {
    projectId: data.id, slug: data.slug, title: data.title,
    description: data.description || '', body: data.body || '',
    iconUrl: data.icon_url || '', downloads: data.downloads || 0,
    source: data.source_url || null,
    gallery: (data.gallery || []).map((g) => ({ url: g.url, title: g.title || '', featured: !!g.featured }))
      .sort((a, b) => (b.featured ? 1 : 0) - (a.featured ? 1 : 0)),
  };
}

/* Подобрать версию плагина строго под версию MC и совместимый лоадер.
   Modrinth возвращает версии от новых к старым — берём первую подходящую. */
async function fetchProjectVersion(projectId, mcVersion, loaders) {
  const params = [];
  if (loaders && loaders.length) params.push('loaders=' + encodeURIComponent(JSON.stringify(loaders)));
  if (mcVersion && mcVersion !== '-') params.push('game_versions=' + encodeURIComponent(JSON.stringify([mcVersion])));
  const url = API + '/project/' + encodeURIComponent(projectId) + '/version' + (params.length ? '?' + params.join('&') : '');
  const versions = await dl.fetchJson(url);
  return Array.isArray(versions) && versions.length ? versions[0] : null;
}

function fileOf(ver) {
  const f = (ver.files || []).find((x) => x.primary) || (ver.files || [])[0];
  return f && f.url ? { url: f.url, filename: f.filename } : null;
}

async function resolveVersion(projectId, mcVersion, loaders) {
  const ver = await fetchProjectVersion(projectId, mcVersion, loaders);
  if (!ver) {
    throw Object.assign(new Error('У плагина нет сборки под версию ' + (mcVersion || 'этого ядра') + ' и его лоадер'), { status: 404 });
  }
  const file = fileOf(ver);
  if (!file) throw Object.assign(new Error('У версии плагина нет файла для скачивания'), { status: 404 });

  // обязательные зависимости (библиотеки) — докачиваем, как делает сам Modrinth
  const deps = [];
  const seen = new Set([ver.project_id]);
  async function collect(v, depth) {
    for (const d of (v.dependencies || [])) {
      if (d.dependency_type !== 'required') continue;
      try {
        let dv = d.version_id ? await dl.fetchJson(API + '/version/' + encodeURIComponent(d.version_id)) : null;
        if (!dv && d.project_id) dv = await fetchProjectVersion(d.project_id, mcVersion, loaders);
        if (!dv || seen.has(dv.project_id)) continue;
        seen.add(dv.project_id);
        const df = fileOf(dv);
        if (df) deps.push({ url: df.url, filename: df.filename, versionNumber: dv.version_number, projectId: dv.project_id });
        if (depth < 3) await collect(dv, depth + 1);
      } catch (e) { /* зависимость не нашлась под эту версию — пропускаем */ }
    }
  }
  await collect(ver, 1);

  return {
    url: file.url,
    filename: file.filename,
    versionNumber: ver.version_number,
    gameVersions: ver.game_versions || [],
    loaders: ver.loaders || [],
    dependencies: deps,
  };
}

module.exports = { search, projectDetails, resolveVersion, supportsPlugins, supportsMods, loadersFor, modLoadersFor };
