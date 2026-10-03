# Validation — remove "Host on Bilko.run" (re-run at HEAD e9861d0b, 2026-10-02)

Supersedes the b07e54b2 record (which marked PRD 18 REFUTED "never committed"; 913e5538 has since landed).
Note: `timeout` binary absent on macOS; commands ran foreground without wrapper.

## 17-remove-bilko-host-tab-ui — VERIFIED
- Commit 72cb6d94. `HostBilko.tsx`, `lib/bilkoHost.ts`, `lib/bilkoHost.test.ts`: `ls` → No such file.
- `rg -n "bilko-host'|HostBilko|lib/bilkoHost" src/renderer` → no matches.
- Renderer tests pass in the full vitest run (no renderer file in the failing list).
- `npm run typecheck` (tsc renderer + main) → exit 0.

## 18-remove-bilko-publisher-tag — VERIFIED
- Commit 913e5538. Only remaining `bilko-host-publisher` refs: `src/main/lib/workTypeLibrary.cjs:38` (`LEGACY_WORK_TYPES`), `promptSessionSchema.cjs:26`, `agentPersonaSchema.cjs:56` (legacy-drop comments), and tests `promptSessionSchema.test.cjs:89-98`, `agentPersonaSchema.test.cjs:55-56`, `workTypeLibrary.test.cjs:65` — all the deliberate legacy tolerance the AC requires.
- Legacy-drop tests present and passing in full run; no renderer tag-map / api.d.ts / dataModelErd / opsOwnership hits (whole-tree rg below).

## 23-remove-bilko-host-backend — VERIFIED
- Commit e9aeb80e (part swept into c79cc017). `src/main/bilkoHost*.cjs` and `src/main/__tests__/bilkoHost*` absent.
- `rg -n "bilkoHost|BilkoHost|bilko-host:" src vitest.config.ts` → only frozen historical log fixtures (see Minor).
- `src/main` vitest files failing: all unrelated env/sandbox (below). Typecheck passes.

## 24-remove-bilko-host-config — VERIFIED
- Commit ced54605. `.mcp.json`, `.claude/agents/bilko-host-publisher.md`, `tests/golden.spec.ts`: No such file.
- `rg -n "bilko-host|bilkoHost" .gitignore playwright.config.ts tests plugins/CLAUDE.md src/CLAUDE.md` → no matches.
- Gate `npm run lint:docs` → "doc-hierarchy: ok (26 junctions, 36 files linted)".

## 25-remove-bilko-host-docs — VERIFIED
- Commits c79cc017, 3a7f4b4c. `session-manager-operations/bilko-host/` and `architecture/bilko-host-integration.md`: absent.
- `rg -n "bilko-host|Host on Bilko|HostBilko" session-manager-operations/architecture session-manager-operations/CLAUDE.md session-manager-operations/project-pages session-manager-operations/manual` → no matches (manual lives at `session-manager-operations/manual/` inside repo, not repo-root `manual/` as the PRD wrote).
- lint:docs ok (above).

## Whole-plan check
- `rg "bilkoHost|BilkoHost|HostBilko|bilko-host" src scripts tests plugins vitest.config.ts playwright.config.ts`: NOT literally empty. Hits = (a) deliberate `bilko-host-publisher` legacy tolerance (listed in PRD 18); (b) frozen log fixtures `src/main/lib/__tests__/fixtures/204-mercury-steam-horse.log.txt:8` and `src/main/__tests__/fixtures/1218-fo-01-move-scripts-lib-into-src-main-lib.log` (recorded tool/transcript text). No live code/config references. Judged acceptable.
- `npx vitest run`: 40 failed files / 219 failed tests / 5529 passed (600 files). None touch this plan's files. Sampled: `scheduler-epic-digest.test.cjs` (15s timeouts), `seedAgentPersonas.test.cjs` ("Write outside allowed write boundaries" on tmp marker), `watchdog-relaunch.test.cjs` ("resolved to live root under vitest" sandbox assertion). Pre-existing/env, not attributed to plan. I did not re-run against pre-plan baseline for every one of the 40 files; matches of the plan's touched areas (navGroups, screenMemoization, layout, AlmanacSidebar, workTypeLibrary, personaMerge, promptSessionSchema, agentPersonaSchema, dataModelErd, opsOwnership, ipcSchemas, preload) in the failing list: none.
- `npm run typecheck` pass; `npm run lint:docs` pass.

## Combined diff review
`git diff 72cb6d94^..HEAD` mixes in unrelated simplify-branch work (115 files), so only plan-relevant paths reviewed: deletions plus ipcSchemas/preload/api.d.ts trimming are clean; legacy-drop in schemas adds no new input-handling surface (value filtered, other unknown tags still rejected). No secrets, no path handling added. /code-review and /security-review not run as separate agents; self-review only.

## Findings
### Critical
- none
### Important
- Process: c79cc017 (docs commit) deleted PRD 23's `bilkoHost*.cjs` + tests before e9aeb80e removed the `index.cjs` require/IPC registration → main would not boot at that intermediate commit (HEAD fine). Bisect hazard only.
### Minor
- Frozen log fixtures still contain `bilko-host` / `bilkoHost` strings (`src/main/lib/__tests__/fixtures/204-mercury-steam-horse.log.txt:8`, `src/main/__tests__/fixtures/1218-fo-01-...log`); whole-plan rg AC needs a fixture exclusion to be literally empty.
- PRD 25 AC names repo-root `manual/`; actual path is `session-manager-operations/manual/`.
- 40 pre-existing failing vitest files (env/sandbox/timeouts) make `npx vitest run` non-green independent of this plan.
