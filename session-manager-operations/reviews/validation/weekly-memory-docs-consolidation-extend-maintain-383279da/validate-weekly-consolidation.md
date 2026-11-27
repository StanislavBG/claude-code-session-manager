# Validation — weekly memory + docs consolidation plan

PRD 4879-validate-weekly-consolidation. Base `1b2c20bd` (parent of f29a2a50, the plan's first commit); HEAD `81494679`.
Plan commits: f29a2a50 (4877), 4e0e0bd5 (4876), 4eeb7c42 (4874), d9fa039f (4875), b4d7a70c (4878), 81494679 (seed-test sync for f29a2a50). 26c9e649, 6cf72e25 and ca9666f3 are outside the plan.

## Gates (re-run 2026-11-26, foreground)

- `npx vitest run` memoryConsolidation, weeklyConsolidationInputs, builtinMacros, seedAgentPersonas, macroLibrary, validatorVerdictSchema, seedValidatorPersona: 7 files, 248 tests passed, exit 0.
- `npm run lint:docs`: `doc-hierarchy: ok (27 junctions, 55 files linted)`, exit 0.
- `npm run typecheck`: exit 0.
- Extra: `npm run lint:readme`: **exit 1**, `README.md: list personas is missing: md-network-curator`.

## Real-data checks (read-only)

- `listProjectTranscripts({cwd: ~/Projects/session-manager, last 7 days})` on the real `~/.claude/projects`: total 62 (53 from the root, 9 from worktrees), 0 foreign. But 1,790 top-level `.jsonl` files in this project's worktree folders (hash `fd076eb59c21f399`) changed in the same window. Dead worktrees fail `worktreeMainRootOf`, so they are dropped.
- `collectLessons` on real data: 0 lessons. Job rows have no `logPath` field: 0 of 1,693 of this project's history.jsonl rows in the window have one, and none of the 38 queue rows do. The scheduler builds the path as `runsDir/<runId>/<slug>.log` (scheduler.cjs:4673). `readMergedSync().jobs` holds only the 38 queue rows, not history.
- Curator resolution: seeding into a temp HOME and calling `readOverlayAwarePersonaModel` / `resolveEpicEffort` gives `model fable` and `effort max (source persona)`. The seeded validator is 6,206 chars, is not truncated and keeps the lessons line.

## 4874-md-network-weekly-mode — VERIFIED

- ac-1: SKILL.md:10,20 list the three modes; :43 References line; :75-86 checklist; 86 lines.
- ac-2: weekly-consolidation.md covers inputs, read-only, the 2-session threshold, verify/organize/enrich, the 5-add cap, housekeeping, the record template, apply and steering.
- ac-3: builtinMacros.cjs options are `['Full review','Drift check','Weekly consolidation']` and builtinVersion 2; the test asserts them; vitest is green.
- ac-4: weekly-consolidation.md "Steering file" explains why no opsOwnership/AGENTS row is needed.
- ac-5: lint:docs and typecheck exit 0.

## 4875-md-network-curator-persona — VERIFIED

- ac-1: md-network-curator.md frontmatter: fable, max, `Read, Grep, Glob, Agent`, packs session-manager-dev, seedVersion 1, executorOnly true. The real resolver gives fable/max.
- ac-2: body of about 1.9 KB covers headless read-only work, propose only, one subagent per batch, and the answer between the markers.
- ac-3: seedAgentPersonas.cjs:84 PERSONAS and the shippedPersonaSeeds entry are present.
- ac-4: seedAgentPersonas tests are green.
- Finding: lint:readme is red (Important, regression).

## 4876-weekly-consolidation-inputs — REFUTED

- ac-1 NOT MET (not-checked-live): the code is correct for live worktrees and the sibling-prefix test passes. On real data it returned 9 of the about 1,790 worktree transcripts in this project's window, because dead worktrees are dropped (the 4e0e0bd5 Follow-up admits this). The criterion says "every … Epic/job worktree".
- ac-2 NOT MET (behavior-wrong): collectLessons reads `job.logPath`, which no job row has, and reads only queue rows, not history. On real data it always returns 0. The tests inject a fake `logPath`.
- ac-3: half-open `inWindow` (weeklyConsolidationInputs.cjs:52); tests cover consecutive windows for transcripts and Lessons blocks.
- ac-4: unit tests cover sibling, worktree, bounds, cap and empty inputs; green.

## 4877-lessons-block-personas — VERIFIED

- ac-1: dev-lead.md:47 adds the line "Don't write auto memory. Optionally … `Lessons:` … at most 3".
- ac-2: validator.md:42 adds the `lessons` line; validatorVerdictSchema.cjs adds an optional maxItems 3 / maxLength 200 field; the test checks that the field stays optional.
- ac-3: seedVersions are now dev-lead 10 and validator 15; the shippedPersonaSeeds entries keep the 6,206-char validator from being truncated.
- ac-4: seed and verdict-schema tests are green at HEAD. seedValidatorPersona was red after f29a2a50 until 81494679.

## 4878-weekly-consolidation-task — REFUTED

- ac-1 NOT MET (missing-test): AGENT is `md-network-curator`, and live resolution is fable/max. The test only checks the seed file with a regex (memoryConsolidation.test.cjs:86). It does not go through the injected resolver or the route stub, as the criterion asks.
- ac-2: the prompt carries the window, transcripts, lessons, memory, stale candidates, budget, steering, weekly-consolidation.md and the markers (test :92). The window comes from lastStartMs, which skips NOT_RUN (memoryConsolidation.cjs:200).
- ac-3: READ_ONLY_TOOLS is Read/Grep/Glob/Agent, set as both tools and allowedTools (:289-290); the test is at :81.
- ac-4: usage hold test :174, switch test :48, cadence tests :120/:131, timeoutSec 3600.
- ac-5: title `…: N adds, N merges, N removals`; the why text tells the owner to press Review MD network with Mode 'Weekly consolidation' and names Task <id>.
- ac-6: one or two lines each in managed-agents-alignment.md#memory, scheduler-operations.md:426 and tasks/README.md.
- ac-7: vitest is green.

## Findings

### Critical
- src/main/lib/tasks/weeklyConsolidationInputs.cjs:677-679,790: collectLessons reads `job.logPath` (no such field) and only `readMergedSync().jobs` (queue, not history.jsonl). On real data no Lessons block is ever collected. It should build the log path as scheduler.cjs:4673 does and read history. (4876, behavior-wrong)

### Important
- src/main/lib/tasks/weeklyConsolidationInputs.cjs:724: dead Epic/job worktrees fail `worktreeMainRootOf`, so their transcripts are dropped (9 of about 1,790 this week). Map them by the project hash in the managed worktree path. (4876, not-checked-live)
- README.md: `npm run lint:readme` fails with "list personas is missing: md-network-curator". d9fa039f added the persona without the README row. ca9666f3 quotes this: "Follow-up: README.md persona list is missing md-network-curator (lint:readme red, unrelated)". (4875, regression)
- src/main/lib/tasks/__tests__/memoryConsolidation.test.cjs:86: the Fable/max test reads the seed file and never goes through the resolver or the route stub. (4878, missing-test)

### Minor
- 4e0e0bd5 trailer: "Follow-up: dead worktrees (git admin gone) can't map to main root; transcripts there are skipped". (4876, other)
- d9fa039f trailer: "Follow-up: seedValidatorPersona.test.cjs has 3 failures unrelated to this change (validator body 6206>6000 chars, dev-lead seedVersion expected 9 got 10)". These were caused by f29a2a50 (4877) and fixed in 81494679. (4875, other)
- src/main/__tests__/seedValidatorPersona.test.cjs: f29a2a50 left it red until 81494679 because 4877's gate did not run it. (4877, regression)
- src/main/lib/persona-macro/builtinMacros.cjs: the macro prompt text changed although the PRD said it needed no change; the old prompt is kept in priorPrompts. (4874, other)
- src/main/lib/tasks/memoryConsolidation.cjs:471: Lessons lines (job output) go verbatim into the curator prompt. The run is read-only, so the injection risk is low. (4878, security)
- src/main/lib/tasks/memoryConsolidation.cjs:289: nothing checks live that Agent subagents inherit the read-only tool set. (4878, not-checked-live)
