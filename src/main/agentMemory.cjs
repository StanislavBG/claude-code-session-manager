/**
 * agentMemory.cjs — per-subagent memory backend.
 *
 * Distinct from the workspace-scoped Memory tool (memoryTool.cjs): this stores
 * memory entries keyed by **agentId** (the subagent name, e.g. "code-reviewer"),
 * not by workspace cwd. Conceptually mirrors Anthropic's "give each subagent its
 * own scratchpad" pattern.
 *
 * Storage: `~/.claude/session-manager/agent-memory/<agentId>.json`
 *
 *   {
 *     "agentId": "code-reviewer",
 *     "entries": [
 *       { "id": "mem_<ts>_<rand>", "body": "<markdown>",
 *         "category": "command|preference|pattern|failure|workflow" (optional),
 *         "createdAt": <epoch ms>, "updatedAt": <epoch ms> }
 *     ],
 *     "lastUpdated": <epoch ms>
 *   }
 *
 * Deviation from Unleashed (which keys by projectPath hash and writes to
 * `~/.claudecodeui/agent-memory/<hash>.json` with raw fs.writeFile): we key by
 * agentId per the user's spec, write under `~/.claude/session-manager/` (the
 * conventional spot for this app's own state), and route every mutation through
 * config.cjs's writeJson / validatePath helpers.
 *
 * Hard caps:
 *   - agentId must match /^[A-Za-z0-9._-]{1,128}$/
 *   - entryId must match /^[A-Za-z0-9._-]{1,128}$/
 *   - body up to 1 MiB
 *   - up to 200 entries per agent (oldest dropped when over cap on set())
 */

'use strict';

const { ipcMain } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const config = require('./config.cjs');

const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB
const MAX_ENTRIES = 200;
const AGENT_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const ENTRY_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

function rootDir() {
  return path.join(os.homedir(), '.claude', 'session-manager', 'agent-memory');
}

function recordPath(agentId) {
  if (!AGENT_ID_RE.test(agentId)) {
    throw new Error(`invalid agentId (must match ${AGENT_ID_RE.source})`);
  }
  return path.join(rootDir(), `${agentId}.json`);
}

async function ensureRoot() {
  await fsp.mkdir(rootDir(), { recursive: true });
}

function emptyRecord(agentId) {
  return { agentId, entries: [], lastUpdated: 0 };
}

async function loadRecord(agentId) {
  const abs = recordPath(agentId);
  const r = await config.readJson(abs).catch(() => ({ exists: false, data: null }));
  if (!r || !r.exists || !r.data) return emptyRecord(agentId);
  const data = r.data;
  if (!data || typeof data !== 'object' || !Array.isArray(data.entries)) {
    return emptyRecord(agentId);
  }
  return {
    agentId,
    entries: data.entries.filter(
      (e) => e && typeof e === 'object' && typeof e.id === 'string' && typeof e.body === 'string'
    ),
    lastUpdated: typeof data.lastUpdated === 'number' ? data.lastUpdated : 0,
  };
}

async function persist(record) {
  await ensureRoot();
  // Cap entry count: drop oldest by updatedAt (or createdAt) ascending.
  if (record.entries.length > MAX_ENTRIES) {
    record.entries = record.entries
      .slice()
      .sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0))
      .slice(0, MAX_ENTRIES);
  }
  const abs = recordPath(record.agentId);
  const out = { ...record, lastUpdated: Date.now() };
  await config.writeJson(abs, out);
  return out;
}

// ────────────────────────────────────────────────── handlers

async function list({ agentId }) {
  if (!AGENT_ID_RE.test(agentId || '')) {
    return { entries: [], agentId: agentId || '', error: 'invalid agentId' };
  }
  try {
    const record = await loadRecord(agentId);
    const entries = record.entries
      .slice()
      .sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0))
      .map((e) => ({
        id: e.id,
        body: e.body,
        category: e.category ?? null,
        createdAt: e.createdAt ?? 0,
        updatedAt: e.updatedAt ?? e.createdAt ?? 0,
        bytes: Buffer.byteLength(e.body, 'utf8'),
      }));
    return { entries, agentId, error: null };
  } catch (e) {
    return { entries: [], agentId, error: e.message };
  }
}

async function get({ agentId, entryId }) {
  if (!AGENT_ID_RE.test(agentId || '') || !ENTRY_ID_RE.test(entryId || '')) {
    return { entry: null, error: 'invalid id' };
  }
  try {
    const record = await loadRecord(agentId);
    const entry = record.entries.find((e) => e.id === entryId) ?? null;
    if (!entry) return { entry: null, error: null };
    return {
      entry: {
        id: entry.id,
        body: entry.body,
        category: entry.category ?? null,
        createdAt: entry.createdAt ?? 0,
        updatedAt: entry.updatedAt ?? entry.createdAt ?? 0,
        bytes: Buffer.byteLength(entry.body, 'utf8'),
      },
      error: null,
    };
  } catch (e) {
    return { entry: null, error: e.message };
  }
}

async function set({ agentId, entryId, body, category }) {
  if (!AGENT_ID_RE.test(agentId || '')) {
    return { ok: false, error: 'invalid agentId' };
  }
  if (!ENTRY_ID_RE.test(entryId || '')) {
    return { ok: false, error: 'invalid entryId' };
  }
  if (typeof body !== 'string') {
    return { ok: false, error: 'body must be a string' };
  }
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > MAX_BODY_BYTES) {
    return { ok: false, error: `body exceeds 1 MiB cap (${bytes} bytes)` };
  }
  try {
    const record = await loadRecord(agentId);
    const now = Date.now();
    const idx = record.entries.findIndex((e) => e.id === entryId);
    if (idx >= 0) {
      // Update — preserve createdAt
      record.entries[idx] = {
        ...record.entries[idx],
        id: entryId,
        body,
        category: category ?? record.entries[idx].category ?? null,
        updatedAt: now,
      };
    } else {
      // Enforce cap on create
      if (record.entries.length >= MAX_ENTRIES) {
        return { ok: false, error: `agent at ${MAX_ENTRIES}-entry cap` };
      }
      record.entries.push({
        id: entryId,
        body,
        category: category ?? null,
        createdAt: now,
        updatedAt: now,
      });
    }
    await persist(record);
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function deleteEntry({ agentId, entryId }) {
  if (!AGENT_ID_RE.test(agentId || '') || !ENTRY_ID_RE.test(entryId || '')) {
    return { ok: false, error: 'invalid id' };
  }
  try {
    const record = await loadRecord(agentId);
    const before = record.entries.length;
    record.entries = record.entries.filter((e) => e.id !== entryId);
    if (record.entries.length === before) {
      // No-op delete (entry didn't exist) — treat as success, same as fs unlink ENOENT.
      return { ok: true, error: null };
    }
    // If we just emptied the record, remove the file outright so listProjects()
    // doesn't report a stale ghost agent.
    if (record.entries.length === 0) {
      const abs = recordPath(agentId);
      let real;
      try {
        real = config.validatePath(abs);
        config.validateWrite(real);
        await fsp.unlink(real);
      } catch (e) {
        if (e.code !== 'ENOENT') {
          // Fall back to persisting an empty record; better than throwing.
          await persist(record);
        }
      }
      return { ok: true, error: null };
    }
    await persist(record);
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function listAgents() {
  try {
    await ensureRoot();
    const dir = rootDir();
    const r = await config.listDir(dir, { filesOnly: true });
    if (!r.ok) return { agents: [], error: r.error };
    const agents = r.entries
      .filter((e) => e.name.endsWith('.json'))
      .map((e) => ({
        agentId: e.name.replace(/\.json$/, ''),
        bytes: e.size,
        mtimeMs: e.mtimeMs,
      }))
      .sort((a, b) => a.agentId.localeCompare(b.agentId));
    return { agents, error: null };
  } catch (e) {
    return { agents: [], error: e.message };
  }
}

function registerAgentMemoryHandlers() {
  const { schemas: s, validated: v } = require('./ipcSchemas.cjs');
  ipcMain.handle('agent-memory:list', v(s.agentMemoryList, list));
  ipcMain.handle('agent-memory:get', v(s.agentMemoryGet, get));
  ipcMain.handle('agent-memory:set', v(s.agentMemorySet, set));
  ipcMain.handle('agent-memory:delete', v(s.agentMemoryDelete, deleteEntry));
  ipcMain.handle('agent-memory:list-agents', () => listAgents());
}

module.exports = {
  registerAgentMemoryHandlers,
  // exported for tests
  rootDir,
  recordPath,
  AGENT_ID_RE,
  ENTRY_ID_RE,
};
