'use strict';

/**
 * adoptedRunSupervisor.cjs — re-arms the budget watchdog, idle-tail kill and
 * deadman for an executor the boot SPARED (scheduler.cjs stamps
 * `adoptedAtBoot`), from the durable `<slug>.supervisor.json` record.
 *
 * executeJob attaches those three timers to the child it spawned; an adopted
 * executor belongs to a dead app process, so nothing supervised it (and a
 * quietMachine row held no lease). Here the same three conditions are polled
 * against the record's own numbers (budgetMs / startedAt, idleKillMs vs the
 * log mtime, maxDurationMs) by the app process that owns the row. The
 * signal goes to the recorded process group only after the pid is proven to
 * still be the recorded process (procIdentity, fail-closed). It never mints
 * a slot token: the adopted row stays `untrackedRunning` in pickNextBatch.
 *
 * Plain Node, no electron — every effect is injected so it is unit-testable
 * with fake timers and without scheduler.cjs.
 */

/**
 * evaluateAdoptedRun(record, { now, logMtimeMs, defaultMaxDurationMs })
 *   → { kind: 'deadman'|'budget'|'idle-tail', reason } | null
 * Pure. Precedence deadman > budget > idle-tail (hardest kill first).
 */
function evaluateAdoptedRun(record, { now, logMtimeMs, defaultMaxDurationMs = 0 }) {
  const started = Number.isFinite(record.startedAt) ? record.startedAt : null;
  const elapsed = started === null ? null : now - started;
  const deadmanMs = record.maxDurationMs > 0 ? record.maxDurationMs : defaultMaxDurationMs;
  if (elapsed !== null && deadmanMs > 0 && elapsed >= deadmanMs) {
    return { kind: 'deadman', reason: `deadman: ran ${Math.round(elapsed / 60_000)}m (>= ${Math.round(deadmanMs / 60_000)}m)` };
  }
  if (elapsed !== null && record.budgetMs > 0 && elapsed >= record.budgetMs) {
    return {
      kind: 'budget',
      reason: `wall-clock budget exceeded: ran ${Math.round(elapsed / 60_000)}m against a ${Math.round(record.budgetMs / 60_000)}m budget (adopted after app restart)`,
    };
  }
  if (record.idleKillMs > 0 && Number.isFinite(logMtimeMs) && now - logMtimeMs > record.idleKillMs) {
    return { kind: 'idle-tail', reason: `idle-output: log mtime stalled ${Math.round((now - logMtimeMs) / 1000)}s (> ${Math.round(record.idleKillMs / 1000)}s)` };
  }
  return null;
}

/**
 * superviseAdoptedRun(record, deps) → { cancel(), check() }
 * One poll timer per adopted run; `check()` runs once immediately so a run
 * already past its budget at boot is killed without waiting a full interval.
 * deps: { logPath, now, statLogMtimeMs, pidAlive, identityOf, isDifferentProcess,
 *   killGroup(pid, signal), stampKill(kind, reason) → Promise, log(msg),
 *   checkIntervalMs, sigkillAfterMs, defaultMaxDurationMs }
 */
function superviseAdoptedRun(record, deps) {
  const {
    logPath, now = Date.now, statLogMtimeMs, pidAlive, identityOf, isDifferentProcess, killGroup,
    stampKill, log = () => {}, checkIntervalMs, sigkillAfterMs, defaultMaxDurationMs = 0,
  } = deps;
  let done = false;
  let timer = null;
  let killTimer = null;

  const isOurs = () => pidAlive(record.pid) && !isDifferentProcess(record.identity, identityOf(record.pid));
  const cancel = () => {
    done = true;
    if (timer) clearInterval(timer);
  };

  async function check() {
    if (done) return null;
    if (!isOurs()) { cancel(); return 'gone'; } // exited (reaper finalizes) or pid recycled — never signal
    const verdict = evaluateAdoptedRun(record, {
      now: now(), logMtimeMs: statLogMtimeMs(logPath), defaultMaxDurationMs,
    });
    if (!verdict) return null;
    cancel();
    try { await stampKill(verdict.kind, verdict.reason); } catch (e) { log(`stampKill failed: ${e?.message ?? e}`); }
    if (!isOurs()) return 'gone'; // exited while the stamp was in flight
    const first = verdict.kind === 'deadman' ? 'SIGKILL' : 'SIGTERM';
    log(`adopted-run ${verdict.kind} watchdog: ${verdict.reason} — ${first} process group`);
    killGroup(record.pgid || record.pid, first, record.pid);
    if (first === 'SIGTERM') {
      killTimer = setTimeout(() => {
        if (isOurs()) killGroup(record.pgid || record.pid, 'SIGKILL', record.pid);
      }, sigkillAfterMs);
      if (killTimer.unref) killTimer.unref();
    }
    return verdict.kind;
  }

  timer = setInterval(() => { check().catch((e) => log(`check failed: ${e?.message ?? e}`)); }, checkIntervalMs);
  if (timer.unref) timer.unref();
  return {
    cancel() { cancel(); if (killTimer) clearTimeout(killTimer); },
    check,
  };
}

/**
 * superviseAdoptedRuns(jobs, ctx) → Promise<string[]> (slugs newly armed)
 * Arms a supervisor for every `running` row stamped adoptedAtBoot that has
 * none in `ctx.registry` (Map key `slug|runId`), drops registry entries whose
 * row is no longer that run, re-acquires the quietMachine lease and stamps
 * supervisedAt. ctx: { registry, runDir(row), readRecord(runDir, slug),
 *   lease: { acquire, holder }, markSupervised(row), makeDeps(row, record) }
 * Complexity: O(jobs).
 */
async function superviseAdoptedRuns(jobs, ctx) {
  const { registry, runDir, readRecord, lease, markSupervised, makeDeps } = ctx;
  const live = new Set();
  const armed = [];
  for (const j of jobs) {
    if (j.status !== 'running' || !j.adoptedAtBoot) continue;
    const key = `${j.slug}|${j.runId ?? ''}`;
    live.add(key);
    if (registry.has(key)) continue;
    const dir = runDir(j);
    const record = dir ? readRecord(dir, j.slug) : null;
    if (!record || !record.pid) continue; // no durable record → nothing to re-arm from
    if (j.quietMachine === true && !lease.acquire(j.slug) && lease.holder() !== j.slug) {
      console.warn(`[scheduler] adopted quietMachine run ${j.slug}: lease held by ${lease.holder()} — not re-acquired`);
    }
    const handle = superviseAdoptedRun(record, makeDeps(j, record));
    registry.set(key, handle);
    armed.push(j.slug);
    await markSupervised(j);
    handle.check().catch(() => {});
  }
  for (const [key, handle] of registry) {
    if (live.has(key)) continue;
    handle.cancel();
    registry.delete(key);
  }
  return armed;
}

module.exports = { evaluateAdoptedRun, superviseAdoptedRun, superviseAdoptedRuns };
