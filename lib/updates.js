'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');

const VERSION = require('./version');
const { DATA_DIR, ROOT } = require('./paths');

const REPOSITORY = 'AlexFirst404/CONTROLGUI';
const RELEASE_API = 'https://api.github.com/repos/' + REPOSITORY + '/releases/latest';
const UPDATE_DIR = path.join(DATA_DIR, 'updates');
const PREFS_FILE = path.join(DATA_DIR, 'update-state.json');
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_ASSET_BYTES = 1024 * 1024 * 1024;
const CHECK_CACHE_MS = 30 * 60 * 1000;
const TRANSIENT_CODES = new Set(['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ERR_STREAM_PREMATURE_CLOSE']);
const TRANSIENT_HTTP = new Set([429, 502, 503, 504]);

let runtime = {
  phase: 'idle',
  checkedAt: 0,
  release: null,
  asset: null,
  downloadedBytes: 0,
  totalBytes: 0,
  file: '',
  error: '',
};
let checkPromise = null;
let downloadPromise = null;
let installPromise = null;

function parseVersion(value) {
  const match = String(value || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/i);
  return match ? match.slice(1, 4).map((part) => Number(part)) : null;
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), '.' + path.basename(file) + '.' + process.pid + '.' +
    crypto.randomBytes(6).toString('hex') + '.tmp');
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch (removeError) { /* временный файл мог не появиться */ }
    throw error;
  }
}

function readPrefs() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) { return {}; }
}

function expectedAssetName(version, platform, arch, env, root) {
  const v = String(version || '');
  if (!parseVersion(v)) return null;
  if (platform === 'win32') return 'CONTROLGUI-' + v + '-windows-setup.exe';
  if (platform === 'darwin') {
    const macArch = arch === 'arm64' ? 'arm64' : 'x64';
    return 'CONTROLGUI-' + v + '-macos-' + macArch + '.pkg';
  }
  if (platform !== 'linux') return null;
  if (env && env.APPIMAGE && arch === 'x64') return 'CONTROLGUI-' + v + '-x86_64.AppImage';
  // Пакет .deb обновляется штатным пакетным менеджером. Для установки из
  // tarball/репозитория выбираем переносимый архив, не притворяясь .deb-пакетом.
  if (path.resolve(String(root || '')) === '/opt/controlgui' && fs.existsSync('/var/lib/dpkg/info/controlgui.list')) {
    return 'controlgui_' + v + '_all.deb';
  }
  return 'controlgui-' + v + '-linux.tar.gz';
}

function assetInstallMode(assetName, platform, env) {
  if (!assetName) return 'none';
  if (platform === 'win32' && /-windows-setup\.exe$/i.test(assetName)) return 'installer';
  if (platform === 'darwin' && /\.pkg$/i.test(assetName)) return 'open';
  // Повышать права из браузерной панели нельзя: между проверкой и `dpkg` иначе
  // появляется TOCTOU. Проверенный .deb отдаём пользователю для `sudo dpkg -i`.
  if (platform === 'linux' && /\.deb$/i.test(assetName)) return 'manual';
  // Простого запуска второй копии недостаточно: ярлык продолжит указывать на
  // старый AppImage. До отдельной атомарной замены отдаём проверенный файл вручную.
  if (platform === 'linux' && /\.AppImage$/i.test(assetName) && env && env.APPIMAGE) return 'manual';
  return 'manual';
}

function normalizeRelease(data) {
  if (!data || data.draft || data.prerelease) throw new Error('Последний релиз ещё не опубликован как стабильный');
  const version = String(data.tag_name || '').replace(/^v/i, '');
  if (!parseVersion(version)) throw new Error('У релиза некорректная версия');
  const expected = expectedAssetName(version, process.platform, process.arch, process.env, ROOT);
  const source = Array.isArray(data.assets) ? data.assets.find((item) => item && item.name === expected) : null;
  let asset = null;
  if (source) {
    const digest = String(source.digest || '').toLowerCase();
    const size = Number(source.size || 0);
    const downloadUrl = String(source.browser_download_url || '');
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error('GitHub не предоставил SHA-256 выбранного файла обновления');
    if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_ASSET_BYTES) throw new Error('Некорректный размер файла обновления');
    if (!isAllowedDownloadUrl(downloadUrl, version, expected, true)) throw new Error('GitHub вернул неожиданный адрес файла обновления');
    asset = { name: expected, size, digest, url: downloadUrl };
  }
  return {
    version,
    name: String(data.name || ('CONTROLGUI ' + version)).slice(0, 180),
    notes: String(data.body || '').slice(0, 12000),
    publishedAt: data.published_at || '',
    // Ссылку не берём из JSON как произвольную строку: интерфейс сможет открыть
    // только страницу релиза именно нашего репозитория.
    pageUrl: 'https://github.com/' + REPOSITORY + '/releases/tag/v' + version,
    asset,
  };
}

function isAllowedDownloadUrl(value, version, fileName, initial) {
  let url;
  try { url = new URL(value); } catch (error) { return false; }
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  if (initial) {
    const expectedPath = '/' + REPOSITORY + '/releases/download/v' + version + '/' + encodeURIComponent(fileName);
    if (host !== 'github.com') return false;
    if (url.pathname === expectedPath) return true;
    try { return decodeURIComponent(url.pathname) === decodeURIComponent(expectedPath); }
    catch (error) { return false; }
  }
  return host === 'release-assets.githubusercontent.com' || host === 'objects.githubusercontent.com' ||
    host === 'github-releases.githubusercontent.com';
}

function requestStream(urlValue, options, redirects) {
  const opts = options || {};
  const remaining = redirects == null ? 5 : redirects;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error); else resolve(value);
    };
    const req = https.get(urlValue, {
      headers: {
        Accept: opts.accept || 'application/octet-stream',
        'User-Agent': 'CONTROLGUI-MinecraftPanel/' + VERSION + ' (+https://github.com/' + REPOSITORY + ')',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    }, (res) => {
      res.setTimeout(30000, () => res.destroy(Object.assign(new Error('Загрузка с GitHub перестала отвечать'), { code: 'ETIMEDOUT' })));
      const code = Number(res.statusCode || 0);
      if (code >= 300 && code < 400 && res.headers.location && remaining > 0) {
        res.resume();
        let next;
        try {
          next = new URL(res.headers.location, urlValue).toString();
          if (typeof opts.allowRedirect !== 'function' || !opts.allowRedirect(next)) {
            return finish(new Error('GitHub перенаправил загрузку на недоверенный адрес'));
          }
        } catch (error) {
          return finish(new Error('GitHub вернул некорректное перенаправление'));
        }
        requestStream(next, opts, remaining - 1).then((value) => finish(null, value), (error) => finish(error));
        return;
      }
      if (code !== 200) {
        res.resume();
        return finish(Object.assign(new Error('GitHub вернул HTTP ' + code), { statusCode: code }));
      }
      finish(null, res);
    });
    req.setTimeout(30000, () => req.destroy(Object.assign(new Error('Таймаут соединения с GitHub'), { code: 'ETIMEDOUT' })));
    req.on('error', (error) => finish(error));
  });
}

async function requestWithRetry(urlValue, options) {
  try { return await requestStream(urlValue, options, 5); }
  catch (error) {
    if (!isTransientError(error)) throw error;
    await wait(250);
    return requestStream(urlValue, options, 5);
  }
}

function isTransientError(error) {
  return TRANSIENT_CODES.has(String(error && error.code || '').toUpperCase()) ||
    TRANSIENT_HTTP.has(Number(error && error.statusCode || 0));
}

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function fetchLatestReleaseOnce() {
  const res = await requestWithRetry(RELEASE_API, {
    accept: 'application/vnd.github+json',
    allowRedirect: () => false,
  });
  const chunks = [];
  let size = 0;
  for await (const chunk of res) {
    size += chunk.length;
    if (size > MAX_METADATA_BYTES) {
      res.destroy();
      throw new Error('Ответ GitHub со сведениями о релизе слишком большой');
    }
    chunks.push(chunk);
  }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch (error) { throw new Error('GitHub вернул некорректное описание релиза'); }
  return normalizeRelease(data);
}

async function fetchLatestRelease() {
  try { return await fetchLatestReleaseOnce(); }
  catch (error) {
    // requestWithRetry покрывает соединение до заголовков; этот повтор также
    // восстанавливает оборванное чтение JSON после уже полученного HTTP 200.
    if (!isTransientError(error)) throw error;
    await wait(250);
    return fetchLatestReleaseOnce();
  }
}

function publicState() {
  const release = runtime.release;
  const cmp = release ? compareVersions(release.version, VERSION) : null;
  const asset = runtime.asset;
  const prefs = readPrefs();
  const total = Number(runtime.totalBytes || (asset && asset.size) || 0);
  const done = Number(runtime.downloadedBytes || 0);
  return {
    currentVersion: VERSION,
    phase: runtime.phase,
    checkedAt: runtime.checkedAt ? new Date(runtime.checkedAt).toISOString() : null,
    available: cmp === 1,
    canDownload: cmp === 1 && !!asset,
    latestVersion: release ? release.version : null,
    releaseName: release ? release.name : '',
    notes: release ? release.notes : '',
    publishedAt: release ? release.publishedAt : '',
    pageUrl: release ? release.pageUrl : '',
    dismissed: !!(release && prefs.dismissedVersion === release.version),
    asset: asset ? { name: asset.name, size: asset.size } : null,
    installMode: assetInstallMode(asset && asset.name, process.platform, process.env),
    downloadedBytes: done,
    totalBytes: total,
    progress: total > 0 ? Math.max(0, Math.min(1, done / total)) : 0,
    downloaded: !!runtime.file,
    error: runtime.error || '',
  };
}

async function check(force) {
  // Проверка не должна сбрасывать release/file посреди скачивания или запуска
  // установщика. UI получит текущее состояние и продолжит polling.
  if (downloadPromise || installPromise || runtime.phase === 'launching' || runtime.phase === 'installing') return publicState();
  if (checkPromise) return checkPromise;
  if (!force && runtime.checkedAt && Date.now() - runtime.checkedAt < CHECK_CACHE_MS && runtime.release) return publicState();
  const previousPhase = runtime.phase;
  runtime.phase = 'checking';
  runtime.error = '';
  checkPromise = (async () => {
    try {
      const release = await fetchLatestRelease();
      runtime.release = release;
      runtime.asset = release.asset;
      runtime.checkedAt = Date.now();
      runtime.downloadedBytes = 0;
      runtime.totalBytes = release.asset ? release.asset.size : 0;
      runtime.file = '';
      const cmp = compareVersions(release.version, VERSION);
      if (cmp === 1 && !release.asset) throw new Error('Для этой системы в релизе нет подходящего файла');
      runtime.phase = cmp === 1 ? 'available' : 'idle';
      return publicState();
    } catch (error) {
      runtime.checkedAt = Date.now();
      runtime.phase = previousPhase === 'downloaded' ? previousPhase : 'error';
      runtime.error = error.message || String(error);
      throw error;
    } finally { checkPromise = null; }
  })();
  return checkPromise;
}

async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(file);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

async function verifiedExisting(file, asset) {
  try {
    if (fs.statSync(file).size !== asset.size) return false;
    return await hashFile(file) === asset.digest.slice('sha256:'.length);
  } catch (error) { return false; }
}

function cleanupUpdateFiles(keepName) {
  const official = /^(?:CONTROLGUI-\d+\.\d+\.\d+-(?:windows-setup\.exe|macos-(?:arm64|x64)\.pkg|x86_64\.AppImage)|controlgui(?:-\d+\.\d+\.\d+-linux\.tar\.gz|_\d+\.\d+\.\d+_all\.deb))$/;
  const staleBefore = Date.now() - 24 * 60 * 60 * 1000;
  let names = [];
  try { names = fs.readdirSync(UPDATE_DIR); } catch (error) { return; }
  for (const name of names) {
    if (name === keepName) continue;
    const file = path.join(UPDATE_DIR, name);
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) continue;
      const stalePart = /^\.(?:CONTROLGUI|controlgui)[-_].+\.part$/.test(name) && stat.mtimeMs < staleBefore;
      if (official.test(name) || stalePart) fs.rmSync(file, { force: true });
    } catch (error) { /* очистка кэша не мешает самому обновлению */ }
  }
}

function download() {
  if (downloadPromise) return downloadPromise;
  if (checkPromise || runtime.phase === 'checking') {
    throw Object.assign(new Error('Дождитесь завершения проверки обновлений'), { status: 409 });
  }
  if (installPromise || runtime.phase === 'launching' || runtime.phase === 'installing') {
    throw Object.assign(new Error('Установщик обновления уже запускается'), { status: 409 });
  }
  if (runtime.release && compareVersions(runtime.release.version, VERSION) !== 1) {
    throw Object.assign(new Error('Новых обновлений нет'), { status: 409 });
  }
  if (runtime.release && !runtime.asset) {
    throw Object.assign(new Error('Для этой системы в релизе нет подходящего файла'), { status: 409 });
  }
  // Первое нажатие после запуска может прийти до фоновой проверки. Запускаем её
  // до установки downloadPromise, иначе check() справедливо увидит активную
  // загрузку и вернёт текущее пустое состояние вместо обращения к GitHub.
  const prepared = runtime.release ? Promise.resolve() : check(true);
  downloadPromise = prepared.then(() => performDownload()).finally(() => { downloadPromise = null; });
  return downloadPromise;
}

async function performDownload() {
  try {
    if (!runtime.release || compareVersions(runtime.release.version, VERSION) !== 1) await check(true);
    const asset = runtime.asset;
    if (!asset || compareVersions(runtime.release.version, VERSION) !== 1) throw new Error('Новых обновлений нет');
    fs.mkdirSync(UPDATE_DIR, { recursive: true });
    const dest = path.join(UPDATE_DIR, asset.name);
    // Удаляем старые официальные пакеты и давно брошенные части до новой попытки,
    // чтобы аварийно завершившаяся загрузка не засоряла каталог навсегда.
    cleanupUpdateFiles(asset.name);
    runtime.phase = 'downloading';
    runtime.error = '';
    runtime.downloadedBytes = 0;
    runtime.totalBytes = asset.size;
    if (await verifiedExisting(dest, asset)) {
      if (/\.AppImage$/i.test(asset.name)) fs.chmodSync(dest, 0o700);
      runtime.downloadedBytes = asset.size;
      runtime.file = dest;
      runtime.phase = 'downloaded';
      cleanupUpdateFiles(asset.name);
      return publicState();
    }
    try { fs.rmSync(dest, { force: true }); } catch (error) { /* файл мог отсутствовать */ }
    let completed = false;
    let lastError = null;
    for (let attempt = 0; attempt < 2 && !completed; attempt++) {
      // Каждая попытка пишет в свой файл: Windows может ещё кратко удерживать
      // дескриптор оборванного потока, и это не должно ломать повтор через flags=wx.
      const tmp = path.join(UPDATE_DIR, '.' + asset.name + '.' + process.pid + '.' +
        crypto.randomBytes(6).toString('hex') + '.part');
      try {
        runtime.downloadedBytes = 0;
        const res = await requestWithRetry(asset.url, {
          allowRedirect: (next) => isAllowedDownloadUrl(next, runtime.release.version, asset.name, false),
        });
        const hash = crypto.createHash('sha256');
        let done = 0;
        const meter = new Transform({
          transform(chunk, encoding, callback) {
            done += chunk.length;
            if (done > asset.size || done > MAX_ASSET_BYTES) {
              callback(new Error('Файл обновления оказался больше заявленного размера'));
              return;
            }
            hash.update(chunk);
            runtime.downloadedBytes = done;
            callback(null, chunk);
          },
        });
        const out = fs.createWriteStream(tmp, { flags: 'wx', mode: 0o600 });
        await pipeline(res, meter, out);
        // pipeline дожидается штатного завершения цепочки; close проверяем явно,
        // прежде чем rename/rm коснутся файла на Windows.
        if (!out.closed) await new Promise((resolve, reject) => {
          out.once('close', resolve);
          out.once('error', reject);
        });
        if (done !== asset.size) throw Object.assign(new Error('Размер скачанного обновления не совпал с данными GitHub'), { code: 'ECONNRESET' });
        const actual = hash.digest('hex');
        if (actual !== asset.digest.slice('sha256:'.length)) throw new Error('SHA-256 обновления не совпал — файл удалён');
        fs.renameSync(tmp, dest);
        if (/\.AppImage$/i.test(asset.name)) fs.chmodSync(dest, 0o700);
        completed = true;
      } catch (error) {
        lastError = error;
        try { await fs.promises.rm(tmp, { force: true }); } catch (removeError) { /* очистка best-effort */ }
        if (attempt === 0 && isTransientError(error)) await wait(300);
        else break;
      }
    }
    if (!completed) throw lastError || new Error('Не удалось скачать обновление');
    runtime.downloadedBytes = asset.size;
    runtime.file = dest;
    runtime.phase = 'downloaded';
    cleanupUpdateFiles(asset.name);
    return publicState();
  } catch (error) {
    runtime.phase = 'error';
    runtime.error = error.message || String(error);
    throw error;
  }
}

function scheduleLaunch(command, args, options, trackInstall) {
  setTimeout(() => {
    try {
      const child = childProcess.spawn(command, args, Object.assign({ detached: true, stdio: 'ignore' }, options || {}));
      child.once('spawn', () => {
        if (trackInstall && runtime.phase === 'launching') runtime.phase = 'installing';
      });
      child.once('error', (error) => {
        runtime.phase = 'error';
        runtime.error = 'Не удалось запустить установщик: ' + error.message;
      });
      child.once('exit', (code) => {
        // При успешной установке панель обычно уже остановлена самим пакетом. Если
        // процесс всё ещё жив, возвращаем проверенный файл в повторно доступное состояние.
        if (trackInstall && (runtime.phase === 'launching' || runtime.phase === 'installing')) {
          runtime.phase = code === 0 ? 'downloaded' : 'error';
          runtime.error = code === 0 ? '' : 'Установщик завершился с кодом ' + code;
        }
      });
      child.unref();
    } catch (error) {
      runtime.phase = 'error';
      runtime.error = 'Не удалось запустить установщик: ' + error.message;
    }
  }, 700);
}

function install() {
  if (installPromise) return installPromise;
  if (checkPromise || runtime.phase === 'checking') {
    throw Object.assign(new Error('Дождитесь завершения проверки обновлений'), { status: 409 });
  }
  if (downloadPromise || runtime.phase === 'downloading') {
    throw Object.assign(new Error('Дождитесь завершения скачивания обновления'), { status: 409 });
  }
  if (runtime.phase === 'launching' || runtime.phase === 'installing') return Promise.resolve(Object.assign(publicState(), {
    launched: false,
    message: 'Установщик уже запускается.',
  }));
  installPromise = performInstall().finally(() => { installPromise = null; });
  return installPromise;
}

async function performInstall() {
  const asset = runtime.asset;
  const file = runtime.file;
  if (!asset || !file) throw new Error('Сначала скачайте и проверьте обновление');
  if (!await verifiedExisting(file, asset)) {
    runtime.phase = 'error';
    runtime.error = 'Скачанный файл не прошёл повторную проверку';
    runtime.file = '';
    throw new Error(runtime.error);
  }
  const mode = assetInstallMode(asset.name, process.platform, process.env);
  runtime.phase = 'launching';
  runtime.error = '';
  if (mode === 'installer') {
    // Завершением панели управляет PrepareToInstall в Inno: он вызывает /api/quit
    // и ждёт файловые операции. Restart Manager здесь не используем, чтобы он не
    // обошёл безопасную остановку жёстким закрытием процессов.
    scheduleLaunch(file, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', '/CGUPDATE'], { windowsHide: true }, true);
    return Object.assign(publicState(), { launched: false, scheduled: true, message: 'Установка запланирована. Приложение безопасно закроется и откроется снова.' });
  }
  if (mode === 'open') {
    const command = process.platform === 'darwin' ? '/usr/bin/open' : '';
    if (command) {
      // `open` не завершает панель, поэтому можно дождаться его кода возврата и
      // не сообщать об успехе, если системное окно фактически не открылось.
      try {
        await new Promise((resolve, reject) => {
          let child;
          try { child = childProcess.spawn(command, [file], { stdio: 'ignore' }); }
          catch (error) { reject(error); return; }
          let settled = false;
          const finish = (error) => {
            if (settled) return;
            settled = true;
            if (error) reject(error); else resolve();
          };
          child.once('error', (error) => finish(new Error('Не удалось открыть пакет: ' + error.message)));
          child.once('exit', (code) => finish(code === 0 ? null : new Error('Системное открытие пакета завершилось с кодом ' + code)));
        });
      } catch (error) {
        runtime.phase = 'error';
        runtime.error = error.message || String(error);
        throw error;
      }
      runtime.phase = 'downloaded';
      return Object.assign(publicState(), { launched: true, manual: true, message: 'Пакет открыт. Завершите установку в системном окне.' });
    }
  }
  runtime.phase = 'downloaded';
  const manualMessage = /\.deb$/i.test(asset.name)
    ? 'Пакет проверен. Установите его командой: sudo dpkg -i ' + file
    : 'Обновление проверено и сохранено: ' + file;
  return Object.assign(publicState(), { launched: false, manual: true, file, message: manualMessage });
}

function dismiss(version) {
  const selected = String(version || (runtime.release && runtime.release.version) || '');
  if (!parseVersion(selected)) throw new Error('Некорректная версия обновления');
  const prefs = readPrefs();
  prefs.dismissedVersion = selected;
  atomicWriteJson(PREFS_FILE, prefs);
  return publicState();
}

module.exports = {
  status: publicState,
  check,
  download,
  install,
  dismiss,
  _test: { parseVersion, compareVersions, expectedAssetName, assetInstallMode, isAllowedDownloadUrl, normalizeRelease },
};
