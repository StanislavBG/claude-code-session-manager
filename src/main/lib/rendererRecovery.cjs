'use strict';

// Bounded automatic recovery for a dead / hung / failed-to-load renderer.
// Without it an OOM-killed renderer leaves a permanently white window while
// scheduler jobs keep running headless with no UI to pause them.
//
// `createReloadPolicy` is the pure cap/timing unit (injected clock);
// `attachRendererRecovery` wires it to one webContents (= one window).

const MAX_RELOADS = 3;
const WINDOW_MS = 10 * 60 * 1000;
const UNRESPONSIVE_GRACE_MS = 30 * 1000;
const LOAD_RETRY_DELAY_MS = 2000;
const ERR_ABORTED = -3;

/** Sliding-window cap: at most `max` reloads per `windowMs`. O(max) per call. */
function createReloadPolicy({ now = Date.now, max = MAX_RELOADS, windowMs = WINDOW_MS } = {}) {
  let stamps = [];
  return {
    /** Record a reload if the cap allows it. Returns true when allowed. */
    tryReload() {
      const t = now();
      stamps = stamps.filter((s) => t - s < windowMs);
      if (stamps.length >= max) return false;
      stamps.push(t);
      return true;
    },
    /** Should a render-process-gone reason trigger recovery? */
    shouldRecoverFromGone(reason) {
      return reason !== 'clean-exit';
    },
    /** Should a did-fail-load trigger a retry? Main frame only, not ERR_ABORTED. */
    shouldRetryLoad(errorCode, isMainFrame) {
      return isMainFrame !== false && errorCode !== ERR_ABORTED;
    },
  };
}

function attachRendererRecovery(wc, {
  logs,
  policy = createReloadPolicy(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let unresponsiveTimer = null;
  let loadRetryTimer = null;
  let capLogged = false;

  const log = (level, message, meta) => {
    try { logs?.writeLine({ scope: 'crash-diag', level, message, meta }); } catch { /* logging must never break recovery */ }
  };
  const alive = () => !wc.isDestroyed();

  function reload(reason) {
    if (!alive()) return;
    if (!policy.tryReload()) {
      if (!capLogged) {
        capLogged = true;
        log('error', 'renderer auto-reload cap reached — giving up', { reason, max: MAX_RELOADS, windowMs: WINDOW_MS });
      }
      return;
    }
    capLogged = false;
    log('warn', 'renderer auto-reload', { reason });
    try { wc.reload(); } catch (e) { log('error', 'renderer reload threw', { reason, error: e?.message }); }
  }

  wc.on('render-process-gone', (_e, details) => {
    const reason = details?.reason;
    if (!policy.shouldRecoverFromGone(reason)) return;
    reload(`render-process-gone:${reason}`);
  });

  wc.on('unresponsive', () => {
    log('warn', 'renderer unresponsive');
    if (unresponsiveTimer) return;
    unresponsiveTimer = setTimer(() => {
      unresponsiveTimer = null;
      reload('unresponsive');
    }, UNRESPONSIVE_GRACE_MS);
  });

  wc.on('responsive', () => {
    if (unresponsiveTimer) { clearTimer(unresponsiveTimer); unresponsiveTimer = null; }
    log('info', 'renderer responsive again');
  });

  wc.on('did-fail-load', (_e, errorCode, errorDescription, _url, isMainFrame) => {
    if (!policy.shouldRetryLoad(errorCode, isMainFrame)) return;
    log('warn', 'main-frame did-fail-load', { errorCode, errorDescription });
    if (loadRetryTimer) return;
    loadRetryTimer = setTimer(() => {
      loadRetryTimer = null;
      reload(`did-fail-load:${errorCode}`);
    }, LOAD_RETRY_DELAY_MS);
  });

  wc.once('destroyed', () => {
    if (unresponsiveTimer) clearTimer(unresponsiveTimer);
    if (loadRetryTimer) clearTimer(loadRetryTimer);
    unresponsiveTimer = loadRetryTimer = null;
  });
}

module.exports = {
  createReloadPolicy,
  attachRendererRecovery,
  MAX_RELOADS,
  WINDOW_MS,
  UNRESPONSIVE_GRACE_MS,
  LOAD_RETRY_DELAY_MS,
  ERR_ABORTED,
};
