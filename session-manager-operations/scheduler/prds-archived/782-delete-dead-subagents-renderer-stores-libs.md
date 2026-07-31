---
title: Delete dead Subagents renderer stores, libs, and styling
cwd: ~/Projects/session-manager
estimateMinutes: 12
---

# Goal

Chain link 2 after PRD 781 (which removed the Subagents tab UI). Delete every renderer module that existed only for that tab and is now importer-less, plus the orphaned Tailwind colors and a dangling comment. The app must compile and all unit tests pass afterward.

# Acceptance criteria

- [ ] For EACH file below, first confirm zero surviving importers (`grep -rn "<basename-without-ext>" src/ tests/`), then delete. If a file unexpectedly still has a live importer, KEEP it and note why in the final report instead of forcing the deletion:
  - `src/renderer/state/hives.ts`
  - `src/renderer/state/orchestrator.ts`
  - `src/renderer/state/dispatch.ts`
  - `src/renderer/state/race.ts`
  - `src/renderer/state/transcriptDigest.ts` (race.ts is its consumer — delete race.ts first)
  - `src/renderer/lib/assignHiveRoles.ts` + `src/renderer/lib/__tests__/assignHiveRoles.test.ts`
  - `src/renderer/lib/defaultHives.ts`
  - `src/renderer/lib/resolveRecipeRoles.ts`
  - `src/renderer/lib/useAgentNames.ts`
  - `src/renderer/lib/agentFrontmatter.ts` + `tests/unit/agentFrontmatter.spec.ts` (NOT `prdFrontmatter.ts` — that is still used by SchedulerPrdsView)
  - `src/renderer/data/canonicalTools.ts`
- [ ] `src/renderer/data/catalog.ts` is KEPT (Library.tsx / provenance.ts / presetBlock.ts import it), but its `CATALOG_AGENTS` export removed IF nothing outside the deleted set uses it; `tests/unit/provenance.spec.ts` still passes
- [ ] `tailwind.config.js` (~lines 52-54): `hive-slate` and `hive-plum` colors removed; `hive-teal` KEPT (used by `src/renderer/components/tabs/history/analytics/ProjectDrill.tsx:78`)
- [ ] `TerminalChat.tsx` line ~123: comment pointing at hive-primitives ToolChip reworded/removed
- [ ] `grep -rn "hives\|HIVE_PALETTE\|hiveEstimate" src/renderer` returns no functional hits (comments about unrelated things OK)
- [ ] `timeout 300 npm run typecheck` passes
- [ ] `timeout 600 npm run test:unit` passes

# Implementation notes

Depends on PRD 781 having landed (Subagents tab tree + modals removed). What 781 delivered: deleted `tabs/Subagents.tsx`, `tabs/subagents/*`, `HiveManagerModal.tsx`, `OrchestratorStatusPanel.tsx`; removed the `'subagents'` NavKey from navGroups/LeftNav/App/MainPane/CommandPalette/slashCommand/learningContent. That removal is exactly what orphaned the modules listed here.

Leave `src/renderer/state/superagent.ts` and `SuperAgentStatusBar.tsx` alone — they belong to PRD 783's SuperAgent stack removal (main + preload + renderer in one unit).

# Out of scope

- Main-process code, preload, api.d.ts, SuperAgent stack, CLAUDE.md, docs/design — PRD 783
- Usage-tab work — PRDs 784/785

## Engineering standards

Before writing any code, read `/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands, verify before done, the finish-protocol sentinel).
