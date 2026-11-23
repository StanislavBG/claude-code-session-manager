# Validation: release gate green (PRDs 3733-3736)

Base: be060ae2 (given). Commits: d182e8e5, 25fafcf5, 265e5deb, b459fb2c (plus unrelated 5966f5f2 project-pages migration). Review tools: self-review of the diff (no secrets, no path traversal, no new input handling).

## repair-runtime-deps-marked — VERIFIED
- `src/main/lib/persona-macro/personaImportHealth.cjs:24` does `require('marked')` at runtime, so allowlisting is the correct branch. Commit d182e8e5 adds `marked` plus a comment naming that file in `tests/unit/runtime-deps-allowlist.spec.ts`. `package.json:156` keeps it in dependencies.
- Gate `npx vitest run tests/unit/runtime-deps-allowlist.spec.ts`: 3/3 passed.

## repair-validator-seed-sentinel — VERIFIED
- The live path is JSON verdicts. `validationSentinels.cjs` survives as a legacy fallback. 25fafcf5 changes `seedValidatorPersona.test.cjs` to assert the JSON contract and adds the seed hash 704173f3 (`bodySha256` 043eefdb…) to `shippedPersonaSeeds.cjs`, appended and with nothing removed.
- The body-cap assertion is retained in the test and passes.
- Gate `seedAgentPersonas` + `seedValidatorPersona`: 48/48 passed.

## repair-ephemeral-cwd-test-regressions — VERIFIED
- b459fb2c names the causing commit (7071526a) with the reason. `ephemeralCwd.cjs` `isEphemeralCwd` gains `{refuseMissingInTmp}` (default true). `opsOwnership.cjs:~318` `resolveProjectRoot` passes false.
- Existing tmpdir roots and linked worktrees are still refused (the `classifyCwd` kind check is untouched). The ephemeral and opsOwnership tests pass, 25/25.
- Gate delegationReadiness + scheduler-fix-plan-path + webRemoteDrilldown: 84/84 passed.

## repair-plan-records-retention-knob-test — VERIFIED
- `runLogRetention.cjs` is unchanged, so it still fails closed on an unreadable index (`:595` throws). 265e5deb gives the test a readable active-index fixture and asserts `epicStatus('live')`.
- Gate `opsRetentionKnobsWired.test.cjs`: 5/5 passed.

## Findings
- Critical: none.
- Important: none.
- Minor: the persona body that states the contract is `src/seed/agents/validator.md`, and it was not changed by this plan. The PRD named it, but the JSON branch only needed the test to change. Not a defect.
- Minor: the PRD files are in `prds-archived/`, so there was no missing PRD file.
