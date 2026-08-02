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

module.exports = {
  buildContextDigest,
};
