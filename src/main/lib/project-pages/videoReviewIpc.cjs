'use strict';

/**
 * videoReviewIpc.cjs — IPC handlers `project-videos:review-list`,
 * `project-videos:review-decide` and `project-videos:review-retry`: the human
 * review step of a project Video tool entry or a built-in Demo Video entry
 * (dispatch.macroId 'builtin-demo-video') — decide/retry re-dispatch whatever
 * macroId dispatch.json recorded, with no tool lookup of their own. Renderer IPC only — no admin route or MCP tool reaches a
 * decision, and nothing here mints an Epic.
 *
 *   approve  — starts the tool's final run in the Epic that built the entry
 *              (runToolJob, review { decision: 'approved', at }), then writes
 *              decision.json with that same `at`.
 *   changes  — re-runs the review stage with the owner's note, then writes
 *              decision.json with the note.
 *
 *   retry    — an approved entry whose final run failed: re-dispatches the
 *              final stage with the recorded approval `at` and inputs; writes
 *              no decision; archives the old failed slug (best effort).
 *
 * A decision is written only after an ok dispatch. One decide/retry per entry
 * at a time (module-level in-flight set), so a double click dispatches one run.
 * review-list adds each entry's `job` (jobStatusesBySlug for dispatch.slug, or
 * null) and `canRetry` (retryable()).
 *
 * deps: the same deps registerMacroJobIpc gets ({ schemas, validatePath,
 *       readActiveIndex, createPrd, loadJobs, archivePrd, ... }), plus
 *       optional readHistoryTail, and videoReview / runToolJob /
 *       jobStatusesBySlug / now overrides for tests.
 */

const NOT_RETRYABLE_ERROR = 'only an approved entry whose final run failed can be retried';
const IN_FLIGHT_ERROR = 'a decision or retry for this entry is already in progress';
const INACTIVE_ERROR = 'the session that built this entry is no longer active — press the tool again';

/** In-flight decides and retries (they share one slot per entry), keyed `${cwd}\0${entryId}`. */
const inFlight = new Set();

function defaultVideoReview() {
  return require('./videoReview.cjs');
}

function defaultJobStatusesBySlug() {
  return require('../persona-macro/macroJobStatus.cjs').jobStatusesBySlug;
}

/**
 * retryable(review, job) -> boolean. Pure. True only for an approved entry
 * (decision 'approve' with a non-empty at) whose recorded final-stage run's
 * job ended failed. No job row counts as not failed.
 */
function retryable(review, job) {
  if (!review || review.status !== 'approved') return false;
  const d = review.decision;
  if (!d || d.decision !== 'approve' || typeof d.at !== 'string' || !d.at.trim()) return false;
  if (!review.dispatch || review.dispatch.stage !== 'final') return false;
  return !!job && job.state === 'failed';
}

/** { [slug]: job | null } for the given reviews' dispatch slugs. */
async function jobsFor(deps, cwd, reviews) {
  const bySlug = deps.jobStatusesBySlug || defaultJobStatusesBySlug();
  const slugs = reviews.map((r) => r && r.dispatch && r.dispatch.slug).filter((s) => typeof s === 'string' && s);
  if (!slugs.length) return {};
  const io = { loadJobs: deps.loadJobs };
  if (typeof deps.readHistoryTail === 'function') io.readHistoryTail = deps.readHistoryTail;
  try {
    return (await bySlug({ cwd, slugs }, io)) || {};
  } catch {
    return {};
  }
}

function jobOf(jobs, review) {
  const slug = review && review.dispatch && review.dispatch.slug;
  return (typeof slug === 'string' && slug && jobs[slug]) || null;
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
  if (inFlight.has(key)) return { ok: false, error: IN_FLIGHT_ERROR };
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

/** retry(deps, { cwd, entryId }) — `cwd` already validated. Writes no decision. */
async function retry(deps, { cwd, entryId }) {
  const videoReview = deps.videoReview || defaultVideoReview();
  const runToolJob = deps.runToolJob || defaultRunToolJob();
  const key = `${cwd}\0${entryId}`;
  if (inFlight.has(key)) return { ok: false, error: IN_FLIGHT_ERROR };
  inFlight.add(key);
  try {
    const rev = await videoReview.readReview(cwd, entryId);
    const job = rev ? jobOf(await jobsFor(deps, cwd, [rev]), rev) : null;
    if (!retryable(rev, job)) return { ok: false, error: NOT_RETRYABLE_ERROR };
    const dispatch = rev.dispatch;
    if (typeof dispatch.macroId !== 'string' || !dispatch.macroId) return { ok: false, error: NOT_RETRYABLE_ERROR };
    const oldSlug = dispatch.slug;

    const result = await runToolJob(deps, {
      cwd,
      macroId: dispatch.macroId,
      epicId: dispatch.epicId,
      inputValues: dispatch.inputValues && typeof dispatch.inputValues === 'object' ? dispatch.inputValues : {},
      extraInstructions: replaceEntryInstructions(dispatch.extraInstructions, entryId),
      review: { decision: 'approved', at: rev.decision.at },
    });
    if (result && result.ok === true && typeof deps.archivePrd === 'function' && oldSlug && oldSlug !== result.slug) {
      try { await deps.archivePrd(oldSlug, cwd); } catch { /* best effort */ }
    }
    return result;
  } finally {
    inFlight.delete(key);
  }
}

function registerVideoReviewIpc(ipcMain, deps = {}) {
  ipcMain.handle('project-videos:review-list', async (_event, rawPayload) => {
    const payload = deps.schemas.projectVideosReviewList.parse(rawPayload);
    const cwd = deps.validatePath(payload.cwd);
    const videoReview = deps.videoReview || defaultVideoReview();
    const reviews = await videoReview.listReviews(cwd);
    const list = Array.isArray(reviews) ? reviews : [];
    const jobs = await jobsFor(deps, cwd, list);
    return list.map((r) => {
      const job = jobOf(jobs, r);
      return { ...r, job, canRetry: retryable(r, job) };
    });
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

  ipcMain.handle('project-videos:review-retry', async (_event, rawPayload) => {
    const payload = deps.schemas.projectVideosReviewRetry.parse(rawPayload);
    const cwd = deps.validatePath(payload.cwd);
    return retry(deps, { cwd, entryId: payload.entryId });
  });
}

module.exports = {
  registerVideoReviewIpc, formatLocalAt, replaceEntryInstructions, retryable,
  INACTIVE_ERROR, NOT_RETRYABLE_ERROR,
};
