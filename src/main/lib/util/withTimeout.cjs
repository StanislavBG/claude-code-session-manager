/**
 * withTimeout.cjs — bound an async body with a wall-clock budget.
 *
 * `withTimeout(promiseFactory, ms, onTimeout)` starts `promiseFactory()` and
 * resolves with its result. If it has not settled after `ms`, `onTimeout()`
 * is called and ITS return value becomes the resolved value; the original
 * promise is abandoned (never cancelled — callers that must neutralise a
 * late-resuming body do so with their own generation fence). The timer is
 * always cleared on settle, and unref'd so it can never hold the process open.
 * `ms <= 0` (or non-finite) disables the bound entirely.
 *
 * Plain Node module (no Electron deps).
 */
'use strict';

function withTimeout(promiseFactory, ms, onTimeout) {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve().then(promiseFactory);
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { resolve(onTimeout()); } catch (e) { reject(e); }
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
    Promise.resolve().then(promiseFactory).then(
      (v) => { if (done) return; done = true; clearTimeout(timer); resolve(v); },
      (e) => { if (done) return; done = true; clearTimeout(timer); reject(e); },
    );
  });
}

module.exports = { withTimeout };
