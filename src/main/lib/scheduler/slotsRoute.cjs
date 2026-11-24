/**
 * slotsRoute.cjs — the agent path for the machine-wide session slot cap.
 *
 *   GET /admin/scheduler/slots
 *     → 200 { ok, cap, min, max, inUse, available } from sessionSlots.cjs.
 *
 *   POST /admin/scheduler/slots  (body ≤ 64 KiB)
 *     { cap, quote, originClaudeSessionId, originProjectRoot?, callerJobSlug? }
 *     Changes the cap only on a verbatim quote of what the human typed in the
 *     calling chat session. Checks, in order, each refusal writing and auditing
 *     nothing:
 *       1. 400 invalid_request — bad body, or cap not an integer in
 *          [MIN_SLOTS, MAX_SLOTS];
 *       2. 403 called_from_headless_job — callerJobSlug is set (the MCP tool
 *          forwards SM_SCHEDULER_JOB_SLUG): a scheduled job never moves the cap;
 *       3. 403 human_request_unverified — the quote is not in a prompt the
 *          human typed in originClaudeSessionId. Same verifier as
 *          taskSwitchRoute.cjs (humanPromptLedger.findHumanPromptContaining);
 *          headless jobs and Tasks never record prompts there, so they fail here
 *          too;
 *       4. 403 quote_does_not_name_slots — no sentence of the quote is the
 *          one accepted form (see SLOT_COMMAND); the reason gives that form,
 *          e.g. say 'raise the limit to 14'.
 *     Success: sessionSlots.setCap(cap) (persists + wakes waiters), one
 *     slot_cap_changed audit event { from, to, epicId, quote, promptAt },
 *     200 { ok, from, to }.
 *
 * Registered from index.cjs next to the other /admin/scheduler/ routes.
 */
'use strict';

const { z } = require('zod');
const { readBody, sendJson } = require('../feedback-remote/localAdminHttp.cjs');

const MAX_SLOTS_BODY_BYTES = 64 * 1024;

const slotsBodySchema = z.object({
  cap: z.unknown(),
  quote: z.string().min(1).max(2000),
  originClaudeSessionId: z.string().min(1).max(128),
  originProjectRoot: z.string().min(1).optional(),
  callerJobSlug: z.string().max(256).optional(),
}).strict();

// The one accepted sentence form, matched against a whole sentence after
// lowercasing and collapsing spaces:
//   [please|ok|okay|so|now|then[,]] set|raise|increase|bump|lower|reduce|change
//   [the|our] [session|slot|parallel] limit|cap|slots to <digits> [sessions|slots]
// Nothing else may come before or after it in that sentence. Anything else —
// questions, negations, percentages, number words, extra words — is refused.
const SLOT_COMMAND = new RegExp(
  '^(?:(?:please|ok|okay|so|now|then),? )?'
  + '(?:set|raise|increase|bump|lower|reduce|change) '
  + '(?:(?:the|our) )?'
  + '(?:(?:session|slot|parallel) )?'
  + '(?:limit|cap|slots) to (\\d+)'
  + '(?: (?:sessions|slots))?$',
);

/** The accepted form, as the refusal states it. @param {number} cap */
function acceptedFormHint(cap) {
  return `say 'raise the limit to ${cap}' (one sentence: [please|ok|so|now|then] `
    + 'set|raise|increase|bump|lower|reduce|change [the|our] [session|slot|parallel] limit|cap|slots '
    + 'to <number in digits> [sessions|slots], with nothing after it and no question mark)';
}

/**
 * True only when one sentence of the quote is exactly the SLOT_COMMAND form
 * naming `cap` in digits. Sentences split on . ! ? ; and line breaks; a
 * sentence ended by '?' never authorizes; a decimal ("14.5") is not split, so
 * it never reads as 14. Refuses on doubt.
 * @param {unknown} quote
 * @param {number} cap
 */
function quoteNamesSlots(quote, cap) {
  if (typeof quote !== 'string' || !Number.isInteger(cap) || cap < 0) return false;
  // Keep a decimal point inside its sentence so "14.5" fails the form.
  const text = quote.toLowerCase().replace(/(\d)[.,](?=\d)/g, '$1#');
  const sentence = /([^.!?;\r\n]*)([.!?;\r\n]|$)/g;
  let m;
  while ((m = sentence.exec(text)) !== null) {
    const body = m[1].replace(/\s+/g, ' ').trim();
    if (m[2] !== '?' && body) {
      const hit = SLOT_COMMAND.exec(body);
      if (hit && hit[1] === String(cap)) return true;
    }
    if (m[2] === '') break; // end of the quote
  }
  return false;
}

/**
 * @param {{ registerRoute: Function }} adminHttp
 * @param {{ findHumanPromptContaining?: Function, resolveProjectContext?: Function,
 *   sessionSlots?: any, appendAuditEvent?: Function, now?: () => number }} [deps]
 */
function registerSlotsRoute(adminHttp, deps = {}) {
  const findPrompt = deps.findHumanPromptContaining
    || ((/** @type {string} */ s, /** @type {string} */ q, /** @type {number} */ n) => require('../feedback-remote/humanPromptLedger.cjs').findHumanPromptContaining(s, q, n));
  const resolveContext = deps.resolveProjectContext
    || ((/** @type {any} */ o) => require('../projectRootResolve.cjs').resolveProjectContext(o));
  const slots = () => deps.sessionSlots || require('./sessionSlots.cjs');
  const audit = deps.appendAuditEvent
    || ((/** @type {string} */ k, /** @type {any} */ f) => require('../telemetry/auditLog.cjs').appendAuditEvent(k, f));
  const now = deps.now || Date.now;

  adminHttp.registerRoute('GET', '/admin/scheduler/slots', (/** @type {any} */ _req, /** @type {any} */ res) => {
    const s = slots();
    sendJson(res, 200, {
      ok: true,
      cap: s.totalSlots(),
      min: s.MIN_SLOTS,
      max: s.MAX_SLOTS,
      inUse: s.inUse(),
      available: s.available(),
    });
  });

  adminHttp.registerRoute('POST', '/admin/scheduler/slots', async (/** @type {any} */ req, /** @type {any} */ res) => {
    const bad = (/** @type {any} */ details) => sendJson(res, 400, { ok: false, error: 'invalid_request', details });
    const refuse = (/** @type {number} */ status, /** @type {string} */ error, /** @type {string} */ reason) =>
      sendJson(res, status, { ok: false, error, reason });

    let raw;
    try {
      raw = await readBody(req, MAX_SLOTS_BODY_BYTES);
    } catch (e) {
      bad(e instanceof Error ? e.message : String(e));
      return;
    }
    let json;
    try { json = JSON.parse(raw || '{}'); } catch {
      bad('body is not valid JSON');
      return;
    }
    const parsed = slotsBodySchema.safeParse(json);
    if (!parsed.success) {
      bad(parsed.error.issues);
      return;
    }
    const { cap, quote, originClaudeSessionId, originProjectRoot, callerJobSlug } = parsed.data;
    const s = slots();
    if (typeof cap !== 'number' || !Number.isInteger(cap) || cap < s.MIN_SLOTS || cap > s.MAX_SLOTS) {
      bad(`cap must be an integer in [${s.MIN_SLOTS}, ${s.MAX_SLOTS}]`);
      return;
    }
    if (callerJobSlug) {
      refuse(403, 'called_from_headless_job', `a headless scheduled job ('${callerJobSlug}') never changes the slot limit; say in your final result what the human should set`);
      return;
    }

    const found = findPrompt(originClaudeSessionId, quote, now());
    if (!found) {
      refuse(403, 'human_request_unverified', 'quote was not found in a prompt the human typed in this chat session');
      return;
    }
    if (!quoteNamesSlots(quote, cap)) {
      refuse(403, 'quote_does_not_name_slots', `the human's quote does not ask to change the session limit to ${cap} in the accepted form; ${acceptedFormHint(cap)}`);
      return;
    }

    let epicId = null;
    try {
      const ctx = resolveContext({ originClaudeSessionId, originProjectRoot });
      if (ctx && typeof ctx.epicId === 'string' && ctx.epicId) epicId = ctx.epicId;
    } catch { epicId = null; }

    const from = s.totalSlots();
    let to;
    try {
      to = s.setCap(cap);
    } catch (e) {
      sendJson(res, 500, { ok: false, error: 'cap_write_failed', details: e instanceof Error ? e.message : String(e) });
      return;
    }
    const promptMs = Number(found.at);
    const promptAt = Number.isFinite(promptMs) ? new Date(promptMs).toISOString() : null;
    try {
      audit('slot_cap_changed', { from, to, epicId, quote, promptAt });
    } catch { /* audit is best-effort, like taskSwitchRoute */ }

    sendJson(res, 200, { ok: true, from, to });
  });
}

module.exports = { registerSlotsRoute, quoteNamesSlots, MAX_SLOTS_BODY_BYTES };
