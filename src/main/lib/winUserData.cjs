// Chromium resolves 'userData' via Windows known folders; with a stripped profile
// (no AppData) app.getPath('userData') throws "Failed to get 'userData' path" and the
// process dies 0x80000003. Fall back to an explicit %APPDATA%-based path.
const path = require('node:path');

function ensureWinUserDataPath({ app, env, platform, fs, os, log = () => {} }) {
  if (platform !== 'win32') return false;
  try {
    app.getPath('userData');
    return false;
  } catch (err) {
    const appData = (env && env.APPDATA) || path.win32.join(os.homedir(), 'AppData', 'Roaming');
    const userData = path.win32.join(appData, 'Session Manager');
    fs.mkdirSync(userData, { recursive: true });
    app.setPath('appData', appData);
    app.setPath('userData', userData);
    log(`[win-userdata] getPath('userData') failed (${err && err.message}); using ${userData}`);
    return true;
  }
}

module.exports = { ensureWinUserDataPath };
