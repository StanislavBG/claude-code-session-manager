# Validation: no-questions automation (PRDs 2336-2341)

Base: eb59efe5bd425fdf216a54a2831cf365d62606f0. Commits: a450649b (2336), de51f8be (2337), 874a2abc (2338), 8df4f4cd (2339), 1bd92e14 (2340), 1e85c1d2 (2341).
All six PRD files found under `prds-archived/`. `/code-review` and `/security-review` not run separately; self-reviewed the diff (no new input handling, paths, or secrets).

## ladder-heals-needs-human-parks — VERIFIED
- `isNeedsHuman` gone: `grep -rn isNeedsHuman src/` hits only the test asserting it is `undefined` (needsHumanVerdict.test.cjs:29-30).
- `selectDueReviewNotices` immediate-due branch deleted (reviewNotice.cjs ~153, diff).
- Root-blocker message reworded (schedulerBatch.cjs:363: "chain resumes when the recovery ladder resolves…").
- Gate: 5 vitest files + `npm run typecheck` green (14 files / 225 tests together with the other gates).

## executor-never-asks-human — VERIFIED
- runVerify.cjs:282-283 maps `NEEDS_HUMAN` to `fail`; the humanQuestion extractor and the needs_human park are gone (only the FAIL reason regex at :331 still accepts a legacy line).
- rcaReport.cjs: `NEEDS_HUMAN` failure class, recovery action, hint and classifier branch deleted (diff).
- `grep NEEDS_HUMAN src/main/scheduler.cjs` → nothing; finish protocol no longer lists it.
- Gate: runVerify, runVerify-sentinel-fail, scheduler-never-stop, needsHumanVerdict + typecheck green.

## scheduler-turns-never-ask — VERIFIED
- `SCHEDULER_TURN_INSTRUCTION` chatRunner.cjs:264-269, exported :1130, chosen by `origin === 'scheduler'` at :572; `enqueueExternalPrompt` reads `extra.origin` :1000-1002.
- Callers pass `{ origin: 'scheduler' }`: scheduler.cjs:3097, :3302; epicValidationHook.cjs:176.
- Gate: chat-stop-signal, stop-signal-anchor, chatRunner-external-send-ack, epicValidationHook + typecheck green.
- Caveat: see Important finding 1 (a non-gated spec broke).

## stuck-failed-auto-skip — VERIFIED
- `applyStuckFailedAutoSkip` scheduler.cjs:8679-8697 sets `needsReviewAutoResolvedSkip`, builds `reviewNotice` via `buildReviewNotice`, `transitionJob(…,'skipped')`; loop at :10130-10146 uses it and keeps `job_stuck_failed` audit with `outcome`. "reset it by hand" text gone.
- `failed → skipped` edge added, scheduleJobTransitions.cjs:119.
- Gate: scheduler-stuck-failed-escalation, scheduler-failed-autoreset + typecheck green.

## develop-docs-no-human-questions — VERIFIED
- `grep -rn NEEDS_HUMAN plugins/session-manager-dev src/main/templates` → empty.
- SKILL.md gate rule 12 and Phase 2 rewritten as specified; PRD_AUTHORING.md line 1 is `v14`, §14 rewritten.

## doc-no-questions-recovery — VERIFIED
- §4 paragraph replaced by one sentence; §8 lists auto-skip of exhausted failed rows and `SCHEDULER_TURN_INSTRUCTION`; the "reset it by hand" entry removed. Claims match the code above.
- Growth is 36574 − 35756 = 818 bytes net of the whole file (≤1,500). Note the diff also carries unrelated ghost-row / held-tick rows from an earlier PRD.

## Full suite: `timeout 600 npm run test:unit`
2 files failed, 7 tests (823 files passed):
- `src/main/__tests__/scheduler-notify-originating-tab.test.cjs` — 6 failures.
- `tests/unit/chatRunner.spec.ts` "cancel then immediate re-run … --resume" — 1 failure.

## Findings

### Critical
- none

### Important
1. `src/main/__tests__/scheduler-notify-originating-tab.test.cjs:54,77,145,160,181,197` — asserts `sendPrompt` called with `(tabId, stringContaining)` and no third arg; PRD 2338 now passes `{origin:'scheduler'}` (scheduler.cjs:3302). The file was outside 2338's `# Files` and gate, so the scoped gate hid it. Fix: add the third argument (`{ origin: 'scheduler' }`) to the six expectations.
2. `tests/unit/chatRunner.spec.ts` cancel/re-run latch failure — not in any of these PRDs' files; matches the known async-executeRun latch regression from epic-turn1 work (fix PRDs 2345/2346 per memory). Not attributed to 2336-2341; not verified against base.

### Minor
- Dead vestiges of the needs_human verdict remain: scheduler.cjs:6774 (`verdict === 'needs_human'` humanQuestion branch, never produced now), reviewNotice.cjs:94, :199, :252, and a stale comment at prdWorktreeReach.cjs:8. Harmless; legacy rows still render.
- `scheduler-operations.md` diff includes unrelated earlier content; the criterion's size bound is met either way.
