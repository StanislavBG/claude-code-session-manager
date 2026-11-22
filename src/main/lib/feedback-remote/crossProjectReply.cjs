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
 *   - LEGACY: a request Epic minted before reply threads (no replyTo, no
 *     replyOf) threads to source.fromEpicId in source.fromCwd, without the
 *     Claude-session check;
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

const crypto = require('node:crypto');
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
/** Event mode (source.replyTo.mode 'event'): the asker keeps its own records,
 *  so the reply is data in the audit row — never a chat prompt or a fallback. */
const EVENT_MODE_REASON = 'asker-requested-event';
const AUDIT_MESSAGE_CHARS = 2000;
const AUDIT_MAX_REFERENCES = 10;

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

/**
 * receiptFields(appendResult) → { receiptOnReplyingEpic, receiptError? }
 *
 * The receipt on Y is the per-thread cap's only record, and
 * appendResponseEventWithReason never throws — a failed write (a transient
 * read mapped to 'no-index', a write 'error') comes back as { ok: false }.
 * Discarding that result let a reply resolve ok with no receipt on disk, so
 * the caller and the cap both believed a write had landed that had not.
 * The reply itself already happened, so the result stays ok (a resend would
 * duplicate it), but it says the receipt is missing and why.
 */
function receiptFields(appendResult) {
  if (appendResult && appendResult.ok) return { receiptOnReplyingEpic: true };
  return {
    receiptOnReplyingEpic: false,
    receiptError: (appendResult && appendResult.reason) || 'append-failed',
  };
}

/** The thread's receipts on Y — the cap count and the latest one (for the
 *  identical-retry check) come from the same read. */
function readReceipts(cwd, epicId) {
  const events = readActiveIndex(cwd).events[epicId];
  return Array.isArray(events) ? events.filter((e) => e && e.notice === RECEIPT_NOTICE) : [];
}

/** reply.hash on every receipt: an identical retry (same outcome + message)
 *  of the thread's latest reply is the same reply, not a new one. */
function replyHash(outcome, message) {
  return crypto.createHash('sha256').update(`${outcome}\n${message}`).digest('hex');
}

/** The delivery fields an earlier receipt recorded, returned to an identical
 *  retry instead of delivering again. */
function earlierDelivery(receipt, { targetCwd, rt, threadField, sent }) {
  const r = receipt.reply || {};
  return {
    ok: true,
    alreadyDelivered: true,
    delivery: r.delivery || 'delivered',
    toCwd: targetCwd,
    toEpicId: r.toEpicId || rt.epicId || null,
    ...(r.fallbackEpicId ? { fallbackEpicId: r.fallbackEpicId } : {}),
    ...(r.reused ? { reused: true } : {}),
    ...(r.reason ? { reason: r.reason } : {}),
    ...threadField,
    receiptOnReplyingEpic: true,
    repliesUsed: sent,
    repliesLeft: Math.max(0, MAX_REPLIES_PER_THREAD - sent),
  };
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
  const resolved = resolveThread(y.source || {});
  if (!resolved.ok) return bad(400, resolved.error);
  const rt = resolved.thread;
  const legacy = resolved.legacy;
  const eventMode = resolved.mode === 'event';
  const threadField = legacy ? { thread: 'legacy' } : {};
  if (input.toEpicId !== undefined && input.toEpicId !== null && input.toEpicId !== rt.epicId) {
    return bad(403, `this session may only reply to Epic ${rt.epicId}, the one that asked`);
  }
  let targetCwd;
  try {
    targetCwd = config.validatePath(path.resolve(rt.cwd));
  } catch (e) {
    return bad(400, `${legacy ? 'source.fromCwd' : 'replyTo.cwd'} rejected: ${e.message}`);
  }
  if (!feedbackConduit().isSessionManagerProject(targetCwd)) {
    return bad(400, `${targetCwd} is not a Session Manager project`);
  }
  if (realOr(targetCwd) === realOr(path.resolve(replierCwd))) {
    return bad(400, 'replyTo points at the replying project itself — use /develop inside this Epic');
  }

  return withThreadLock(`${realOr(replierCwd)}\u0000${yId}`, async () => {
    // 4. Identical retry, then cap.
    const receipts = readReceipts(replierCwd, yId);
    const sent = receipts.length;
    const hash = replyHash(outcome, message);
    const latest = receipts[sent - 1];
    if (latest && latest.reply && latest.reply.hash === hash) {
      return earlierDelivery(latest, { targetCwd, rt, threadField, sent });
    }
    if (sent >= MAX_REPLIES_PER_THREAD) {
      return bad(429, `reply limit of ${MAX_REPLIES_PER_THREAD} reached for this thread`);
    }

    if (eventMode) {
      return replyAsEvent({
        appendEvent, audit, sent, rt, targetCwd, replierCwd, yId, y,
        message, outcome, referencePaths, hash,
      });
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
      const reused = opened.reused === true;
      // A reused fallback Epic already carries the first reply in its opening
      // prompt; this one must land in it too, or its text is lost.
      let landedInFallback = null;
      if (reused) {
        landedInFallback = await deliverIntoReusedFallback({
          sendPrompt, appendEvent, targetCwd, epicId: opened.epicId,
          replierCwd, yId, y, outcome, message, referencePaths,
        });
      }
      // Receipt on Y — counts toward the per-thread cap like a delivered reply.
      const receipt = await appendEvent(replierCwd, yId,
        reused
          ? `Reply to ${rt.epicId} in ${project} fell back into the open session ${opened.epicId} in ${project} (${reason}).`
          : `Reply to ${rt.epicId} in ${project} fell back to a new proposed session ${opened.epicId} in ${project} (${reason}).`,
        {
          notice: RECEIPT_NOTICE,
          allowInactive: true,
          reply: {
            fromCwd: replierCwd, fromEpicId: yId, outcome, referencePaths, hash,
            delivery: 'fallback', toEpicId: rt.epicId, fallbackEpicId: opened.epicId, reason,
            ...(reused ? { reused: true } : {}),
          },
        });
      // Best-effort receipt on X, only while X is still in A's active index.
      let receiptOnAskingEpic = false;
      try {
        if (readActiveIndex(targetCwd).sessions[rt.epicId]) {
          const r = await appendEvent(targetCwd, rt.epicId,
            `A reply from ${path.basename(replierCwd)} (${outcome}) could not be delivered here (${reason}); `
            + (reused ? `it was added to the open session ${opened.epicId}.` : `it opened as a new proposed session ${opened.epicId}.`),
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
        ...(reused ? { reused: true, landedInFallback } : {}),
        receiptOnAskingEpic,
        ...threadField,
        ...receiptFields(receipt),
        repliesUsed: sent + 1,
        repliesLeft: MAX_REPLIES_PER_THREAD - sent - 1,
      };
    };

    // 5. Deliver.
    const x = readActiveIndex(targetCwd).sessions[rt.epicId];
    if (!x) return fallback('missing');
    if (x.status !== 'active') return fallback('not-active');
    // Legacy threads carry no session pin; X's own (1:1, life-long) session is the one that asked.
    if (legacy ? !(typeof x.claudeSessionId === 'string' && x.claudeSessionId) : x.claudeSessionId !== rt.claudeSessionId) {
      return fallback('session-mismatch');
    }

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
    const receipt = await appendEvent(replierCwd, yId,
      `Reply sent to ${x.id} in ${path.basename(targetCwd)} (${outcome}, ${delivery}).`,
      {
        notice: RECEIPT_NOTICE,
        allowInactive: true,
        reply: {
          fromCwd: replierCwd, fromEpicId: yId, outcome, referencePaths, hash,
          delivery, toEpicId: x.id,
          ...(delivery === 'event-only' && sendResult && sendResult.reason ? { reason: sendResult.reason } : {}),
        },
      });

    // 7. Audit.
    audit('epic_cross_project_reply', {
      cwd: targetCwd,
      epicId: x.id,
      fromCwd: replierCwd,
      fromEpicId: yId,
      outcome,
      delivery,
      ...threadField,
    });

    return {
      ok: true,
      delivery,
      toCwd: targetCwd,
      toEpicId: x.id,
      ...threadField,
      ...receiptFields(receipt),
      repliesUsed: sent + 1,
      repliesLeft: MAX_REPLIES_PER_THREAD - sent - 1,
      ...(delivery === 'event-only' && sendResult && sendResult.reason ? { reason: sendResult.reason } : {}),
    };
  });
}

/**
 * replyAsEvent(ctx) → Promise<result>. Event-mode delivery, run inside the
 * per-Epic lock after the cap check: append the reply event on X only when
 * replyTo.epicId names an active Epic in replyTo.cwd, write the receipt on Y,
 * and put what an outside app needs to match and read the reply into the
 * audit row. Never prompts a chat, never opens a fallback session.
 */
async function replyAsEvent({
  appendEvent, audit, sent, rt, targetCwd, replierCwd, yId, y, message, outcome, referencePaths, hash,
}) {
  const replyMeta = { fromCwd: replierCwd, fromEpicId: yId, outcome, referencePaths };
  let eventOnAskingEpic = false;
  const x = nonEmpty(rt.epicId) ? readActiveIndex(targetCwd).sessions[rt.epicId] : null;
  if (x && x.status === 'active') {
    const prompt = composeReplyPrompt({
      fromCwd: replierCwd, fromEpicId: yId, fromGoalText: y.goalText, outcome, message, referencePaths,
    });
    try {
      const appended = await appendEvent(targetCwd, x.id, prompt, { notice: REPLY_NOTICE, reply: replyMeta });
      eventOnAskingEpic = !!(appended && appended.ok);
    } catch { eventOnAskingEpic = false; }
  }

  const project = path.basename(targetCwd);
  const receipt = await appendEvent(replierCwd, yId,
    `Reply recorded as an event for ${rt.epicId ? `${rt.epicId} in ` : ''}${project} (${outcome}, event-only).`,
    {
      notice: RECEIPT_NOTICE,
      allowInactive: true,
      reply: {
        ...replyMeta, hash, delivery: 'event-only', reason: EVENT_MODE_REASON,
        ...(rt.epicId ? { toEpicId: rt.epicId } : {}),
      },
    });

  const externalRef = y.source && y.source.externalRef;
  audit('epic_cross_project_reply', {
    cwd: targetCwd,
    epicId: rt.epicId || null,
    fromCwd: replierCwd,
    fromEpicId: yId,
    outcome,
    delivery: 'event-only',
    mode: 'event',
    ...(externalRef ? { externalRef } : {}),
    message: message.slice(0, AUDIT_MESSAGE_CHARS),
    referencePaths: referencePaths.slice(0, AUDIT_MAX_REFERENCES),
  });

  return {
    ok: true,
    delivery: 'event-only',
    reason: EVENT_MODE_REASON,
    toCwd: targetCwd,
    toEpicId: rt.epicId || null,
    eventOnAskingEpic,
    ...receiptFields(receipt),
    repliesUsed: sent + 1,
    repliesLeft: MAX_REPLIES_PER_THREAD - sent - 1,
  };
}

const nonEmpty = (v) => typeof v === 'string' && v.length > 0;

/**
 * deliverIntoReusedFallback(ctx) → Promise<'delivered'|'event-only'|'event-failed'>
 * A later reply on a thread whose open fallback Epic F was reused: an ACTIVE
 * F gets the same event + prompt as a delivered reply; a PROPOSED F (no chat
 * running yet) gets the reply as an event on its chain (allowInactive).
 */
async function deliverIntoReusedFallback({
  sendPrompt, appendEvent, targetCwd, epicId, replierCwd, yId, y, outcome, message, referencePaths,
}) {
  const f = readActiveIndex(targetCwd).sessions[epicId] || {};
  const active = f.status === 'active';
  const prompt = composeReplyPrompt({
    fromCwd: replierCwd, fromEpicId: yId, fromGoalText: y.goalText, outcome, message, referencePaths,
  });
  let appended;
  try {
    appended = await appendEvent(targetCwd, epicId, prompt, {
      notice: REPLY_NOTICE,
      ...(active ? {} : { allowInactive: true }),
      reply: { fromCwd: replierCwd, fromEpicId: yId, outcome, referencePaths },
    });
  } catch { appended = null; }
  if (!appended || !appended.ok) return 'event-failed';
  if (!active) return 'event-only';
  let sendResult;
  try {
    sendResult = await sendPrompt(epicId, prompt, { sessionId: f.claudeSessionId, cwd: f.cwd || targetCwd });
  } catch { sendResult = null; }
  const d = sendResult && sendResult.disposition;
  return d === 'sent' || d === 'queued' ? 'delivered' : 'event-only';
}

/**
 * resolveThread(src) — pure. The thread a replying Epic's `source` names:
 *   { ok: true, thread: { cwd, epicId, claudeSessionId }, legacy } or { ok: false, error }.
 * A complete replyTo → legacy false; a replyTo with mode 'event' needs only a cwd
 * (→ mode: 'event'). A pre-reply-thread request Epic (no
 * replyTo key, no replyOf, fromCwd + fromEpicId set) → legacy true, no
 * session pin. Every refusal says why and points at feedback_open_session.
 */
function resolveThread(src) {
  const s = src && typeof src === 'object' ? src : {};
  const isRequest = s.producer === 'cross-project-feedback';
  const rt = s.replyTo;
  // Event mode needs only the asker's cwd; epicId/claudeSessionId may be null.
  if (isRequest && rt && typeof rt === 'object' && rt.mode === 'event' && nonEmpty(rt.cwd)) {
    return {
      ok: true,
      thread: {
        cwd: rt.cwd,
        epicId: nonEmpty(rt.epicId) ? rt.epicId : null,
        claudeSessionId: nonEmpty(rt.claudeSessionId) ? rt.claudeSessionId : null,
      },
      legacy: false,
      mode: 'event',
    };
  }
  if (isRequest && rt && typeof rt === 'object'
    && nonEmpty(rt.cwd) && nonEmpty(rt.epicId) && nonEmpty(rt.claudeSessionId)) {
    return { ok: true, thread: { cwd: rt.cwd, epicId: rt.epicId, claudeSessionId: rt.claudeSessionId }, legacy: false };
  }
  if (s.replyOf) {
    return {
      ok: false,
      error: 'this session is itself a reply that could not be delivered, so it has no thread to answer — '
        + 'a new request to another project goes through feedback_open_session',
    };
  }
  const hasReplyTo = Object.prototype.hasOwnProperty.call(s, 'replyTo');
  if (isRequest && !hasReplyTo && nonEmpty(s.fromCwd)) {
    if (nonEmpty(s.fromEpicId)) {
      return { ok: true, thread: { cwd: s.fromCwd, epicId: s.fromEpicId, claudeSessionId: null }, legacy: true };
    }
    return {
      ok: false,
      error: 'the sending session was not identified when this request was opened, so there is no thread to answer — '
        + `send a new request to ${s.fromCwd} with feedback_open_session`,
    };
  }
  return {
    ok: false,
    error: 'this session is not answering a cross-project request with a reply thread — '
      + 'a new request to another project goes through feedback_open_session',
  };
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
