# Validation: history-by-launcher plan

Base: 576f358d. Commits: 2fbe2f23 (fold), 2e4f4c2d (panel). Self-review used (no background reviewers); no secrets, no path handling, no new IPC.

## history-launcher-fold — VERIFIED
- Helper, type, ordered list, name rules: src/renderer/lib/historyLauncher.ts:11-19.
- byLauncher per row with 6 fields, cost from estimatedCostUsd, filled by source folder's launcher: historyProjectFold.ts addToLauncher (~73-83), cloneRow, `launcherOfEncodedDir(encoded)` in the fold loop.
- Merge adds buckets like byModel: mergeRow calls addToLauncher; buckets sum to row totals.
- Row type FoldedProjectRow declares byLauncher; excluded handling untouched in diff.
- Tests: historyProjectFold.test.ts (+50), historyLauncher.test.ts incl. `-tmp-session-manager-` names.
- Gate: vitest (fold, launcher, facet) 23 passed; `npm run lint` exit 0; `npm run typecheck` clean.

## history-by-launcher-panel — VERIFIED
- historyFacet.ts:42-46, 89, 111-122, 134: byLauncherTotals summed over kept rows; rows without byLauncher add nothing.
- LauncherMix.tsx:12-16 labels, :20 fixed order, zero for missing, :26-27 "no usage in range", cost/share/bar :30-45.
- HistoryDashboard.tsx:372 renders LauncherMix with facet.byLauncherTotals next to ModelMix.
- .claude/agents/page-history.md:36 invariant added.
- Tests: historyFacet.test.ts (+45), LauncherMix.test.tsx (new).
- Gate: vitest (facet, LauncherMix, navface, legacyNote) 26 passed; lint and typecheck green.

## Visual check
The panel cannot be checked by launching the app here. A visual check by the owner is still due.

## Findings
Critical: none
Important: none
Minor:
- Minor: LauncherMix.tsx:25 kicker "07 · composition" repeats "composition" while ModelMix/Cache/Rhythm/Concentration share "05"; harmless naming only.
- Minor: combined diff (base..HEAD) also holds unrelated commits (claude-config, editor, agents) from other jobs; not part of this plan, not reviewed.
