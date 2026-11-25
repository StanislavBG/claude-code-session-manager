/**
 * videoScriptRunRoute.cjs — a project's own script presses Demo Video.
 *
 *   POST /admin/project-home/videos/run  (body ≤ 64 KiB)
 *     { cwd, kind, target?, length?, style?, character?, voiceId?, focus?, reviewFirst?, externalRef? }
 *   curl -s -X POST "http://127.0.0.1:$(jq -r .port ~/.claude/session-manager/admin-api.json)/admin/project-home/videos/run" -H "Authorization: Bearer $(jq -r .token ~/.claude/session-manager/admin-api.json)" -H 'Content-Type: application/json' -d '{"cwd":"/abs/project","kind":"blog-post","target":"posts/hello.md","externalRef":"post:hello"}'
 *
 * Starts ONE builtin-demo-video job for the cwd through the same renderer
 * press path as POST /admin/macros/run (deps.startExternalNewSession ->
 * launchSession run 'job'), so persona, checks, review stage and the single
 * mint authority are the human press's own. Checks, in order, each refusal
 * launching nothing:
 *   1. 400 — body/cwd (resolveCwd from projectHomeAdminRoutes.cjs);
 *   2. 403 scripts_not_allowed — the project's 'Scripts may run Demo Video'
 *      switch is off (videoScriptPress.isVideoScriptSwitchOn);
 *   3. 400 — the press choices (videoPressLines.parseScriptPress), a voiceId
 *      not in voiceLibrary.listVoices(cwd), or a bad externalRef;
 *   4. with externalRef: a ledger run with the same cwd + ref answers
 *      200 { ok, existing:true, entryId, epicId } (concurrent identical calls
 *      share one launch under withExternalRefLock);
 *   5. 409 already_building — a pending/held/running builtin-demo-video job
 *      row for the cwd (deps.listJobRows), or a launch in flight here.
 * Success: 200 { ok, entryId, epicId, slug, stage }, the run recorded with
 * videoScriptPress.recordScriptRun and one 'admin_video_script_run' audit
 * event. A launch failure, or a result without entryId, is 503.
 * Registered by adminRouteRegistry.cjs.
 */
'use strict';

const { readBody, sendJson } = require('../feedback-remote/localAdminHttp.cjs');
const { normalizeExternalRef } = require('../epic/externalRef.cjs');
const { parseScriptPress, pressLines } = require('./videoPressLines.cjs');

const ROUTE_PATH = '/admin/project-home/videos/run';
const MAX_RUN_BODY_BYTES = 64 * 1024;
const MACRO_ID = 'builtin-demo-video';
const ACTIVE = new Set(['pending', 'held', 'running']);
const PRESS_KEYS = ['kind', 'target', 'length', 'style', 'character', 'voiceId', 'focus', 'reviewFirst'];
const ALLOWED_KEYS = new Set(['cwd', 'externalRef', ...PRESS_KEYS]);
const SWITCH_REASON = "the 'Scripts may run Demo Video' switch is off for this project; a human turns it on in Project Home > Video";

/** cwd -> launch promise; one scripted launch per project at a time. */
const inFlight = new Map();

function oneLine(s) {
  return String(s).replace(/[\r\n]+/g, ' ').slice(0, 300);
}

function launchError(result) {
  if (result && result.ok && !result.entryId) return 'the session started but did not report a Demo Video entry id';
  return oneLine(result?.reason === 'timeout'
    ? 'timed out waiting for the window; the job may still start, check Project Home > Video before retrying'
    : result?.error || 'launch failed');
}

/**
 * @param {{ registerRoute: Function }} adminHttp
 * @param {{ startExternalNewSession?: (p: object) => Promise<any>, isTabBusy?: (id: string) => boolean,
 *   listJobRows?: () => Promise<any[]>, resolveCwd?: (c: unknown) => any, videoScriptPress?: any,
 *   listVoices?: (cwd: string) => { voices: Array<{ id: string }> }, builtinMacros?: any[],
 *   appendAuditEvent?: Function, withExternalRefLock?: Function, now?: () => number }} [deps]
 */
function registerAdminRoute(adminHttp, deps = {}) {
  const resolveCwd = deps.resolveCwd
    || ((/** @type {any} */ c) => require('../feedback-remote/projectHomeAdminRoutes.cjs').resolveCwd(c));
  const store = () => deps.videoScriptPress || require('./videoScriptPress.cjs');
  const listVoices = deps.listVoices
    || ((/** @type {string} */ c) => require('../demo-video-kit/voiceLibrary.cjs').listVoices(c));
  const builtins = () => deps.builtinMacros || require('../persona-macro/builtinMacros.cjs').BUILTIN_MACROS;
  const audit = deps.appendAuditEvent
    || ((/** @type {string} */ k, /** @type {any} */ f) => require('../telemetry/auditLog.cjs').appendAuditEvent(k, f));
  const withLock = deps.withExternalRefLock
    || ((/** @type {any} */ k, /** @type {any} */ fn) => require('../epic/externalRefIndex.cjs').withExternalRefLock(k, fn));
  const isTabBusy = deps.isTabBusy || (() => false);
  const listJobRows = deps.listJobRows || (async () => []);
  const now = deps.now || Date.now;

  adminHttp.registerRoute('POST', ROUTE_PATH, async (/** @type {any} */ req, /** @type {any} */ res) => {
    const bad = (/** @type {string} */ error) => sendJson(res, 400, { ok: false, error: oneLine(error) });

    let raw;
    try {
      raw = await readBody(req, MAX_RUN_BODY_BYTES);
    } catch (e) {
      bad(`request body rejected: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    let body;
    try { body = JSON.parse(raw || '{}'); } catch {
      bad('body is not valid JSON');
      return;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('body must be a JSON object');
    const unknown = Object.keys(body).find((k) => !ALLOWED_KEYS.has(k));
    if (unknown) return bad(`unknown field: ${unknown}`);

    const resolved = resolveCwd(body.cwd);
    if (!resolved || !resolved.ok) {
      sendJson(res, resolved?.status || 400, { ok: false, error: oneLine(resolved?.error || 'cwd rejected') });
      return;
    }
    const cwd = resolved.cwd;

    if (!store().isVideoScriptSwitchOn(cwd)) {
      sendJson(res, 403, { ok: false, error: 'scripts_not_allowed', reason: SWITCH_REASON });
      return;
    }

    /** @type {Record<string, unknown>} */
    const pressBody = {};
    for (const k of PRESS_KEYS) if (body[k] !== undefined) pressBody[k] = body[k];
    const parsed = parseScriptPress(pressBody);
    if (!parsed.ok) return bad(parsed.error);
    const cfg = parsed.cfg;

    if (cfg.voice) {
      let ids;
      try {
        const lib = listVoices(cwd);
        ids = new Set(((lib && lib.voices) || []).map((v) => v && v.id));
      } catch (e) {
        return bad(`could not read the voice library: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (!ids.has(cfg.voice)) return bad(`unknown voice '${cfg.voice}': not in this project's voice library (GET /admin/voices)`);
    }

    const ref = normalizeExternalRef(body.externalRef);
    if (!ref.ok) return bad(ref.error);
    const externalRef = ref.value;

    const macro = builtins().find((/** @type {any} */ m) => m && m.id === MACRO_ID);
    if (!macro) {
      sendJson(res, 503, { ok: false, error: `${MACRO_ID} is not a built-in macro in this build` });
      return;
    }

    const press = async () => {
      if (externalRef !== undefined) {
        const found = store().findScriptRun(cwd, { externalRef });
        if (found) {
          sendJson(res, 200, {
            ok: true, existing: true, entryId: found.entryId, epicId: found.epicId,
            slug: found.slug, alreadyRunning: !!isTabBusy(found.epicId), externalRef,
          });
          return;
        }
      }
      if (inFlight.has(cwd)) {
        sendJson(res, 409, { ok: false, error: 'already_building', activeSlug: null });
        return;
      }
      let rows;
      try {
        rows = (await listJobRows()) || [];
      } catch (e) {
        sendJson(res, 503, { ok: false, error: oneLine(`could not read the job queue: ${e instanceof Error ? e.message : String(e)}`) });
        return;
      }
      const active = rows.find((/** @type {any} */ r) => r && r.macroId === MACRO_ID && (!r.cwd || r.cwd === cwd) && ACTIVE.has(r.status));
      if (active) {
        sendJson(res, 409, { ok: false, error: 'already_building', activeSlug: active.slug ?? null });
        return;
      }

      const payload = {
        cwd,
        agentName: macro.agentName,
        tag: macro.tag,
        title: macro.label,
        prompt: `${macro.prompt}\n\nAdditional instructions: ${pressLines(cfg).join('\n')}`,
        macroId: MACRO_ID,
        via: 'script',
        ...(cfg.review ? { reviewStage: true } : {}),
        ...(externalRef !== undefined ? { externalRef } : {}),
      };
      const launch = (async () => {
        try {
          return await deps.startExternalNewSession?.(payload);
        } catch (e) {
          return { ok: false, reason: 'launch-failed', error: e instanceof Error ? e.message : 'launch failed' };
        }
      })();
      inFlight.set(cwd, launch);
      let result;
      try {
        result = await launch;
      } finally {
        inFlight.delete(cwd);
      }
      if (!result || !result.ok || typeof result.entryId !== 'string' || !result.entryId || !result.epicId) {
        sendJson(res, 503, { ok: false, error: launchError(result) });
        return;
      }
      const slug = typeof result.slug === 'string' && result.slug ? result.slug : null;
      const stage = result.stage ?? null;
      let recorded = true;
      try {
        store().recordScriptRun(cwd, {
          entryId: result.entryId,
          epicId: result.epicId,
          slug: slug || result.entryId,
          kind: cfg.kind,
          at: new Date(now()).toISOString(),
          ...(externalRef !== undefined ? { externalRef } : {}),
        });
      } catch (e) {
        recorded = false;
        console.warn('[videoScriptRunRoute] could not record the scripted run:', e instanceof Error ? e.message : e);
      }
      try {
        audit('admin_video_script_run', {
          route: ROUTE_PATH, cwd, macroId: MACRO_ID, kind: cfg.kind,
          entryId: result.entryId, epicId: result.epicId, slug, stage,
          ...(externalRef !== undefined ? { externalRef } : {}),
        });
      } catch { /* audit is best-effort */ }
      sendJson(res, 200, {
        ok: true, entryId: result.entryId, epicId: result.epicId, slug, stage,
        ...(recorded ? {} : { runRecorded: false }),
      });
    };

    if (externalRef !== undefined) await withLock({ cwd, externalRef }, press);
    else await press();
  });
}

module.exports = { registerAdminRoute, ROUTE_PATH, MAX_RUN_BODY_BYTES };
