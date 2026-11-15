# Validation: just Claude switch plan

Base: 00ccf511470488cd658d6eaa51a4a8f27128146b. Commits: 87ee8b54 (switch), 03c9309a (CLI lock), 20302cc2 (3D Art), 2883ddb5 (refusal text). PRD files found in prds-archived/.

Gates re-run (all exit 0): `vitest run` NewEpicCard + tagLibrary + tagTaxonomyParity + prdCreate = 4 files / 161 tests passed; `npm run typecheck` ok; `lint:hooks`, `lint:selectors`, `lint:test-smells` ok.
Absence check: no `developLoopOverride`, `NON_CLAUDE_LOOP_TITLE`, `data-testid="new-epic-develop-loop"` or `3D art / animation` in NewEpicCard.tsx / tagLibrary.ts (grep clean).

## new-session-just-claude-switch — VERIFIED
- Switch in `NewEpicHeader`, `data-testid="new-epic-just-claude"`, label `just Claude`, rendered before `advanced` (NewEpicCard.tsx:1410-1418); used on both faces (L740, L1088).
- ON sets NO_AGENT, tag null, `setCliOverride(null)` (L433-442); note `new-epic-just-claude-note` with exact text (L35, L824-826).
- OFF restores prior pick or falls back to architect/first persona + `feature` (L444-455).
- `developLoop = !justClaude && !nonClaudeCli` (L267); override state removed.
- Draft seeding (L221-224); resetForm clears switch and prev ref (L424-425).
- Tests named `just Claude …` at test.tsx L1148-1330, L1937 cover each criterion.

## just-claude-locks-cli-to-claude-code — VERIFIED
- Source line and picker gated `advanced && !justClaude` (L1151, L1172); `new-epic-agent-cli-just-claude` line with exact text (L1173-1176).
- Tests 'just Claude locks the CLI to Claude Code in advanced' (L1825) and 'turning just Claude off brings the CLI picker back' (L1839) exist and pass.

## relabel-art-mission-3d-art — VERIFIED
- tagLibrary.ts diff changes only `label` to `'3D Art'`; other fields untouched. Old text absent. Test at tagLibrary.test.ts:21-23.

## prd-refusal-names-just-claude — VERIFIED
- prdCreate.cjs error text matches the criterion exactly; status 409, ok/applied false unchanged, refusal precedes any write.
- Test at prdCreate.test.cjs:679 asserts status, exact text, and no writePrd call.

## Review
`/code-review` and `/security-review` not run separately; self-reviewed the combined diff (UI state, a string change, a label): no input handling, secrets, paths, or duplicated helpers. `HeaderSwitch` is a shared component for both switches.

## Findings
- Critical: none.
- Important: none.
- Minor: combined diff also includes 2bd71322 (manual.json `documentsAppVersion` bump), a release commit outside the plan, not attributable to these PRDs.
- Minor: PRD 3129 note says old drafts with an agent and the loop off reopen with the switch off and re-save with the loop on; a deliberate, documented behavior change.
