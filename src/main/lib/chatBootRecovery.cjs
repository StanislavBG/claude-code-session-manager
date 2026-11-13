'use strict';

/**
 * Boot recovery for chat turns that were in flight when the app died
 * (ledger: lib/chatInflight.cjs). Per ledger entry:
 *  - pid alive AND it is an sm-claude-chat process for that sessionId → orphan: hold the
 *    session in chatRunner so run() queues instead of spawning a second writer, poll until
 *    it exits, then treat it as dead;
 *  - dead (or recycled pid) → Claude's own session JSONL decides (classifyTurnTail): finished or
 *    missing, or a silent entry → just clear the entry; unfinished → re-run ONCE through
 *    chatRunner.run() with the same sessionId and a fixed continue prompt, at most once per
 *    session per 24 h.
 * Touches only the session's own turn: never mints an Epic or edits its title/objective/status.
 * An entry whose Epic runs a non-Claude agent CLI (agentCli) has no Claude JSONL to judge and
 * no `claude --resume` to continue, so it is cleared from the ledger and logged, never re-run.
 */

const { isNonClaudeAgentCli } = require('./agent-cli/agentCliEvents.cjs');

const DAY_MS = 24 * 60 * 60 * 1000;
const ORPHAN_POLL_MS = 5000;

const CONTINUE_PROMPT = 'The Session Manager app restarted while your previous turn was running. '
  + 'Check what already landed (files, git status, commits, tool results) before repeating any step, '
  + 'then continue the interrupted work from where it stopped.';

function defaultPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
}

/**
 * Default Epic lookup for a ledger entry: the project's active index, keyed by promptId
 * (the Epic id) or matched by claudeSessionId. Returns the Epic's agentCli or null.
 */
function defaultAgentCliOf(entry) {
  try {
    if (!entry || typeof entry.cwd !== 'string' || !entry.cwd) return null;
    const { projectRootOf } = require('./activeSessions.cjs');
    const { readActiveIndex } = require('./epic/epicMint.cjs');
    const sessions = readActiveIndex(projectRootOf(entry.cwd)).sessions || {};
    let rec = entry.promptId && Object.prototype.hasOwnProperty.call(sessions, entry.promptId)
      ? sessions[entry.promptId] : null;
    if (!rec) rec = Object.values(sessions).find((s) => s && s.claudeSessionId === entry.sessionId) || null;
    return rec && typeof rec.agentCli === 'string' ? rec.agentCli : null;
  } catch { return null; }
}

function defaultLog(line) {
  try { require('../logs.cjs').writeLine(line); } catch { /* best-effort */ }
}

function isChatProcessFor(identity, sessionId) {
  const cmd = identity && typeof identity.cmdline === 'string' ? identity.cmdline : '';
  return cmd.includes('sm-claude-chat') && cmd.includes(sessionId);
}

/**
 * Classify the tail of a Claude session JSONL.
 * @param {string} text
 * @returns {'finished'|'unfinished'|'missing'}
 */
function classifyTurnTail(text) {
  if (typeof text !== 'string' || !text) return 'missing';
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (!t) continue;
    let obj;
    try { obj = JSON.parse(t); } catch { continue; }
    if (!obj || typeof obj !== 'object') continue;
    if (obj.type === 'user') return 'unfinished';
    if (obj.type === 'assistant') {
      const sr = obj.message && obj.message.stop_reason;
      return sr != null && sr !== 'tool_use' ? 'finished' : 'unfinished';
    }
  }
  return 'missing';
}

/**
 * @param {object} deps
 *  ledger {list,end,markRecovered,recoveredMap}, run(opts), holdOrphan(sid), releaseOrphan(sid),
 *  pidAlive(pid), identityOf(pid), sessionTurnState(entry) → 'finished'|'unfinished'|'missing',
 *  now(), pollMs, setTimer/clearTimer (tests), agentCliOf(entry) → agentCli|null, log(line)
 * @returns {Promise<{ pending: Promise<void>, results: object[] }>} resolves after the first pass;
 *  `pending` settles once every orphan has exited and been handled.
 */
async function recoverInflightTurns(deps) {
  const {
    ledger, run, holdOrphan = () => {}, releaseOrphan = () => {},
    pidAlive = defaultPidAlive, identityOf = () => null,
    sessionTurnState = async () => 'missing',
    now = Date.now, pollMs = ORPHAN_POLL_MS,
    setTimer = setTimeout,
    agentCliOf = defaultAgentCliOf, log = defaultLog,
  } = deps;
  const results = [];
  const waits = [];
  let entries = [];
  try { entries = await ledger.list(); } catch { entries = []; }

  async function settleDead(entry) {
    const { sessionId, tabId, cwd } = entry;
    let state = 'missing';
    if (!entry.silent) {
      try { state = await sessionTurnState(entry); } catch { state = 'missing'; }
    }
    if (entry.silent || state !== 'unfinished') {
      await ledger.end(sessionId);
      return { sessionId, outcome: 'finished' };
    }
    let recovered = {};
    try { recovered = await ledger.recoveredMap(); } catch { recovered = {}; }
    const prev = Number(recovered[sessionId]);
    if (Number.isFinite(prev) && now() - prev < DAY_MS) {
      await ledger.end(sessionId);
      return { sessionId, outcome: 'guarded' };
    }
    await ledger.markRecovered(sessionId, now());
    await ledger.end(sessionId);
    run({
      tabId, sessionId, cwd, prompt: CONTINUE_PROMPT, resume: true,
      ...(entry.promptId ? { promptId: entry.promptId } : {}),
      ...(entry.origin ? { origin: entry.origin } : {}),
      ...(entry.worktreeDirHint ? { worktreeDirHint: entry.worktreeDirHint } : {}),
    });
    return { sessionId, outcome: 'rerun' };
  }

  function isOrphan(entry) {
    if (!pidAlive(entry.pid)) return false;
    try { return isChatProcessFor(identityOf(entry.pid), entry.sessionId); } catch { return false; }
  }

  for (const entry of entries) {
    if (!entry || !entry.sessionId) continue;
    let agentCli = null;
    try { agentCli = agentCliOf(entry); } catch { agentCli = null; }
    if (isNonClaudeAgentCli(agentCli)) {
      try {
        log({
          scope: 'chat-boot-recovery', level: 'info',
          message: `skipping interrupted ${agentCli} turn for session ${entry.sessionId} (no auto-continue for non-Claude agent CLIs)`,
          meta: { sessionId: entry.sessionId, agentCli },
        });
      } catch { /* best-effort */ }
      try { await ledger.end(entry.sessionId); } catch { /* best-effort */ }
      results.push({ sessionId: entry.sessionId, outcome: 'skipped_agent_cli', agentCli });
      continue;
    }
    if (isOrphan(entry)) {
      holdOrphan(entry.sessionId);
      waits.push(new Promise((resolve) => {
        const tick = () => {
          if (isOrphan(entry)) {
            const t = setTimer(tick, pollMs);
            if (t && typeof t.unref === 'function') t.unref();
            return;
          }
          settleDead(entry)
            .catch(() => ({ sessionId: entry.sessionId, outcome: 'error' }))
            .then((r) => { results.push(r); releaseOrphan(entry.sessionId); resolve(); });
        };
        const t = setTimer(tick, pollMs);
        if (t && typeof t.unref === 'function') t.unref();
      }));
      results.push({ sessionId: entry.sessionId, outcome: 'orphan' });
      continue;
    }
    try { results.push(await settleDead(entry)); } catch { results.push({ sessionId: entry.sessionId, outcome: 'error' }); }
  }
  return { results, pending: Promise.all(waits).then(() => undefined) };
}

module.exports = { recoverInflightTurns, classifyTurnTail, CONTINUE_PROMPT, DAY_MS };
