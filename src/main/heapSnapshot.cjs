/**
 * heapSnapshot.cjs — on-demand V8 heap snapshot of the RENDERER process,
 * written to disk without restarting the app and without opening a
 * `--remote-debugging-port`.
 *
 * Gated behind SM_HEAP_SNAPSHOT=1 (read fresh on every call, never cached at
 * require time, so a test can flip it per-case). With the flag unset:
 *   - registerIpc() registers no IPC channel.
 *   - buildMenuItem() returns null (nothing spliced into the Dev menu).
 *   - No timer, listener, or allocation is added anywhere.
 *
 * Uses webContents.takeHeapSnapshot(filePath) (Electron's own DevTools-
 * protocol capture) rather than a debugging port — this stays off by
 * default and never listens on a socket. capture() races the write against
 * a hard timeout so a stuck capture can't hang the caller (or a scheduler
 * job waiting on the same event loop) forever; it does not and cannot
 * cancel Electron's in-flight write, it only stops *waiting* on it.
 *
 * Kept free of `require('electron')` at module scope so it can be unit
 * tested with fake ipcMain/webContents objects, no Electron runtime needed.
 */

'use strict';

const path = require('node:path');
const os = require('node:os');
const fsp = require('node:fs/promises');

const CHANNEL = 'diagnostics:heap-snapshot';
const DEFAULT_TIMEOUT_MS = 3 * 60 * 1000; // 3 min — snapshots can be multi-hundred-MB

function isEnabled() {
  return process.env.SM_HEAP_SNAPSHOT === '1';
}

function snapshotDir() {
  return path.join(os.homedir(), '.claude', 'session-manager');
}

function timestampedFilename(now = new Date()) {
  return `heap-${now.toISOString().replace(/[:.]/g, '-')}.heapsnapshot`;
}

/**
 * @param {{ webContents: { takeHeapSnapshot(filePath: string): Promise<void> } }} win
 * @param {{ dir?: string, now?: Date, timeoutMs?: number }} [opts]
 * @returns {Promise<{ filePath: string, bytes: number|null, ms: number }>}
 */
async function captureSnapshot(win, opts = {}) {
  if (!isEnabled()) {
    throw new Error('Heap snapshot capture is disabled — set SM_HEAP_SNAPSHOT=1 and restart to enable.');
  }
  if (!win || win.isDestroyed?.() || !win.webContents) {
    throw new Error('No renderer window available to snapshot.');
  }
  const dir = opts.dir || snapshotDir();
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  await fsp.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, timestampedFilename(opts.now));

  const started = Date.now();
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Heap snapshot timed out after ${timeoutMs}ms (still writing ${filePath})`));
    }, timeoutMs);
  });
  try {
    await Promise.race([win.webContents.takeHeapSnapshot(filePath), timeout]);
  } finally {
    clearTimeout(timer);
  }

  const stat = await fsp.stat(filePath).catch(() => null);
  const result = { filePath, bytes: stat ? stat.size : null, ms: Date.now() - started };
  console.log(`[heapSnapshot] wrote ${filePath}${stat ? ` (${stat.size} bytes, ${result.ms}ms)` : ''}`);
  return result;
}

/**
 * Registers the IPC handler ONLY when SM_HEAP_SNAPSHOT=1. No-op otherwise —
 * this is the whole default-off contract for the renderer-facing trigger.
 * @param {{ ipcMain: { handle(channel: string, listener: Function): void } }} deps
 * @param {() => any} getWindow
 */
function registerIpc({ ipcMain, getWindow }) {
  if (!isEnabled()) return false;
  ipcMain.handle(CHANNEL, () => captureSnapshot(getWindow()));
  return true;
}

/**
 * Menu item template for the Dev menu, or null when disabled. index.cjs
 * splices this into its existing template — never builds a menu unless the
 * flag is set.
 * @param {() => any} getWindow
 */
function buildMenuItem(getWindow) {
  if (!isEnabled()) return null;
  return {
    label: 'Take Heap Snapshot (renderer)',
    click: async () => {
      try {
        const result = await captureSnapshot(getWindow());
        console.log(`[heapSnapshot] menu capture complete: ${result.filePath}`);
      } catch (err) {
        console.error('[heapSnapshot] menu capture failed:', err && err.message);
      }
    },
  };
}

module.exports = {
  CHANNEL,
  DEFAULT_TIMEOUT_MS,
  isEnabled,
  snapshotDir,
  timestampedFilename,
  captureSnapshot,
  registerIpc,
  buildMenuItem,
};
