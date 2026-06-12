'use strict';

/* Тонкий клиент REST API панели. */

window.API = (function () {
  async function call(method, url, body) {
    let res;
    try {
      res = await fetch(url, {
        method: method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new Error('Нет связи с панелью. Проверьте, что server.js запущен.');
    }
    let data = {};
    try { data = await res.json(); } catch (e) { /* пустой ответ */ }
    if (!res.ok) throw new Error(data.error || ('Ошибка HTTP ' + res.status));
    return data;
  }

  async function upload(id, relPath, file) {
    let res;
    try {
      res = await fetch('/api/servers/' + id + '/file-upload?path=' + encodeURIComponent(relPath), {
        method: 'PUT',
        body: file,
      });
    } catch (e) {
      throw new Error('Загрузка прервалась: ' + e.message);
    }
    let data = {};
    try { data = await res.json(); } catch (e) { /* пустой ответ */ }
    if (!res.ok) throw new Error(data.error || ('Ошибка HTTP ' + res.status));
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
    consoleStream: (id) => new EventSource('/api/servers/' + id + '/console'),
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

    me: () => call('GET', '/api/auth/me'),
    logout: () => call('POST', '/api/auth/logout'),
    usersList: () => call('GET', '/api/users'),
    userCreate: (body) => call('POST', '/api/users', body),
    userUpdate: (name, body) => call('PUT', '/api/users/' + encodeURIComponent(name), body),
    userDelete: (name) => call('DELETE', '/api/users/' + encodeURIComponent(name)),

    backups: (id) => call('GET', '/api/servers/' + id + '/backups'),
    backupCreate: (id, label) => call('POST', '/api/servers/' + id + '/backups', { label: label }),
    backupDelete: (id, name) => call('DELETE', '/api/servers/' + id + '/backup?name=' + encodeURIComponent(name)),
    backupRestore: (id, name) => call('POST', '/api/servers/' + id + '/backup?name=' + encodeURIComponent(name)),
    backupDownloadUrl: (id, name) => '/api/servers/' + id + '/backup?name=' + encodeURIComponent(name),
  };
})();
