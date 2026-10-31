'use strict';

/**
 * Durable ledger of in-flight chat turns (~/.claude/session-manager/chat-inflight.json).
 * begin() after a successful spawn, end() when the turn settles; list() lets the next
 * boot see what was running. Carries NO prompt text and nothing from childEnv.
 * Never throws into a turn: a missing/corrupt ledger reads as empty.
 */

const path = require('node:path');
const { readJsonOr, writeJsonAtomic } = require('./util/atomicFs.cjs');
const { schedulerHome } = require('./scheduler/schedulerPaths.cjs');

function ledgerPath() {
  return process.env.SM_CHAT_INFLIGHT_PATH || path.join(schedulerHome(), 'chat-inflight.json');
}

// One in-process chain serializes every read-modify-write.
let chain = Promise.resolve();

async function readAll() {
  try {
    const data = await readJsonOr(ledgerPath(), {});
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch { return {}; }
}

function enqueue(mutate) {
  const next = chain.then(async () => {
    try {
      const all = await readAll();
      mutate(all);
      await writeJsonAtomic(ledgerPath(), all);
    } catch { /* ledger is best-effort */ }
  });
  chain = next;
  return next;
}

/** Fields of a run() payload that may be persisted (never prompt / env). */
function sanitize(sessionId, entry) {
  const e = entry || {};
  const out = { sessionId, startedAt: Date.now() };
  for (const k of ['tabId', 'cwd', 'pid', 'startedAt', 'resume', 'silent', 'promptId', 'origin', 'worktreeDirHint']) {
    if (e[k] !== undefined && typeof e[k] !== 'function') out[k] = e[k];
  }
  out.sessionId = sessionId;
  return out;
}

function begin(sessionId, entry) {
  if (!sessionId) return Promise.resolve();
  return enqueue((all) => { all[sessionId] = sanitize(sessionId, entry); });
}

function end(sessionId) {
  if (!sessionId) return Promise.resolve();
  return enqueue((all) => { delete all[sessionId]; });
}

/** @returns {Promise<object[]>} */
async function list() {
  await chain;
  return Object.values(await readAll());
}

module.exports = { begin, end, list, ledgerPath };
