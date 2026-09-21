/**
 * intradayRefresh.cjs — lock-guarded runner for the in-app intraday rollup tick.
 *
 * Extracted from index.cjs so the failure paths are unit-testable. Guarantees:
 * a lock-acquire throw is logged (never escapes the interval callback), and a
 * synchronous OR asynchronous throw from `refresh` always releases the lock.
 */
'use strict';

function createIntradayRefresh({ tryAcquireLock, releaseLock, lockPath, refresh, logs }) {
  const logError = (message, e) =>
    logs.writeLine({ scope: 'history-rollup', level: 'error', message, meta: { error: e?.message } });

  return function runIntradayRefresh() {
    let acquired;
    try {
      acquired = tryAcquireLock(lockPath);
    } catch (e) {
      logError('intraday lock acquire failed', e);
      return;
    }
    if (!acquired) return;
    // Promise.resolve().then would defer the call; use an async IIFE so a sync
    // throw from refresh() lands in the same catch as a rejection.
    (async () => { await refresh(); })()
      .catch((e) => logError('refreshIntradayToday failed', e))
      .finally(() => {
        try { releaseLock(lockPath); } catch (e) { logError('intraday lock release failed', e); }
      });
  };
}

module.exports = { createIntradayRefresh };
