'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

global.__controlguiSkipDataInit = true;
const updates = require('../lib/updates')._test;

function apiRequest(url, remote) {
  const { handleApi } = require('../lib/api');
  return new Promise((resolve) => {
    const req = {
      method: 'GET', url,
      cgRemote: !!remote,
      cgUser: remote ? { remote: true, admin: false, perms: {} } : { admin: true, perms: { admin: true } },
    };
    const result = { status: 0, headers: null, body: '' };
    const res = {
      headersSent: false,
      writeHead(status, headers) { result.status = status; result.headers = headers; this.headersSent = true; },
      end(body) { result.body = String(body || ''); resolve(result); },
    };
    handleApi(req, res);
  });
}

test('версии релизов сравниваются численно, а не как строки', () => {
  assert.equal(updates.compareVersions('2.10.0', '2.9.9'), 1);
  assert.equal(updates.compareVersions('v2.4.0', '2.4.0'), 0);
  assert.equal(updates.compareVersions('2.3.9', '2.4.0'), -1);
  assert.equal(updates.compareVersions('не-версия', '2.4.0'), null);
});

test('для каждой оболочки выбирается только ожидаемое имя артефакта', () => {
  assert.equal(updates.expectedAssetName('2.4.0', 'win32', 'x64', {}),
    'CONTROLGUI-2.4.0-windows-setup.exe');
  assert.equal(updates.expectedAssetName('2.4.0', 'darwin', 'arm64', {}),
    'CONTROLGUI-2.4.0-macos-arm64.pkg');
  assert.equal(updates.expectedAssetName('2.4.0', 'linux', 'x64', { APPIMAGE: '/tmp/CONTROLGUI.AppImage' }),
    'CONTROLGUI-2.4.0-x86_64.AppImage');
  assert.equal(updates.expectedAssetName('2.4.0', 'linux', 'arm64', {}),
    'controlgui-2.4.0-linux.tar.gz');
});

test('первичный URL привязан к репозиторию, тегу и имени файла', () => {
  const file = 'CONTROLGUI-2.4.0-windows-setup.exe';
  assert.equal(updates.isAllowedDownloadUrl(
    'https://github.com/AlexFirst404/CONTROLGUI/releases/download/v2.4.0/' + file,
    '2.4.0', file, true), true);
  assert.equal(updates.isAllowedDownloadUrl(
    'https://github.com/other/CONTROLGUI/releases/download/v2.4.0/' + file,
    '2.4.0', file, true), false);
  assert.equal(updates.isAllowedDownloadUrl('http://release-assets.githubusercontent.com/file', '2.4.0', file, false), false);
  assert.equal(updates.isAllowedDownloadUrl('https://evil.example/file', '2.4.0', file, false), false);
  assert.equal(updates.isAllowedDownloadUrl('https://release-assets.githubusercontent.com/file', '2.4.0', file, false), true);
});

test('описание релиза без sha256 отклоняется до скачивания', () => {
  const version = '9.9.9';
  const expected = updates.expectedAssetName(version, process.platform, process.arch, process.env);
  assert.throws(() => updates.normalizeRelease({
    tag_name: 'v' + version,
    draft: false,
    prerelease: false,
    assets: [{
      name: expected,
      size: 42,
      digest: '',
      browser_download_url: 'https://github.com/AlexFirst404/CONTROLGUI/releases/download/v' + version + '/' + expected,
    }],
  }), /SHA-256/);
});

test('API обновлений доступен локально и закрыт через удалённый listener', async () => {
  const local = await apiRequest('/api/update', false);
  assert.equal(local.status, 200);
  assert.equal(JSON.parse(local.body).currentVersion, '2.4.1');

  const remote = await apiRequest('/api/update', true);
  assert.equal(remote.status, 403);
  assert.match(JSON.parse(remote.body).error, /только на этом компьютере/i);
});
