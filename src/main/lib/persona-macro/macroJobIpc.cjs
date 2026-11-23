'use strict';

/**
 * macroJobIpc.cjs — IPC handlers `macros:dispatch-job` and `macros:job-status`.
 * Thin wiring over dispatchMacroJob / macroJobStatuses; every dependency is
 * injected (index.cjs passes the real scheduler, createPrd and archive).
 *
 * deps: { schemas, validatePath, readActiveIndex, createPrd, loadJobs,
 *         archivePrd, appendResponseEventWithReason?, dispatchMacroJob?,
 *         macroJobStatuses?, readHistoryTail?, builtins?, listMacros?
 *         (default macroLibrary.listMacros), videoReview? (default
 *         project-pages/videoReview.cjs), listReviews?,
 *         checkProjectVideoToolRunnable? (default projectVideoToolCheck.cjs) }
 *
 * runToolJob is the one dispatch path: macros:dispatch-job calls it without a
 * review decision (but with the press's reviewStage opt-in); the
 * review-decision IPC calls it with one. After an ok dispatch of a project
 * Video tool — or of builtin-demo-video when the result has a stage ('review'
 * or 'final') — it records the entry's review dispatch (dispatch.json), so the
 * review card, Approve, Ask for changes and Retry can re-dispatch it. A plain
 * Demo Video press (stage null) records nothing.
 * Before dispatching a library 'project-video' tool with a job it runs
 * checkProjectVideoToolRunnable; a refusal returns { ok: false, error } with
 * no PRD written and the job-not-queued notice. Built-ins are never checked.
 *
 * When a dispatch returns ok:false for an Epic that exists in the cwd's
 * active-index.json (and no build is already running for it — `activeSlug`),
 * one durable 'response' event marked `notice: 'job-not-queued'` is appended
 * to that Epic naming the macro, the error and the retry path (PRD 2950), so
 * a job-macro Epic whose build never queued cannot read as a silently running
 * session. The append is best effort: it never changes the returned result.
 * `createPrd` is called as `chat:create-prd` calls it, so its own
 * remote.requestReconcile() queues the row at once — no second rescan here.
 */

const { dispatchMacroJob: realDispatch } = require('./macroJobDispatch.cjs');
const { macroJobStatuses: realStatuses } = require('./macroJobStatus.cjs');
const { BUILTIN_MACROS } = require('./builtinMacros.cjs');
const macroLibrary = require('./macroLibrary.cjs');

const JOB_NOT_QUEUED_NOTICE = 'job-not-queued';
/** The one built-in whose review-stage runs are recorded for the review card. */
const DEMO_VIDEO_ID = 'builtin-demo-video';

function noticeText(label, error) {
  return `${label} background build was not queued: ${error} — press it again in Project Home ▸ Tools to retry.`;
}

function defaultCheckRunnable() {
  return require('./projectVideoToolCheck.cjs').checkProjectVideoToolRunnable;
}

function defaultVideoReview() {
  return require('../project-pages/videoReview.cjs');
}

const findById = (list, id) => (Array.isArray(list) ? list : []).find((m) => m && m.id === id);

/** Built-in label first, then the library tool's label, then the id itself. */
async function appendNotice(deps, macros, cwd, macroId, epicId, error) {
  if (typeof deps.appendResponseEventWithReason !== 'function') return;
  try {
    const macro = findById(deps.builtins || BUILTIN_MACROS, macroId) || findById(macros, macroId);
    const label = (macro && macro.label) || macroId;
    const res = await deps.appendResponseEventWithReason(
      cwd, epicId, noticeText(label, error),
      { notice: JOB_NOT_QUEUED_NOTICE, allowInactive: true },
    );
    if (res && res.ok === false) console.warn('[macroJobIpc] job-not-queued notice not appended', epicId, res.reason);
  } catch (e) {
    console.warn('[macroJobIpc] job-not-queued notice append failed', epicId, e?.message ?? e);
  }
}

async function listLibraryMacros(deps) {
  const list = typeof deps.listMacros === 'function' ? deps.listMacros : macroLibrary.listMacros;
  const macros = await list();
  return Array.isArray(macros) ? macros : [];
}

/**
 * runToolJob(deps, { cwd, macroId, epicId, extraInstructions, inputValues, effort, review, reviewStage })
 * `cwd` must already be validated. Returns dispatchMacroJob's result.
 */
async function runToolJob(deps = {}, { cwd, macroId, epicId, extraInstructions, inputValues, effort, review, reviewStage } = {}) {
  const dispatch = deps.dispatchMacroJob || realDispatch;
  const index = deps.readActiveIndex(cwd);
  const sessions = index && index.sessions ? index.sessions : {};
  const entry = Object.prototype.hasOwnProperty.call(sessions, epicId) ? sessions[epicId] : null;
  const notActive = `epic ${epicId} is not an active session in this project`;
  if (!entry) return { ok: false, error: notActive };

  let macros = [];
  let result;
  try {
    macros = await listLibraryMacros(deps);
    if (entry.status !== 'active') {
      await appendNotice(deps, macros, cwd, macroId, epicId, notActive);
      return { ok: false, error: notActive };
    }
    const refusal = await projectVideoRefusal(deps, macros, cwd, macroId);
    if (refusal) {
      await appendNotice(deps, macros, cwd, macroId, epicId, refusal);
      return { ok: false, error: refusal };
    }
    const args = { cwd, macroId, epicId, extraInstructions, effort };
    if (inputValues !== undefined) args.inputValues = inputValues;
    if (review !== undefined) args.review = review;
    if (reviewStage !== undefined) args.reviewStage = reviewStage;
    const dispatchDeps = {
      createPrd: deps.createPrd,
      listRows: async () => deps.loadJobs(),
      archivePrd: (slug, rowCwd) => deps.archivePrd(slug, rowCwd),
      macros,
    };
    if (deps.builtins) dispatchDeps.builtins = deps.builtins;
    result = await dispatch(args, dispatchDeps);
  } catch (e) {
    await appendNotice(deps, macros, cwd, macroId, epicId, e?.message ?? String(e));
    throw e;
  }
  if (result && result.ok === false && !result.activeSlug) {
    await appendNotice(deps, macros, cwd, macroId, epicId, result.error || 'unknown error');
  }
  if (result && result.ok === true && result.entryId) {
    const isBuiltin = !!findById(deps.builtins || BUILTIN_MACROS, macroId);
    const tool = isBuiltin ? null : findById(macros, macroId);
    const reviewedBuiltin = isBuiltin && macroId === DEMO_VIDEO_ID && (result.stage === 'review' || result.stage === 'final');
    if (reviewedBuiltin || (tool && !tool.builtin && macroLibrary.isProjectVideoTool(tool, cwd))) {
      await recordToolDispatch(deps, cwd, result, { macroId, epicId, inputValues, extraInstructions });
    }
  }
  return result;
}

/**
 * The runnable-check error for a library 'project-video' tool with a job, or
 * null (built-ins, other macros and runnable tools).
 */
async function projectVideoRefusal(deps, macros, cwd, macroId) {
  if (findById(deps.builtins || BUILTIN_MACROS, macroId)) return null;
  const tool = findById(macros, macroId);
  if (!tool || tool.builtin || tool.surface !== 'project-video' || !tool.job || typeof tool.job !== 'object') return null;
  const check = deps.checkProjectVideoToolRunnable || defaultCheckRunnable();
  const verdict = await check({ cwd, agentName: tool.agentName, job: tool.job });
  return verdict && verdict.ok === false ? verdict.error : null;
}

/** Best effort: a failed record is logged and never changes the dispatch result. */
async function recordToolDispatch(deps, cwd, result, { macroId, epicId, inputValues, extraInstructions }) {
  try {
    const videoReview = deps.videoReview || defaultVideoReview();
    const rec = await videoReview.recordDispatch(cwd, result.entryId, {
      macroId,
      epicId,
      slug: result.slug,
      stage: result.stage || 'final',
      inputValues: inputValues && typeof inputValues === 'object' ? inputValues : {},
      extraInstructions: typeof extraInstructions === 'string' ? extraInstructions : '',
    });
    if (rec && rec.ok === false) console.warn('[macroJobIpc] review dispatch not recorded', result.entryId, rec.error);
  } catch (e) {
    console.warn('[macroJobIpc] review dispatch record failed', result.entryId, e?.message ?? e);
  }
}

function registerMacroJobIpc(ipcMain, deps = {}) {
  const statuses = deps.macroJobStatuses || realStatuses;

  ipcMain.handle('macros:dispatch-job', async (_event, rawPayload) => {
    const payload = deps.schemas.macrosDispatchJob.parse(rawPayload);
    const cwd = deps.validatePath(payload.cwd);
    return runToolJob(deps, {
      cwd,
      macroId: payload.macroId,
      epicId: payload.epicId,
      extraInstructions: payload.extraInstructions,
      inputValues: payload.inputValues,
      effort: payload.effort,
      reviewStage: payload.reviewStage,
    });
  });

  ipcMain.handle('macros:job-status', async (_event, rawPayload) => {
    const payload = deps.schemas.macrosJobStatus.parse(rawPayload);
    const cwd = deps.validatePath(payload.cwd);
    let macros = [];
    try {
      macros = await listLibraryMacros(deps);
    } catch (e) {
      console.warn('[macroJobIpc] macro library unreadable for job-status', e?.message ?? e);
    }
    return statuses({ cwd }, {
      loadJobs: deps.loadJobs,
      macros,
      ...(deps.readHistoryTail ? { readHistoryTail: deps.readHistoryTail } : {}),
      ...(deps.listReviews ? { listReviews: deps.listReviews } : {}),
    });
  });
}

module.exports = { registerMacroJobIpc, runToolJob, JOB_NOT_QUEUED_NOTICE };
