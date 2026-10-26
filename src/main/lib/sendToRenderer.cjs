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
 * Send a payload on a channel iff the BrowserWindow AND its render frame are alive.
 * No-ops on null/destroyed windows so callers don't need their own guards.
 *
 * `window.isDestroyed()` alone is insufficient: during a reload/navigation the
 * BrowserWindow stays alive while its underlying render frame (WebFrameMain) is
 * disposed and recreated. In that window, `webContents.send` throws
 * "Render frame was disposed before WebFrameMain could be accessed". The frame
 * can also vanish between our check and the send (TOCTOU), so we both probe the
 * webContents state and wrap the send in try/catch.
 */
function sendIfAlive(window, channel, payload) {
  sendToWindow(window, channel, payload);
  // Remote fanout runs even when the window is gone (web clients outlive it) and never throws.
  if (_remoteFanout) {
    try {
      _remoteFanout(channel, payload);
    } catch {
      // A broken remote subscriber must never break the Electron send path.
    }
  }
}

function sendToWindow(window, channel, payload) {
  if (!window || window.isDestroyed()) return;
  const wc = window.webContents;
  if (!wc || wc.isDestroyed() || wc.isCrashed?.()) return;
  try {
    wc.send(channel, payload);
  } catch {
    // Render frame disposed mid-send (reload/teardown race). Drop the message —
    // a stale frame has no listener anyway.
  }
}

/** @type {((channel: string, payload: unknown) => void) | null} */
let _remoteFanout = null;

/** Register (or clear with null) the fanout that mirrors every push to E2E web clients. */
function setRemoteFanout(fn) {
  _remoteFanout = typeof fn === 'function' ? fn : null;
}

module.exports = { sendIfAlive, setRemoteFanout };
