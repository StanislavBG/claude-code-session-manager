---
title: Enable 7-day run-log retention: wire a caller and turn it on (human-approved policy)
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 40
sourcePromptId: performance-identiy-why-session-manager-is-feeli-24e0a0ae
sourceTabId: performance-identiy-why-session-manager-is-feeli-24e0a0ae
---
# Goal

PRD 1015 built the run-log retention module (src/main/lib/runLogRetention.cjs) with dry-run-by-default safety, live-job protection, and full test coverage — but deliberately stopped short of wiring it to run, because the human had not chosen a policy. They have now chosen: 7 days. Two things are missing. (1) applyRetention has ZERO production callers — grep confirms the only hits are its own definition and doc comments; health.cjs uses only the read-only computeReport. So the deletion path is currently inert and setting the config alone would do nothing. (2) scheduler-machine.json carries no schedulerRunLogRetention key. Wire a caller and enable the policy: maxAgeDays 7, keepPerSlug 1. Measured effect on the real machine: frees ~178 MB across 109 directories of a 1.19 GB store.

# Acceptance criteria

- [ ] applyRetention gains exactly ONE production caller, invoked on a predictable, low-risk trigger. Prefer a once-per-app-boot call (deferred well past first paint, mirroring index.cjs's existing 30s-deferred finalizeClosedDays pattern) over a new timer. State the chosen trigger and why in the result.
- [ ] The caller passes the real scheduler queue's jobs (or liveKeys) explicitly — it must NOT rely on applyRetention's internal queueStore fallback, which exists only as a defensive net. Verify by test.
- [ ] The retention config is written to ~/.claude/session-manager/scheduler-machine.json under config.schedulerRunLogRetention as { enabled: true, policy: { maxAgeDays: 7, keepPerSlug: 1 } }. The exact JSON written is pasted in the result.
- [ ] BEFORE enabling, run the dry-run one final time against the real runs dir and paste its eligibleSummary + removableDirs count in the result, so the delete set is on record before anything is removed.
- [ ] AFTER the first real run, report actual bytes freed and directory count removed, and re-measure the runs dir with du so the before/after is a measured number, not the predicted one.
- [ ] Every safety property from PRD 1015 still holds and is re-asserted by the existing tests: live jobs (pending/running/needs_review/investigating) never removed; each slug's most recent run never removed; dirs holding unclaimed files never fully removed. Run src/main/__tests__/runLogRetention.test.cjs and report the pass count.
- [ ] A kill-switch exists: setting config.schedulerRunLogRetention.enabled back to false fully disables deletion with no code change. Test asserts it.
- [ ] Deletion failures are non-fatal — a permission error or a file vanishing mid-sweep must be logged and skipped, never thrown into the boot path or the scheduler tick. Test this.
- [ ] timeout 300 npm run typecheck passes.
- [ ] timeout 600 npm run test:unit passes.
- [ ] timeout 120 npm run lint passes.
- [ ] timeout 300 npm run health exits 0, or the result explains precisely why not.

# Implementation notes

Target project: /home/bilko/Projects/session-manager

The human explicitly approved this policy — 7 days — in conversation. This PRD is authorized to actually delete run logs, unlike PRD 1015 which was deliberately dry-run only. That authorization is narrow: 7 days + keepPerSlug 1, nothing more aggressive.

Key files: src/main/lib/runLogRetention.cjs (applyRetention at :305, isRetentionEnabled at :271, liveKeysFromJobs at :66, LIVE_STATUSES at :56), src/main/health.cjs:377-381 (existing read-only computeReport call + where the config is documented to live), src/main/index.cjs (the deferred-30s setTimeout around :1134-1147 that already runs finalizeClosedDays — the natural place for a boot-time sweep), src/main/lib/queueStore.cjs (readMergedSync for live jobs).

Do NOT loosen any PRD 1015 safety property to free more bytes. In particular the "each slug's most recent run is never eligible" rule is load-bearing and stays — it is why 7d frees 178 MB rather than ~1 GB (1,635 distinct slugs across 2,173 runs; most PRDs ran once, so their sole run is their latest). Reclaiming that remaining ~840 MB is a SEPARATE decision the human has not made.

Do not launch a second Electron instance to test this — the scheduler is live; a second instance SIGTERMs running jobs and clobbers admin-api.json. Use plain node against the real module, and tmpdir fixtures for tests.

Measured baseline for the before/after (taken 2026-08-07): runs dir 1.19 GB / 2,359 dirs; 7d+keep1 dry-run predicts 178 MB across 109 dirs.

Main-process tests live in src/main/__tests__/ and run under vitest (npm run test:unit).

# Out of scope

- Any policy more aggressive than 7 days / keepPerSlug 1
- Removing or weakening the keep-latest-per-slug protection to reclaim the remaining ~840 MB (separate human decision)
- Adding a systemd timer or cron job
- Handling the definition-of-done-only run dirs that carry no <slug>.log (they are never scanned and never eligible today; a separate concern)
- Pruning ~/.claude/projects transcripts

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
