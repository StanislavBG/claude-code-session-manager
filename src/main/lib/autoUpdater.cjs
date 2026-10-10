'use strict';

/**
 * autoUpdater.cjs — pure, dependency-injected state machine around electron-updater's autoUpdater.
 *
 * Requires neither electron nor electron-updater: the caller injects the updater instance. The feed is
 * whatever app-update.yml electron-builder baked into the installer; this module never supplies a feed URL.
 * Checks on start() and every 4h, downloads in the background, and installs ONLY after requestInstall() —
 * deferring (polling isBusy every 60s) while scheduler jobs or terminals are busy.
 */

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const BUSY_POLL_MS = 60 * 1000;

/** Unsigned mac builds cannot use Squirrel.Mac, so darwin is always unsupported. */
function isAutoUpdateSupported({ packaged, platform, env }) {
  const e = env || {};
  if (packaged !== true) return false;
  if (e.SM_AUTO_UPDATE === '0' || e.SM_E2E === '1') return false;
  if (platform === 'win32') return true;
  return platform === 'linux' && typeof e.APPIMAGE === 'string' && e.APPIMAGE.length > 0;
}

function createAutoUpdater({
  updater, supported, currentVersion, isBusy, getEnabled,
  setInterval: setIntervalFn = setInterval, clearInterval: clearIntervalFn = clearInterval,
  now = Date.now, log = () => {},
}) {
  let enabledOverride = null;
  let started = false;
  let listening = false;
  let checkTimer = null;
  let pollTimer = null;
  const subscribers = new Set();

  const isEnabled = () => {
    if (enabledOverride !== null) return enabledOverride;
    return typeof getEnabled === 'function' ? getEnabled() !== false : true;
  };

  let snapshot = {
    state: supported ? 'idle' : 'unsupported',
    current: currentVersion,
    latest: null,
    progress: null,
    error: null,
    busyReason: null,
    lastCheckedAt: null,
  };

  function setState(patch) {
    const next = { ...snapshot, ...patch };
    if (Object.keys(next).every((k) => next[k] === snapshot[k])) return;
    snapshot = next;
    for (const fn of [...subscribers]) {
      try { fn(snapshot); } catch (e) { log('autoUpdater subscriber threw', e); }
    }
  }

  const holding = () => snapshot.state === 'ready' || snapshot.state === 'deferred';

  function fail(e) {
    const message = e && e.message ? e.message : String(e);
    log('autoUpdater error', message);
    setState({ state: 'error', error: message, progress: null });
  }

  function clearPoll() {
    if (pollTimer !== null) { clearIntervalFn(pollTimer); pollTimer = null; }
  }

  function clearChecks() {
    if (checkTimer !== null) { clearIntervalFn(checkTimer); checkTimer = null; }
  }

  function attach() {
    if (listening) return;
    listening = true;
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.on('checking-for-update', () => {
      if (!holding()) setState({ state: 'checking', error: null });
    });
    updater.on('update-available', (info) => {
      if (!holding()) setState({ state: 'downloading', latest: info && info.version ? info.version : null, progress: null, error: null });
    });
    updater.on('download-progress', (p) => {
      if (!holding()) setState({ state: 'downloading', progress: p && typeof p.percent === 'number' ? p.percent : null });
    });
    updater.on('update-downloaded', (info) => {
      setState({ state: 'ready', latest: info && info.version ? info.version : snapshot.latest, progress: 100, error: null, busyReason: null });
    });
    updater.on('update-not-available', () => {
      if (!holding()) setState({ state: 'idle', latest: null, progress: null, error: null });
    });
    updater.on('error', (e) => {
      if (!holding()) fail(e);
    });
  }

  async function checkNow() {
    if (!supported || !isEnabled()) return;
    if (holding() || snapshot.state === 'checking' || snapshot.state === 'downloading') return;
    attach();
    setState({ state: 'checking', error: null, lastCheckedAt: now() });
    try {
      await updater.checkForUpdates();
    } catch (e) {
      fail(e);
    }
  }

  function startChecks() {
    clearChecks();
    checkTimer = setIntervalFn(() => { checkNow(); }, CHECK_INTERVAL_MS);
    if (checkTimer && typeof checkTimer.unref === 'function') checkTimer.unref();
    checkNow();
  }

  function applyEnabled() {
    if (!supported) return;
    if (!isEnabled()) {
      clearChecks();
      clearPoll();
      setState({ state: 'disabled', busyReason: null, progress: null, error: null });
      return;
    }
    if (snapshot.state === 'disabled') setState({ state: 'idle' });
    if (started) startChecks();
  }

  function start() {
    if (!supported || started) return;
    started = true;
    applyEnabled();
  }

  function stop() {
    started = false;
    clearChecks();
    clearPoll();
  }

  function setEnabled(value) {
    enabledOverride = !!value;
    applyEnabled();
  }

  function install() {
    clearPoll();
    try {
      updater.quitAndInstall(false, true);
    } catch (e) {
      fail(e);
    }
  }

  function requestInstall({ force } = {}) {
    if (!supported || !holding()) return;
    if (snapshot.state === 'deferred' && !force) return;
    if (force) { install(); return; }
    const b = isBusy ? isBusy() : { busy: false };
    if (!b || !b.busy) { install(); return; }
    setState({ state: 'deferred', busyReason: b.reason || null });
    clearPoll();
    pollTimer = setIntervalFn(() => {
      const cur = isBusy ? isBusy() : { busy: false };
      if (cur && cur.busy) { setState({ busyReason: cur.reason || null }); return; }
      install();
    }, BUSY_POLL_MS);
    if (pollTimer && typeof pollTimer.unref === 'function') pollTimer.unref();
  }

  function cancelDeferred() {
    if (snapshot.state !== 'deferred') return;
    clearPoll();
    setState({ state: 'ready', busyReason: null });
  }

  function subscribe(fn) {
    subscribers.add(fn);
    return () => { subscribers.delete(fn); };
  }

  return { start, stop, checkNow, requestInstall, cancelDeferred, setEnabled, status: () => snapshot, subscribe };
}

module.exports = { isAutoUpdateSupported, createAutoUpdater, CHECK_INTERVAL_MS, BUSY_POLL_MS };
