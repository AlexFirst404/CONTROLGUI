'use strict';
const dl = require('./download');

/* Поиск и установка плагинов с Modrinth (api.modrinth.com).
   Сетевые запросы идут через download.js (там корректный User-Agent). */

const API = 'https://api.modrinth.com/v2';

// какие лоадеры плагинов совместимы с конкретным ядром
const LOADERS_BY_TYPE = {
  paper: ['paper', 'spigot', 'bukkit', 'folia', 'purpur'],
  purpur: ['purpur', 'paper', 'spigot', 'bukkit'],
  folia: ['folia', 'paper', 'spigot', 'bukkit'],
  mohist: ['paper', 'spigot', 'bukkit'],
};

function supportsPlugins(type) {
  return Object.prototype.hasOwnProperty.call(LOADERS_BY_TYPE, type);
}

function loadersFor(type) {
  return LOADERS_BY_TYPE[type] || ['paper', 'spigot', 'bukkit'];
}

async function search(query, mcVersion, loaders) {
  const facets = [['project_type:plugin']];
  if (mcVersion && mcVersion !== '-') facets.push(['versions:' + mcVersion]);
  if (loaders && loaders.length) facets.push(loaders.map((l) => 'categories:' + l));
  const url = API + '/search?limit=20&index=relevance'
    + '&query=' + encodeURIComponent(query || '')
    + '&facets=' + encodeURIComponent(JSON.stringify(facets));
  const data = await dl.fetchJson(url);
  return (data.hits || []).map((h) => ({
    projectId: h.project_id,
    slug: h.slug,
    title: h.title,
    description: h.description,
    author: h.author,
    downloads: h.downloads,
    iconUrl: h.icon_url || '',
    categories: (h.display_categories || []).filter((c) => loadersFor('paper').concat(['fabric', 'forge', 'neoforge', 'velocity', 'bungeecord', 'sponge', 'waterfall']).indexOf(c) >= 0),
  }));
}

/* Подобрать версию плагина строго под версию MC и совместимый лоадер.
   Modrinth возвращает версии от новых к старым — берём первую подходящую. */
async function resolveVersion(projectId, mcVersion, loaders) {
  const params = [];
  if (loaders && loaders.length) params.push('loaders=' + encodeURIComponent(JSON.stringify(loaders)));
  if (mcVersion && mcVersion !== '-') params.push('game_versions=' + encodeURIComponent(JSON.stringify([mcVersion])));
  const url = API + '/project/' + encodeURIComponent(projectId) + '/version' + (params.length ? '?' + params.join('&') : '');
  const versions = await dl.fetchJson(url);
  if (!Array.isArray(versions) || !versions.length) {
    throw Object.assign(new Error('У плагина нет сборки под версию ' + (mcVersion || 'этого ядра') + ' и его лоадер'), { status: 404 });
  }
  const ver = versions[0];
  const file = (ver.files || []).find((f) => f.primary) || (ver.files || [])[0];
  if (!file || !file.url) throw Object.assign(new Error('У версии плагина нет файла для скачивания'), { status: 404 });
  return {
    url: file.url,
    filename: file.filename,
    versionNumber: ver.version_number,
    gameVersions: ver.game_versions || [],
    loaders: ver.loaders || [],
  };
}

module.exports = { search, resolveVersion, supportsPlugins, loadersFor };
