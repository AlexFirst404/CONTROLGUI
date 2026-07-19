'use strict';
/* Модель доступа панели (v2, опенсорс): аккаунтов и многопользовательского входа нет.
   Локально (localhost) панель полностью открыта владельцу; удалённый доступ защищён
   единым паролем (lib/remoteaccess.js) и после входа тоже даёт полный доступ.
   Каркас прав (hasPerm/canAccessServer) сохранён: все проверки в api.js проходят
   через него, так что модель с ограниченными пользователями легко вернуть. */

/* Принципал текущего запроса: полный доступ (локальный владелец или
   аутентифицированный по паролю удалённый пользователь). */
function currentUser(req) {
  return { username: null, openMode: true, admin: true, perms: { admin: true } };
}

function hasPerm(user, key) {
  return !!(user && user.perms && (user.perms.admin || user.perms[key]));
}

/* true — пользователю доступен этот сервер (admin — всегда). */
function canAccessServer(user, serverId) {
  if (!user) return false;
  if (user.perms && user.perms.admin) return true;
  const srv = user.servers;
  if (srv == null) return true; // нет ограничения = все серверы
  return srv.indexOf(String(serverId)) >= 0;
}

module.exports = { currentUser, hasPerm, canAccessServer };
