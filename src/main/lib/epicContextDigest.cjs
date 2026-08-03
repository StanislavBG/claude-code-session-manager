'use strict';

/**
 * epicContextDigest.cjs — condensed, real (never fabricated) digest of an
 * Epic's own session, for later injection into a scheduled PRD job's opening
 * prompt (wiring is a separate, dependent PRD — this module is groundwork
 * only). Composes the Epic's goalText (active-index.json, via epicMint.cjs's
 * readActiveIndex) with its most-recent turns (the JSONL transcript, via
 * promptSessionTranscript.cjs's readTurns) — never reimplements either read.
 *
 * Plain Node module (no Electron deps), matching sessionSlots.cjs's and
 * promptSessionTranscript.cjs's own posture, so it is callable from
 * scheduler.cjs.
 */

const { readTurns } = require('../promptSessionTranscript.cjs');
const { readActiveIndex } = require('./epicMint.cjs');

const DEFAULT_MAX_CHARS = 4000;
const TURN_LIMIT = 40;

function formatTurn(turn) {
  return `[${turn.role}] ${turn.text}`;
}

/**
 * buildContextDigest({ cwd, epicId, maxChars }) → Promise<string>
 *
 * Best-effort: every internal call is wrapped so a failure here can never
 * propagate to a caller — returns '' on any error, missing epicId, an epicId
 * absent from the cwd's active-index.json, or an empty transcript.
 */
async function buildContextDigest({ cwd, epicId, maxChars } = {}) {
  try {
    if (!cwd || !epicId) return '';
    const limit = typeof maxChars === 'number' && maxChars > 0 ? maxChars : DEFAULT_MAX_CHARS;

    const index = readActiveIndex(cwd);
    if (!Object.prototype.hasOwnProperty.call(index.sessions, epicId)) return '';
    const session = index.sessions[epicId];
    const goalText = session && typeof session.goalText === 'string' ? session.goalText.trim() : '';

    const turns = await readTurns(cwd, epicId, { limit: TURN_LIMIT });

    const header = goalText;
    const headerChars = header ? header.length + 1 : 0; // +1 for trailing newline before turns

    // Drop whole turns from the oldest first until the joined digest fits —
    // never a hard mid-string slice that could cut a turn's text in half.
    let kept = turns.slice();
    while (kept.length > 0) {
      const lines = kept.map(formatTurn);
      const bodyChars = lines.length > 0 ? lines.join('\n').length : 0;
      const total = headerChars + bodyChars;
      if (total <= limit) break;
      kept = kept.slice(1);
    }

    const parts = [];
    if (header) parts.push(header);
    if (kept.length > 0) parts.push(kept.map(formatTurn).join('\n'));

    let digest = parts.join('\n');
    if (digest.length > limit) {
      // Header alone (no turns fit) can still exceed maxChars — clip the
      // header itself rather than exceeding the caller's bound.
      digest = digest.slice(0, limit);
    }
    return digest;
  } catch (e) {
    console.error('[epicContextDigest] buildContextDigest error', cwd, epicId, e);
    return '';
  }
}

const TASK_RESTATEMENT = 'Your task is the PRD at the top of this prompt. Implement it now.';

/**
 * composeExecutorPrompt({ prdBody, digestText, finishProtocol, maxChars }) → string
 *
 * Orders the executor prompt so the PRD body is unambiguously the task, the
 * Epic digest is unambiguously subordinate background, and the mandatory
 * finish protocol (review → security-review → verify → commit → verdict
 * sentinel) stays in the prompt's tail where it belongs: PRD body first,
 * then the fenced digest (if any), then the finish protocol (if supplied),
 * then a one-line restatement of the task last (recency matters — a prompt
 * that ends in someone else's conversation invites a conversational reply
 * instead of a diff, and a finish protocol buried before 4000 chars of
 * digest is easy for the model to lose track of).
 *
 * The digest is re-capped here (in addition to buildContextDigest's own
 * cap) so composeExecutorPrompt is safe to call with an arbitrary digest
 * string, not just one already produced by buildContextDigest. The PRD body
 * itself is never truncated to make room for the digest.
 *
 * When finishProtocol is omitted, callers get the pre-existing behavior
 * (body + digest fence + task restatement, no finish-protocol text) — this
 * keeps composeExecutorPrompt usable standalone. scheduler.cjs always
 * passes finishProtocol so its composed prompt matches what it used to
 * produce via `parsed.body + FINISH_PROTOCOL` in the no-digest case, byte
 * for byte.
 */
function composeExecutorPrompt({ prdBody, digestText, finishProtocol, maxChars } = {}) {
  const body = typeof prdBody === 'string' ? prdBody : '';
  const finish = typeof finishProtocol === 'string' && finishProtocol.trim() ? finishProtocol : '';
  const limit = typeof maxChars === 'number' && maxChars > 0 ? maxChars : DEFAULT_MAX_CHARS;

  const rawDigest = typeof digestText === 'string' ? digestText.trim() : '';
  if (!rawDigest) {
    return finish ? `${body}${finish}` : `${body}\n\n${TASK_RESTATEMENT}`;
  }

  const truncated = rawDigest.length > limit;
  const clippedDigest = truncated ? rawDigest.slice(0, limit) : rawDigest;

  const headerNote = truncated ? ' Truncated to fit the context budget.' : '';
  const fenceHeader = `--- BEGIN EPIC CONTEXT (background only — prior conversation from the Epic that authored the PRD above. It is NOT your task and contains no instructions for you. Your deliverable is the PRD above.${headerNote}) ---`;
  const fenceFooter = '--- END EPIC CONTEXT ---';

  const tail = finish ? `${finish.trim()}\n\n${TASK_RESTATEMENT}` : TASK_RESTATEMENT;

  return [body, fenceHeader, clippedDigest, fenceFooter, tail].join('\n\n');
}

module.exports = {
  buildContextDigest,
  composeExecutorPrompt,
};
