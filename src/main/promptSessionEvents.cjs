'use strict';

/**
 * Main-process counterpart to promptSessions.ts's event chain, used ONLY by
 * the scheduler's PRD-finished notification path (notifyOriginatingTab,
 * scheduler.cjs). The renderer owns the live in-memory PromptSession store
 * and its own persistActiveIndex; this module never touches that store — it
 * reads/writes the SAME on-disk active-index.json directly, read-modify-
 * write, so a scheduler job (which runs in the main process, with no
 * renderer store to append to) can chain a 'response' event onto a known
 * session's tail without routing a synthetic prompt into an unrelated tab
 * (PRD 814).
 */

const config = require('./config.cjs');
// activeIndexPath/withPathLock come from epicMint.cjs so this module's
// read-modify-write of active-index.json (appendResponseEventIfKnown, below)
// serializes through the EXACT SAME lock instance as ensureEpic/
// appendPrdCreatedEvent and lib/activeIndexMerge.cjs's mergeActiveIndex — one
// lock across all three writers of this file, not three independent maps
// that could still interleave a stale read-modify-write past each other.
const { activeIndexPath: promptSessionActiveIndexPath, withPathLock } = require('./lib/epicMint.cjs');

// IPC channel broadcast whenever an event is appended to a PromptSession's
// chain from the main process (currently only the scheduler's response-event
// append below). Mirrors chatRunner.cjs's attachWindow/broadcast pattern.
const EVENT_APPENDED_CHANNEL = 'promptSession:event-appended';

let mainWindow = null;
function attachWindow(win) { mainWindow = win; }

function broadcast(channel, payload) {
  try {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send(channel, payload);
    }
  } catch { /* render frame may be gone */ }
}

let seq = 0;
function mintEventId() {
  seq += 1;
  return `pevt-${Date.now().toString(36)}-${seq}`;
}

/**
 * If `sourcePromptId` resolves to a known, still-active PromptSession under
 * `cwd`'s active-index.json, appends a 'response' event chained to that
 * session's current tail and returns true. Returns false (never throws) for
 * every case the caller must fall back on: missing cwd/id, no index file,
 * unknown id, a completed session, an empty event chain, or any I/O error —
 * so notifyOriginatingTab's existing tab-external-ticket path stays the
 * safety net, not a special case.
 *
 * The optional 4th argument stamps `prdSlug`/`outcome` onto the appended
 * event (PRD 976) — which PRD checked in and whether it completed, failed,
 * or needs review — so the Epic's own event chain keeps that signal even
 * after the job is archived out of queue.json. Both keys are added to the
 * event object only when present in `meta`, never as `undefined`-valued
 * keys, so events appended without them serialize identically to before.
 */
async function appendResponseEventIfKnown(cwd, sourcePromptId, text, meta = {}) {
  if (!cwd || !sourcePromptId) return false;
  const path = promptSessionActiveIndexPath(cwd);
  try {
    return await withPathLock(path, async () => {
      const result = await config.readJson(path);
      if (!result.exists || !result.data) return false;
      const data = result.data;
      const session = data.sessions && data.sessions[sourcePromptId];
      if (!session || session.status !== 'active') return false;
      const events = (data.events && data.events[sourcePromptId]) || [];
      const tail = events.length > 0 ? events[events.length - 1] : null;
      if (!tail) return false;
      const event = {
        id: mintEventId(),
        promptSessionId: sourcePromptId,
        kind: 'response',
        causedByEventId: tail.id,
        at: new Date().toISOString(),
        text,
      };
      if (meta && meta.prdSlug) event.prdSlug = meta.prdSlug;
      if (meta && meta.outcome) event.outcome = meta.outcome;
      data.events[sourcePromptId] = [...events, event];
      await config.writeJson(path, data, { writer: 'scheduler' });
      broadcast(EVENT_APPENDED_CHANNEL, { cwd, promptSessionId: sourcePromptId, event });
      return true;
    });
  } catch (e) {
    console.error('[promptSessionEvents] appendResponseEventIfKnown error', cwd, sourcePromptId, e);
    return false;
  }
}

module.exports = {
  appendResponseEventIfKnown,
  promptSessionActiveIndexPath,
  attachWindow,
  EVENT_APPENDED_CHANNEL,
};
