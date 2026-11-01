# Validation: load-gate-tests-settle-between-cases, spawn-site-tests-wait-for-cmdline

Base: 5093b433. Commits: 75579fd7 (PRD 2519), fde6ccaa (PRD 2520). PRD files found under prds-archived/.

## load-gate-tests-settle-between-cases (2519) — VERIFIED
- AC1: tests/helpers/schedulerSettle.cjs:38-50 — settleScheduler polls every 20 ms (POLL_MS), checks sessionSlots.inUse()===0 and no `running` row in any project queue.json (missing/mid-write tolerated, :28-30), throws naming slots + running rows at maxWaitMs (default 20000).
- AC2: schedulerSettle.cjs:51-56 — rmSync epics, mkdir epics/fixture-epic/prds, `_mutateForTests(s => { s.jobs = []; })`, `await scheduler.tickQueue()`.
- AC3: scheduler-load-gate-tick.test.cjs:97 and scheduler-load-gate-last-resort.test.cjs:99 — `afterEach(() => settleScheduler({ scheduler, projectsDir: path.join(tmpHome, 'Projects') }))`.
- AC4: PRD_BODY (frontmatter with createdVia: scheduler-api) is used at all 5 fixture writes (tick :40,:140,:183; last-resort :42,:119); no literal 'Load gate PRD.' write remains. Zero 'quarantining unstamped PRD' lines in every probe log.
- AC5: tests/README.md Stability section (added paragraph after the stability-runner text) states the settle rule and why.
- Gate: both load-gate files 10/10 pass; `npm run lint:docs` exit 0.

### Slow-git probe (fake `git` first on PATH: sleep $SLOW_GIT_S then exec /usr/bin/git; SM_CHAT_SESSION_ID, SM_PROJECT_ROOT unset)
| SLOW_GIT_S | tick (6 tests) | last-resort (4 tests) | quarantine lines |
|---|---|---|---|
| 0.05 | pass | pass | 0 |
| 0.1 | pass | pass | 0 |
| 0.2 | pass | pass | 0 |
| 0.3 | pass | pass | 0 |
| 0.5 | pass | pass | 0 |
| 6 plain runs each | 6/6 pass | 6/6 pass | 0 |

All 22 runs exit 0.

## spawn-site-tests-wait-for-cmdline (2520) — VERIFIED
- AC1: procname-claude-spawn-sites.test.cjs:159-160 adds `execDone(pid, name)` (comm===name && cmdline length>0); used at :166 and :187 (the two named tests) before `const cmd = cmdline(child.pid)`.
- AC2: execDone wraps both reads in try/catch returning false (:160), matching the existing slug wait pattern.
- AC3: diff is +5/-2, no sleep added; waitFor untouched; file passes 13/13.
- Gate: `vitest run procname-claude-spawn-sites.test.cjs` exit 0.
- Note: cause of the original red was never proven (per PRD); this change is a defensive fix, so a rare recurrence cannot be excluded by this validation.

## Full suite
`env -u SM_CHAT_SESSION_ID -u SM_PROJECT_ROOT timeout 300 npx vitest run`, unfiltered output saved at /tmp/full-suite.413760.log: exit 0, 863 files passed, 8169 tests passed, 1 skipped, 181 s. Nothing red.

## Review
Combined diff is test-only (4 test/helper files + README). Self-review: no secrets, no path traversal (helper only touches paths under the test's tmp projectsDir; rmSync scoped to `<project>/session-manager-operations/scheduler/epics`). Helper requires the same sessionSlots module path as the scheduler. Remaining sub-second-wide race (job launched between slot check and rmSync) is covered by the final tickQueue await.

## Findings
- Critical: none.
- Important: none.
- Minor: settleScheduler deletes every project's epics folder under projectsDir unconditionally; only safe because callers pass a tmp HOME (scheduler-load-gate-tick.test.cjs:97). Not a defect today.
