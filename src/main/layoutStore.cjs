/**
 * LayoutStore — persists the Workbench's ONE system dockview layout so
 * resizes/splits survive an electron restart.
 *
 * Storage: ~/.claude/session-manager/workbench-layout.json
 * Shape: { version: number, panels: string[], dockview: object, savedAt: number }
 *
 * `dockview` is dockview's own opaque `SerializedDockview` blob (from
 * `api.toJSON()`) — only the envelope (version + panels list) is validated
 * here; the blob itself is round-tripped verbatim so a dockview library
 * upgrade never bricks a saved layout. Unknown-panel pruning against the
 * live screen registry happens renderer-side (main has no knowledge of the
 * NavKey registry) before `api.fromJSON()` is called.
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { ipcMain } = require('electron');
const config = require('./config.cjs');

function storePath() {
  return path.join(os.homedir(), '.claude', 'session-manager', 'workbench-layout.json');
}

async function load() {
  const p = storePath();
  try {
    const raw = await fsp.readFile(p, 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || !Array.isArray(data.panels) || !data.dockview) {
      console.warn('[layoutStore] load: malformed shape, ignoring');
      return null;
    }
    return {
      version: typeof data.version === 'number' ? data.version : 1,
      panels: data.panels,
      dockview: data.dockview,
    };
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('[layoutStore] load failed:', e.message);
    return null;
  }
}

async function save({ version, panels, dockview }) {
  const payload = { version, panels, dockview, savedAt: Date.now() };
  await config.writeJson(storePath(), payload);
  return { ok: true };
}

function registerLayoutHandlers() {
  const { schemas: s, validated: v } = require('./ipcSchemas.cjs');
  ipcMain.handle('layout:load', () => load());
  ipcMain.handle('layout:save', v(s.layoutEnvelope, (payload) => save(payload)));
}

module.exports = { registerLayoutHandlers, load, save, storePath };
