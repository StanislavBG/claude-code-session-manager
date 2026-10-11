# Validation record: readability plan (PRDs 1821-1847), pass 1

Base: `3447c51e` (44 commits to HEAD `71ef643f`, 642 files). PRD files read from `prds-archived/` (retry PRDs `1822-fix-…`, `1828-fix-…`, `1844-fix-…` exist beside the originals).
Commands were run in the job worktree with `node_modules` symlinked to the main checkout (gitignored) and a scratch `TMPDIR`.

## Whole-plan gate results

| Command | Result |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npm run lint` (selectors, hooks, docs, paths, any, filenames, test-smells, page-stewards, e2e-budget) | exit 0 |
| `npm run test:unit` | 707 files / 6806 tests passed, 1 skipped |
| `vitest run scripts/__tests__/{check-doc-hierarchy,check-e2e-budget,move-modules}.test.cjs` | 15 passed |
| `npx playwright test --list` (list only) | 57 tests in 21 files, exit 0 |

## Per-PRD verdicts

- **1821 sched-extract-review-ladder: VERIFIED.** `src/main/scheduler/reviewLadder.cjs:1-5` has the header and `'use strict'`. Its exports (`:966`) include `isExhaustedAutoFix`, `isFixPlanDead`, `selectAutoFixTargets` and `selectGateShadowTarget`. None of them is defined or exported in `scheduler.cjs` (grep 0). `health.cjs:24` requires it directly. `scheduler.cjs` is 10981 lines against 14003 at base, a drop of 3022 across the five extractions.
- **1822 sched-extract-git-tree-guard: VERIFIED.** `gitTreeGuard.cjs:1-5` has the header. Internal calls go through `module.exports.*` (2 hits). `scheduler.cjs:5832` calls `gitTreeGuard.stashList(...)`. The moved names are gone from `scheduler.cjs`. The only `stashList` hit that is not a call is a comment at `:2336`. `runVerify.cjs` has no `scheduler.cjs` import left. Gate green.
- **1823 sched-extract-prd-paths: VERIFIED.** `prdPaths.cjs` exists with the header, and the spy seam goes through `module.exports`. `scheduler.cjs` requires it. Gate green.
- **1824 sched-extract-starvation: VERIFIED.** `starvation.cjs` exists. `health.cjs:23` requires `classifyQueueStarvation`, `launchBlockedSlugs` and `STARVE_ESCALATION_MS` from it. `scheduler.cjs` neither defines nor exports them (grep 0).
- **1825 sched-extract-budget-watchdog: VERIFIED.** `budget.cjs` exists. `health.cjs:22` requires `computeStallSummary` and `computeDepHistorySatisfaction` from it. `scheduler.cjs` is 10981 lines, below the 11,000 AC.
- **1826 main-ipc-agents-handlers: VERIFIED.** `agentsIpc.cjs:18,76` defines and exports `registerAgentsHandlers`. It holds 8 `ipcMain.handle('agents:` calls and `index.cjs` has 0. `index.cjs:125,1043` requires and calls it. Lint is green.
- **1827 main-ipc-telemetry-handlers: VERIFIED.** `telemetryIpc.cjs:19,51` defines and exports `registerTelemetryHandlers`. It holds 10 `telemetry:`/`otel:` handlers and `index.cjs` has 0. `index.cjs:126,1069` wires it.
- **1828 main-dedupe-pid-alive: VERIFIED.** `lib/process/instanceLock.cjs:33`, `lib/scheduler/watchdogHelpers.cjs:10` and `lib/scheduler/reservationExpiry.cjs:12` each require `pidAlive.cjs`. A grep for `isPidAlive` and `defaultPidAlive` across src, scripts and tests returns 0. Unit tests are green.
- **1829 main-dedupe-json-io: VERIFIED** (see Minor 1). `upgradeDrain.cjs:27,37,60` uses `atomicFs.readJsonOrSync` and `writeJsonAtomicSync`. `delegationReadiness.cjs:28` imports `readJsonOrSync`. `definitionOfDone.cjs:18,748,879` uses `atomicFs.writeTextAtomicSync`. No private tmp+rename remains.
- **1830 renderer-basename-primitive: VERIFIED.** `src/renderer/lib/basename.ts` splits on `[\\/]`, filters empties and falls back to the input. The test has 7 cases: posix, windows, mixed, trailing slash, empty, bare filename and all-separators. The base copy split on `/` only, which is a deliberate superset.
- **1831 renderer-basename-wire-editor: VERIFIED.** `state/editor.ts:15`, `EditorView.tsx:55`, `DocumentMenu.tsx:18` and `DocumentEditorPane.tsx:36` import `basename`, and none defines a local one.
- **1832 renderer-basename-wire-panels: VERIFIED.** `ReferencedFilesPanel.tsx:4`, `RemoteSessionsPanel.tsx:4` and `epicOrigin.ts:16` import `basename`.
- **1833 renderer-dedupe-format-bytes-time: VERIFIED.** `attachments.tsx:4` and `BinaryPane.tsx:7` import `formatBytes`. `BillingStatusBanner.tsx:1` imports `formatAgo`. `lib/formatBytes.ts` and `lib/formatTime.ts` have an empty diff.
- **1834 renderer-dedupe-elapsed-relative: VERIFIED.** `Home.tsx:57` imports `formatAgo`. `schedulerStages.ts:23` imports `formatDuration`. A grep for `relativeTime` and `formatElapsed` across src and tests returns 0.
- **1835 remove-dead-renderer-job-status: VERIFIED.** `src/renderer/lib/jobStatus.ts` is gone and `grep lib/jobStatus` is clean. `scheduleJobStatusDrift.test.cjs` is kept with 3 assertions and no `jobStatus` reference, which the AC allows.
- **1836 remove-orphan-scripts: VERIFIED.** `render-icon.cjs` and `health.sh` are gone, and the absence grep over package.json, .github, scripts, src, bin and plugins is clean. Lint is green.
- **1837 e2e-prune-and-budget: VERIFIED** (see Minor 2). `memory-clusters.spec.ts` and `projects-workspace.spec.ts` are deleted (56 lines removed). `scripts/check-e2e-budget.cjs` has `E2E_SPEC_CEILING = 19` and the repo has 19 specs. It prints a one-line diagnostic and exits 1 when over, and `lint:e2e-budget` is wired into `lint`. The test has under, at and over cases. `tests/README.md:112-116` has the E2E budget section. `playwright --list` exits 0.
- **1838 docs-track-lifecycle-readmes: VERIFIED.** `.gitignore:49-52` ignores `scheduler/*` and `prompt-sessions/*` except each README. `git check-ignore` on `scheduler/queue.json` exits 0, `git ls-files --error-unmatch` finds both READMEs, and both are byte-identical to the main-checkout copies. `lint:docs` is ok.
- **1839 agent-search-ignore-history: VERIFIED.** The root `.ignore` has a 2-line header and lists reviews, design-mocks and HUMAN_LEARN. `rg -l 'reviewLadder|MINT_AUTHORITIES'` returns nothing under those folders, and 89 files in reviews are still tracked.
- **1840 docs-trim-domain-model: VERIFIED.** `domain-model.md` is 16164 bytes (limit 20000). The history-word grep returns 0. The Single-writer section opens with 3 sentences (`:173-177`) and links `../CLAUDE.md` for the enumeration. `lint:docs` is ok.
- **1841 docs-trim-code-map-conventions: VERIFIED.** `code-map.md` is 10636 bytes (limit 13000) with 0 lines over 600 characters. Every backticked `.cjs/.ts/.tsx` path resolves. `conventions.md:55` names `src/main/lib/util/atomicFs.cjs`, with `config.cjs` as a caller only.
- **1842 docs-fix-stale-junctions: VERIFIED.** Root `CLAUDE.md` is 11887 bytes with 0 mentions of `docs/README`. `src/CLAUDE.md:15` no longer carries a persona count or "may not exist yet". The ops `CLAUDE.md` table links the HUMAN_LEARN, design-mocks and reviews READMEs. `PENDING` and the TODO are gone from `check-doc-hierarchy.cjs`. Tests pass.
- **1843 lib-move-codemod: VERIFIED.** `scripts/move-modules.cjs` exists. Re-running it on `lib-layout.json` reports "0 move(s), 0 edit(s)", so it is idempotent. The scratch-repo test passes and lint is green.
- **1844 lib-partition-subfolders: VERIFIED.** `scripts/lib-layout.json` maps 131 modules into the 10 required subfolders. The `src/main/lib` root has 39 `.cjs` files (limit 40). A scan of every tracked text file for the old flat paths (`src/main/lib/<m>.cjs`, `./lib/<m>.cjs`) finds 0. Typecheck, unit tests and lint are all green.
- **1845 docs-lib-junction: VERIFIED.** `src/main/lib/CLAUDE.md` is 2638 bytes (limit 4000). Every subfolder that exists is documented. It has a "Where a new module goes" section and a reuse table, and all 10 table paths resolve. `src/CLAUDE.md:10` links it.
- **1846 docs-scheduler-junction: VERIFIED.** `src/main/scheduler/CLAUDE.md` is 1684 bytes. Every `scheduler/*.cjs` is named in it. Line 10 states the spy-seam rule, line 11 the new-pure-logic rule, line 6 links `scheduler-operations.md`, and line 23 holds the `scheduler.cjs` remainder row. `src/CLAUDE.md:10` links it.
- **1847 docs-dag-orphan-lint: VERIFIED.** `check-doc-hierarchy.cjs:28-42` defines `EXEMPT_PREFIXES` with reason comments, covering every required prefix plus GitHub meta files. Check (6) is the BFS reachability check. `CONTROL_MAP.md` is linked from `src/renderer/CLAUDE.md`, and `tests/README.md:110` links `quality/*.md`. The test case at `:85` covers reachable, orphan and exempt. `lint:docs` reports ok (21 junctions, 34 files).

## Findings

### Critical
None.

### Important
None.

### Minor
1. `src/main/lib/scheduler/definitionOfDone.cjs:861-868`: `readWatermark` still does its own `readFileSync` + `JSON.parse` + catch-to-null instead of `atomicFs.readJsonOrSync`. It is domain-specific field extraction and behaves identically, so I did not treat it as breaching 1829's "no private JSON-read-with-fallback". A follow-up could fold it into `atomicFs`.
2. 1837 deleted two of the three named specs. `tests/e2e/scheduler-supervisor-panel.spec.ts` was kept: it navigates to the Supervisor link and asserts the React #300/#310 hook errors are absent, which goes beyond a plain mount check. The AC allows keeping a spec that asserts real behavior, and the ceiling (19) matches the post-deletion count. A reviewer who reads it as mount-only could merge it.
3. `domain-model.md:179-182`: the Single-writer section has a second paragraph beyond the 3-sentence law. It is rationale, not enumeration.
4. `check-doc-hierarchy.cjs` `EXEMPT_PREFIXES` also exempts GitHub meta files (`README.md`, `.github/` and others) beyond the required list. This is reasonable but unrequested.
5. Environment: the worktree had no `node_modules`, so I symlinked the main checkout's (gitignored, not committed). The untracked `<path>` file in the worktree is the known sqlite-MCP placeholder, not plan output.

### Review method
`/code-review` and `/security-review` were not run on the 642-file diff. I self-reviewed the new executable surface: `move-modules.cjs`, `check-e2e-budget.cjs` and the BFS in `check-doc-hierarchy.cjs`. They take a root path from argv or env, read only from it, and run only git. I found no unsafe input handling, secrets or path traversal.
