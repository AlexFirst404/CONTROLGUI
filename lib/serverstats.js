'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./paths');

const DAY_MS = 86400000;
const HISTORY_DAYS = 366;
const MAX_GAP_MS = 60000;
const FLUSH_MS = 60000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_IDLE_CACHE = 256;

function emptyMetrics() {
  return { uptimeMs: 0, starts: 0, longestSessionMs: 0, peakPlayers: null,
    peakPlayersAt: null, playerMs: 0, onlineObservedMs: 0 };
}

function safeNumber(value) {
  return Number.isFinite(value) && value >= 0 ? Math.min(Number.MAX_SAFE_INTEGER, value) : 0;
}

function cleanMetrics(source) {
  const out = emptyMetrics();
  if (!source || typeof source !== 'object') return out;
  for (const key of ['uptimeMs', 'starts', 'longestSessionMs', 'playerMs', 'onlineObservedMs']) {
    out[key] = safeNumber(source[key]);
  }
  out.onlineObservedMs = Math.min(out.onlineObservedMs, out.uptimeMs);
  if (Number.isInteger(source.peakPlayers) && source.peakPlayers >= 0 && source.peakPlayers <= 1000000) {
    out.peakPlayers = source.peakPlayers;
    out.peakPlayersAt = safeNumber(source.peakPlayersAt) || null;
  }
  return out;
}

function publicMetrics(source) {
  return {
    uptimeMs: source.uptimeMs,
    starts: source.starts,
    longestSessionMs: source.longestSessionMs,
    peakPlayers: source.peakPlayers,
    peakPlayersAt: source.peakPlayersAt,
    averagePlayers: source.onlineObservedMs > 0 ? source.playerMs / source.onlineObservedMs : null,
    playerHours: source.playerMs / 3600000,
    onlineObservedMs: source.onlineObservedMs,
  };
}

function addNumber(target, key, amount) {
  target[key] = Math.min(Number.MAX_SAFE_INTEGER, target[key] + amount);
}

function updatePeak(target, players, at) {
  if (players == null) return;
  if (target.peakPlayers == null || players > target.peakPlayers ||
      (players === target.peakPlayers && at != null &&
        (target.peakPlayersAt == null || at < target.peakPlayersAt))) {
    target.peakPlayers = players;
    target.peakPlayersAt = at;
  }
}

function dayKey(now) { return new Date(now).toISOString().slice(0, 10); }
function dayStart(now) { return Math.floor(now / DAY_MS) * DAY_MS; }
function playerCount(value) {
  return Number.isInteger(value) && value >= 0 && value <= 1000000 ? value : null;
}

/* Пишем отдельно от мира: восстановление старого бэкапа не должно откатывать
   статистику панели. Фабрика позволяет тестам использовать изолированный диск
   и часы, не запуская Java и не меняя пользовательские данные. */
function createTracker(options) {
  options = options || {};
  const root = options.root || path.join(DATA_DIR, 'server-statistics');
  const clock = options.now || Date.now;
  const entries = new Map();
  const logger = options.log || ((message) => console.error(message));

  function timestamp(value) {
    const now = value == null ? clock() : value;
    if (!Number.isFinite(now) || now < 0 || now > 8640000000000000) throw new Error('Некорректное время статистики');
    return Math.floor(now);
  }

  function filename(id) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error('Некорректный идентификатор сервера');
    return path.join(root, id + '.json');
  }

  function prune(entry, now) {
    const oldest = dayKey(Math.max(0, dayStart(now) - (HISTORY_DAYS - 1) * DAY_MS));
    for (const key of Object.keys(entry.data.daily)) {
      if (key < oldest) {
        delete entry.data.daily[key];
        entry.dirty = true;
      }
    }
    const keys = Object.keys(entry.data.daily).sort();
    if (keys.length > HISTORY_DAYS) {
      const today = dayKey(now);
      const observed = keys.filter((key) => key <= today).reverse();
      const future = keys.filter((key) => key > today);
      const keep = new Set(observed.concat(future).slice(0, HISTORY_DAYS));
      for (const key of keys) if (!keep.has(key)) { delete entry.data.daily[key]; entry.dirty = true; }
    }
  }

  function readStored(id, now) {
    const file = filename(id);
    if (fs.statSync(file).size > MAX_FILE_BYTES) throw new Error('Файл статистики превышает допустимый размер');
    const source = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!source || source.version !== 1 || !source.totals || typeof source.totals !== 'object' || Array.isArray(source.totals) ||
        !source.daily || typeof source.daily !== 'object' || Array.isArray(source.daily)) {
      throw new Error('Некорректный формат статистики');
    }
    const data = { version: 1, collectedSince: Math.min(now, safeNumber(source.collectedSince) || now),
      lastUpdatedAt: Math.min(now, safeNumber(source.lastUpdatedAt) || now),
      totals: cleanMetrics(source.totals), daily: Object.create(null), active: null };
    const keys = Object.keys(source.daily).filter((key) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;
      const parsed = Date.parse(key + 'T00:00:00.000Z');
      return Number.isFinite(parsed) && dayKey(parsed) === key;
    }).sort().slice(-HISTORY_DAYS);
    for (const key of keys) data.daily[key] = cleanMetrics(source.daily[key]);
    const active = source.active;
    const savedActive = active && Number.isInteger(active.pid) && active.pid > 0 ? {
      pid: active.pid,
      startedAt: Math.min(now, safeNumber(active.startedAt) || now),
      observedMs: safeNumber(active.observedMs),
      day: typeof active.day === 'string' ? active.day : '',
      dayMs: safeNumber(active.dayMs),
    } : null;
    return { data, savedActive };
  }

  function recoverRead(entry, now) {
    if (!entry.readError || now - entry.lastReadAttemptAt < FLUSH_MS) return;
    entry.lastReadAttemptAt = now;
    let stored;
    try { stored = readStored(entry.id, now); }
    catch (e) { warn(entry, now); return; }
    const delta = entry.data;
    const merge = (target, extra) => {
      for (const key of ['uptimeMs', 'starts', 'playerMs', 'onlineObservedMs']) addNumber(target, key, extra[key]);
      target.longestSessionMs = Math.max(target.longestSessionMs, extra.longestSessionMs);
      updatePeak(target, extra.peakPlayers, extra.peakPlayersAt);
    };
    // Пока файл был недоступен, в памяти копились только новые наблюдения.
    // После восстановления чтения прибавляем их к старому файлу, не обнуляя
    // ни прежнюю историю, ни текущую сессию.
    merge(stored.data.totals, delta.totals);
    for (const [key, value] of Object.entries(delta.daily)) {
      if (!stored.data.daily[key]) stored.data.daily[key] = emptyMetrics();
      merge(stored.data.daily[key], value);
    }
    stored.data.collectedSince = Math.min(stored.data.collectedSince, delta.collectedSince);
    stored.data.lastUpdatedAt = Math.max(stored.data.lastUpdatedAt, delta.lastUpdatedAt);
    const session = entry.session;
    const previous = stored.savedActive;
    const continuation = previous && session && session.orphan && previous.pid === session.pid ? session
      : previous && entry.pendingOrphan && previous.pid === entry.pendingOrphan.pid ? entry.pendingOrphan : null;
    if (continuation) {
      continuation.startedAt = Math.min(continuation.startedAt, previous.startedAt);
      continuation.observedMs += previous.observedMs;
      if (continuation.day === previous.day) continuation.dayMs += previous.dayMs;
      stored.data.totals.longestSessionMs = Math.max(stored.data.totals.longestSessionMs, continuation.observedMs);
      const currentDay = stored.data.daily[continuation.day];
      if (currentDay) currentDay.longestSessionMs = Math.max(currentDay.longestSessionMs, continuation.dayMs);
    }
    entry.data = stored.data;
    entry.savedActive = session || continuation ? null : stored.savedActive;
    entry.pendingOrphan = null;
    entry.readError = false;
    entry.persistenceError = false;
    entry.dirty = true;
    prune(entry, now);
  }

  function get(id, now) {
    filename(id);
    let entry = entries.get(id);
    if (entry) {
      recoverRead(entry, now);
      prune(entry, now);
      entries.delete(id);
      entries.set(id, entry);
      return entry;
    }
    // Живые сессии не вытесняем, а просмотр сотен давно остановленных серверов
    // не должен оставлять их годовую историю навсегда в оперативной памяти.
    if (entries.size >= MAX_IDLE_CACHE) {
      for (const [oldId, oldEntry] of entries) {
        if (oldEntry.session) continue;
        save(oldEntry, now, true);
        entries.delete(oldId);
        break;
      }
    }
    const data = { version: 1, collectedSince: now, lastUpdatedAt: now,
      totals: emptyMetrics(), daily: Object.create(null), active: null };
    entry = { id, data, session: null, savedActive: null, pendingOrphan: null, dirty: true, lastFlushAt: 0,
      readError: false, persistenceError: false, lastWarningAt: null, lastReadAttemptAt: now };
    try {
      const stored = readStored(id, now);
      entry.data = stored.data;
      entry.savedActive = stored.savedActive;
      entry.dirty = false;
    } catch (e) {
      if (e.code !== 'ENOENT') {
        // Не заменяем повреждённый/недоступный файл нулевой статистикой:
        // исходные данные остаются на месте для восстановления владельцем.
        entry.readError = true;
        entry.persistenceError = true;
        warn(entry, now);
      }
    }
    prune(entry, now);
    entries.set(id, entry);
    return entry;
  }

  function warn(entry, now) {
    if (entry.lastWarningAt != null && now - entry.lastWarningAt < FLUSH_MS) return;
    entry.lastWarningAt = now;
    logger('[ПАНЕЛЬ] Не удалось сохранить или прочитать статистику сервера ' + entry.id + '. Проверьте доступность диска.');
  }

  function daily(entry, now) {
    const key = dayKey(now);
    if (!entry.data.daily[key]) entry.data.daily[key] = emptyMetrics();
    return entry.data.daily[key];
  }

  function advance(entry, now) {
    const session = entry.session;
    if (!session) return;
    if (now < session.lastAt) {
      // После перевода часов не добавляем отрицательное время и не повторяем
      // уже учтённый участок; следующее наблюдение продолжится с новых часов.
      session.lastAt = now;
      entry.dirty = true;
      return;
    }
    // Сон компьютера/долгий стоп event loop не доказывает работу сервера.
    // В статистику попадает максимум минута между живыми наблюдениями.
    let from = Math.max(session.lastAt, now - MAX_GAP_MS);
    while (from < now) {
      const until = Math.min(now, dayStart(from) + DAY_MS);
      const elapsed = until - from;
      const key = dayKey(from);
      const day = daily(entry, from);
      if (session.day !== key) { session.day = key; session.dayMs = 0; }
      session.observedMs += elapsed;
      session.dayMs += elapsed;
      for (const target of [entry.data.totals, day]) {
        addNumber(target, 'uptimeMs', elapsed);
        if (session.players != null) {
          addNumber(target, 'onlineObservedMs', elapsed);
          addNumber(target, 'playerMs', session.players * elapsed);
          updatePeak(target, session.players, from);
        }
      }
      entry.data.totals.longestSessionMs = Math.max(entry.data.totals.longestSessionMs, session.observedMs);
      day.longestSessionMs = Math.max(day.longestSessionMs, session.dayMs);
      from = until;
    }
    if (now !== session.lastAt) {
      entry.data.lastUpdatedAt = now;
      entry.dirty = true;
    }
    session.lastAt = now;
    prune(entry, now);
  }

  function save(entry, now, force) {
    recoverRead(entry, now);
    if (!entry.dirty || entry.readError || (!force && now - entry.lastFlushAt < FLUSH_MS)) return;
    entry.lastFlushAt = now;
    const session = entry.session;
    entry.data.active = session ? { pid: session.pid, startedAt: session.startedAt,
      observedMs: session.observedMs, day: session.day, dayMs: session.dayMs } : null;
    const file = filename(entry.id);
    const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(5).toString('hex') + '.tmp';
    try {
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(entry.data), { mode: 0o600 });
      fs.renameSync(tmp, file);
      entry.dirty = false;
      entry.persistenceError = false;
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch (removeError) { /* файл мог не появиться */ }
      entry.persistenceError = true;
      warn(entry, now);
    }
  }

  function begin(id, details, at) {
    const now = timestamp(at);
    const entry = get(id, now);
    details = details || {};
    if (entry.session && entry.session.pid === details.pid) return;
    if (entry.session) advance(entry, now);
    const previous = details.orphan && entry.savedActive && entry.savedActive.pid === details.pid
      ? entry.savedActive : null;
    entry.savedActive = null;
    entry.session = {
      pid: Number.isInteger(details.pid) && details.pid > 0 ? details.pid : null,
      orphan: !!details.orphan,
      startedAt: previous ? previous.startedAt : now,
      observedMs: previous ? previous.observedMs : 0,
      lastAt: now,
      players: null,
      day: dayKey(now),
      dayMs: previous && previous.day === dayKey(now) ? previous.dayMs : 0,
    };
    if (!details.orphan) {
      addNumber(entry.data.totals, 'starts', 1);
      addNumber(daily(entry, now), 'starts', 1);
    }
    entry.data.lastUpdatedAt = now;
    entry.dirty = true;
    save(entry, now, true);
  }

  function observe(id, players, at) {
    const now = timestamp(at);
    const entry = entries.get(id);
    if (!entry || !entry.session) return;
    advance(entry, now);
    entry.session.players = entry.session.orphan ? null : playerCount(players);
    updatePeak(entry.data.totals, entry.session.players, now);
    updatePeak(daily(entry, now), entry.session.players, now);
    entry.dirty = true;
    save(entry, now, false);
  }

  function stop(id, at) {
    const entry = entries.get(id);
    if (!entry) return;
    const now = timestamp(at);
    advance(entry, now);
    if (entry.readError && entry.session && entry.session.orphan && !entry.pendingOrphan) {
      // Диск может восстановиться уже после остановки усыновлённой JVM.
      // Сохраняем хвост сессии, чтобы longest объединился с прежним checkpoint.
      entry.pendingOrphan = { ...entry.session };
    }
    entry.session = null;
    entry.savedActive = null;
    entry.data.lastUpdatedAt = now;
    entry.dirty = true;
    save(entry, now, true);
  }

  function getStatistics(id, days, at) {
    const now = timestamp(at);
    if (days == null) days = 30;
    if (![0, 7, 30, 90].includes(days)) throw new Error('Период статистики: 7, 30, 90 дней или всё время');
    const entry = get(id, now);
    advance(entry, now);
    save(entry, now, false);
    const from = days ? Math.max(entry.data.collectedSince, dayStart(now) - (days - 1) * DAY_MS) : entry.data.collectedSince;
    const cutoff = dayKey(Math.max(0, from));
    const today = dayKey(now);
    const rows = Object.keys(entry.data.daily).sort().filter((key) => key >= cutoff && key <= today)
      .map((date) => ({ date, ...publicMetrics(entry.data.daily[date]) }));
    const periodTotals = emptyMetrics();
    for (const row of rows) {
      const source = entry.data.daily[row.date];
      for (const key of ['uptimeMs', 'starts', 'playerMs', 'onlineObservedMs']) addNumber(periodTotals, key, source[key]);
      periodTotals.longestSessionMs = Math.max(periodTotals.longestSessionMs, source.longestSessionMs);
      updatePeak(periodTotals, source.peakPlayers, source.peakPlayersAt);
    }
    const session = entry.session;
    return {
      collectedSince: entry.data.collectedSince,
      period: { days, from, to: now },
      summary: { ...publicMetrics(days ? periodTotals : entry.data.totals),
        longestSessionMs: days ? null : entry.data.totals.longestSessionMs,
        longestSessionScope: 'session' },
      lifetime: publicMetrics(entry.data.totals),
      current: { running: !!session, orphan: !!(session && session.orphan),
        playersKnown: !!session && session.players != null, players: session ? session.players : null,
        startedAt: session ? session.startedAt : null, uptimeMs: session ? session.observedMs : 0 },
      daily: rows,
      historyDays: HISTORY_DAYS,
      timeZone: 'UTC',
      lastUpdatedAt: entry.data.lastUpdatedAt,
      persistenceError: entry.persistenceError,
    };
  }

  function flush(id, at) {
    const now = timestamp(at);
    const list = id == null ? entries.values() : [entries.get(id)].filter(Boolean);
    for (const entry of list) { advance(entry, now); save(entry, now, true); }
  }

  function remove(id) {
    const file = filename(id);
    fs.rmSync(file, { force: true });
    entries.delete(id);
  }

  return { begin, observe, stop, getStatistics, flush, remove };
}

const tracker = createTracker();
module.exports = { ...tracker, createTracker };
