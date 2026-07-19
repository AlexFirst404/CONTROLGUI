'use strict';
/* Модель прав панели (v2). Локально (localhost) панель полностью открыта владельцу.
   Удалённый доступ (lib/remoteaccess.js) — по пользователям с правами НА КАЖДЫЙ
   сервер: access = { "<serverId>"|"*": { "console.view": true, ... } }. Права —
   булев набор уровня сервера (создание НОВЫХ серверов — только локально). */

// права уровня сервера (server.create — глобальная операция, удалённым не выдаём)
const PERMISSIONS = [
  { key: 'console.view', group: 'Консоль', label: 'Просмотр консоли' },
  { key: 'console.command', group: 'Консоль', label: 'Ввод команд' },
  { key: 'logs.view', group: 'Логи', label: 'Просмотр логов' },
  { key: 'server.start', group: 'Управление', label: 'Запуск' },
  { key: 'server.stop', group: 'Управление', label: 'Остановка и перезапуск' },
  { key: 'server.kill', group: 'Управление', label: 'Принудительное завершение' },
  { key: 'server.install', group: 'Управление', label: 'Установка / переустановка ядра' },
  { key: 'server.delete', group: 'Управление', label: 'Удаление сервера' },
  { key: 'settings.edit', group: 'Настройки', label: 'server.properties и память' },
  { key: 'files.read', group: 'Файлы', label: 'Просмотр и чтение' },
  { key: 'files.write', group: 'Файлы', label: 'Изменение и создание' },
  { key: 'files.upload', group: 'Файлы', label: 'Загрузка' },
  { key: 'files.delete', group: 'Файлы', label: 'Удаление' },
  { key: 'players.kick', group: 'Игроки', label: 'Кик' },
  { key: 'players.ban', group: 'Игроки', label: 'Бан и разбан' },
  { key: 'players.op', group: 'Игроки', label: 'Выдача OP' },
  { key: 'players.whitelist', group: 'Игроки', label: 'Белый список' },
  { key: 'players.delete', group: 'Игроки', label: 'Удаление данных игрока' },
  { key: 'backups.create', group: 'Бэкапы', label: 'Создание' },
  { key: 'backups.restore', group: 'Бэкапы', label: 'Восстановление' },
  { key: 'backups.delete', group: 'Бэкапы', label: 'Удаление' },
];
const PERM_KEYS = PERMISSIONS.map((p) => p.key);

// пресеты уровня доступа (набор включённых ключей)
const PRESETS = {
  full: PERM_KEYS.slice(),
  manage: ['console.view', 'console.command', 'logs.view', 'server.start', 'server.stop', 'server.kill'],
  view: ['console.view', 'logs.view', 'files.read'],
};
function presetPerms(name) {
  const out = {};
  for (const k of (PRESETS[name] || [])) out[k] = true;
  return out;
}
/* Какому пресету соответствует набор (для показа в UI): none/full/manage/view/custom. */
function permsPreset(perms) {
  const on = PERM_KEYS.filter((k) => perms && perms[k]);
  if (!on.length) return 'none';
  for (const name of ['full', 'manage', 'view']) {
    const set = PRESETS[name];
    if (set.length === on.length && set.every((k) => perms[k])) return name;
  }
  return 'custom';
}
/* Оставляем только известные ключи с true (чистим ввод). */
function sanitizePerms(perms) {
  const out = {};
  for (const k of PERM_KEYS) if (perms && perms[k]) out[k] = true;
  return out;
}

/* Принципал локального запроса — полный доступ (владелец за клавиатурой). */
function currentUser(req) {
  return { username: null, openMode: true, admin: true, perms: { admin: true } };
}

/* Есть ли у принципала это право. Для удалённого req.cgUser.perms уже скоуплены
   под целевой сервер запроса (см. server.js). */
function hasPerm(user, key) {
  if (!user) return false;
  if (user.perms && user.perms.admin) return true;
  return !!(user.perms && user.perms[key]);
}

/* Доступен ли серверу пользователю (admin — всё; удалённый — по access-карте). */
function canAccessServer(user, serverId) {
  if (!user) return false;
  if (user.admin || (user.perms && user.perms.admin)) return true;
  const acc = user.access;
  if (!acc) return true; // нет ограничений (локальный принципал)
  return !!(acc[String(serverId)] || acc['*']);
}

/* Права пользователя НА КОНКРЕТНЫЙ сервер (точный набор или wildcard "*"). */
function permsForServer(user, serverId) {
  if (user && (user.admin || (user.perms && user.perms.admin))) return { admin: true };
  const acc = (user && user.access) || {};
  return acc[String(serverId)] || acc['*'] || {};
}

module.exports = {
  PERMISSIONS, PERM_KEYS, PRESETS, presetPerms, permsPreset, sanitizePerms,
  currentUser, hasPerm, canAccessServer, permsForServer,
};
