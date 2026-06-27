'use strict';

/* Тонкий клиент REST API панели. */

window.API = (function () {
  // База API. Локально пусто (тот же origin). На центральном сайте удалённого управления
  // выставляется window.CG_API_BASE = '/r/<globalId>' — и все запросы идут через прокси-туннель.
  function B(p) { return (window.CG_API_BASE || '') + p; }

  async function call(method, url, body) {
    let res;
    try {
      res = await fetch(B(url), {
        method: method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new Error('Нет связи с панелью. Проверьте, что server.js запущен.');
    }
    let data = {};
    try { data = await res.json(); } catch (e) { /* пустой ответ */ }
    if (!res.ok) { const err = new Error(data.error || ('Ошибка HTTP ' + res.status)); err.status = res.status; throw err; }
    return data;
  }

  async function upload(id, relPath, file) {
    let res;
    try {
      res = await fetch(B('/api/servers/' + id + '/file-upload?path=' + encodeURIComponent(relPath)), {
        method: 'PUT',
        body: file,
      });
    } catch (e) {
      throw new Error('Загрузка прервалась: ' + e.message);
    }
    let data = {};
    try { data = await res.json(); } catch (e) { /* пустой ответ */ }
    if (!res.ok) { const err = new Error(data.error || ('Ошибка HTTP ' + res.status)); err.status = res.status; throw err; }
    return data;
  }

  return {
    status: () => call('GET', '/api/status'),
    versions: (type) => call('GET', '/api/versions/' + type),
    servers: () => call('GET', '/api/servers'),
    server: (id) => call('GET', '/api/servers/' + id),
    create: (body) => call('POST', '/api/servers', body),
    remove: (id) => call('DELETE', '/api/servers/' + id),
    start: (id) => call('POST', '/api/servers/' + id + '/start'),
    stop: (id) => call('POST', '/api/servers/' + id + '/stop'),
    kill: (id) => call('POST', '/api/servers/' + id + '/kill'),
    restart: (id) => call('POST', '/api/servers/' + id + '/restart'),
    download: (id) => call('POST', '/api/servers/' + id + '/download'),
    command: (id, command) => call('POST', '/api/servers/' + id + '/command', { command: command }),
    properties: (id) => call('GET', '/api/servers/' + id + '/properties'),
    saveProperties: (id, body) => call('PUT', '/api/servers/' + id + '/properties', body),
    remoteGet: (id) => call('GET', '/api/servers/' + id + '/remote'),
    remoteSet: (id, enabled) => call('POST', '/api/servers/' + id + '/remote', { enabled: enabled }),
    remoteRegenerate: (id) => call('POST', '/api/servers/' + id + '/remote/regenerate'),
    consoleStream: (id) => new EventSource(B('/api/servers/' + id + '/console')),
    stats: (id) => call('GET', '/api/servers/' + id + '/stats'),
    player: (id, name) => call('GET', '/api/servers/' + id + '/player?name=' + encodeURIComponent(name)),
    whitelist: (id) => call('GET', '/api/servers/' + id + '/whitelist'),
    whitelistChange: (id, action, name) => call('POST', '/api/servers/' + id + '/whitelist', { action: action, name: name }),
    moderate: (id, action, name) => call('POST', '/api/servers/' + id + '/moderate', { action: action, name: name }),
    playerDelete: (id, name) => call('DELETE', '/api/servers/' + id + '/player?name=' + encodeURIComponent(name)),
    files: (id, path) => call('GET', '/api/servers/' + id + '/files?path=' + encodeURIComponent(path || '')),
    fileGet: (id, path) => call('GET', '/api/servers/' + id + '/file?path=' + encodeURIComponent(path)),
    fileSave: (id, path, content) => call('PUT', '/api/servers/' + id + '/file', { path: path, content: content }),
    fileDelete: (id, path) => call('DELETE', '/api/servers/' + id + '/file?path=' + encodeURIComponent(path)),
    filesCreate: (id, path, type) => call('POST', '/api/servers/' + id + '/files-create', { path: path, type: type }),
    filesRename: (id, from, to) => call('POST', '/api/servers/' + id + '/files-rename', { from: from, to: to }),
    upload: upload,

    launchMode: () => call('GET', '/api/launch-mode'),
    setLaunchMode: (mode) => call('POST', '/api/launch-mode', { mode: mode }),
    trayMinimize: () => call('GET', '/api/tray-minimize'),
    setTrayMinimize: (enabled) => call('POST', '/api/tray-minimize', { enabled: enabled }),

    javaInstall: (major) => call('POST', '/api/java/install', { major: major }),
    javaInstallState: () => call('GET', '/api/java/install'),

    browse: (path) => call('GET', '/api/browse?path=' + encodeURIComponent(path || '')),

    me: () => call('GET', '/api/auth/me'),
    logout: () => call('POST', '/api/auth/logout'),

    // аккаунт центрального сервера (удалённые серверы в десктопе)
    centralState: () => call('GET', '/api/central'),
    centralLogin: (username, password) => call('POST', '/api/central/login', { username: username, password: password }),
    centralRegister: (username, password) => call('POST', '/api/central/register', { username: username, password: password }),
    centralLogout: () => call('POST', '/api/central/logout'),
    centralLink: (code) => call('POST', '/api/central/link', { code: code }),
    centralMe: () => call('GET', '/api/central/me'),
    centralRename: (newName) => call('POST', '/api/central/rename', { newName: newName }),
    centralDiscordLink: () => call('POST', '/api/central/discord/link'),
    centralDiscordUnlink: () => call('POST', '/api/central/discord/unlink'),
    usersList: () => call('GET', '/api/users'),
    userCreate: (body) => call('POST', '/api/users', body),
    userUpdate: (name, body) => call('PUT', '/api/users/' + encodeURIComponent(name), body),
    userDelete: (name) => call('DELETE', '/api/users/' + encodeURIComponent(name)),

    backups: (id) => call('GET', '/api/servers/' + id + '/backups'),
    backupCreate: (id, label) => call('POST', '/api/servers/' + id + '/backups', { label: label }),
    backupDelete: (id, name) => call('DELETE', '/api/servers/' + id + '/backup?name=' + encodeURIComponent(name)),
    backupRestore: (id, name) => call('POST', '/api/servers/' + id + '/backup?name=' + encodeURIComponent(name)),
    backupDownloadUrl: (id, name) => B('/api/servers/' + id + '/backup?name=' + encodeURIComponent(name)),

    logs: (id) => call('GET', '/api/servers/' + id + '/logs'),
    log: (id, name) => call('GET', '/api/servers/' + id + '/log?name=' + encodeURIComponent(name)),

    iconUpload: async (id, blob) => {
      let res;
      try { res = await fetch(B('/api/servers/' + id + '/icon'), { method: 'PUT', body: blob }); }
      catch (e) { throw new Error('Загрузка иконки прервалась: ' + e.message); }
      let data = {};
      try { data = await res.json(); } catch (e) { /* пусто */ }
      if (!res.ok) throw new Error(data.error || ('Ошибка HTTP ' + res.status));
      return data;
    },
    iconDelete: (id) => call('DELETE', '/api/servers/' + id + '/icon'),
    iconUrl: (id, mtime) => B('/api/servers/' + id + '/icon?t=' + (mtime || 0)),

    pluginsList: (id) => call('GET', '/api/servers/' + id + '/plugins'),
    pluginsSearch: (id, opts) => {
      opts = opts || {};
      const qs = 'q=' + encodeURIComponent(opts.q || '') +
        '&category=' + encodeURIComponent(opts.category || '') +
        '&sort=' + encodeURIComponent(opts.sort || 'relevance') +
        '&offset=' + (opts.offset || 0);
      return call('GET', '/api/servers/' + id + '/plugins/search?' + qs);
    },
    pluginInstall: (id, projectId) => call('POST', '/api/servers/' + id + '/plugins/install', { projectId: projectId }),
    pluginDelete: (id, file) => call('DELETE', '/api/servers/' + id + '/plugins?file=' + encodeURIComponent(file)),
    pluginToggle: (id, file) => call('POST', '/api/servers/' + id + '/plugins/toggle', { file: file }),

    modsList: (id) => call('GET', '/api/servers/' + id + '/mods'),
    modsSearch: (id, opts) => {
      opts = opts || {};
      const qs = 'q=' + encodeURIComponent(opts.q || '') +
        '&category=' + encodeURIComponent(opts.category || '') +
        '&sort=' + encodeURIComponent(opts.sort || 'relevance') +
        '&offset=' + (opts.offset || 0);
      return call('GET', '/api/servers/' + id + '/mods/search?' + qs);
    },
    modInstall: (id, projectId) => call('POST', '/api/servers/' + id + '/mods/install', { projectId: projectId }),
    modDelete: (id, file) => call('DELETE', '/api/servers/' + id + '/mods?file=' + encodeURIComponent(file)),
    modToggle: (id, file) => call('POST', '/api/servers/' + id + '/mods/toggle', { file: file }),

    resourcePack: (id) => call('GET', '/api/servers/' + id + '/resourcepack'),
    resourcePackDelete: (id) => call('DELETE', '/api/servers/' + id + '/resourcepack'),
    resourcePackUpload: async (id, file, required) => {
      let res;
      try { res = await fetch(B('/api/servers/' + id + '/resourcepack?required=' + (required ? 'true' : 'false')), { method: 'PUT', body: file }); }
      catch (e) { throw new Error('Загрузка текстурпака прервалась: ' + e.message); }
      let data = {};
      try { data = await res.json(); } catch (e) { /* пусто */ }
      if (!res.ok) throw new Error(data.error || ('Ошибка HTTP ' + res.status));
      return data;
    },

    coreUpload: async (id, file) => {
      let res;
      try { res = await fetch(B('/api/servers/' + id + '/core'), { method: 'PUT', body: file }); }
      catch (e) { throw new Error('Загрузка ядра прервалась: ' + e.message); }
      let data = {};
      try { data = await res.json(); } catch (e) { /* пусто */ }
      if (!res.ok) throw new Error(data.error || ('Ошибка HTTP ' + res.status));
      return data;
    },
  };
})();
