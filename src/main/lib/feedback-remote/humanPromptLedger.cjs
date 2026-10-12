'use strict';

/**
 * humanPromptLedger.cjs — in-memory record of prompts a HUMAN typed into each
 * chat claude session, keyed by claudeSessionId.
 *
 * Why it exists. The cross-project feedback conduit (crossProjectFeedback.cjs)
 * may auto-approve a receiving-project session only when the human explicitly
 * asked for it. An agent's say-so is not evidence of that. This ledger is the
 * ONLY evidence that a human — not an agent, not an external/Web Remote
 * injection, not an inbound proposal's agent-written opening prompt — typed a
 * given prompt. Callers record only prompts that arrived from the human's own
 * chat input, then ask `findHumanPromptContaining` whether a quoted request
 * really appears in one.
 *
 * In-memory by design. Losing the ledger on restart only degrades auto-approve
 * back to the ordinary 'proposed' path — it fails closed, so nothing is
 * persisted to disk.
 *
 * Bounds: 10 prompts per session, 24h TTL, 200 sessions (least-recently-
 * recorded evicted), 20000 chars per stored prompt. Pure Node, no Electron.
 */

const MIN_QUOTE_CHARS = 20;
const MAX_PER_SESSION = 10;
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 200;
const MAX_TEXT_CHARS = 20000;

/** @type {Map<string, Array<{ text: string, norm: string, at: number }>>} */
const ledger = new Map();

/** @param {string} s */
function normalize(s) {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * @param {unknown} claudeSessionId
 * @param {unknown} text
 * @param {number} [now]
 */
function recordHumanPrompt(claudeSessionId, text, now = Date.now()) {
  try {
    if (typeof claudeSessionId !== 'string' || !claudeSessionId) return;
    if (typeof text !== 'string' || !text.trim()) return;
    const stored = text.slice(0, MAX_TEXT_CHARS);
    const prior = (ledger.get(claudeSessionId) || []).filter((e) => now - e.at <= TTL_MS);
    prior.push({ text: stored, norm: normalize(stored), at: now });
    while (prior.length > MAX_PER_SESSION) prior.shift();
    // Re-insert so Map order is least-recently-recorded first.
    ledger.delete(claudeSessionId);
    ledger.set(claudeSessionId, prior);
    while (ledger.size > MAX_SESSIONS) {
      const oldest = ledger.keys().next().value;
      if (oldest === undefined) break;
      ledger.delete(oldest);
    }
  } catch {
    /* never throws */
  }
}

/**
 * @param {unknown} claudeSessionId
 * @param {unknown} quote
 * @param {number} [now]
 * @returns {{ text: string, at: number } | null}
 */
function findHumanPromptContaining(claudeSessionId, quote, now = Date.now()) {
  try {
    if (typeof claudeSessionId !== 'string' || typeof quote !== 'string') return null;
    const q = normalize(quote);
    if (q.length < MIN_QUOTE_CHARS) return null;
    const entries = ledger.get(claudeSessionId);
    if (!entries) return null;
    const live = entries.filter((e) => now - e.at <= TTL_MS);
    if (live.length === 0) ledger.delete(claudeSessionId);
    else if (live.length !== entries.length) ledger.set(claudeSessionId, live);
    for (let i = live.length - 1; i >= 0; i--) {
      if (live[i].norm.includes(q)) return { text: live[i].text, at: live[i].at };
    }
    return null;
  } catch {
    return null;
  }
}

function _resetForTests() {
  ledger.clear();
}

module.exports = { recordHumanPrompt, findHumanPromptContaining, MIN_QUOTE_CHARS, _resetForTests };
