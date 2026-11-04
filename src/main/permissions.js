'use strict';

function configurePermissions({ guestSession, defaultSession, isDiscordURL, dialog, getWindow }) {
  guestSession.setPermissionCheckHandler((_wc, permission, origin) => isDiscordURL(origin) && ['media', 'clipboard-sanitized-write', 'fullscreen'].includes(permission));
  guestSession.setPermissionRequestHandler(async (wc, permission, callback, details) => {
    if (wc.isDestroyed() || !isDiscordURL(wc.getURL()) || !isDiscordURL(details.requestingUrl || wc.getURL())) return callback(false);
    if (['clipboard-sanitized-write', 'fullscreen'].includes(permission)) return callback(true);
    if (permission !== 'media') return callback(false);
    const window = getWindow();
    if (!window || window.isDestroyed()) return callback(false);
    try {
      const answer = await dialog.showMessageBox(window, { type: 'question', title: 'Discord 권한 요청', message: '마이크 또는 카메라 사용을 허용할까요?', buttons: ['허용 안 함', '허용'], defaultId: 0, cancelId: 0 });
      callback(!wc.isDestroyed() && !window.isDestroyed() && answer.response === 1);
    } catch { callback(false); }
  });
  defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
}
module.exports = { configurePermissions };
