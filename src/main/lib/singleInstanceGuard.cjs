/**
 * singleInstanceGuard.cjs — the losing side of Electron's single-instance
 * lock must actually terminate the process, not just request a quit.
 *
 * app.quit() only requests a graceful shutdown via the normal
 * window-all-closed -> quit -> exit chain; a losing instance calls it before
 * app.whenReady() ever fires (no window, no IPC), so there's nothing for
 * that chain to hook into and the process can sit as a zombie indefinitely.
 * app.exit() terminates immediately without waiting on that chain; the
 * setTimeout is a defense-in-depth backstop in case app.exit() itself is
 * ever delayed by an Electron internal on a future version.
 */
'use strict';

function terminateLosingInstance(app, { fallbackDelayMs = 2000 } = {}) {
  setTimeout(() => process.exit(0), fallbackDelayMs).unref?.();
  app.exit(0);
}

module.exports = { terminateLosingInstance };
