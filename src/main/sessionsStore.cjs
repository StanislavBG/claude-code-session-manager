/**
 * SessionsStore — persists the renderer's tab list to disk so the app can
 * restore tabs + resume claude sessions after an electron restart.
 *
 * Storage: ~/.config/session-manager/tabs.json
 * Shape: { tabs: PersistedTab[], activeTabId: string | null, savedAt: number }
 *
 * Only serializable, durable fields are persisted: id, claudeSessionId, cwd,
 * label, presetId. Runtime-only fields (pid, status, startupCommand,
 * exitCode) are recomputed on boot.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { ipcMain } = require('electron');
const config = require('./config.cjs');

function storePath() {
  return path.join(os.homedir(), '.config', 'session-manager', 'tabs.json');
}

async function load() {
  const p = storePath();
  try {
    const raw = await fsp.readFile(p, 'utf8');
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.tabs)) return { tabs: [], activeTabId: null, freshStart: false };
    return {
      tabs: data.tabs,
      activeTabId: typeof data.activeTabId === 'string' ? data.activeTabId : null,
      freshStart: !!data.freshStart,
    };
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('[sessionsStore] load failed:', e.message);
    return { tabs: [], activeTabId: null, freshStart: false };
  }
}

async function save({ tabs, activeTabId, freshStart }) {
  const payload = { tabs, activeTabId, savedAt: Date.now() };
  if (freshStart) payload.freshStart = true;
  await config.writeJson(storePath(), payload);
  return { ok: true };
}

function registerSessionsHandlers() {
  const { schemas: s, validated: v } = require('./ipcSchemas.cjs');
  ipcMain.handle('sessions:load', () => load());
  ipcMain.handle('sessions:save', v(s.sessionsPayload, (payload) => save(payload)));
}

/** Rewrite persisted tabs with fresh session IDs so next boot starts new sessions. */
async function markFreshRestart() {
  const { tabs, activeTabId } = await load();
  if (tabs.length === 0) return;
  const crypto = require('node:crypto');
  const freshTabs = tabs.map((t) => ({
    ...t,
    claudeSessionId: crypto.randomUUID(),
  }));
  await save({ tabs: freshTabs, activeTabId, freshStart: true });
}

module.exports = { registerSessionsHandlers, load, save, storePath, markFreshRestart };
