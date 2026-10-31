'use strict';

/**
 * Boot recovery for chat turns that were in flight when the app died
 * (ledger: lib/chatInflight.cjs). Per ledger entry:
 *  - pid alive AND it is an sm-claude-chat process for that sessionId → orphan: hold the
 *    session in chatRunner so run() queues instead of spawning a second writer, poll until
 *    it exits, then treat it as dead;
 *  - dead (or recycled pid) → transcript's last turn is the assistant's = finished: just
 *    clear the entry + refresh the tab; otherwise re-run ONCE through chatRunner.run() with
 *    the same sessionId and a fixed continue prompt, at most once per session per 24 h.
 * Touches only the session's own turn: never mints an Epic or edits its title/objective/status.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const ORPHAN_POLL_MS = 5000;

const CONTINUE_PROMPT = 'The Session Manager app restarted while your previous turn was running. '
  + 'Check what already landed (files, git status, commits, tool results) before repeating any step, '
  + 'then continue the interrupted work from where it stopped.';

function defaultPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
}

function isChatProcessFor(identity, sessionId) {
  const cmd = identity && typeof identity.cmdline === 'string' ? identity.cmdline : '';
  return cmd.includes('sm-claude-chat') && cmd.includes(sessionId);
}

/**
 * @param {object} deps
 *  ledger {list,end,markRecovered,recoveredMap}, run(opts), holdOrphan(sid), releaseOrphan(sid),
 *  pidAlive(pid), identityOf(pid), readTranscriptTail(cwd, tabId) → last turn|null,
 *  notify(channel, payload), now(), pollMs, setTimer/clearTimer (tests)
 * @returns {Promise<{ pending: Promise<void>, results: object[] }>} resolves after the first pass;
 *  `pending` settles once every orphan has exited and been handled.
 */
async function recoverInflightTurns(deps) {
  const {
    ledger, run, holdOrphan = () => {}, releaseOrphan = () => {},
    pidAlive = defaultPidAlive, identityOf = () => null,
    readTranscriptTail = async () => null, notify = () => {},
    now = Date.now, pollMs = ORPHAN_POLL_MS,
    setTimer = setTimeout,
  } = deps;
  const results = [];
  const waits = [];
  let entries = [];
  try { entries = await ledger.list(); } catch { entries = []; }

  async function settleDead(entry) {
    const { sessionId, tabId, cwd } = entry;
    let last = null;
    try { last = await readTranscriptTail(cwd, tabId); } catch { last = null; }
    const finished = !!last && last.role === 'assistant';
    if (finished) {
      await ledger.end(sessionId);
      safeNotify('chat:run:recovered', { tabId, sessionId, outcome: 'finished' });
      return { sessionId, outcome: 'finished' };
    }
    let recovered = {};
    try { recovered = await ledger.recoveredMap(); } catch { recovered = {}; }
    const prev = Number(recovered[sessionId]);
    if (Number.isFinite(prev) && now() - prev < DAY_MS) {
      await ledger.end(sessionId);
      safeNotify('chat:run:recovered', { tabId, sessionId, outcome: 'guarded' });
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

  function safeNotify(channel, payload) { try { notify(channel, payload); } catch { /* tab may be closed */ } }

  function isOrphan(entry) {
    if (!pidAlive(entry.pid)) return false;
    try { return isChatProcessFor(identityOf(entry.pid), entry.sessionId); } catch { return false; }
  }

  for (const entry of entries) {
    if (!entry || !entry.sessionId) continue;
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

module.exports = { recoverInflightTurns, CONTINUE_PROMPT, DAY_MS };
