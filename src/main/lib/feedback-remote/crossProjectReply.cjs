'use strict';

/**
 * crossProjectReply.cjs — the RETURN LEG of the project-to-project conduit.
 *
 * crossProjectFeedback.cjs mints a `proposed` Epic Y in Project-B for a
 * finding sent from Epic X in Project-A, and stamps Y with
 * `source.replyTo = { cwd, epicId, claudeSessionId }` — the thread back to X.
 * This module lets the session running Y answer INTO X rather than open yet
 * another proposed session in Project-A: the reply lands as an event on X's
 * chain (notice 'cross-project-reply') plus X's next chat prompt, which
 * resumes X's own Claude session even when its tab is closed.
 *
 * THE THREAD RULE. A reply may only go to the one Epic that asked:
 *   - the replying Epic Y is resolved ONLY from the caller's
 *     originClaudeSessionId (set by chatRunner for interactive chat runs,
 *     never for scheduler jobs) — never from an agent-supplied Epic id;
 *   - Y must be a cross-project-feedback Epic carrying a complete replyTo;
 *     anything else is a NEW request, which is feedback_open_session's job;
 *   - the target is replyTo.epicId and nothing else (toEpicId may only
 *     restate it);
 *   - at most MAX_REPLIES_PER_THREAD replies per Y, serialized per Y in
 *     memory, so two agents bouncing replies cannot loop forever.
 * The reply is sent through chatRunner.enqueueExternalPrompt with no human
 * origin, so it is never recorded in humanPromptLedger and can never be
 * replayed as an autoStart humanRequestQuote.
 *
 * Single-writer law: every write goes through promptSessionEvents.cjs's
 * appendResponseEventWithReason (writer 'scheduler', the existing
 * active-index.json delegation). Reads use epicMint.cjs's readActiveIndex.
 */

const fs = require('node:fs');
const path = require('node:path');

const config = require('../../config.cjs');
const { readBody, sendJson } = require('./localAdminHttp.cjs');
const { readActiveIndex } = require('../epic/epicMint.cjs');
const { appendAuditEvent } = require('../telemetry/auditLog.cjs');
const { resolveProjectContext } = require('../projectRootResolve.cjs');

/** crossProjectFeedback.cjs is required lazily: its fallback path may require
 *  this module, and a top-level require both ways would hand one side a
 *  half-built exports object. */
function feedbackConduit() {
  return require('./crossProjectFeedback.cjs');
}

const MAX_REPLIES_PER_THREAD = 3;
const REPLY_OUTCOMES = Object.freeze(['done', 'blocked', 'question']);
const RECEIPT_NOTICE = 'cross-project-reply-sent';
const REPLY_NOTICE = 'cross-project-reply';
const FALLBACK_NOTICE = 'cross-project-reply-fallback';

/** Per-Y promise chain: cap check → deliver → receipt run one at a time. */
const threadLocks = new Map();

function withThreadLock(key, fn) {
  const prev = threadLocks.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(() => {}, () => {});
  threadLocks.set(key, tail);
  tail.then(() => { if (threadLocks.get(key) === tail) threadLocks.delete(key); });
  return run;
}

function bad(status, error, extra = {}) {
  return { ok: false, status, error, ...extra };
}

function singleLine(s) {
  return String(s ?? '').replace(/\r?\n/g, ' ').trim();
}

function realOr(p) {
  try { return fs.realpathSync(p); } catch { return p; }
}

/**
 * composeReplyPrompt({ fromCwd, fromEpicId, fromGoalText, outcome, message,
 * referencePaths }) → string. Pure. The framing tells X's agent the text came
 * from an agent elsewhere, not from its human.
 */
function composeReplyPrompt({ fromCwd, fromEpicId, fromGoalText, outcome, message, referencePaths = [] }) {
  const cwd = singleLine(fromCwd);
  const base = path.basename(cwd) || cwd;
  const goal = singleLine(fromGoalText);
  const lines = [
    `REPLY FROM ANOTHER PROJECT: ${base} (${cwd}), session ${singleLine(fromEpicId)}`
      + `${goal ? ` — "${goal}"` : ''} — outcome: ${outcome}.`,
    'Nobody in this project wrote this. An agent in that project did, and it may be wrong about '
      + 'this codebase — verify before acting.',
    '',
    String(message).trim(),
  ];
  if (referencePaths.length) {
    lines.push('');
    for (const p of referencePaths) lines.push(`Reference: ${singleLine(p)}`);
  }
  return lines.join('\n');
}

function validateReplyInput(input) {
  if (!input || typeof input !== 'object') return bad(400, 'body must be an object');
  const { MAX_BODY_CHARS, MAX_REFERENCES } = feedbackConduit();
  const message = typeof input.message === 'string' ? input.message.trim() : '';
  if (!message) return bad(400, 'message is required');
  if (message.length > MAX_BODY_CHARS) {
    return bad(400, `message is ${message.length} chars; cap is ${MAX_BODY_CHARS}`);
  }
  if (!REPLY_OUTCOMES.includes(input.outcome)) {
    return bad(400, `outcome must be one of ${REPLY_OUTCOMES.join(' | ')}`);
  }
  let referencePaths = [];
  if (input.referencePaths !== undefined && input.referencePaths !== null) {
    if (!Array.isArray(input.referencePaths) || !input.referencePaths.every((p) => typeof p === 'string')) {
      return bad(400, 'referencePaths must be an array of strings');
    }
    if (input.referencePaths.length > MAX_REFERENCES) {
      return bad(400, `too many referencePaths (${input.referencePaths.length}); cap is ${MAX_REFERENCES}`);
    }
    referencePaths = input.referencePaths.slice();
  }
  return { ok: true, value: { message, outcome: input.outcome, referencePaths } };
}

function defaultSendPrompt(tabId, prompt, extra) {
  return require('../../chatRunner.cjs').enqueueExternalPrompt(tabId, prompt, extra);
}

function defaultAppendEvent(cwd, epicId, text, meta) {
  return require('../../promptSessionEvents.cjs').appendResponseEventWithReason(cwd, epicId, text, meta);
}

function defaultResolveEpicId(cwd, claudeSessionId) {
  return require('../prd/prdCreate.cjs').resolveSourcePromptIdFromClaudeSession(cwd, claudeSessionId);
}

/** The request Y was opened with: its title (goalText), source.proposal, and
 *  the sources of its 'reference' intake sections. */
function originalRequest(y) {
  const sections = Array.isArray(y.sections) ? y.sections : [];
  return {
    title: typeof y.goalText === 'string' ? y.goalText : '',
    proposal: (y.source && y.source.proposal && typeof y.source.proposal === 'object') ? y.source.proposal : {},
    referencePaths: sections
      .filter((s) => s && s.part === 'reference' && typeof s.source === 'string' && s.source)
      .map((s) => s.source),
  };
}

function countReceipts(cwd, epicId) {
  const events = readActiveIndex(cwd).events[epicId];
  return Array.isArray(events) ? events.filter((e) => e && e.notice === RECEIPT_NOTICE).length : 0;
}

/**
 * sendFeedbackReply(input, deps) → Promise<result>
 *
 * input: { message, outcome, referencePaths?, toEpicId?, fromCwd,
 *          originProjectRoot?, originClaudeSessionId }
 * deps:  { sendPrompt, appendEvent, resolveEpicId, appendAudit, openFallback }
 *        openFallback defaults to crossProjectFeedback.openReplyFallbackSession;
 *        pass null to get a 409 fallbackNeeded instead.
 */
async function sendFeedbackReply(input, deps = {}) {
  const sendPrompt = deps.sendPrompt || defaultSendPrompt;
  const appendEvent = deps.appendEvent || defaultAppendEvent;
  const resolveEpicId = deps.resolveEpicId || defaultResolveEpicId;
  const audit = deps.appendAudit || appendAuditEvent;

  // 1. Validation.
  const valid = validateReplyInput(input);
  if (!valid.ok) return valid;
  const { message, outcome, referencePaths } = valid.value;

  // 2. Identity — Y comes ONLY from the caller's chat session id.
  const originClaudeSessionId = typeof input.originClaudeSessionId === 'string' ? input.originClaudeSessionId : '';
  const rawCwd = input.originProjectRoot || input.fromCwd;
  if (!originClaudeSessionId || !rawCwd || typeof rawCwd !== 'string') {
    return bad(403, 'feedback_reply needs the calling chat session identity; scheduled jobs and unidentified callers cannot reply');
  }
  const replierCwd = resolveProjectContext({ cwd: rawCwd }).cwd;
  let yId = null;
  try {
    yId = replierCwd ? resolveEpicId(replierCwd, originClaudeSessionId) : null;
  } catch {
    yId = null;
  }
  if (!yId) return bad(403, 'no Epic in the calling project owns this chat session — cannot reply');
  const yIndex = readActiveIndex(replierCwd);
  const y = yIndex.sessions[yId];
  if (!y) return bad(403, 'no Epic in the calling project owns this chat session — cannot reply');

  // 3. Thread.
  const src = y.source || {};
  const rt = src.replyTo;
  const threadComplete = src.producer === 'cross-project-feedback' && rt && typeof rt === 'object'
    && typeof rt.cwd === 'string' && rt.cwd
    && typeof rt.epicId === 'string' && rt.epicId
    && typeof rt.claudeSessionId === 'string' && rt.claudeSessionId;
  if (!threadComplete) {
    return bad(400, 'this session is not answering a cross-project request with a reply thread — '
      + 'a new request to another project goes through feedback_open_session');
  }
  if (input.toEpicId !== undefined && input.toEpicId !== null && input.toEpicId !== rt.epicId) {
    return bad(403, `this session may only reply to Epic ${rt.epicId}, the one that asked`);
  }
  let targetCwd;
  try {
    targetCwd = config.validatePath(path.resolve(rt.cwd));
  } catch (e) {
    return bad(400, `replyTo.cwd rejected: ${e.message}`);
  }
  if (!feedbackConduit().isSessionManagerProject(targetCwd)) {
    return bad(400, `${targetCwd} is not a Session Manager project`);
  }
  if (realOr(targetCwd) === realOr(path.resolve(replierCwd))) {
    return bad(400, 'replyTo points at the replying project itself — use /develop inside this Epic');
  }

  return withThreadLock(`${realOr(replierCwd)}\u0000${yId}`, async () => {
    // 4. Cap.
    const sent = countReceipts(replierCwd, yId);
    if (sent >= MAX_REPLIES_PER_THREAD) {
      return bad(429, `reply limit of ${MAX_REPLIES_PER_THREAD} reached for this thread`);
    }

    // The fallback (default: crossProjectFeedback.openReplyFallbackSession,
    // the only cross-project mint authority) opens a NEW proposed Epic in the
    // asking project. `openFallback: null` disables it (409 fallbackNeeded).
    const openFallback = Object.prototype.hasOwnProperty.call(deps, 'openFallback')
      ? deps.openFallback
      : (args) => feedbackConduit().openReplyFallbackSession(args);
    const fallback = async (reason) => {
      if (typeof openFallback !== 'function') {
        return bad(409, `the asking Epic cannot take a reply: ${reason}`, { fallbackNeeded: true, reason });
      }
      const opened = await openFallback({
        reason,
        toCwd: targetCwd,
        toEpicId: rt.epicId,
        fromCwd: replierCwd,
        fromEpicId: yId,
        message,
        outcome,
        referencePaths,
        originClaudeSessionId,
        original: originalRequest(y),
      });
      if (!opened || !opened.ok || typeof opened.epicId !== 'string') return opened;
      const project = path.basename(targetCwd);
      // Receipt on Y — counts toward the per-thread cap like a delivered reply.
      await appendEvent(replierCwd, yId,
        `Reply to ${rt.epicId} in ${project} fell back to a new proposed session ${opened.epicId} in ${project} (${reason}).`,
        {
          notice: RECEIPT_NOTICE,
          allowInactive: true,
          reply: { fromCwd: replierCwd, fromEpicId: yId, outcome, referencePaths, fallbackEpicId: opened.epicId, reason },
        });
      // Best-effort receipt on X, only while X is still in A's active index.
      let receiptOnAskingEpic = false;
      try {
        if (readActiveIndex(targetCwd).sessions[rt.epicId]) {
          const r = await appendEvent(targetCwd, rt.epicId,
            `A reply from ${path.basename(replierCwd)} (${outcome}) could not be delivered here (${reason}); `
            + `it opened as a new proposed session ${opened.epicId}.`,
            { notice: FALLBACK_NOTICE, allowInactive: true, reply: { fromCwd: replierCwd, fromEpicId: yId, outcome, fallbackEpicId: opened.epicId } });
          receiptOnAskingEpic = !!(r && r.ok);
        }
      } catch { receiptOnAskingEpic = false; }
      return {
        ok: true,
        delivery: 'fallback',
        reason,
        toCwd: targetCwd,
        toEpicId: rt.epicId,
        fallbackEpicId: opened.epicId,
        receiptOnAskingEpic,
        repliesUsed: sent + 1,
        repliesLeft: MAX_REPLIES_PER_THREAD - sent - 1,
      };
    };

    // 5. Deliver.
    const x = readActiveIndex(targetCwd).sessions[rt.epicId];
    if (!x) return fallback('missing');
    if (x.status !== 'active') return fallback('not-active');
    if (x.claudeSessionId !== rt.claudeSessionId) return fallback('session-mismatch');

    const prompt = composeReplyPrompt({
      fromCwd: replierCwd,
      fromEpicId: yId,
      fromGoalText: y.goalText,
      outcome,
      message,
      referencePaths,
    });
    const appended = await appendEvent(targetCwd, x.id, prompt, {
      notice: REPLY_NOTICE,
      reply: { fromCwd: replierCwd, fromEpicId: yId, outcome, referencePaths },
    });
    if (!appended || !appended.ok) return fallback((appended && appended.reason) || 'append-failed');

    let sendResult;
    try {
      sendResult = await sendPrompt(x.id, prompt, { sessionId: x.claudeSessionId, cwd: x.cwd || targetCwd });
    } catch (e) {
      sendResult = { disposition: 'unconfirmed', reason: e && e.message ? e.message : 'send-error' };
    }
    const disposition = sendResult && sendResult.disposition;
    if (disposition === 'refused') return fallback(`send-refused:${sendResult.reason || 'unknown'}`);
    const delivery = disposition === 'sent' || disposition === 'queued' ? 'delivered' : 'event-only';

    // 6. Receipt on Y (counts toward the cap).
    await appendEvent(replierCwd, yId,
      `Reply sent to ${x.id} in ${path.basename(targetCwd)} (${outcome}, ${delivery}).`,
      {
        notice: RECEIPT_NOTICE,
        allowInactive: true,
        reply: { fromCwd: replierCwd, fromEpicId: yId, outcome, referencePaths },
      });

    // 7. Audit.
    audit('epic_cross_project_reply', {
      cwd: targetCwd,
      epicId: x.id,
      fromCwd: replierCwd,
      fromEpicId: yId,
      outcome,
      delivery,
    });

    return {
      ok: true,
      delivery,
      toCwd: targetCwd,
      toEpicId: x.id,
      repliesUsed: sent + 1,
      repliesLeft: MAX_REPLIES_PER_THREAD - sent - 1,
      ...(delivery === 'event-only' && sendResult && sendResult.reason ? { reason: sendResult.reason } : {}),
    };
  });
}

/** Registers POST /admin/feedback/reply on the loopback admin transport —
 *  mirrors crossProjectFeedback.registerAdminRoute; auth is the transport's. */
function registerAdminRoute(adminHttp, deps) {
  adminHttp.registerRoute('POST', '/admin/feedback/reply', async (req, res) => {
    const raw = await readBody(req);
    let parsed;
    try {
      parsed = raw ? JSON.parse(raw) : {};
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
      return;
    }
    const result = await sendFeedbackReply(parsed, deps);
    if (!result.ok) {
      const { ok: _ok, status, ...rest } = result;
      sendJson(res, status ?? 400, { ok: false, ...rest });
      return;
    }
    sendJson(res, 200, result);
  });
}

module.exports = {
  MAX_REPLIES_PER_THREAD,
  REPLY_OUTCOMES,
  composeReplyPrompt,
  validateReplyInput,
  sendFeedbackReply,
  registerAdminRoute,
};
