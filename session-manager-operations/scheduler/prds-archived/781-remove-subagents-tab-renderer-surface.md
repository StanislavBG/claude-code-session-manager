---
title: Remove Subagents tab: nav destination + renderer tab tree
cwd: ~/Projects/session-manager
estimateMinutes: 15
---

# Goal

Remove the Subagents nav destination and the entire renderer surface of the Subagents tab (the feature is retired as useless/impractical). After this PRD the app compiles and runs with no `'subagents'` nav key anywhere; deleting the now-dead stores/libs and the main-process backend happens in two follow-up PRDs (782, 783).

# Acceptance criteria

- [ ] Deleted: `src/renderer/components/tabs/Subagents.tsx` and the whole `src/renderer/components/tabs/subagents/` directory (DispatchLaunch.tsx, DispatchLive.tsx, ExamplePromptsSection.tsx, hive-primitives.tsx, OrchestratorRunView.tsx, RaceRunView.tsx)
- [ ] Deleted: `src/renderer/components/modals/HiveManagerModal.tsx` and `src/renderer/components/layout/OrchestratorStatusPanel.tsx`, and their mounts/imports removed from `App.tsx`
- [ ] `src/renderer/lib/navGroups.ts`: the `'subagents'` NAV_ITEMS entry removed; with only `'scheduler'` remaining as a `liveKind`, either keep the one-member union or collapse `liveKind` to a boolean — pick one and keep `AlmanacSidebar.tsx` `useLiveIndicators()` (lines ~95-112, consumed ~line 204) consistent; the `subagents` indicator key is removed
- [ ] `'subagents'` removed from: `LeftNav.tsx` NavKey union (~line 23), `App.tsx` SCREEN_KEYS (~line 49), `MainPane.tsx` routing (~lines 7, 64-65, 118), `CommandPalette.tsx` (~line 173)
- [ ] `src/renderer/lib/slashCommand.ts` lines 8-9: the `agents`/`subagents` → `'subagents'` nav mappings removed, and `src/renderer/lib/__tests__/slashCommand.test.ts` line 14 (`'/agents foo bar'` → `'subagents'`) removed/updated to match
- [ ] `learningContent.ts`: the `'subagents'` block (~lines 360-388) removed so `Record<NavKey, LearningContent>` still typechecks; copy-only mentions at ~lines 270 and 339 reworded to not reference the removed tab
- [ ] `AlmanacIcon.tsx`: `'hive'` icon name+glyph removed; `'agents'` icon (lines ~11, 46) also removed IF grep shows no surviving user
- [ ] `tests/e2e/hive-shortcut.spec.ts` deleted; `tests/e2e/tabs-smoke.spec.ts` line ~30 `'subagents'` entry removed from the tab list
- [ ] `timeout 300 npm run typecheck` passes
- [ ] `timeout 600 npm run test:unit` passes

# Implementation notes

This is link 1 of a 3-PRD chain (this one removes the UI surface; 782 deletes now-dead renderer stores/libs; 783 deletes the main-process backend + docs). Delete files outright — single-author repo, no-backwards-compat-shims convention.

IMPORTANT KEEPS (shared with other features, verified in the authoring session): `state/live.ts` agent tracking (Terminal/AlmanacSidebar), `src/main/usageMatrix.cjs` subagent counters, `components/tabs/memory/SubagentMemoryView.tsx` (Memory tab), `ProvenanceBadge.tsx`, TeamsCard/teams.cjs, `data/catalog.ts` (Library.tsx, provenance.ts, presetBlock.ts import it — do NOT delete). `MainPane.tsx` line ~74 "Subagent scope" text belongs to the Memory tab — keep.

Do NOT delete state stores (`hives.ts`, `orchestrator.ts`, `dispatch.ts`, `race.ts`, `superagent.ts`) or libs in this PRD even though their importers vanish — that's link 2; this PRD only needs the app to compile, and those modules compile standalone.

Verify at the end: `grep -rn "'subagents'" src/renderer` — remaining hits should only be inside the stores/libs slated for 782.

# Out of scope

- Deleting renderer stores/libs (hives.ts, orchestrator.ts, dispatch.ts, race.ts, transcriptDigest.ts, superagent.ts, assignHiveRoles, defaultHives, resolveRecipeRoles, useAgentNames, agentFrontmatter, canonicalTools) — chain link 2 (PRD 782)
- Main-process hives.cjs / superagent.cjs / preload / api.d.ts / CLAUDE.md / docs — chain link 3 (PRD 783)
- Any Usage-tab work (separate chain, PRDs 784/785)

## Engineering standards

Before writing any code, read `/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands, verify before done, the finish-protocol sentinel).
