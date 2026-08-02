'use strict';

/**
 * activeIndexMerge.cjs — main-process read-merge-write for a cwd's
 * prompt-sessions/active-index.json, invoked over IPC by the renderer's
 * persistActiveIndex (state/promptSessions.ts). Moved here from the renderer
 * (which used to read-merge-write itself over config:read-json/
 * config:write-json, commit 3d12e19) to close two holes a purely-renderer
 * merge can't:
 *
 *  1. Resurrection: a second window that still holds an archived/deleted
 *     Epic as 'active'/'proposed' in its stale in-memory snapshot would
 *     write that row right back on its next persist — "memory wins on id
 *     collision" doesn't know the row was deliberately removed elsewhere.
 *     Fixed with a removal tombstone (index.tombstones, id -> removedAt
 *     ISO): an id present there is dropped from every future merge's memory
 *     contribution, not just from the write that performed the removal.
 *  2. TOCTOU: a renderer's own read (config:read-json) and write
 *     (config:write-json), round-tripped over IPC with no lock in between,
 *     left a gap where a main-process mint (epicMint.cjs's ensureEpic,
 *     itself serialized through its own withPathLock) could land and then
 *     be silently dropped by the renderer's subsequent write. Running the
 *     merge inside the SAME withPathLock instance epicMint.cjs already
 *     serializes ensureEpic/appendPrdCreatedEvent through closes the gap:
 *     every read-modify-write of this file, from either caller, is now one
 *     lock (epicMint.cjs exports withPathLock; requiring it here shares the
 *     same module-level Map via Node's require cache, not a second one).
 *
 * Tombstones are never auto-cleared: resumeArchived() (state/promptSessions.ts)
 * always mints a BRAND NEW Epic id + claudeSessionId — it never reuses the
 * archived id — so a tombstoned id is never legitimately reborn under the
 * current domain model. If that ever changes, this module would need an
 * explicit "un-tombstone" path; today one would be dead code.
 */

const { activeIndexPath, withPathLock } = require('./epicMint.cjs');
const config = require('../config.cjs');

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

// Mirrors state/promptSessions.ts's compareEventsChainAware exactly. Kept as
// a separate copy (not a shared module) since one side runs in the renderer
// and the other in Node — small and stable enough that duplicating it here
// is cheaper than wiring a cross-boundary shared module for one function.
function compareEventsChainAware(a, b) {
  const ta = Date.parse(a.at);
  const tb = Date.parse(b.at);
  const aValid = !Number.isNaN(ta);
  const bValid = !Number.isNaN(tb);
  if (aValid && bValid && ta !== tb) return ta - tb;
  if (b.causedByEventId === a.id) return -1;
  if (a.causedByEventId === b.id) return 1;
  if (aValid && bValid) return 0;
  if (aValid) return -1;
  if (bValid) return 1;
  return 0;
}

/**
 * mergeActiveIndex(cwd, { sessions, events, removedIds }) → Promise<{ sessions, events }>
 *
 * `sessions`/`events` are the CALLING renderer's own in-memory contribution
 * for this cwd only (already filtered to 'active'/'proposed' sessions by
 * persistActiveIndex) — never a full merged file; disk remains the source of
 * truth this function reads and reconciles against. Returns the merged
 * { sessions, events } actually written.
 */
async function mergeActiveIndex(cwd, { sessions: rawMemorySessions = {}, events: rawMemoryEvents = {}, removedIds = [] } = {}) {
  if (!cwd || typeof cwd !== 'string') throw new Error('mergeActiveIndex: cwd is required');
  const filePath = activeIndexPath(cwd);
  // Null-prototype copies of the CALLER'S OWN payload too: an Epic id equal
  // to "__proto__" is a plain string key from the caller's perspective, but
  // `rawMemoryEvents[id]` on a plain object literal resolves through the
  // prototype chain to Object.prototype itself (not undefined) rather than
  // hitting the `?? []` fallback below — same hazard as the disk-side merge
  // targets, just on the read side instead of the write side.
  const memorySessions = Object.assign(Object.create(null), rawMemorySessions);
  const memoryEvents = Object.assign(Object.create(null), rawMemoryEvents);
  return withPathLock(filePath, async () => {
    // Null-prototype targets: `sessions`/`events` are keyed by Epic id, which
    // for an IPC payload delivered via Electron's structured-clone (not
    // JSON.parse) could legitimately carry an own-enumerable "__proto__" key.
    // A plain-object target's bracket assignment (`obj[id] = x`) with
    // id === "__proto__" invokes Object.prototype's accessor and re-links the
    // object's own prototype instead of storing a normal entry — the same
    // hazard epicMint.cjs's hasOwn() helper guards reads against (see its
    // comment ~epicMint.cjs:61). A null-prototype target has no such accessor,
    // so "__proto__"/"constructor"/etc. behave as ordinary keys.
    let diskSessions = Object.create(null);
    let diskEvents = Object.create(null);
    let tombstones = Object.create(null);
    const result = await config.readJson(filePath);
    if (result.exists && result.data) {
      const disk = result.data;
      if (disk.sessions && typeof disk.sessions === 'object') Object.assign(diskSessions, disk.sessions);
      if (disk.events && typeof disk.events === 'object') Object.assign(diskEvents, disk.events);
      if (disk.tombstones && typeof disk.tombstones === 'object') Object.assign(tombstones, disk.tombstones);
    } else if (result.error || result.parseError) {
      // Genuine unreadable/corrupt disk index (fs error, or valid file that
      // failed JSON.parse) rather than "file legitimately doesn't exist yet".
      // config.readJson never throws (it reports failure via exists/error/
      // parseError, not exceptions), so this branch — not a try/catch — is
      // the only way to detect it. Falling back to this caller's own memory
      // contribution is still the best-effort choice (matches the old
      // renderer merge's contract), but silently doing so would recreate the
      // exact "unlogged data loss" incident this module exists to close —
      // any on-disk tombstones/other-window sessions get dropped, so log it.
      console.warn(
        `[activeIndexMerge] disk index unreadable for ${filePath} (error=${result.error ?? 'none'}, `
        + `parseError=${result.parseError ?? 'none'}) — falling back to this caller's in-memory contribution alone`,
      );
    }

    const now = new Date().toISOString();
    for (const id of removedIds) tombstones[id] = now;

    const mergedSessions = Object.assign(Object.create(null), diskSessions);
    for (const [id, session] of Object.entries(memorySessions)) {
      // Resurrection guard: a caller whose in-memory snapshot still thinks a
      // tombstoned id is open (it hasn't hydrated the removal yet) must not
      // write it back into the merged file.
      if (hasOwn(tombstones, id)) continue;
      mergedSessions[id] = session;
    }
    for (const id of removedIds) delete mergedSessions[id];

    // Events are a per-id UNION (same contract the renderer's own merge used
    // — PRD 855): a scheduler job appends events to disk under its narrow
    // delegation, so memory-wins-wholesale would silently drop any event
    // that landed since this caller's last hydrate. Memory order wins for
    // events both sides know; disk-only events are appended and re-sorted
    // chain-aware.
    const mergedEvents = Object.create(null);
    for (const id of Object.keys(mergedSessions)) {
      const memEvts = memoryEvents[id] ?? [];
      const diskEvts = diskEvents[id] ?? [];
      if (memEvts.length === 0) {
        mergedEvents[id] = diskEvts;
        continue;
      }
      const memIds = new Set(memEvts.map((e) => e.id));
      const missing = diskEvts.filter((e) => !memIds.has(e.id));
      mergedEvents[id] = missing.length > 0 ? [...memEvts, ...missing].sort(compareEventsChainAware) : memEvts;
    }

    const index = { sessions: mergedSessions, events: mergedEvents, tombstones };
    // Single-writer law: prompt-sessions/ is owned by 'epics'
    // (lib/opsOwnership.cjs) — hardcoded here, never taken from the IPC
    // payload, so a compromised/forged renderer call can't claim a
    // different writer id.
    await config.writeJson(filePath, index, { writer: 'epics' });
    return { sessions: mergedSessions, events: mergedEvents };
  });
}

function registerActiveIndexMergeHandlers() {
  const { ipcMain } = require('electron');
  const { schemas: s, validated: v } = require('../ipcSchemas.cjs');
  ipcMain.handle(
    'promptSessions:merge-active-index',
    v(s.promptSessionsMergeActiveIndex, ({ cwd, sessions, events, removedIds }) =>
      mergeActiveIndex(cwd, { sessions, events, removedIds: removedIds || [] })),
  );
}

module.exports = { mergeActiveIndex, registerActiveIndexMergeHandlers };
