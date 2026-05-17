/**
 * sendToRenderer.cjs — `webContents.send` with a destroyed-window guard.
 *
 * Every IPC-broadcasting module was open-coding `if (window && !window.isDestroyed())`
 * before invoking `webContents.send`. Forgetting the guard produces a hard
 * crash when a broadcast lands during teardown. Centralized here so new
 * broadcasters can't reintroduce the footgun.
 */
'use strict';

/**
 * Send a payload on a channel iff the BrowserWindow is alive.
 * No-ops on null/destroyed windows so callers don't need their own guards.
 */
function sendIfAlive(window, channel, payload) {
  if (window && !window.isDestroyed()) {
    window.webContents.send(channel, payload);
  }
}

module.exports = { sendIfAlive };
