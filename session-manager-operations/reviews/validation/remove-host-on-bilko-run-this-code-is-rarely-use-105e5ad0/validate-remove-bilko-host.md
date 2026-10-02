# Validation: Remove "Host on Bilko.run" plan

Plan: `remove-host-on-bilko-run-this-code-is-rarely-use-105e5ad0`. Validated at repo HEAD `e9aeb80e` (2026-10-02), after a concurrent sibling job landed `e9aeb80e` mid-review — HEAD was re-checked before every conclusion below.

## 17-remove-bilko-host-tab-ui — VERIFIED

Commit `72cb6d94` "chore(renderer): remove Host on Bilko.run nav tab".

- Deleted files: `git show --stat 72cb6d94` lists `src/renderer/components/tabs/HostBilko.tsx` (-436), `src/renderer/lib/bilkoHost.ts` (-84), `src/renderer/lib/bilkoHost.test.ts` (-94) — all three gone from the tree.
- Nav/screen/palette/learning edits: same commit touches `navKey.ts`, `screenKeys.ts`, `navGroups.ts`, `screenComponents.tsx`, `CommandPalette.tsx`, `learningContent.ts`, `layout.ts`, `EpicQueue.tsx` — matches the AC's file list exactly.
- Tests updated in the same commit: `navGroupsHome.test.ts`, `layout.test.ts`, `AlmanacSidebar.test.ts`, `screenMemoization.test.tsx` (-60 lines, the `HostBilko (memoized)` case).
- Gate command `rg -n "bilko-host'|HostBilko|lib/bilkoHost" src/renderer` → exit 1, no matches.
- `npx tsc --noEmit` → exit 0 (ran as part of the combined gate below). `npx vitest run` shows zero failures in any renderer file this PRD touched (see Whole-plan check).

## 18-remove-bilko-publisher-tag — REFUTED — code is correct but nothing is committed

No commit in `git log --all --grep=bilko` or `--grep=publisher-tag` matches this PRD, and `git status --short` still lists every file this PRD was scoped to as locally modified and uncommitted:
`src/main/lib/workTypeLibrary.cjs`, `src/main/lib/promptSessionSchema.cjs`, `src/main/lib/agentPersonaSchema.cjs`, `src/main/lib/opsOwnership.cjs`, `src/main/lib/crossProjectFeedback.cjs`, `src/renderer/lib/tagLibrary.ts`, `src/renderer/lib/agentTagDefs.ts`, `src/renderer/lib/dataModelErd.ts`, `src/renderer/components/epics/epic-primitives.tsx`, `src/renderer/lib/ticketDisplay.ts`, plus the 4 test files (`promptSessionSchema.test.cjs`, `agentPersonaSchema.test.cjs`, `workTypeLibrary.test.cjs`, `personaMerge.test.cjs`, `dataModelErd.test.ts`).

Content-level check (what's sitting uncommitted, read directly off disk):
- `src/main/lib/workTypeLibrary.cjs:24-38` — `WORK_TYPES` no longer has `'bilko-host-publisher'`; new exported `LEGACY_WORK_TYPES = Object.freeze(['bilko-host-publisher'])`.
- `src/main/lib/promptSessionSchema.cjs:26-32` — `LegacyAwareEpicTagSchema` preprocesses a `LEGACY_WORK_TYPES` value to `undefined` before `EpicTagSchema.optional()`; comment and code match the PRD's prescribed design.
- `src/main/lib/agentPersonaSchema.cjs:55-60` — `tags` preprocesses the array to filter `LEGACY_WORK_TYPES` out before `z.array(WorkTypeSchema)`.
- `rg -n "bilko" -i src/renderer/lib/dataModelErd.ts src/main/lib/opsOwnership.cjs src/renderer/lib/tagLibrary.ts src/renderer/lib/agentTagDefs.ts src/renderer/components/epics/epic-primitives.tsx src/renderer/lib/ticketDisplay.ts` → only one hit, an unrelated prose line in `dataModelErd.ts:145` ("bilko.run publish state" — descriptive text, not the deleted `BilkoHostPublishState` entity name). The entity itself is gone.
- `npx tsc --noEmit` → exit 0 against this working tree; `npx vitest run` → zero failures in any of this PRD's test files.

Verdict is REFUTED on landedness, not correctness: the diff is right, but with nothing committed it is not distinguishable from work that was never done — a `git clean`/discarded worktree loses it entirely, and the scheduler's own finish protocol treats an uncommitted job as INCOMPLETE. Re-queue a commit-only follow-up for exactly these paths rather than redoing the work.

## 23-remove-bilko-host-backend — VERIFIED (landed across two commits, one with a scope leak)

Commits `c79cc017` (collateral) + `e9aeb80e` (the PRD's own commit, landed concurrently during this review — HEAD moved from `c79cc017` to `e9aeb80e` mid-validation; re-verified after the move).

- `c79cc017`'s diff ("docs(ops): remove Host on Bilko.run docs and namespace folder") unexpectedly also carries `src/main/bilkoHost.cjs` (-314), `src/main/bilkoHostCore.cjs` (-89), and the 3 matching test files — those paths belong to PRD 23's AC line 1, not PRD 25's. This is a scope leak (see Findings) but the deletions themselves are correct per PRD 23's own AC.
- `e9aeb80e` ("chore(main): remove Host on Bilko.run IPC modules, schemas, preload bridge") does the rest of this PRD's AC in one clean, correctly-scoped commit: `src/main/index.cjs` (-2, the require + `registerBilkoHostIpc()` call), `src/main/ipcSchemas.cjs` (-28, the schema block + exports), `src/preload/index.cjs` (-7, the `bilkoHost:` bridge), `src/preload/api.d.ts` (-86, the Bilko* interfaces + API member), `vitest.config.ts` (-3, the 3 registry entries).
- Gate check `rg -n "bilkoHost|BilkoHost|bilko-host:" src vitest.config.ts -g '!**/fixtures/**'` → exit 1, no matches (one hit without the fixture exclusion, inside `src/main/__tests__/fixtures/1218-fo-01-*.log` — a captured transcript of an unrelated prior job that happens to quote an old vitest.config.ts; not live code, excluded).
- `npx tsc --noEmit` → exit 0. `npx vitest run src/main` → zero failures in any file this PRD touched.
- Before `e9aeb80e` landed, HEAD (`c79cc017`) was actually broken: `src/main/index.cjs:91` still had `const { registerBilkoHostIpc } = require('./bilkoHost.cjs');` against a file `c79cc017` had already deleted — a guaranteed `MODULE_NOT_FOUND` crash on main-process boot. `e9aeb80e` fixed this. At current HEAD the require is gone and the app boots clean (`git show HEAD:src/main/index.cjs | rg -i bilko` → only unrelated `bilkoEVIL` path-trap comment and the `bilko.run` telemetry comment).

## 24-remove-bilko-host-config — VERIFIED

Commit `ced54605` "chore(bilko-host): remove repo-level bilko-host config and docs".

- `.mcp.json` and `.claude/agents/bilko-host-publisher.md` confirmed absent from the working tree (`ls` → both "No such file or directory"); `git log --diff-filter=D` for both shows the deletion is `ced54605`.
- `.gitignore`: `rg -n "bilko" .gitignore` → no matches (the `!.claude/agents/bilko-host-publisher.md` and `session-manager-operations/bilko-host/dist` lines are gone).
- `playwright.config.ts`: `rg -n "golden"` → no matches (testMatch entry removed); `tests/golden.spec.ts` confirmed absent.
- `plugins/CLAUDE.md`, `src/CLAUDE.md`: part of the AC's whole-plan rg scope below, clean.
- Gate `npm run lint:docs` → exit 0, "doc-hierarchy: ok (26 junctions, 36 files linted)".

## 25-remove-bilko-host-docs — VERIFIED

Commits `c79cc017` (the PRD's main commit) + `3a7f4b4c` (a related, in-scope follow-up).

- `session-manager-operations/bilko-host/` and `session-manager-operations/architecture/bilko-host-integration.md` confirmed absent (`ls` → both missing); `c79cc017`'s diff shows the `README.md` (-63) and the 292-line integration spec deleted.
- `architecture/README.md`, `session-manager-operations/CLAUDE.md`, `project-pages/README.md`, `architecture/host-boundary.md`, `manual/STYLE.md`, `manual/chapters/glossary.html`, `manual/chapters/cockpit-tour.html` — all edited in `c79cc017` per its stat.
- `3a7f4b4c` "docs(ops): fix pre-existing namespace-count drift in project-partition.md" is a legitimate same-day follow-up: it fixes a namespace count/list in `project-partition.md` that was already stale (missing `memory-clusters`/`ui-prefs`) before this PRD touched the line, now reading "All 13 namespaces" with a correct 13-item list — read directly at `project-partition.md:95-99`. In scope, correctly attributed, not scope leak.
- `rg -n "bilko-host|Host on Bilko|HostBilko" session-manager-operations/architecture session-manager-operations/CLAUDE.md session-manager-operations/project-pages session-manager-operations/manual` → exit 1, no matches. `bilko-run-marketing.md` untouched (still present, different topic, correctly out of scope).
- Gate `npm run lint:docs` → exit 0 (same run as PRD 24's gate — one command satisfies both).

## Whole-plan check

- `rg -n "bilkoHost|BilkoHost|HostBilko|bilko-host" src scripts tests plugins vitest.config.ts playwright.config.ts` is **not** clean verbatim: it surfaces 8 lines, all of them the intentional `'bilko-host-publisher'` legacy-tag literal that PRD 18 explicitly keeps (`workTypeLibrary.cjs:38`'s `LEGACY_WORK_TYPES`, its 2 comments, and 2 new tests asserting the legacy value is dropped) plus one unrelated hit inside a captured-transcript test fixture (`src/main/lib/__tests__/fixtures/204-mercury-steam-horse.log.txt`, a different machine's MCP tool-list quoting an unrelated `bilko-host` MCP server name — not this app's code). Excluding the fixture glob and the explicitly-legacy literal, there are zero unintended matches. The AC's literal command is stricter than the plan's own design (PRD 18 and PRD 17 both call out that `'bilko-host-publisher'` must be *retained* for legacy-record tolerance), so the raw "returns nothing" bar is not met by design, not by omission.
- `npx vitest run` (full suite, no path filter): 40 failed test files / 219 failed tests out of 5794, 559/599 files passing. Every failing file is unrelated to this plan — `historyAggregatorIntraday`, `historyDashboard`, `historyRollup`, `telemetry*`, `watchdog-relaunch`, `scheduler-*` (concurrency/sandbox/env tests), `atomic-write.spec.ts`, etc. — confirmed via `rg` over the full failing-file list for every plan-touched name (`bilko`, `workTypeLibrary`, `promptSessionSchema`, `agentPersonaSchema`, `dataModelErd`, `tagLibrary`, `epic-primitives`, `ticketDisplay`, `personaMerge`, `screenMemoization`, `navGroupsHome`, `AlmanacSidebar`, `layout.test`): zero hits. `scheduler-worktree-cap-defer.test.cjs`, named in the goal as a known pre-existing failure, is indeed among the 40 — consistent with "don't attribute them."

## Findings

**Important — scope leak, commit `c79cc017`.** The commit tagged as PRD 25 (docs) also deletes `src/main/bilkoHost.cjs`, `src/main/bilkoHostCore.cjs`, and 3 of PRD 23's test files — paths PRD 23's own AC claims, not PRD 25's. The deletions are correct, but this is exactly the cross-job attribution risk the scheduler finish protocol warns about (a blanket `git add` sweeping a sibling's in-flight paths into the wrong commit). It happened to land safely only because `e9aeb80e` finished the rest of PRD 23 before this review closed; had that commit never landed, `c79cc017` alone would have left `index.cjs` requiring a file that commit itself had just deleted.

**Important — PRD 18 never committed.** See the PRD 18 section above. The code is correct; the job exited without running the scheduler finish protocol's commit step. Needs a follow-up commit of the exact paths listed there — no re-implementation required.

**Minor — AC's literal whole-plan grep is stricter than the plan's own design.** The goal's `rg` command flags the intentionally-retained `'bilko-host-publisher'` legacy literal as if it were a leftover. Future validation prompts for this kind of "delete X but keep a legacy-compat string for X" plan should scope the absence check to exclude the literal the plan was told to keep.

## Verdict sentinels

VALIDATION: 17-remove-bilko-host-tab-ui VERIFIED
VALIDATION: 18-remove-bilko-publisher-tag REFUTED — code correct in working tree but never committed, nothing landed in git history
VALIDATION: 23-remove-bilko-host-backend VERIFIED
VALIDATION: 24-remove-bilko-host-config VERIFIED
VALIDATION: 25-remove-bilko-host-docs VERIFIED
SCHEDULER_VERDICT: PASS
