---
title: A verdict carrying downgradeTo must never land as completed, and a zero-edit run must never report success
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 50
sourcePromptId: prd-to-epic-communication-this-seems-to-be-broke-dd52dacb
---
# Goal

PRD 972 ran for 34 s, edited zero files, and was recorded `completed` in queue.json — a false green that reached the user. Its own `verdicts.json` had correctly caught it: `verdict: "no_verdict_sentinel"`, `downgradeTo: "needs_review"`, scanned 03:45:36. The queue nonetheless finished it `completed` at 03:46:38 and the definition-of-done drain ran a second later. Two independent defects allowed this: (1) the verdict's `downgradeTo: 'needs_review'` did not stick — something between the scan and the terminal write overrode it; (2) the commit-guard that exists to catch exactly this is gated behind a dirty working tree, so a run that changes NOTHING never reaches it. Close both, so "the agent did nothing" can never present as green.

# Acceptance criteria

- [ ] DIAGNOSE FIRST, in writing, before changing behaviour: determine which code path overrode `downgradeTo: 'needs_review'` for slug 972-notify-epic-prd-path-and-epicid-fallback on 2026-08-03. The run dir is `~/.claude/session-manager/scheduled-plans/runs/2026-08-03T03-44-58-361Z/`. The three candidates to rule in or out are (a) the same-tick auto-fix block at scheduler.cjs:3005-3027 promoting the job, (b) `reverifyNeedsReview` re-verifying and promoting, (c) a rescan via `RESCANNABLE_VERDICTS` (scheduler.cjs:3564, which contains 'no_verdict_sentinel'). Record the answer in the PRD's completion report. Do not skip this step and patch speculatively.
- [ ] Fix the path identified above so a verifyResult carrying a non-null `downgradeTo` can never terminate as `completed` without an explicit, logged, materially-checkable promotion reason (e.g. a re-verify that positively confirmed the AC). A silent promotion is the bug.
- [ ] The commit-guard precondition at scheduler.cjs:2881 (`const after = await uncommittedChanges(guardCwd); if (after && after.length > 0)`) no longer skips the guard for a zero-change run. A run that exits 0, made no commit (`jobSelfCommitted` false), and left NO newly-dirty files is the strongest possible silent-no-op signal and must reach `commitGuardVerdict`, not bypass it. Preserve all four existing false-positive defenses in `commitGuardVerdict` (scheduler.cjs:2028) — in particular `legitimateNoOp`/`COMPLETED_EQUIVALENT_VERDICTS`, so an honest `pass_no_commit_already_shipped` and a fix-plan job (`^\d+-fix-`) are still exempt and do NOT regress into needs_review.
- [ ] New unit test: a job with exitCode 0, a verifyResult of `{verdict:'no_verdict_sentinel', downgradeTo:'needs_review'}`, no commit, and an empty newly-dirty set resolves to effectiveStatus `needs_review` — NOT `completed`. This test must fail against current main.
- [ ] New unit test: an honest no-op — verdict `pass_no_commit_already_shipped`, no commit, clean tree — still resolves to `completed`. This is the regression guard for the exemption above; the fix must not make every no-op a failure.
- [ ] New unit test for the fix-plan exemption: a slug matching `^\d+-fix-` with no commit and a clean tree still resolves to `completed`.
- [ ] `npm run typecheck`, `npm run lint:selectors`, and `npm run test:unit` all pass.

# Implementation notes

Main-process only. Read the appended standards file first.

EVIDENCE — already gathered, do not re-derive, but DO verify each claim against the files before relying on it:
- Run dir: `~/.claude/session-manager/scheduled-plans/runs/2026-08-03T03-44-58-361Z/` contains `972-*.log`, `.meta.json`, `.verdicts.json`.
- `verdicts.json`: `{"verdict":"no_verdict_sentinel","reason":"run made no commit and emitted no SCHEDULER_VERDICT sentinel …","downgradeTo":"needs_review","scannedAt":"2026-08-03T03:45:36.777Z"}`.
- `meta.json`: `exitCode: 0`, `durationMs: 34355`, `contextDigestApplied: true`.
- queue.json / history recorded the job `completed`, finishedAt `2026-08-03T03:46:38.799Z`.
- Only ONE run dir exists for this slug, so this was not a re-run that later succeeded.
- `git log` for that window shows no commit touching `src/main/scheduler.cjs` from this job.

Key files/lines:
- `src/main/scheduler.cjs:2878-2903` — the commit-guard block and its dirty-tree precondition (the bypass).
- `src/main/scheduler.cjs:2028` — `commitGuardVerdict`, pure and already unit-testable; its four defenses are documented in the doc comment above it and must be preserved.
- `src/main/scheduler.cjs:2933-2960` — the effectiveStatus decision chain. Note it branches on `COMPLETED_EQUIVALENT_VERDICTS.has(verifyResult.verdict)` and only consults `downgradeTo` for the `'pending'` case — `downgradeTo: 'needs_review'` is never read here. Verify whether that asymmetry is itself the bug before looking further afield.
- `src/main/lib/terminalRunOutcome.cjs:19` — `COMPLETED_EQUIVALENT_VERDICTS` (4 members; `no_verdict_sentinel` is NOT one of them).
- `src/main/scheduler.cjs:3564` — `RESCANNABLE_VERDICTS`, which DOES contain `no_verdict_sentinel`.
- `src/main/runVerify.cjs:868-874` — where `no_verdict_sentinel` is raised. This logic is CORRECT; do not weaken it.

Design constraint: the goal is that a green PRD means "work landed", not "the process exited 0". Bias every ambiguous case toward needs_review — a false yellow costs a human glance, a false green costs a silently-unfixed bug, which is what happened here.

# Out of scope

- Changing runVerify.cjs's verdict-raising logic
- The context-digest bleed (separate PRD)
- Re-implementing PRD 972's own notify fix (separate PRD)
- Removing or weakening any existing commit-guard false-positive defense

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
