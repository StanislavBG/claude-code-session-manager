# Validation: hotkeys-keep-last-known-macros, terminal-outcome-run-index

Base: 97cd6db8. Commits: d22b22bf (hotkeys), 151a9b26 (run index). Gates re-run: all green
(vitest 3 files/33 tests; terminalRunOutcome 16 tests; `npm run typecheck` exit 0).
/code-review and /security-review not run as separate tools; self-reviewed the diff (no input/path/secret risk; run-dir names are only joined under runsDir from readdir).

## hotkeys-keep-last-known-macros — VERIFIED
- Returns `{macros, loaded}`, module-level `lastKnown` seeds state/loaded: useMacros.ts:40-43.
- Reject keeps state, toast once per streak, success resets `failing`: useMacros.ts:50-62.
- `hotkey-loading` "Loading hot keys…" between New Session and macros when `!loaded`: SessionActionsBar.tsx:142-146 (macro buttons follow; New Macro after). ProjectHome.tsx:36 destructures `{ macros: library }`.
- Tests: useMacros.test.ts (pending first mount, never-resolving remount, rejected-after-success + toast.error at :91); SessionActionsBar.test.tsx:94-105.
- `__resetMacrosCacheForTests` exported (useMacros.ts:35) and called in beforeEach in useMacros/SessionActionsBar tests (+ deleteScope, ProjectHomeEmptyState).
- Gate: green.

## terminal-outcome-run-index — VERIFIED
- Signature/return shape unchanged; module-level `indexes` Map keyed by runsDir: terminalRunOutcome.cjs:31-40, 94-102.
- One readdirSync(runsDir) per call; dirs >24h cached permanently, younger/unparseable re-listed: refreshIndex, :50-78.
- Spy test over 2,000 old dirs, 50 missing lookups: test.cjs:212; young-dir late meta.json test :239; `__resetRunIndexForTests` exported and used in beforeEach (:20).
- Existing tests pass unchanged (16/16). scheduler.cjs untouched.
- Gate: green.

## Findings
### Critical
none
### Important
none
### Minor
- useMacros.ts:50-62: the rejection toast fires even after the component unmounted (the `cancelled` flag only guards state setters); harmless, deduped by the streak flag.
- Out-of-`# Files` edit to ProjectHomeEmptyState.test.tsx (disclosed in the run report; justified).
- terminalRunOutcome.cjs: a meta.json added to an old (>24h) dir after caching is never seen (by design); the first cold call still lists every run dir once (unavoidable, one-time).
