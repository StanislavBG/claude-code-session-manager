---
title: Remove Subagents main-process backend, SuperAgent stack, and docs
cwd: ~/Projects/session-manager
estimateMinutes: 15
---

# Goal

Chain link 3 after PRDs 781/782. Delete the main-process backend that only the removed Subagents tab used: `hives.cjs` and the entire SuperAgent ("Boss") stack, whose only launch UI was the deleted DispatchLaunch.tsx — leaving it would keep a status bar that can never light up. Also purge preload/typing surface and update docs.

# Acceptance criteria

## Hives backend

- [ ] Deleted `src/main/hives.cjs`; removed `index.cjs:63` require and `index.cjs:780` `registerHiveHandlers()` call
- [ ] Removed hives exposure from `src/preload/index.cjs` (~lines 251-255: `hives.list/get/save/delete`) and from `src/preload/api.d.ts` (~lines 702-705 and 1338-1342)
- [ ] `src/main/lib/kebabCase.cjs` KEPT (`prdCreate.cjs:22` uses it); `src/main/lib/classifyTranscriptLine.cjs` KEPT (`transcripts.cjs:41` uses it — its header comments mentioning race/orchestrator may be updated but the module stays)

## SuperAgent ("Boss") stack

- [ ] Deleted `src/main/superagent.cjs`; removed `index.cjs:58` require, `index.cjs:310` + `1094` `attachWindow` calls, `index.cjs:775` `registerSuperAgentHandlers()`
- [ ] Removed the `dropTab` superagent hook in `src/main/pty.cjs` (~lines 229-231, 248)
- [ ] Removed `superagentStart`/`superagentTabId` schemas from `src/main/ipcSchemas.cjs` (~lines 623-633, exports ~772-773)
- [ ] Removed preload exposure (`src/preload/index.cjs` ~341-352) and api.d.ts blocks (~959-990, 1459-1468)
- [ ] Deleted `src/renderer/state/superagent.ts` and `src/renderer/components/layout/SuperAgentStatusBar.tsx`; removed the App.tsx mount (~line 660) and imports (~lines 14, 16, 330)

## Docs

- [ ] `CLAUDE.md`: all Subagents/Hive/orchestrator feature references removed or reworded (architecture bullets for Subagents.tsx / hives.ts / orchestrator.ts / hive-primitives, "Hive design" convention bullets, agentFrontmatter mention at line ~63 — note prdFrontmatter.ts survives). Keep teams.cjs and Memory-tab lines.
- [ ] Deleted `docs/design/subagents-hive/` (10 files) and `session-manager-operations/reviews/subagents-findings.md`

## Tests

- [ ] `timeout 300 npm run typecheck` passes
- [ ] `timeout 600 npm run test:unit` passes
- [ ] `grep -rn "superagent\|registerHiveHandlers" src/ --include=*.cjs --include=*.ts --include=*.tsx` returns no functional hits

# Implementation notes

Depends on 781 (tab UI removed) and 782 (dead renderer stores/libs removed) having landed. What they delivered: no renderer file imports hives/orchestrator/dispatch/race/superagent state anymore except `state/superagent.ts` + `SuperAgentStatusBar.tsx`, which are this PRD's job together with their main-process counterpart.

`hives.cjs` uses inline zod (no entries in `ipcSchemas.cjs` — verified; don't hunt for them). The SuperAgent ipcSchemas entries DO exist and must go. Line numbers are from before 781/782 landed — re-grep rather than trusting offsets.

# Out of scope

- Usage-tab work — PRDs 784/785
- Removing state/live.ts agent tracking, usageMatrix subagent counters, Memory tab SubagentMemoryView, teams.cjs — all shared, all stay

## Engineering standards

Before writing any code, read `/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands, verify before done, the finish-protocol sentinel).
