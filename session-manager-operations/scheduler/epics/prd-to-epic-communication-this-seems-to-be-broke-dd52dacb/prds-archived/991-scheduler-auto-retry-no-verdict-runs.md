---
title: Auto-recover a job that exits 0 having done nothing, instead of parking it in needs_review forever
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 26
sourcePromptId: prd-to-epic-communication-this-seems-to-be-broke-dd52dacb
---
# Goal

A headless PRD run that delegates its work to a subagent (or invokes /develop, or backgrounds a review and ends its turn) exits 0 having produced no commit and no verdict sentinel. scheduler.cjs parks that job in needs_review and stops. Nothing retries it — boot reconciliation only reaps orphaned PIDs, and the dead-process reaper only classifies runs that actually died. Recovery today is entirely manual: a human notices and hand-authors a "Fix: ..." PRD. That has now happened at least twice in this project (979 and 980; 980-chat-typed-event-renderers is parked needs_review right now while a hand-written 980-fix- sibling does its work). Make the scheduler detect this specific no-op outcome and auto-requeue the same PRD once, with the anti-self-delegation guard injected, so the common case self-heals.

# Acceptance criteria

- [ ] Read src/main/scheduler.cjs first, specifically: the run-outcome classifier and the dead-process reaper, notifyNeedsReview, the boot reconciliation path (partitionBootOrphans / applyOrphanOutcome / BOOT_ORPHAN_KILL_GRACE_MS), and src/main/lib/rcaReport.cjs. Confirm exactly where a run is currently classified as needs_review and what signals are available at that point.
- [ ] CORE: define and implement a precise detector for the no-op outcome. It must require ALL of: process exited 0, AND no verdict sentinel was printed, AND the run produced no new commit in the PRD's cwd (compare git HEAD before/after the run). Do NOT key the detector on exit code alone, and do NOT key it on the absence of the sentinel alone — a legitimately-completed run that merely forgot to print the sentinel must not be silently re-run and duplicate its own work.
- [ ] CORE: on detecting that outcome, requeue the SAME PRD slug exactly once (a bounded retry counter persisted on the job, not an unbounded loop), rather than parking it. The second failure parks in needs_review as today — never retry more than once automatically.
- [ ] CORE: the retry injects the anti-self-delegation guard into the prompt the executor receives (the 'You ARE the executor — never re-queue or self-schedule' rule from plugins/session-manager-dev/skills/develop/standards.md, Execution discipline). Reference that file's rule rather than forking a second copy of the text.
- [ ] CORE: the auto-retry is recorded on the AUTHORING Epic's event chain via the same notifyNeedsReview/notifyOriginatingTab channel, so the human sees 'auto-retried once' rather than silence. Resolve the Epic from the PRD's sourcePromptId with the existing epicId fallback.
- [ ] EDGE: a run that exits 0, prints no sentinel, but DID produce a commit is NOT retried (the work landed; this is the false-positive case that would double-apply a diff). Test it.
- [ ] EDGE: a run that exits non-zero, and a run that was rate-limited (exit 1 / rateLimited — the scheduler's designed auto-pause), keep their existing behavior untouched. rateLimited must NOT consume the retry budget. Test both.
- [ ] EDGE: a job already at its retry limit parks in needs_review with the RCA report as today, and the report states that an automatic retry was already attempted and also produced nothing.
- [ ] EDGE: state.paused (rate-limit pause) and cancelToken.cancelled suppress auto-retry, consistent with how the DoD drain gate already guards itself.
- [ ] INTERACTION EFFECT: the retry must not bypass the session slot pool (lib/sessionSlots.cjs, machine-wide cap of 3 concurrent claude -p sessions) — it acquires a slot like any other job. Confirm a burst of auto-retries cannot exceed the cap.
- [ ] INTERACTION EFFECT: confirm the retry does not re-fire the definition-of-done drain gate (lib/dodDrainHook.cjs) spuriously — its batchKey/reportExists idempotence must still hold.
- [ ] TESTS: unit coverage for the detector's full truth table (exit code x sentinel present/absent x commit present/absent), the once-only retry bound, the rateLimited carve-out, and the Epic notification.
- [ ] `npm run typecheck`, `npm run test:unit`, and `npm run health` all pass.

# Implementation notes

Concrete live evidence to build the fixture from, observed 2026-08-02: queue.json holds `980-chat-typed-event-renderers` status needs_review (its run exited 0 after delegating implementation to a dev-lead subagent, producing no commit and no sentinel) alongside `980-fix-chat-typed-event-renderers` status running — a hand-authored retry that exists only because no automatic recovery fired. The same pattern previously produced `979-fix-transcript-paged-reads.md`.

The failure class is already documented verbatim in plugins/session-manager-dev/skills/develop/standards.md under "Execution discipline (headless runs)" — it names prior incidents PRD 460 (invoked /develop, spawned a duplicate PRD, exited 0 with no work) and PRD 479 (landed a commit, then backgrounded /code-review + ScheduleWakeup and ended the turn). Read that section before implementing; the detector is essentially the machine-checkable form of that rule.

Key files: src/main/scheduler.cjs (run classification, notifyNeedsReview, boot reconciliation), src/main/lib/rcaReport.cjs (writes runs/<runId>/root-cause-<slug>.md next to the run log), src/main/lib/queueStore.cjs (per-project queue + history shards under <cwd>/session-manager-operations/scheduler/state/ — raw fs, subject to the single-writer law in src/main/lib/opsOwnership.cjs with writer 'scheduler'), src/main/lib/sessionSlots.cjs, src/main/lib/dodDrainHook.cjs.

The retry counter belongs on the JOB (its lifecycle matches a run attempt), not on the PRD and not on the Epic — CLAUDE.md's rule is that a tracking field goes on the entity whose lifecycle it shares.

Getting the before/after commit comparison right matters: capture git HEAD in the PRD's cwd at job start and compare at exit. Do not shell out with shell:true (CLAUDE.md 'Avoid') — pass argv arrays.

# Out of scope

- Retrying more than once automatically — second failure still parks for a human
- Changing what the RCA report contains beyond noting that a retry was attempted
- Any change to rate-limit auto-pause / auto-resume behavior
- Detecting other failure classes (hangs, post-AC overruns) — the supervisor and watchdog already own those
- Editing the standards.md rule text itself

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
