---
title: Perf P10: add retention for scheduler run logs (1.2 GB, 2351 run dirs, currently unbounded)
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 45
sourcePromptId: performance-identiy-why-session-manager-is-feeli-24e0a0ae
sourceTabId: performance-identiy-why-session-manager-is-feeli-24e0a0ae
---
# Goal

~/.claude/session-manager/scheduled-plans/runs holds 2351 run directories totalling 1.2 GB with no retention policy — it only ever grows. Beyond disk, it makes any glob or scan over that tree progressively slower, and it is the single largest thing under ~/.claude/session-manager (1.2 GB of a 1.2 GB total). Add a retention mechanism. CRITICAL: this PRD implements the mechanism and reports what WOULD be removed; it must NOT delete anything by default. The human has not chosen a policy yet, so deletion stays behind an explicit opt-in setting.

# Acceptance criteria

- [ ] A retention module exists that, given a policy, computes the set of run directories eligible for removal. Support at least: age-based (older than N days) and count-based (keep the most recent N runs per PRD slug). The two must be combinable.
- [ ] DEFAULT BEHAVIOUR IS DRY-RUN: with no explicit opt-in setting, the module computes and logs/reports what it would delete and deletes NOTHING. A test asserts that with default settings, zero files are removed.
- [ ] Actual deletion requires an explicit, named setting (e.g. schedulerRunLogRetention.enabled = true plus a policy) documented in the result. A test asserts deletion happens ONLY when that setting is present and true.
- [ ] A run directory belonging to a job that is currently queued, running, or in needs_review is NEVER eligible for removal, regardless of age. Test this explicitly — deleting a live job's log destroys the evidence the RCA report and the Scheduler tab depend on.
- [ ] The most recent run for any PRD slug is never removed even if it exceeds the age cap, so every PRD retains at least its latest evidence. Test this.
- [ ] A report surface states current usage (total bytes, directory count, oldest run date) and what the configured policy would remove — so the human can pick a policy from real numbers.
- [ ] The dry-run report is produced against the REAL ~/.claude/session-manager/scheduled-plans/runs (read-only) and its output is included in the result, so the human can choose a policy from actual data.
- [ ] Any test that creates run directories does so under a tmpdir, never the real runs/ directory, and cleans up in afterEach.
- [ ] timeout 300 npm run typecheck passes.
- [ ] timeout 600 npm run test:unit passes.
- [ ] timeout 120 npm run lint passes.
- [ ] timeout 300 npm run health exits 0, OR the result explains precisely why not (health mixes build checks with live queue state, so a busy queue can make it red for reasons unrelated to this PRD).

# Implementation notes

Target project: /home/bilko/Projects/session-manager

THE SAFETY CONSTRAINT IS THE POINT OF THIS PRD. The human has been asked twice which retention policy they want and has not answered. Do not pick one and start deleting. Build the mechanism, default it to dry-run, and surface real numbers so they can decide. A wrong guess here destroys run evidence that cannot be recovered.

Run logs live under ~/.claude/session-manager/scheduled-plans/runs/<timestamp>/ (machine-level Session-Manager runtime, NOT under a project's session-manager-operations/, so the single-writer law in src/main/lib/opsOwnership.cjs does not apply here — but confirm that before writing, do not assume).

Live-job protection: read the queue via src/main/lib/queueStore.cjs rather than inferring status from the filesystem. Jobs in needs_review are questions awaiting a human answer and their root-cause report (src/main/lib/rcaReport.cjs writes root-cause-<slug>.md into the run dir) is the whole record.

Related existing surfaces to reuse rather than duplicate: src/main/health.cjs already reports on runtime state; src/main/lib/definitionOfDone.cjs already writes into run dirs. Check whether either already has a notion of run-dir lifecycle before adding a third.

Do not launch a second Electron instance to test this — the scheduler is live and a second instance SIGTERMs running jobs and clobbers admin-api.json. Use plain node + tmpdir fixtures.

Main-process tests live in src/main/__tests__/ and run under vitest.

# Out of scope

- Actually deleting any run log as part of this PRD's execution
- Choosing the retention policy on the human's behalf
- Pruning ~/.claude/projects transcripts (different store, different risk profile)
- Adding a cron/systemd timer to run retention automatically

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
