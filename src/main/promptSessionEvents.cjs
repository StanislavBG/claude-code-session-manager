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
 * session's current tail and returns `{ ok: true }`. Returns `{ ok: false,
 * reason }` (never throws) for every case the caller must fall back on:
 *
 *   'missing-args' — cwd or sourcePromptId not given.
 *   'no-index'     — no active-index.json for this cwd, or it has no data.
 *   'no-session'   — sourcePromptId is not a known session.
 *   'not-active'   — the session exists but has already completed.
 *   'no-events'    — the session has no event chain to append onto.
 *   'error'        — a caught exception (e.g. a disk read/write failure).
 *
 * `'error'` is the only reason worth retrying — every other reason means the
 * session or event chain genuinely is not there to append to, and trying
 * again later cannot change that. flushDueReviewNotices (scheduler.cjs)
 * uses exactly that split to decide whether to hold a notice back for one
 * more pass or give up on it.
 *
 * The optional 4th argument stamps `prdSlug`/`outcome` onto the appended
 * event (PRD 976) — which PRD checked in and whether it completed, failed,
 * or needs review — so the Epic's own event chain keeps that signal even
 * after the job is archived out of queue.json. PRD 986 extends the same
 * meta arg (not a fifth positional parameter) with `validation`: a
 * scheduler check-in is born `'unvalidated'` — never `'verified'` —
 * regardless of the job's self-reported outcome; the authoring Epic's own
 * validation pass is what may later move it to 'verified'/'refuted'. All
 * keys are added to the event object only when present in `meta`, never as
 * `undefined`-valued keys, so events appended without them serialize
 * identically to before.
 */
async function appendResponseEventWithReason(cwd, sourcePromptId, text, meta = {}) {
  if (!cwd || !sourcePromptId) return { ok: false, reason: 'missing-args' };
  const path = promptSessionActiveIndexPath(cwd);
  try {
    return await withPathLock(path, async () => {
      const result = await config.readJson(path);
      if (!result.exists || !result.data) return { ok: false, reason: 'no-index' };
      const data = result.data;
      const session = data.sessions && data.sessions[sourcePromptId];
      if (!session) return { ok: false, reason: 'no-session' };
      if (session.status !== 'active') return { ok: false, reason: 'not-active' };
      const events = (data.events && data.events[sourcePromptId]) || [];
      const tail = events.length > 0 ? events[events.length - 1] : null;
      if (!tail) return { ok: false, reason: 'no-events' };
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
      if (meta && meta.validation) event.validation = meta.validation;
      data.events[sourcePromptId] = [...events, event];
      await config.writeJson(path, data, { writer: 'scheduler' });
      broadcast(EVENT_APPENDED_CHANNEL, { cwd, promptSessionId: sourcePromptId, event });
      return { ok: true };
    });
  } catch (e) {
    console.error('[promptSessionEvents] appendResponseEventWithReason error', cwd, sourcePromptId, e);
    return { ok: false, reason: 'error' };
  }
}

/**
 * appendResponseEventIfKnown(cwd, sourcePromptId, text, meta) → Promise<boolean>
 *
 * Boolean-only wrapper around appendResponseEventWithReason, for every
 * caller that only needs "did it go out", not why — notifyOriginatingTab's
 * existing tab-external-ticket fallback stays keyed on this boolean.
 */
async function appendResponseEventIfKnown(cwd, sourcePromptId, text, meta = {}) {
  const result = await appendResponseEventWithReason(cwd, sourcePromptId, text, meta);
  return result.ok;
}

module.exports = {
  appendResponseEventIfKnown,
  appendResponseEventWithReason,
  promptSessionActiveIndexPath,
  attachWindow,
  EVENT_APPENDED_CHANNEL,
};
