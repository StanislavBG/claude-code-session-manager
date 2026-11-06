# Validation: plain-Claude new sessions (Agent None, Mission None, develop loop off)

Base: d58293ea (given). Final commit validated: a9b9fac6. Env: all SM_* unset.
Plan-wide: `npm run typecheck` exit 0; `npm run lint` clean (page-stewards clean, e2e budget 18/19); CLAUDE.md = 11987 bytes (<= 12000).
Full `npm run test:unit`: **8 files / 30 tests FAILED** (8457 passed) — see Findings. All other files, including every other PRD's gate files, pass.

## Per-PRD verdicts

| PRD | Verdict |
| --- | --- |
| epic-develop-loop-flag-schema | VERIFIED |
| epic-develop-loop-flag-mint-and-store | VERIFIED |
| prd-api-refuses-develop-loop-off-epic | VERIFIED |
| intake-plain-composition-and-injection-defaults | VERIFIED |
| agent-picker-none-option-and-order | VERIFIED |
| tag-library-no-mission-and-develop-loop-flag | VERIFIED |
| new-session-card-none-agent-none-mission-loop-toggle | VERIFIED |
| inline-guard-allows-develop-loop-off-epic | VERIFIED |
| chat-turn-disables-dev-plugin-when-loop-off | VERIFIED |
| terminal-launch-disables-dev-plugin-when-loop-off | **REFUTED** — own gate red: EpicDetail.terminalMode (9) + EpicTerminalPane (1) fail on `window.api.agents` undefined |
| agentless-epic-model-follows-settings | VERIFIED |
| runtime-readout-for-agentless-epics | VERIFIED (with Important finding F1) |
| epic-views-no-mission-no-agent-loop-off | VERIFIED (with Important finding F2) |
| docs-plain-session-laws | VERIFIED |
| develop-skill-no-mission-and-loop-off | VERIFIED (with Important finding F3) |

## Evidence per PRD (one line per criterion; commits via `git log d58293ea..HEAD`)

- **schema** (0e492632): promptSessionSchema.cjs +3 lines `developLoop` optional boolean; ipcSchemas.cjs createEpic schema +; api.d.ts create input; new tests in promptSessionSchema/promptSessionsCreateEpicHandler tests — in full-suite pass set. Typecheck 0.
- **mint-and-store** (41968d1a): epicMint.cjs:234 option, :348 `...(developLoop === false ? { developLoop: false } : {})`; promptSessionsCreateEpic.cjs forwards; renderer promptSessions.ts + test pass.
- **prd-api-refuses** (8c7c7e9c): prdCreate.cjs:322 `row.developLoop === false` → 409; prdCreateDevelopLoopOff.test.cjs passes (with batch/planId/estimate tests).
- **intake** (1dbc4a6e): contextInjections.ts `resolveContextInjections`; epicIntake.ts input-section omission; contextInjections.test.ts + epicIntake.test.ts pass.
- **agent-picker** (f7f8fc00): AgentPicker.tsx:41 `NO_AGENT='__none__'`, :60 `allowNone=false`, :113 `disabled={!allowNone && agents.length===0}`, :117-118 None option testid `new-epic-agent-none`; AgentPicker/NewEpicCard/MacroEditor tests pass; lint clean.
- **tag-library** (b8f23d86): tagLibrary.ts:33 `requiresDevelopLoop` true for feature/bug/art (lines 44,53,89), false for the rest; :111 `NO_MISSION`, :116 `missionLabel`; tests pass.
- **new-session-card** (f91d78eb): NewEpicCard +142/-: NewEpicCard.test.tsx new cases pass; lint clean.
- **inline-guard** (958c20c2): guard-inline-implementation-policy.cjs:139-142 allows when `epic.developLoop === false` with develop-loop reason; guard test passes.
- **chat-turn** (52c8b939): chatRunner.cjs:51 import, :638 `developLoopOffSettingsArgs(findEpicByClaudeSessionId(...))`; developLoopSpawn tests + chatRunner-develop-loop-off pass.
- **terminal-launch** (d8553497): epicLaunchCommand.ts + test pass (epicLaunchCommand.test.ts green). Gate files EpicTerminalPane.test.tsx and EpicDetail.terminalMode.test.tsx RED (re-run in isolation: 10 failed / 11 passed, `TypeError: Cannot read properties of undefined (reading 'resolveModelInfo')`).
- **agentless-model** (223aeed9): src/main/lib/claude/ suite passes (resolveEpicModelSettings, effectiveModelInfo); modelCatalog.cjs readSettingsModel; agentModelResolve.cjs order.
- **runtime-readout** (733c6a12): effectiveModelInfo.ts:113 `resolveModelInfo(agentType ? { cwd, agentType } : { cwd })`; its gate tests pass.
- **epic-views** (1cc76235): epicQueueControls.ts:26 `NO_MISSION_GROUP_LABEL='No mission'`; groundingBoard.ts:130 'no agent selected — no persona'; EpicDetail chips; gate tests pass.
- **docs** (e038f102): domain-model.md +16 lines, prompt-sessions/README.md +5, CLAUDE.md 11987 bytes; lint clean.
- **develop-skill** (a9b9fac6): SKILL.md diff is +4 lines (tag/developLoop in rule 1.3; No-mission ≈ discussion; developLoop false → no PRDs, stop); plugin.json 0.2.3→0.2.4; lint clean.

## Findings

### Critical
none

### Important
- **F1 — 29 unit tests regress because agentless Epics now call `window.api.agents.resolveModelInfo`** (src/renderer/lib/effectiveModelInfo.ts:113, from PRD 2633). Test mocks that formerly short-circuited on a null agent have no `window.api.agents`. Red files: EpicDetailPrdsRuns.test.tsx (6), EpicDetail.terminalMode.test.tsx (9), EpicDetail.timelineMemo.test.tsx (1), EpicTerminalPane.test.tsx (1), EpicsWorkspace.test.tsx (8), EpicsWorkspace.usagePoll.test.tsx (3). Per-PRD gates missed it except 2631's. Fix: add `agents.resolveModelInfo` to those mocks (or a shared mock), or guard the hook when the API is absent.
- **F2 — stale assertion** src/renderer/components/epics/__tests__/EpicWorktreeUI.test.tsx:152 expects no `epic-detail-meta-line` for an agentless Epic; PRD 2634 now always renders the "No agent" chip there (intended). Update the test.
- **F3 — plugin version drift**: plugin.json is 0.2.4 but `.claude-plugin/marketplace.json:17` still 0.2.3; `scripts/__tests__/dev-plugin-skillset.test.cjs` ("plugin.json version equals the marketplace entry version") fails, and installed copies may not refresh. Bump marketplace.json to 0.2.4.

### Minor
- Base was given; `validate-architect-persona-prd-executor.md` (another plan's record) appears in the diff stat — unrelated to this plan.
- Foreign WIP `session-manager-operations/project-pages/home.html` ignored as instructed.
