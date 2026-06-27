'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { DATA_ROOT, serverDir } = require('./paths');
const manager = require('./manager');

/* Реальные бэкапы каталога сервера в .tar.gz через системный tar
   (bsdtar на Windows 10+/Linux). Архивы — в backups/<id>/. */

const BACKUPS_ROOT = path.join(DATA_ROOT, 'backups');

function backupsDir(serverId) {
  const dir = path.join(BACKUPS_ROOT, serverId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeName(name) {
  // только имя файла, без путей; добавляем .tar.gz
  const base = String(name || '').replace(/[^A-Za-z0-9_.\-]/g, '_').replace(/^_+|_+$/g, '');
  return base;
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    '_' + p(d.getHours()) + '-' + p(d.getMinutes()) + '-' + p(d.getSeconds());
}

function listBackups(serverId) {
  const dir = backupsDir(serverId);
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.tar.gz')); } catch (e) { /* пусто */ }
  return files.map((name) => {
    let size = 0; let mtime = 0;
    try { const st = fs.statSync(path.join(dir, name)); size = st.size; mtime = st.mtimeMs; } catch (e) { /* исчез */ }
    return { name, size, mtime };
  }).sort((a, b) => b.mtime - a.mtime);
}

/* tolerateWarnings: код 1 у tar — это предупреждения (файлы менялись/были
   заняты во время чтения у работающего сервера), архив при этом валиден.
   Считаем это успехом; код ≥2 — настоящая ошибка. */
// На Windows форсируем РОДНОЙ bsdtar из System32 — иначе в PATH может оказаться
// GNU/MSYS tar (Git for Windows), который трактует «D:\...» в пути архива как
// удалённый хост (host:path) и портит/не создаёт архив. bsdtar понимает диск-буквы.
function tarBin() {
  if (process.platform === 'win32') {
    const sys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    try { if (fs.existsSync(sys)) return sys; } catch (e) { /* */ }
  }
  return 'tar';
}
function runTar(args, label, tolerateWarnings) {
  return new Promise((resolve, reject) => {
    let proc;
    try { proc = spawn(tarBin(), args, { windowsHide: true }); }
    catch (e) { return reject(new Error('tar недоступен: ' + e.message)); }
    let err = '';
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('error', (e) => reject(new Error((label || 'tar') + ': ' + e.message)));
    proc.on('exit', (code) => {
      if (code === 0 || (tolerateWarnings && code === 1)) resolve({ code, warned: code === 1 });
      else reject(new Error((label || 'tar') + ' завершился с кодом ' + code + (err ? ': ' + err.trim().slice(0, 300) : '')));
    });
  });
}

/* Создать бэкап. Если сервер работает — сбрасываем мир командой save-all
   перед архивацией (best effort). Возвращает имя архива. */
async function createBackup(server, label) {
  const id = server.id;
  const dir = serverDir(id);
  if (!fs.existsSync(dir)) throw Object.assign(new Error('Каталог сервера не найден'), { status: 404 });

  const st = manager.getState(id);
  if (st.proc) {
    try {
      manager.sendCommand(id, 'save-all flush');
      manager.pushLine(id, '[ПАНЕЛЬ] Сохраняю мир перед бэкапом...');
      await new Promise((r) => setTimeout(r, 2500));
    } catch (e) { /* не критично */ }
  }

  const clean = safeName(label);
  const name = timestamp() + (clean ? '_' + clean : '') + '.tar.gz';
  const out = path.join(backupsDir(id), name);
  // -C <serverDir> .  — архивируем содержимое каталога сервера;
  // у работающего сервера терпим предупреждения (код 1) — архив валиден
  const result = await runTar(['-czf', out, '-C', dir, '.'], 'Создание бэкапа', true);
  let size = 0;
  try { size = fs.statSync(out).size; } catch (e) { /* ? */ }
  if (!size) throw Object.assign(new Error('Архив пуст — бэкап не создан'), { status: 500 });
  manager.pushLine(id, '[ПАНЕЛЬ] Бэкап создан: ' + name + (result.warned ? ' (часть файлов была занята сервером — пропущена)' : ''));
  return { name, size };
}

function deleteBackup(serverId, name) {
  const clean = safeName(name);
  if (!clean.endsWith('.tar.gz')) throw Object.assign(new Error('Некорректное имя бэкапа'), { status: 400 });
  const file = path.join(backupsDir(serverId), clean);
  if (!fs.existsSync(file)) throw Object.assign(new Error('Бэкап не найден'), { status: 404 });
  fs.rmSync(file, { force: true });
}

function backupFilePath(serverId, name) {
  const clean = safeName(name);
  if (!clean.endsWith('.tar.gz')) throw Object.assign(new Error('Некорректное имя бэкапа'), { status: 400 });
  const file = path.join(backupsDir(serverId), clean);
  if (!fs.existsSync(file)) throw Object.assign(new Error('Бэкап не найден'), { status: 404 });
  return file;
}

/* Восстановить бэкап: только на остановленном сервере. Содержимое каталога
   сервера очищается и заменяется содержимым архива. */
async function restoreBackup(server, name) {
  const id = server.id;
  const st = manager.getState(id);
  if (st.proc) throw Object.assign(new Error('Сначала остановите сервер'), { status: 409 });
  if (manager.orphanAlive(id)) throw Object.assign(new Error('Процесс сервера ещё работает — завершите его'), { status: 409 });
  const file = backupFilePath(id, name);
  const dir = serverDir(id);

  // защитный авто-бэкап текущего состояния перед перезаписью
  try { await createBackup(server, 'before-restore'); } catch (e) { /* не блокируем */ }

  // очищаем каталог сервера
  for (const entry of fs.readdirSync(dir)) {
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  await runTar(['-xzf', file, '-C', dir], 'Восстановление');
  manager.pushLine(id, '[ПАНЕЛЬ] Восстановлен бэкап: ' + safeName(name));
}

module.exports = { listBackups, createBackup, deleteBackup, restoreBackup, backupFilePath };
