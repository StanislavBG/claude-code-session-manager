/**
 * macroAdminRoutes.cjs — loopback admin HTTP routes so an agent session (via
 * the scheduler MCP) can list, create/update and delete a HOT KEYS macro
 * for its own project, through the existing macroLibrary.cjs store:
 *   GET  /admin/macros?cwd=…                          -> { ok, macros }
 *   POST /admin/macros/save  {cwd, id?, label, agentName, tag, prompt, inputs?, surface?, job?, voiceId?}
 *   POST /admin/macros/delete {cwd, id, originClaudeSessionId?}
 *                                                     -> { ok, deleted, macro }
 * delete removes the macro from THIS project through
 * macroLibrary.removeMacroFromProject (deleted:false when other projects still
 * list it), fires onChanged once and appends one `admin_macro_delete` audit
 * event on success; every refusal is a 400 with no onChanged and no audit.
 *
 * cwd resolution matches projectHomeAdminRoutes.cjs's resolveCwd exactly
 * (reused, not copied). `surface` ('sessions' | 'project-home') is accepted on
 * create and update; a create defaults it to 'sessions' and `projects` to
 * [resolvedCwd]. A Project Home tool is part of Session Manager and shown in
 * every project's Project Home, so any save whose resulting surface is
 * 'project-home' stores projects ["*"]; only what it generates is per project.
 * `projects` is accepted ONLY as exactly ["*"] (show in every
 * project); anything else is a 400. An update without `projects` leaves them
 * unchanged. An update is refused (400) if the macro is not visible to the
 * resolved cwd (macroLibrary.macroVisibleIn, so '*' macros are reachable), if
 * `id` starts with `builtin-`, or if `id` is not found. Field validation
 * reuses macroLibrary's `MacroSaveSchema`.
 *
 * A save whose existing or resulting macro is shown in every project needs a
 * VERIFIED human request: body.humanRequestQuote must appear in a prompt the
 * human typed into body.originClaudeSessionId (humanPromptLedger) AND name
 * every/all projects (or, for a 'project-home' macro, Project Home). Otherwise 400, no write, no onChanged, no audit.
 *
 * A save whose resulting surface is 'project-video' (one project's own Video
 * tool, Project Home ▸ Video) may carry `job` (forwarded to saveMacro), always
 * needs the same verified quote as a 'project-home' save, and ignores a
 * caller's `projects`: a create stores [resolvedCwd], an update keeps the
 * stored projects, so the library refuses a '*' or multi-project macro.
 *
 * Before the write, a save whose resulting macro is surface 'project-video'
 * with a job (the sent job, or the stored one an update keeps) runs
 * projectVideoToolCheck's checkProjectVideoToolRunnable (deps-injectable) for
 * the resolved cwd and persona; a refusal is a 400 with the helper's error.
 *
 * Every successful save appends one `admin_macro_save` audit event and calls
 * `onChanged()` exactly once so the Sessions HOT KEYS strip updates live,
 * matching the IPC handlers in index.cjs.
 *
 * POST /admin/macros/run {cwd, id, inputs?, effort?, externalRef?, caller?}
 *                                -> { ok, epicId, alreadyRunning, externalRef? }
 * Starts a saved macro from a script (e.g. a systemd timer) through the
 * renderer's press path (deps.startExternalNewSession: same persona, tag, AIM
 * prompt and source.macroId, so autoStartTargets apply). Refused (400, no
 * launch) unless a human ticked 'Can be started by a script' (scriptStart)
 * on a visible, non-builtin, non-job macro whose persona is listed. {{inputs}}
 * = the macro's defaults overlaid by `inputs`. While that macro's Epic is
 * still running in the cwd it returns that Epic (alreadyRunning:true) instead
 * of a second start. A launch failure is a 503 with no audit event.
 * externalRef (normalizeExternalRef; invalid = 400), e.g. a date, starts the
 * macro at most once per ref: it rides in the payload, is recorded in
 * externalRefIndex and audited; a repeat with the same cwd + ref answers
 * { existing: true } with that Epic (409 if another producer/macro owns the ref).
 * caller ({pipeline?, runId?, step?, attempt?}, CallerSchema in
 * epic/scriptStartedBy.cjs; invalid = 400, no launch) rides in the audit event as scriptCaller (the audit log stamps its own `caller`);
 * every launch payload carries startedBy (deps.startedByFromRequest) so the Epic
 * records it was script-started. The mint producer stays 'new-epic-ui'.
 *   curl -s -X POST "http://127.0.0.1:$(jq -r .port ~/.claude/session-manager/admin-api.json)/admin/macros/run" -H "Authorization: Bearer $(jq -r .token ~/.claude/session-manager/admin-api.json)" -H 'Content-Type: application/json' -d '{"cwd":"/abs/project","id":"<macro-id>"}'
 */
'use strict';

const { readBody, sendJson } = require('./localAdminHttp.cjs');
const { usageHeldBody } = require('../scheduler/usageHoldRoute.cjs');
const { resolveCwd } = require('./projectHomeAdminRoutes.cjs');
const macroLibrary = require('../persona-macro/macroLibrary.cjs');
const { appendAuditEvent } = require('../telemetry/auditLog.cjs');
const { findHumanPromptContaining } = require('./humanPromptLedger.cjs');
const { readActiveIndex } = require('../epic/epicMint.cjs');
const { PRD_EFFORT_LEVELS } = require('../prd/prdFrontmatter.cjs');
const { CallerSchema, startedByFromRequest: defaultStartedByFromRequest } = require('../epic/scriptStartedBy.cjs');
const { normalizeExternalRef } = require('../epic/externalRef.cjs');
const { findEpicByExternalRef, recordExternalRef, withExternalRefLock } = require('../epic/externalRefIndex.cjs');

const EVERY_PROJECT_RE = /(^|[^a-z0-9])(every|all|each)\s+(of\s+)?(my\s+|the\s+|our\s+)?projects?($|[^a-z0-9])/;

/** True when the quote asks for every/all projects (or "everywhere"). */
function quoteNamesEveryProject(quote) {
  if (typeof quote !== 'string') return false;
  const q = quote.toLowerCase().replace(/[-_]/g, ' ');
  return EVERY_PROJECT_RE.test(q) || /(^|[^a-z0-9])everywhere($|[^a-z0-9])/.test(q);
}

const PROJECT_HOME_RE = /(^|[^a-z0-9])project\s*home($|[^a-z0-9])/;

/** True when the quote names Project Home (project home / project-home / project_home). */
function quoteNamesProjectHome(quote) {
  if (typeof quote !== 'string') return false;
  const q = quote.toLowerCase().replace(/[-_]/g, ' ');
  return PROJECT_HOME_RE.test(q);
}

const PROJECT_VIDEO_HINT =
  "a Project Video tool (Project Home ▸ Video, this project only) needs humanRequestQuote (the human's words naming Project Home); the human can add one from Project Home ▸ Video";
const HUMAN_HINT = "the human can set 'Show in every project' in the macro editor";
const PROJECT_HOME_HINT =
  "a Project Home tool is shown in every project's Project Home, so it needs humanRequestQuote (the human's words asking for a Project Home tool); the human can add one from Project Home ▸ Tools ▸ Add a tool";

/** Fail-closed check that a human asked for an all-projects macro (or a Project Home / Project Video tool). */
function verifyAllProjectsRequest(body, { projectHome = false, projectVideo = false } = {}) {
  const hint = projectVideo ? PROJECT_VIDEO_HINT : projectHome ? PROJECT_HOME_HINT : HUMAN_HINT;
  const what = projectVideo ? 'a Project Video tool' : 'a macro shown in every project';
  const quote = body.humanRequestQuote;
  if (typeof quote !== 'string' || !quote.trim()) {
    return { ok: false, reason: `${what} needs humanRequestQuote (a verbatim human request); ${hint}` };
  }
  const origin = body.originClaudeSessionId;
  if (typeof origin !== 'string' || origin.length < 1 || origin.length > 128) {
    return { ok: false, reason: `${what} needs originClaudeSessionId (1-128 chars); ${hint}` };
  }
  if (!findHumanPromptContaining(origin, quote)) {
    return { ok: false, reason: `humanRequestQuote was not found in a prompt the human typed in this session; ${hint}` };
  }
  if (!quoteNamesEveryProject(quote) && !(projectHome && quoteNamesProjectHome(quote))) {
    const named = projectHome ? 'Project Home or every/all projects' : 'every/all projects';
    return { ok: false, reason: `humanRequestQuote does not name ${named}; ${hint}` };
  }
  return { ok: true, quote };
}

/** Read + parse a JSON object body; on failure sends the 400 and returns null. */
async function readJsonBody(req, res) {
  let raw;
  try {
    raw = await readBody(req);
  } catch (e) {
    sendJson(res, 400, { ok: false, error: `request body rejected: ${e?.message ?? 'unreadable'}` });
    return null;
  }
  let body;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
    return null;
  }
  if (body === null || typeof body !== 'object') {
    sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
    return null;
  }
  return body;
}

function listHandler(onChanged, libOpts) {
  return async (_req, res, query) => {
    const resolved = resolveCwd(query.get('cwd'));
    if (!resolved.ok) {
      sendJson(res, resolved.status, { ok: false, error: resolved.error });
      return;
    }
    const macros = await macroLibrary.listMacros(libOpts);
    const visible = macros.filter(
      (m) => m.projects.includes(resolved.cwd) || m.projects.includes(macroLibrary.ALL_PROJECTS),
    );
    sendJson(res, 200, { ok: true, macros: visible });
  };
}

function saveHandler(onChanged, libOpts, deps = {}) {
  return async (req, res) => {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const resolved = resolveCwd(body.cwd);
    if (!resolved.ok) {
      sendJson(res, resolved.status, { ok: false, error: resolved.error });
      return;
    }
    if (typeof body.id === 'string' && body.id.startsWith('builtin-')) {
      sendJson(res, 400, { ok: false, error: 'built-in macros cannot be edited through this route' });
      return;
    }
    let input;
    try {
      input = macroLibrary.MacroSaveSchema.parse({
        id: body.id,
        label: body.label,
        agentName: body.agentName,
        tag: body.tag,
        prompt: body.prompt,
        inputs: body.inputs,
        surface: body.surface,
        job: body.job,
        voiceId: body.voiceId,
      });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e?.issues?.[0]?.message ?? e?.message ?? 'invalid payload' });
      return;
    }
    let existing;
    if (input.id) {
      const macros = await macroLibrary.listMacros(libOpts);
      existing = macros.find((m) => m.id === input.id);
      if (!existing) {
        sendJson(res, 400, { ok: false, error: `macro not found: ${input.id}` });
        return;
      }
      if (!macroLibrary.macroVisibleIn(existing, resolved.cwd)) {
        sendJson(res, 400, { ok: false, error: `macro ${input.id} is not visible to ${resolved.cwd}` });
        return;
      }
    }
    const resultSurface = input.surface ?? existing?.surface ?? 'sessions';
    const projectHome = resultSurface === 'project-home';
    // A Project Video tool belongs to the resolved project only: a caller's `projects` is ignored.
    const projectVideo = resultSurface === 'project-video';
    const p = projectVideo ? undefined : body.projects;
    if (p !== undefined && !(Array.isArray(p) && p.length === 1 && p[0] === macroLibrary.ALL_PROJECTS)) {
      sendJson(res, 400, { ok: false, error: 'projects: only ["*"] is accepted; omit it to use the current project' });
      return;
    }
    const wantsAll = p !== undefined;
    const allProjects = Boolean(existing?.projects.includes(macroLibrary.ALL_PROJECTS)) || wantsAll || projectHome;
    let quote = null;
    if (allProjects || projectVideo) {
      const v = verifyAllProjectsRequest(body, { projectHome: projectHome || projectVideo, projectVideo });
      if (!v.ok) {
        sendJson(res, 400, { ok: false, error: v.reason });
        return;
      }
      quote = v.quote;
    }
    if (!input.id) {
      input = {
        ...input,
        projects: (wantsAll || projectHome) && !projectVideo ? [macroLibrary.ALL_PROJECTS] : [resolved.cwd],
        surface: input.surface ?? 'sessions',
      };
    } else if ((wantsAll || projectHome) && !projectVideo) {
      input = { ...input, projects: [macroLibrary.ALL_PROJECTS] };
    }
    const resultJob = input.job !== undefined ? input.job : existing?.job;
    if (projectVideo && resultJob && typeof resultJob === 'object') {
      const check = deps.checkProjectVideoToolRunnable
        || require('../persona-macro/projectVideoToolCheck.cjs').checkProjectVideoToolRunnable;
      const verdict = await check({ cwd: resolved.cwd, agentName: input.agentName ?? existing?.agentName, job: resultJob });
      if (!verdict || verdict.ok === false) {
        sendJson(res, 400, { ok: false, error: verdict?.error ?? 'project-video tool check failed' });
        return;
      }
    }
    let macro;
    try {
      macro = await macroLibrary.saveMacro(input, libOpts);
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e?.message ?? 'save failed' });
      return;
    }
    const origin = body.originClaudeSessionId;
    appendAuditEvent('admin_macro_save', {
      route: '/admin/macros/save',
      cwd: resolved.cwd,
      macroId: macro.id,
      projects: macro.projects,
      surface: macro.surface,
      created: !input.id,
      humanRequestQuote: quote,
      originClaudeSessionId: typeof origin === 'string' && origin.length >= 1 && origin.length <= 128 ? origin : null,
    });
    if (onChanged) onChanged();
    sendJson(res, 200, { ok: true, macro });
  };
}

function deleteHandler(onChanged, libOpts) {
  return async (req, res) => {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const resolved = resolveCwd(body.cwd);
    if (!resolved.ok) {
      sendJson(res, resolved.status, { ok: false, error: resolved.error });
      return;
    }
    if (typeof body.id !== 'string' || !body.id) {
      sendJson(res, 400, { ok: false, error: 'id is required' });
      return;
    }
    let result;
    try {
      result = await macroLibrary.removeMacroFromProject({ id: body.id, cwd: resolved.cwd }, libOpts);
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e?.issues?.[0]?.message ?? e?.message ?? 'delete failed' });
      return;
    }
    if (!result.ok) {
      sendJson(res, 400, result);
      return;
    }
    const origin = body.originClaudeSessionId;
    appendAuditEvent('admin_macro_delete', {
      route: '/admin/macros/delete',
      cwd: resolved.cwd,
      deleted: result.deleted,
      macro: result.macro,
      originClaudeSessionId: typeof origin === 'string' && origin.length >= 1 && origin.length <= 128 ? origin : null,
    });
    if (onChanged) onChanged();
    sendJson(res, 200, result);
  };
}

const RUN_INPUT_MAX_KEYS = 20;
const RUN_INPUT_MAX_LEN = 2000;
const RECENT_START_MS = 60_000;
const OPEN_STATUSES = new Set(['proposed', 'active']);
/** `${cwd}\u0000${id}` -> { epicId, at } — starts made by this route. */
const recentRuns = new Map();
/** `${cwd}\u0000${id}` -> Promise<{ok, epicId?}> — runs still awaiting the renderer. */
const inProgressRuns = new Map();

const SCRIPT_START_HINT = "the human can tick 'Can be started by a script' in the macro editor";

/** The open Epic this macro is already running in `cwd`, or null. */
function findRunningEpic(cwd, id, isTabBusy) {
  const index = readActiveIndex(cwd);
  for (const epic of Object.values(index.sessions)) {
    if (!epic || typeof epic !== 'object' || !OPEN_STATUSES.has(epic.status)) continue;
    const src = epic.source;
    if (!src || src.producer !== 'new-epic-ui' || src.macroId !== id) continue;
    if (typeof epic.id === 'string' && isTabBusy(epic.id)) return epic.id;
  }
  const key = `${cwd}\u0000${id}`;
  const recent = recentRuns.get(key);
  if (recent && Date.now() - recent.at < RECENT_START_MS) {
    const entry = index.sessions[recent.epicId];
    // Not in the index yet = just minted and still being persisted: open.
    const open = entry ? OPEN_STATUSES.has(entry.status) : !index.tombstones[recent.epicId];
    if (open) return recent.epicId;
  } else if (recent) {
    recentRuns.delete(key);
  }
  return null;
}

/** Returns an error string, or null when `inputs` is acceptable for `macro`. */
function validateRunInputs(inputs, macro) {
  if (inputs === undefined) return null;
  if (inputs === null || typeof inputs !== 'object' || Array.isArray(inputs)) return 'inputs must be an object';
  const keys = Object.keys(inputs);
  if (keys.length > RUN_INPUT_MAX_KEYS) return `inputs: at most ${RUN_INPUT_MAX_KEYS} keys`;
  const declared = new Set((macro.inputs || []).map((i) => i.name));
  for (const k of keys) {
    if (!declared.has(k)) return `inputs: ${k} is not an input of macro ${macro.id}`;
    const v = inputs[k];
    if (typeof v !== 'string') return `inputs: ${k} must be a string`;
    if (v.length > RUN_INPUT_MAX_LEN) return `inputs: ${k} is longer than ${RUN_INPUT_MAX_LEN} characters`;
  }
  return null;
}

function runHandler(deps, libOpts) {
  const listPersonas = deps.listPersonas || ((...a) => require('../../agentLibrary.cjs').listPersonas(...a));
  return async (req, res) => {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const resolved = resolveCwd(body.cwd);
    if (!resolved.ok) {
      sendJson(res, resolved.status, { ok: false, error: resolved.error });
      return;
    }
    const cwd = resolved.cwd;
    const bad = (error) => sendJson(res, 400, { ok: false, error });
    const id = body.id;
    if (typeof id !== 'string' || !id) return bad('id is required');
    if (id.startsWith('builtin-')) return bad('built-in macros cannot be started through this route');
    const macros = await macroLibrary.listMacros(libOpts);
    const macro = macros.find((m) => m.id === id);
    if (!macro) return bad(`macro not found: ${id}`);
    if (!macroLibrary.macroVisibleIn(macro, cwd)) return bad(`macro ${id} is not visible to ${cwd}`);
    if (macro.job) return bad(`macro ${id} runs a job, not a session; it cannot be started through this route`);
    if (macro.scriptStart !== true) {
      return bad(`macro ${id} is not marked 'Can be started by a script'; ${SCRIPT_START_HINT}`);
    }
    const personas = await listPersonas();
    if (!personas.some((a) => a.name === macro.agentName)) return bad(`unknown agent: ${macro.agentName}`);
    const inputsError = validateRunInputs(body.inputs, macro);
    if (inputsError) return bad(inputsError);
    const effort = body.effort;
    if (effort !== undefined && !PRD_EFFORT_LEVELS.includes(effort)) {
      return bad(`effort must be one of: ${PRD_EFFORT_LEVELS.join(', ')}`);
    }
    let caller;
    if (body.caller !== undefined) {
      const parsedCaller = CallerSchema.safeParse(body.caller);
      if (!parsedCaller.success) {
        return bad(`caller: ${parsedCaller.error.issues?.[0]?.message ?? 'invalid'}`);
      }
      caller = parsedCaller.data;
    }
    const ref = normalizeExternalRef(body.externalRef);
    if (!ref.ok) return bad(ref.error);
    const rendered = macroLibrary.renderMacroPrompt(macro.prompt, macro.inputs, {
      ...macroLibrary.defaultMacroValues(macro.inputs),
      ...(body.inputs || {}),
    });
    if (!rendered.ok) return bad(rendered.error);

    if (ref.value !== undefined) {
      await runWithExternalRef({ deps, req, res, caller, cwd, macro, prompt: rendered.prompt, effort, externalRef: ref.value });
      return;
    }

    const key = `${cwd}\u0000${id}`;
    const pending = inProgressRuns.get(key);
    if (pending) {
      const first = await pending;
      if (first.ok) {
        sendJson(res, 200, { ok: true, epicId: first.epicId, alreadyRunning: true });
      } else {
        sendJson(res, 503, { ok: false, error: first.error || 'launch failed' });
      }
      return;
    }
    const running = findRunningEpic(cwd, id, deps.isTabBusy || (() => false));
    if (running) {
      sendJson(res, 200, { ok: true, epicId: running, alreadyRunning: true });
      return;
    }

    if (refusedByUsageHold(deps, res)) return;

    const startedBy = await (deps.startedByFromRequest || defaultStartedByFromRequest)(
      { route: '/admin/macros/run', caller, socket: req.socket }, deps);
    const payload = {
      cwd,
      agentName: macro.agentName,
      tag: macro.tag,
      title: macro.label,
      prompt: rendered.prompt,
      macroId: macro.id,
      via: 'script',
      startedBy,
      ...(effort !== undefined ? { effort } : {}),
    };
    const launch = (async () => {
      try {
        return await deps.startExternalNewSession(payload);
      } catch (e) {
        return { ok: false, reason: 'launch-failed', error: e?.message ?? 'launch failed' };
      }
    })();
    inProgressRuns.set(key, launch);
    let result;
    try {
      result = await launch;
      if (result && result.ok) recentRuns.set(key, { epicId: result.epicId, at: Date.now() });
    } finally {
      inProgressRuns.delete(key);
    }
    if (!result || !result.ok) {
      const error = result?.reason === 'timeout'
        ? 'timed out waiting for the window; the session may still start, check the Sessions queue before retrying'
        : result?.error || 'launch failed';
      sendJson(res, 503, { ok: false, error });
      return;
    }
    appendAuditEvent('admin_macro_run', {
      route: '/admin/macros/run',
      cwd,
      macroId: macro.id,
      epicId: result.epicId,
      alreadyRunning: false,
      ...(caller ? { scriptCaller: caller } : {}),
    });
    sendJson(res, 200, { ok: true, epicId: result.epicId, alreadyRunning: false });
  };
}

const USAGE_HOLD_HINT =
  "Usage is above 'pause above': script presses wait until the window resets or usage drops below it. "
  + 'Retry after hold.resetsAt. GET /admin/usage-hold reads the hold.';

/**
 * The usage hold ('pause above') gate in front of every script-press
 * startExternalNewSession call. Replies 429 usage_held / 503 usage_hold_error
 * and returns true when the press must not start; false when it may.
 * Read lazily so scheduler.cjs never loads at module load.
 */
function refusedByUsageHold(deps, res) {
  const usageHold = deps.usageHold || (() => require('../../scheduler.cjs').currentUsageHold());
  let hold;
  try {
    hold = usageHold();
  } catch (e) {
    sendJson(res, 503, { ok: false, error: 'usage_hold_error', details: e instanceof Error ? e.message : String(e) });
    return true;
  }
  if (!hold) return false;
  sendJson(res, 429, usageHeldBody(hold, USAGE_HOLD_HINT));
  return true;
}

/** 503 error text for a failed startExternalNewSession result. */
function launchFailureError(result) {
  return result?.reason === 'timeout'
    ? 'timed out waiting for the window; the session may still start, check the Sessions queue before retrying'
    : result?.error || 'launch failed';
}

/**
 * The externalRef branch of /admin/macros/run. The lookup, launch and record
 * run inside withExternalRefLock, so concurrent calls with the same
 * (cwd, externalRef) share one launch. The macro-wide findRunningEpic shortcut
 * is skipped: a new ref is a new run even while another run is busy.
 */
async function runWithExternalRef({ deps, req, res, caller, cwd, macro, prompt, effort, externalRef }) {
  const isTabBusy = deps.isTabBusy || (() => false);
  const existingAnswer = (epicId) => sendJson(res, 200, {
    ok: true, epicId, existing: true, alreadyRunning: !!isTabBusy(epicId), externalRef,
  });
  await withExternalRefLock({ cwd, externalRef }, async () => {
    const key = `${cwd}\u0000${macro.id}\u0000${externalRef}`;
    const pending = inProgressRuns.get(key);
    if (pending) {
      const first = await pending;
      if (first.ok) existingAnswer(first.epicId);
      else sendJson(res, 503, { ok: false, error: first.error || 'launch failed' });
      return;
    }
    const found = await findEpicByExternalRef({ cwd, externalRef });
    if (found) {
      if (found.producer !== 'new-epic-ui' || found.macroId !== macro.id) {
        sendJson(res, 409, {
          ok: false,
          error: `externalRef ${externalRef} already names Epic ${found.epicId}, started by ${found.producer || 'an unknown producer'}${found.macroId ? ` for macro ${found.macroId}` : ''}, not by macro ${macro.id}`,
          epicId: found.epicId,
          externalRef,
        });
        return;
      }
      existingAnswer(found.epicId);
      return;
    }
    const recent = recentRuns.get(key);
    if (recent && Date.now() - recent.at < RECENT_START_MS) {
      existingAnswer(recent.epicId);
      return;
    } else if (recent) {
      recentRuns.delete(key);
    }

    if (refusedByUsageHold(deps, res)) return;

    const startedBy = await (deps.startedByFromRequest || defaultStartedByFromRequest)(
      { route: '/admin/macros/run', caller, socket: req.socket }, deps);
    const payload = {
      cwd,
      agentName: macro.agentName,
      tag: macro.tag,
      title: macro.label,
      prompt,
      macroId: macro.id,
      via: 'script',
      startedBy,
      externalRef,
      ...(effort !== undefined ? { effort } : {}),
    };
    const launch = (async () => {
      try {
        return await deps.startExternalNewSession(payload);
      } catch (e) {
        return { ok: false, reason: 'launch-failed', error: e?.message ?? 'launch failed' };
      }
    })();
    inProgressRuns.set(key, launch);
    let result;
    try {
      result = await launch;
      if (result && result.ok) recentRuns.set(key, { epicId: result.epicId, at: Date.now() });
    } finally {
      inProgressRuns.delete(key);
    }
    if (!result || !result.ok) {
      sendJson(res, 503, { ok: false, error: launchFailureError(result) });
      return;
    }
    // The session already started; a failed write is retried once, then
    // reported as externalRefRecorded: false (the open-session scan in
    // findEpicByExternalRef still finds it while it is open).
    // Required lazily: crossProjectFeedback.cjs is a heavy module this file
    // otherwise never loads.
    const { recordExternalRefWithRetry } = require('./crossProjectFeedback.cjs');
    const recorded = await recordExternalRefWithRetry(
      deps.recordExternalRef || recordExternalRef,
      { cwd, externalRef, epicId: result.epicId, producer: 'new-epic-ui', macroId: macro.id },
      '[macroAdminRoutes]',
    );
    appendAuditEvent('admin_macro_run', {
      route: '/admin/macros/run',
      cwd,
      macroId: macro.id,
      epicId: result.epicId,
      alreadyRunning: false,
      externalRef,
      ...(caller ? { scriptCaller: caller } : {}),
    });
    sendJson(res, 200, {
      ok: true, epicId: result.epicId, alreadyRunning: false, externalRef,
      ...(recorded ? {} : { externalRefRecorded: false }),
    });
  });
}

/**
 * @param {{ onChanged?: () => void, startExternalNewSession?: (p: object) => Promise<any>,
 *   isTabBusy?: (tabId: string) => boolean, listPersonas?: () => Promise<Array<{name: string}>>,
 *   usageHold?: () => any,
 *   checkProjectVideoToolRunnable?: (i: { cwd: string, agentName: string, job: object }) => Promise<{ ok: boolean, error?: string }> }} deps
 */
function registerAdminRoute(adminHttp, deps = {}, opts = {}) {
  const { onChanged } = deps;
  const libOpts = opts.filePath ? { filePath: opts.filePath } : undefined;
  adminHttp.registerRoute('GET', '/admin/macros', listHandler(onChanged, libOpts));
  adminHttp.registerRoute('POST', '/admin/macros/save', saveHandler(onChanged, libOpts, deps));
  adminHttp.registerRoute('POST', '/admin/macros/delete', deleteHandler(onChanged, libOpts));
  if (typeof deps.startExternalNewSession === 'function') {
    adminHttp.registerRoute('POST', '/admin/macros/run', runHandler(deps, libOpts));
  }
}

module.exports = {
  registerAdminRoute,
  quoteNamesEveryProject,
  quoteNamesProjectHome,
};
