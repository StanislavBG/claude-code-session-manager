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
 *       4. 403 quote_does_not_name_slots — the quote is not a change request:
 *          a change verb (set / raise / bump / lower / make …), a limit word
 *          (limit / cap / slots / sessions / parallel / concurrent) AND the new
 *          number given as the target ("to 14", "= 14", "at 14", "14 parallel
 *          sessions"). Naming a limit and a number in passing is not enough.
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

const LIMIT_WORDS = '(?:limit|limits|cap|caps|slot|slots|session|sessions|parallel|parallelism|concurrent|concurrency)';
const CHANGE_VERBS = '(?:set|raise|increase|bump|lift|lower|reduce|drop|change|move|make)';
const NEGATION = '(?:not|never|no|dont|don t|won t|wont|can t|cant|shouldn t|shouldnt)';
const TARGET = '(?:to|=|at)';

const NUMBER_WORDS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen',
  'nineteen', 'twenty',
];
const TENS = { 20: 'twenty', 30: 'thirty' };
const ANY_NUMBER = `(?:\\d+|${[...NUMBER_WORDS, 'thirty', 'forty', 'fifty'].join('|')})`;
// One filler word: letters only, never a number word, so a gap can never
// swallow half of "thirty two" or step over a different number.
const WORD = `(?!${ANY_NUMBER}(?: |$))[a-z]+`;
const gap = (/** @type {number} */ n) => `(?: ${WORD}){0,${n}}`;

/** @param {number} n */
function wordsFor(n) {
  if (n < 0) return [];
  if (n <= 20) return [NUMBER_WORDS[n]];
  const tens = Math.floor(n / 10) * 10;
  const unit = n % 10;
  const t = TENS[/** @type {20|30} */ (tens)];
  if (!t) return [];
  return unit === 0 ? [t] : [`${t} ${NUMBER_WORDS[unit]}`];
}

/** @param {unknown} quote */
function normalizeQuote(quote) {
  return String(quote)
    .toLowerCase()
    .replace(/\d+[.,]\d+/g, ' # ') // a decimal is never a cap; never let "14.5" read as 14
    .replace(/=/g, ' = ')
    .replace(/[.!?;:()[\]{}]/g, ' . ') // a clause boundary: no gap word crosses it
    .replace(/[^a-z0-9=.# ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The anchored change-request patterns for `cap`:
 *   A. verb … limit word … to|=|at <cap>   ("raise the limit to 14")
 *   B. verb … [to|=|at] <cap> … limit word  ("make it 16 parallel sessions")
 * The verb must be the base form and not negated; the number must stand alone.
 * @param {number} cap
 */
function changeRequestPatterns(cap) {
  const num = `(?:${[String(cap), ...wordsFor(cap)].join('|')})`;
  const numEnd = `(?= |$)(?! ${ANY_NUMBER}(?: |$))`;
  const verb = `(?<!${NEGATION}${gap(2)} )(?<=^| )${CHANGE_VERBS}`;
  const verbAtStart = `(?:^| )${verb}`;
  return [
    new RegExp(`${verbAtStart}${gap(4)} ${LIMIT_WORDS}${gap(3)} ${TARGET} ${num}${numEnd}`),
    new RegExp(`${verbAtStart}${gap(4)}(?: ${TARGET})? ${num}${numEnd}${gap(2)} ${LIMIT_WORDS}(?= |$)`),
  ];
}

/**
 * True only when the quote is a request to CHANGE the session limit to `cap`:
 * a change verb, a limit word, and `cap` (digits, or English words up to
 * thirty-nine) given as the new target. Mentioning a limit and a number is not
 * enough — "lets see first 10 sessions chugging and then we will move the
 * limit via the mcp" authorizes nothing. Refuses on doubt.
 * @param {unknown} quote
 * @param {number} cap
 */
function quoteNamesSlots(quote, cap) {
  if (typeof quote !== 'string' || !Number.isInteger(cap) || cap < 0) return false;
  const q = normalizeQuote(quote);
  return changeRequestPatterns(cap).some((re) => re.test(q));
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
      refuse(403, 'quote_does_not_name_slots', `the human's quote does not ask to change the session limit to ${cap}`);
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
