/**
 * taskSwitchRoute.cjs — the agent path for 'Scripts may run Tasks'.
 *
 *   POST /admin/tasks/switch  (body ≤ 64 KiB)
 *     { enabled, humanRequestQuote, originClaudeSessionId, cwd?, originProjectRoot? }
 *     Sets ONE project's switch on or off, and only on a verbatim quote of what
 *     the human typed in the calling chat session (humanPromptLedger). Checks,
 *     in order, each refusal writing and auditing nothing:
 *       1. 403 human_request_unverified — the quote is not in a prompt the
 *          human typed in originClaudeSessionId (the ledger is the only proof);
 *       2. 403 quote_does_not_name_switch — the quote does not say
 *          'Scripts may run Tasks' (quoteNamesTaskSwitch);
 *       3. 403 quote_does_not_name_project — the target is not the calling
 *          session's own project and the quote does not name it
 *          (crossProjectFeedback.quoteNamesTarget);
 *       4. 409 request_older_than_switch — the matched prompt is not later
 *          than the switch's last change: one human instruction authorizes one
 *          write, and never undoes a later click.
 *     Success: setTaskSwitch(target, enabled, { via:'agent', claudeSessionId,
 *     quote, promptAt }), one task_switch_changed audit event, the held
 *     interactive slot re-synced, 200 { ok, cwd, enabled, changedAt, by, previous }.
 *     Setting the value the switch already has re-stamps the attribution.
 *
 * Scripts, scheduled jobs and Tasks cannot reach this: their prompts are never
 * recorded in humanPromptLedger (only the Chat view records them).
 * Registered by taskAdminRoutes.cjs registerAdminRoute.
 */
'use strict';

const path = require('node:path');
const { z } = require('zod');
const { readBody, sendJson } = require('../feedback-remote/localAdminHttp.cjs');

const MAX_SWITCH_BODY_BYTES = 64 * 1024;

const switchBodySchema = z.object({
  enabled: z.boolean(),
  humanRequestQuote: z.string().min(1).max(2000),
  originClaudeSessionId: z.string().min(1).max(128),
  cwd: z.string().min(1).optional(),
  originProjectRoot: z.string().min(1).optional(),
}).strict();

const SWITCH_RE = /(^|[^a-z0-9])scripts?\s+(may|can)\s+run\s+tasks?($|[^a-z0-9])/;

/** True when the quote names the 'Scripts may run Tasks' switch (case, quote-mark, hyphen variants). */
function quoteNamesTaskSwitch(quote) {
  if (typeof quote !== 'string') return false;
  const q = quote
    .toLowerCase()
    .replace(/[-_'"‘’‚‛“”„‟′″`]/g, ' ')
    .replace(/\s+/g, ' ');
  return SWITCH_RE.test(q);
}

/**
 * @param {{ registerRoute: Function }} adminHttp
 * @param {{ findHumanPromptContaining?: Function, resolveProjectContext?: Function,
 *   resolveProjectRoot?: Function, taskSwitch?: any, appendAuditEvent?: Function,
 *   quoteNamesTarget?: Function, now?: () => number }} [deps]
 */
function registerTaskSwitchRoute(adminHttp, deps = {}) {
  const findPrompt = deps.findHumanPromptContaining
    || ((/** @type {string} */ s, /** @type {string} */ q, /** @type {number} */ n) => require('../feedback-remote/humanPromptLedger.cjs').findHumanPromptContaining(s, q, n));
  const resolveContext = deps.resolveProjectContext
    || ((/** @type {any} */ o) => require('../projectRootResolve.cjs').resolveProjectContext(o));
  const projectRoot = deps.resolveProjectRoot
    || ((/** @type {string} */ c, /** @type {any} */ o) => require('../opsOwnership.cjs').resolveProjectRoot(c, o));
  const taskSwitch = () => deps.taskSwitch || require('./taskSwitch.cjs');
  const audit = deps.appendAuditEvent
    || ((/** @type {string} */ k, /** @type {any} */ f) => require('../telemetry/auditLog.cjs').appendAuditEvent(k, f));
  const namesTarget = deps.quoteNamesTarget
    || ((/** @type {string} */ q, /** @type {string} */ c) => require('../feedback-remote/crossProjectFeedback.cjs').quoteNamesTarget(q, c));
  const now = deps.now || Date.now;

  adminHttp.registerRoute('POST', '/admin/tasks/switch', async (/** @type {any} */ req, /** @type {any} */ res) => {
    const bad = (/** @type {any} */ details) => sendJson(res, 400, { ok: false, error: 'invalid_request', details });
    const refuse = (/** @type {number} */ status, /** @type {string} */ error, /** @type {string} */ reason) =>
      sendJson(res, status, { ok: false, error, reason });

    let raw;
    try {
      raw = await readBody(req, MAX_SWITCH_BODY_BYTES);
    } catch (e) {
      bad(e instanceof Error ? e.message : String(e));
      return;
    }
    let json;
    try { json = JSON.parse(raw || '{}'); } catch {
      bad('body is not valid JSON');
      return;
    }
    const parsed = switchBodySchema.safeParse(json);
    if (!parsed.success) {
      bad(parsed.error.issues);
      return;
    }
    const { enabled, humanRequestQuote: quote, originClaudeSessionId, cwd: rawCwd, originProjectRoot } = parsed.data;

    // The calling session's own project.
    let origin = null;
    try {
      const ctx = resolveContext({ originClaudeSessionId, originProjectRoot });
      const o = ctx && (ctx.epicCwd || ctx.cwd);
      if (typeof o === 'string' && o) origin = path.resolve(o);
    } catch { origin = null; }

    let target = origin;
    if (rawCwd !== undefined) {
      try {
        const root = projectRoot(rawCwd, { opsInternal: 'refuse' });
        if (path.resolve(root) !== path.resolve(rawCwd)) throw new Error(`cwd is not a project root (its root is "${root}")`);
        target = path.resolve(root);
      } catch (e) {
        bad(e instanceof Error ? e.message : String(e));
        return;
      }
    }
    if (!target) {
      bad('no target project: pass cwd, or call from a Session Manager chat session whose project can be resolved');
      return;
    }

    const found = findPrompt(originClaudeSessionId, quote, now());
    if (!found) {
      refuse(403, 'human_request_unverified', 'humanRequestQuote was not found in a prompt the human typed in this chat session');
      return;
    }
    if (!quoteNamesTaskSwitch(quote)) {
      refuse(403, 'quote_does_not_name_switch', "the human's quote does not name the 'Scripts may run Tasks' switch");
      return;
    }
    if (target !== origin && !namesTarget(quote, target)) {
      refuse(403, 'quote_does_not_name_project', `the target is not this session's project and the human's quote does not name it (${path.basename(target)})`);
      return;
    }
    const current = taskSwitch().getTaskSwitch(target);
    const promptMs = Number(found.at);
    const changedMs = current && current.changedAt ? Date.parse(current.changedAt) : NaN;
    if (!Number.isFinite(promptMs) || (Number.isFinite(changedMs) && !(promptMs > changedMs))) {
      refuse(409, 'request_older_than_switch', "the human's request is not newer than the switch's last change; ask the human again");
      return;
    }

    const promptAt = new Date(promptMs).toISOString();
    let saved;
    try {
      saved = taskSwitch().setTaskSwitch(target, enabled, { via: 'agent', claudeSessionId: originClaudeSessionId, quote, promptAt });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: 'switch_write_failed', details: e instanceof Error ? e.message : String(e) });
      return;
    }
    try {
      audit('task_switch_changed', { cwd: saved.cwd, enabled: saved.enabled, via: 'agent', claudeSessionId: originClaudeSessionId, quote });
    } catch { /* audit is best-effort, like taskIpc */ }
    try { taskSwitch().syncInteractiveReserve(); } catch { /* a failed sync never changes the response */ }

    sendJson(res, 200, {
      ok: true,
      cwd: saved.cwd,
      enabled: saved.enabled,
      changedAt: saved.changedAt,
      by: saved.by,
      previous: {
        enabled: !!(current && current.enabled),
        by: current ? current.by : null,
      },
    });
  });
}

module.exports = { registerTaskSwitchRoute, quoteNamesTaskSwitch, MAX_SWITCH_BODY_BYTES };
