/**
 * voiceHotkey — F1 push-to-talk hotkey wiring (main process).
 *
 * Two layers per F1 v2 PRD:
 *   1. Window-local: mainWindow.webContents.on('before-input-event', …) —
 *      always on, fires before xterm, blocks the terminal via preventDefault.
 *   2. Global: globalShortcut.register(...) — opt-in via voice.json.global,
 *      always toggle-only (globalShortcut has no keyup signal).
 *
 * Precedence: when window is focused, globalShortcut is unregistered so the
 * window-local layer owns the chord. On blur we re-register if global=true.
 *
 * Wayland: globalShortcut is broken on Wayland in Electron 32–40 (see
 * electron#45607, #49806). For v1 we just disable global mode if
 * XDG_SESSION_TYPE=wayland and log a warn. The DBus portal probe is deferred.
 */

const { app, globalShortcut, ipcMain } = require('electron');
const voiceSettings = require('./voiceSettings.cjs');
const { voiceHotkeyLog } = require('./lib/voice-hotkey-log.cjs');
const { schemas, validated } = require('./ipcSchemas.cjs');

let mainWindow = null;
let currentConfig = null;
let beforeInputHandler = null;
// Per-press state for hold mode: we only care that *some* chord-member is
// held, then any chord-member keyup ends the press (PRD F1 v2 §Edge Cases #13).
let holdActive = false;
let globalRegisteredAccel = null;
// Suppress the first global callback within 500ms of registration to dodge
// the "key held during cold start" edge case (PRD §Edge Cases #4).
let globalRegisteredAt = 0;

/**
 * Map an Electron Accelerator string to a token set we can compare against
 * before-input-event Input. Handles CommandOrControl/Cmd/Ctrl/Alt/Option/
 * Shift/Super and a key (letter, F-key, or named key like Space).
 *
 * Complexity: O(p) per call where p = number of '+' segments (≤ 5 in practice).
 */
function parseAccelerator(accel) {
  if (typeof accel !== 'string' || !accel) return null;
  const parts = accel.split('+').map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return null; // PRD requires ≥1 modifier + 1 key
  const mods = { ctrl: false, meta: false, alt: false, shift: false };
  let key = null;
  for (const raw of parts) {
    const p = raw.toLowerCase();
    if (p === 'commandorcontrol') {
      if (process.platform === 'darwin') mods.meta = true;
      else mods.ctrl = true;
    } else if (p === 'cmd' || p === 'command' || p === 'super') {
      mods.meta = true;
    } else if (p === 'ctrl' || p === 'control') {
      mods.ctrl = true;
    } else if (p === 'alt' || p === 'option') {
      mods.alt = true;
    } else if (p === 'shift') {
      mods.shift = true;
    } else {
      // Normalize the key part so a hand-edited voice.json with `cmd+option+v`
      // still parses despite the schema regex requiring `[A-Z]`. Uppercase
      // single letters; leave F-keys / Space / digits as the user wrote them.
      key = raw.length === 1 ? raw.toUpperCase() : raw;
    }
  }
  if (!key) return null;
  return { mods, key };
}

/** True if the modifier flags on `input` exactly match `mods`. */
function modsMatch(input, mods) {
  return (
    !!input.control === mods.ctrl &&
    !!input.meta === mods.meta &&
    !!input.alt === mods.alt &&
    !!input.shift === mods.shift
  );
}

/** True if the input.key matches an accelerator key token. */
function keyMatches(input, key) {
  const ik = String(input.key || '').toLowerCase();
  const ic = String(input.code || '').toLowerCase();
  const kk = String(key).toLowerCase();
  if (ik === kk) return true;
  // Space: input.key may be ' ' (literal space) or 'space'.
  if (kk === 'space' && (ik === ' ' || ik === 'space' || ic === 'space')) return true;
  // Letters: input.code is 'KeyV' for V key. This is robust to dead-key
  // modifier substitutions on macOS (e.g. Option+V → '√' in input.key).
  if (kk.length === 1 && /[a-z0-9]/.test(kk) && ic === `key${kk}`) return true;
  // Digit row: input.code is 'Digit1' for '1'.
  if (/^[0-9]$/.test(kk) && ic === `digit${kk}`) return true;
  // F-keys: input.code matches 'F1'..'F24', case differs.
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(kk) && ic === kk) return true;
  return false;
}

/** True if `input.key` is one of the chord's modifier keys (for hold-end). */
function isChordMemberRelease(input, parsed) {
  const k = String(input.key || '').toLowerCase();
  if (parsed.mods.ctrl && (k === 'control')) return true;
  if (parsed.mods.meta && (k === 'meta' || k === 'cmd' || k === 'command' || k === 'os' || k === 'super')) return true;
  if (parsed.mods.alt && (k === 'alt' || k === 'option')) return true;
  if (parsed.mods.shift && (k === 'shift')) return true;
  return false;
}

function detachBeforeInput() {
  if (mainWindow && !mainWindow.isDestroyed() && beforeInputHandler) {
    try { mainWindow.webContents.removeListener('before-input-event', beforeInputHandler); } catch { /* */ }
  }
  beforeInputHandler = null;
  holdActive = false;
}

function attachBeforeInput() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  detachBeforeInput();
  const cfg = currentConfig;
  if (!cfg) return;
  const parsed = parseAccelerator(cfg.accelerator);
  if (!parsed) {
    voiceHotkeyLog('error', 'register-failed', {
      accelerator: cfg.accelerator,
      platform: process.platform,
      sessionType: process.env.XDG_SESSION_TYPE || null,
      reason: 'parse',
    });
    return;
  }

  const handler = (event, input) => {
    if (input.type !== 'keyDown' && input.type !== 'keyUp') return;
    // PRD F1 v2 §Auto-repeat: discard isAutoRepeat in main.
    if (input.isAutoRepeat) return;

    if (input.type === 'keyDown') {
      // For keyDown, both modifiers and the key must match exactly.
      if (!modsMatch(input, parsed.mods)) return;
      if (!keyMatches(input, parsed.key)) return;
      event.preventDefault();
      if (cfg.mode === 'hold') {
        if (holdActive) return; // ignore re-press while held
        holdActive = true;
        emitHotkey('down', 'window');
      } else {
        // Toggle: every fresh keyDown emits 'down'. Renderer state machine
        // decides whether that means start or stop.
        emitHotkey('down', 'window');
      }
      return;
    }

    // keyUp: in hold mode, any chord-member release ends the press
    // (PRD §Edge Cases #13 — modifier release timing).
    if (cfg.mode === 'hold' && holdActive) {
      const releaseEndsHold = keyMatches(input, parsed.key) || isChordMemberRelease(input, parsed);
      if (releaseEndsHold) {
        event.preventDefault();
        holdActive = false;
        emitHotkey('up', 'window');
      }
    }
  };

  mainWindow.webContents.on('before-input-event', handler);
  beforeInputHandler = handler;
}

function emitHotkey(phase, source) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('voice:hotkey', { phase, source });
  voiceHotkeyLog('info', phase === 'down' ? 'down' : 'up', { source });
}

function unregisterGlobal() {
  if (globalRegisteredAccel) {
    try { globalShortcut.unregister(globalRegisteredAccel); } catch { /* */ }
    globalRegisteredAccel = null;
  }
}

function registerGlobalIfWanted() {
  unregisterGlobal();
  const cfg = currentConfig;
  if (!cfg || !cfg.global) return;

  // Wayland: disable global for v1 (PRD §Wayland is experimental).
  if (process.platform === 'linux' && process.env.XDG_SESSION_TYPE === 'wayland') {
    voiceHotkeyLog('warn', 'global-disabled-wayland', {
      accelerator: cfg.accelerator,
      sessionType: 'wayland',
    });
    return;
    // TODO(F1-followup): DBus probe org.freedesktop.portal.GlobalShortcuts
    // and enable global mode when present (xdg-desktop-portal ≥ 1.17).
  }

  let ok = false;
  try {
    ok = globalShortcut.register(cfg.accelerator, () => {
      // Suppress callbacks within 500ms of registration (PRD §Edge Cases #4).
      if (Date.now() - globalRegisteredAt < 500) return;
      // Global is toggle-only (no keyup). Renderer state machine handles
      // arm/disarm regardless of configured mode.
      emitHotkey('down', 'global');
    });
  } catch (err) {
    voiceHotkeyLog('error', 'register-failed', {
      accelerator: cfg.accelerator,
      platform: process.platform,
      sessionType: process.env.XDG_SESSION_TYPE || null,
      reason: err && err.message ? err.message : 'unknown',
    });
    return;
  }

  if (ok) {
    globalRegisteredAccel = cfg.accelerator;
    globalRegisteredAt = Date.now();
    voiceHotkeyLog('info', 'register', {
      accelerator: cfg.accelerator,
      global: true,
      mode: cfg.mode,
      ok: true,
      sessionType: process.env.XDG_SESSION_TYPE || null,
    });
  } else {
    voiceHotkeyLog('warn', 'collision', {
      accelerator: cfg.accelerator,
      platform: process.platform,
    });
  }
}

function applyConfig(cfg) {
  currentConfig = cfg;
  attachBeforeInput();
  // If a focused window owns the chord, keep global unregistered until blur.
  const focused = mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused();
  if (focused) {
    unregisterGlobal();
  } else {
    registerGlobalIfWanted();
  }
  // Always log the window-local registration so the e2e test can see it
  // even if global is off / suppressed.
  voiceHotkeyLog('info', 'register', {
    accelerator: cfg.accelerator,
    global: !!cfg.global,
    mode: cfg.mode,
    ok: true,
    sessionType: process.env.XDG_SESSION_TYPE || null,
    layer: 'window',
  });
}

function attachWindow(win) {
  mainWindow = win;
  if (!mainWindow) return;
  attachBeforeInput();

  // Precedence: window focus → unregister global; blur → re-register.
  // Debounce focus 50ms so second-instance show()→focus() doesn't race
  // with a held chord. (PRD §requestSingleInstanceLock).
  // BrowserWindow emits `focus`/`blur` (not `browser-window-focus`/`-blur`,
  // which are app-level events). The legacy listener was a no-op.
  let focusDebounce = null;
  const onFocus = () => {
    if (focusDebounce) clearTimeout(focusDebounce);
    focusDebounce = setTimeout(() => unregisterGlobal(), 50);
  };
  const onBlur = () => {
    if (focusDebounce) { clearTimeout(focusDebounce); focusDebounce = null; }
    registerGlobalIfWanted();
  };
  mainWindow.on('focus', onFocus);
  mainWindow.on('blur', onBlur);
  mainWindow.on('closed', () => {
    if (focusDebounce) { clearTimeout(focusDebounce); focusDebounce = null; }
    try { mainWindow.removeListener('focus', onFocus); } catch { /* */ }
    try { mainWindow.removeListener('blur', onBlur); } catch { /* */ }
    detachBeforeInput();
    mainWindow = null;
  });
}

async function init(win) {
  attachWindow(win);
  currentConfig = await voiceSettings.load();
  applyConfig(currentConfig);
}

function registerHotkeyHandlers() {
  ipcMain.handle('voice:get-hotkey-config', async () => {
    if (!currentConfig) currentConfig = await voiceSettings.load();
    return currentConfig;
  });

  ipcMain.handle('voice:set-hotkey', validated(schemas.voiceSetHotkey, async (cfg) => {
    // voiceSettings.isValidConfig adds one cross-field check zod can't express
    // tersely (global=true + mode=hold is rejected, see PRD F1 v2). Keep it.
    if (!voiceSettings.isValidConfig(cfg)) {
      throw new Error('Invalid voice hotkey config');
    }
    await voiceSettings.save(cfg);
    currentConfig = await voiceSettings.load();
    applyConfig(currentConfig);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('voice:hotkey-changed', currentConfig);
    }
    return { ok: true, config: currentConfig };
  }));

  // F5 — device picker preference (additive subtree on voice.json).
  ipcMain.handle('voice:get-device-pref', async () => {
    return await voiceSettings.loadDevice();
  });

  ipcMain.handle('voice:set-device-pref', validated(schemas.voiceSetDevicePref, async (pref) => {
    await voiceSettings.saveDevice(pref);
    return { ok: true };
  }));

  // Renderer pings this when isRecording flips so we can prefix the window
  // title with `● REC — ` (PRD F1 v2 §Security: privacy invariant). This is
  // `ipcMain.on` (not handle), so we can't use the validated() helper —
  // safeParse inline and silently drop malformed payloads.
  ipcMain.on('voice:set-recording', (_e, recording) => {
    const parsed = schemas.voiceSetRecording.safeParse(recording);
    if (!parsed.success) return;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const baseTitle = 'Claude Session Manager';
    const next = parsed.data ? `● REC — ${baseTitle}` : baseTitle;
    try { mainWindow.setTitle(next); } catch { /* */ }
  });
}

function disposeOnQuit() {
  unregisterGlobal();
  detachBeforeInput();
}

module.exports = {
  init,
  registerHotkeyHandlers,
  disposeOnQuit,
  // exported for tests
  parseAccelerator,
};
