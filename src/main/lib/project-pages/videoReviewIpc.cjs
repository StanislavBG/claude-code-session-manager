'use strict';

/**
 * videoReviewIpc.cjs — IPC handlers `project-videos:review-list` and
 * `project-videos:review-decide`: the human review step of a project Video
 * tool entry. Renderer IPC only — no admin route or MCP tool reaches a
 * decision, and nothing here mints an Epic.
 *
 *   approve  — starts the tool's final run in the Epic that built the entry
 *              (runToolJob, review { decision: 'approved', at }), then writes
 *              decision.json with that same `at`.
 *   changes  — re-runs the review stage with the owner's note, then writes
 *              decision.json with the note.
 *
 * A decision is written only after an ok dispatch. One decide per entry at a
 * time (module-level in-flight set), so a double click dispatches one run.
 *
 * deps: the same deps registerMacroJobIpc gets ({ schemas, validatePath,
 *       readActiveIndex, createPrd, loadJobs, archivePrd, ... }), plus
 *       optional videoReview / runToolJob / now overrides for tests.
 */

const INACTIVE_ERROR = 'the session that built this entry is no longer active — press the tool again';

/** In-flight decides, keyed `${cwd}\0${entryId}`. */
const inFlight = new Set();

function defaultVideoReview() {
  return require('./videoReview.cjs');
}

function defaultRunToolJob() {
  return require('../persona-macro/macroJobIpc.cjs').runToolJob;
}

/** '2026-11-22 13:05 PST' — the machine's local zone, 24-hour clock. */
function formatLocalAt(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    timeZoneName: 'short',
  }).formatToParts(date);
  const get = (type) => (parts.find((p) => p.type === type) || {}).value || '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')} ${get('timeZoneName')}`.trim();
}

/** Drop every 'Replace entry:' line, then name this entry. */
function replaceEntryInstructions(extra, entryId) {
  const kept = (typeof extra === 'string' ? extra : '')
    .split(/\r?\n/)
    .filter((l) => !/^\s*replace entry:/i.test(l))
    .join('\n')
    .trim();
  return [kept, `Replace entry: ${entryId}`].filter(Boolean).join('\n');
}

function epicIsActive(readActiveIndex, cwd, epicId) {
  if (typeof epicId !== 'string' || !epicId) return false;
  const index = readActiveIndex(cwd);
  const sessions = index && index.sessions ? index.sessions : {};
  if (!Object.prototype.hasOwnProperty.call(sessions, epicId)) return false;
  const entry = sessions[epicId];
  return !!entry && entry.status === 'active';
}

/** decide(deps, { cwd, entryId, decision, note }) — `cwd` already validated. */
async function decide(deps, { cwd, entryId, decision, note }) {
  const videoReview = deps.videoReview || defaultVideoReview();
  const runToolJob = deps.runToolJob || defaultRunToolJob();
  const key = `${cwd}\0${entryId}`;
  if (inFlight.has(key)) return { ok: false, error: 'a decision for this entry is already being sent' };
  inFlight.add(key);
  try {
    const trimmedNote = typeof note === 'string' ? note.trim() : '';
    if (decision === 'changes' && !trimmedNote) return { ok: false, error: 'a note is required to ask for changes' };

    const rev = await videoReview.readReview(cwd, entryId);
    if (!rev || rev.status !== 'waiting') {
      return { ok: false, error: `entry ${entryId} is not waiting for review (${rev ? rev.status : 'no review'})` };
    }
    const dispatch = rev.dispatch;
    if (!dispatch || typeof dispatch.macroId !== 'string' || !dispatch.macroId) {
      return { ok: false, error: `entry ${entryId} has no recorded tool run` };
    }
    if (!epicIsActive(deps.readActiveIndex, cwd, dispatch.epicId)) return { ok: false, error: INACTIVE_ERROR };

    const at = decision === 'approve' ? formatLocalAt(deps.now ? deps.now() : new Date()) : null;
    const review = decision === 'approve'
      ? { decision: 'approved', at }
      : { decision: 'changes', note: trimmedNote };

    const result = await runToolJob(deps, {
      cwd,
      macroId: dispatch.macroId,
      epicId: dispatch.epicId,
      inputValues: dispatch.inputValues && typeof dispatch.inputValues === 'object' ? dispatch.inputValues : {},
      extraInstructions: replaceEntryInstructions(dispatch.extraInstructions, entryId),
      review,
    });
    if (!result || result.ok !== true) {
      return { ok: false, error: (result && result.error) || 'dispatch failed' };
    }

    const written = await videoReview.writeDecision(cwd, entryId, decision === 'approve'
      ? { decision: 'approve', at }
      : { decision: 'changes', note: trimmedNote });
    if (!written || written.ok !== true) {
      return { ok: false, error: `run queued (${result.slug}) but the decision was not recorded: ${(written && written.error) || 'unknown error'}` };
    }
    return { ok: true, slug: result.slug, stage: result.stage, decision: written.decision };
  } finally {
    inFlight.delete(key);
  }
}

function registerVideoReviewIpc(ipcMain, deps = {}) {
  ipcMain.handle('project-videos:review-list', async (_event, rawPayload) => {
    const payload = deps.schemas.projectVideosReviewList.parse(rawPayload);
    const cwd = deps.validatePath(payload.cwd);
    const videoReview = deps.videoReview || defaultVideoReview();
    return videoReview.listReviews(cwd);
  });

  ipcMain.handle('project-videos:review-decide', async (_event, rawPayload) => {
    const payload = deps.schemas.projectVideosReviewDecide.parse(rawPayload);
    const cwd = deps.validatePath(payload.cwd);
    return decide(deps, {
      cwd,
      entryId: payload.entryId,
      decision: payload.decision,
      note: payload.note,
    });
  });
}

module.exports = { registerVideoReviewIpc, formatLocalAt, replaceEntryInstructions, INACTIVE_ERROR };
