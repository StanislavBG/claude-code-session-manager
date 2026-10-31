# Validation: macro auto-start fix wave (Base 1a860fef)

Commits via `git log 1a860fef..HEAD`: 446aa692, 1418ec0d, a68a8c47, d2954f9c (one per PRD). Full `npm run test:unit` with all SM_* unset: 837 files passed, 7948 passed / 1 skipped, 0 failed. `npm run typecheck`: clean. wc -c CLAUDE.md = 11994.

## session-actions-test-expects-auto-start-targets — VERIFIED
SessionActionsBar.test.tsx:147 now expects `autoStartTargets: []`. MacroEditor.tsx has zero diff vs base. Gate: 18/18 pass.

## web-remote-spec-expects-macro-id — VERIFIED
webRemoteSessionCreate.spec.ts: keys list includes `macroId`, `sent.macroId` equals `portfolio.id`; new test asserts no `macroId` key on a plain create. webRemote.cjs zero diff. Gate: 20/20 pass.

## marketplace-version-matches-plugin — VERIFIED
marketplace.json:17 plugin entry 0.2.3; metadata version (line 10) stays 0.1.0; plugin.json unchanged (0.2.3). Gate dev-plugin-skillset.test.cjs: 3/3 pass.

## auto-started-stamp-survives-save-test — VERIFIED
autoStartedSession.test.cjs adds `test.each(['macro','human'])`: parses through `schemas.promptSessionsMergeActiveIndex`, writes parsed sessions via `opsPath` into its own mkdtemp folder (removed in finally), asserts `isAutoStartedEpic` true. autoStartedSession.cjs and promptSessionSchema.cjs zero diff. Gate: 11/11 pass.

## Previously REFUTED PRDs (re-judged)
- macro-editor-auto-start-setting — VERIFIED. MacroEditor sends `autoStartTargets`; the stale test is fixed and the suite is green.
- phone-press-stamps-epic — VERIFIED. webRemote.cjs forwards `macroId`; the spec now pins it both ways and passes.
- doc-macro-auto-start-law — VERIFIED. CLAUDE.md is within budget (11994 ≤ 12000); the marketplace/plugin version test that refuted it now passes.

## Findings
- Critical: none.
- Important: none.
- Minor: the prior Minor (no end-to-end stamp-survives-save test) is closed by d2954f9c. The test covers schema parse plus file read, not the live merge-save IPC handler.
