# Validation: validate-prd-api-followups

Base 15e3203b6a32cf80ea8c5c49afd9553744e8a589, HEAD 2f6b5e09. Commits: f11936fe, 771d4382, f3103dc5, 2f6b5e09. SM_* unset for all runs. `/code-review` and `/security-review` not run; self-reviewed (no new input-handling surface beyond the persona-name regex in prdAgentType.cjs, which is safe).

## persona-default-estimate-minutes — REFUTED
- Schema accepts int 1..60: agentPersonaSchema.cjs:61 (OK).
- resolvePersonaDefaultEstimate exported, uses resolvePersonaPaths, project then global, never throws: prdAgentType.cjs:82-106 (OK).
- scheduler.cjs:4612-4613 calls `resolvePersonaDefaultEstimate(...)` and `DEFAULT_PRD_AGENT_TYPE` but **neither is imported** in scheduler.cjs (`grep prdAgentType src/main/scheduler.cjs` finds no require). At runtime `executeJob` throws `ReferenceError: resolvePersonaDefaultEstimate is not defined` (reproduced in scheduler-prd-persona-spawn.test.cjs). Every job spawn would fail.
- personaDefaultEstimate.test.cjs present (59 lines); it tests the resolver only, so it misses the wiring break.
- Gate (4 files, 37 tests): green — but the gate does not exercise executeJob.

## develop-skill-document-new-prd-apis — VERIFIED
- SKILL.md:123-127 step 11 batch `scheduler_create_prds`, fallback to single; validate-PRD section scopes the dependsOn rule to single creates (diff @ ~231).
- Step 12 and Phase 2 case 2 use validated gate/files/acceptanceCriteria fields; "does not check them"/"copy the # Gate" grep: clean.
- Files rule 3 in SKILL.md:195 and PRD_AUTHORING.md:109 match.
- Failure mode (c) mentions `applied` and bare slug; estimateMinutes row and §5 item 3 mention defaultEstimateMinutes.
- PRD_AUTHORING.md Worktree reach adds worktreeSetup sentence; version bumped v11→v12.
- develop-skill-planning-rules.test.cjs +13 lines. Gate (3 files, 15 tests): green.

## scheduler-tool-descriptions-new-apis — VERIFIED
- mcpToolCatalog.cjs:110-112 wording present; scheduler-mcp-server.cjs:168,181 files + estimateMinutes descriptions present.
- mcpToolCatalog.test.cjs +12 asserts wording. Gate (3 files, 105 tests): green.

## telemetry-wire-contract-seeds — VERIFIED
- telemetryClient.test.cjs:630-635, 949-954 include 'seeds'; comment present; seeds null/enum check at ~1062. `git diff` of src/main/lib/telemetry is empty (client unchanged).
- Gate (2 files, 51 tests): green.

## Full unit suite — RED
`timeout 600 npx vitest run` (SM_* unset): 15 files failed, 27 tests failed, 7598 passed. All failing files are scheduler tests that load scheduler.cjs (e.g. scheduler-prd-persona-spawn, scheduler-epic-digest, scheduler-inplace-salvage, scheduler-launch-failure, scheduler-worktree-cap-defer, scheduler-worktree-exec-cwd, scheduler-gate-shadow, scheduler-bash-timeout-env, scheduler-quiet-machine-lease, scheduler-rate-limit-spin-guard, scheduler-shard-quarantine, scheduler-supervisor-record, scheduler-prd-missing-skip, procname-claude-spawn-sites). Confirmed cause for scheduler-prd-persona-spawn: the ReferenceError above. Others plausibly share it. Also failing: prdBodyPatch.test.cjs:64 (issuedAt millisecond mismatch — looks like a pre-existing timing flake, unrelated).

## Findings
### Critical
- src/main/scheduler.cjs:4613 uses `resolvePersonaDefaultEstimate` and `DEFAULT_PRD_AGENT_TYPE` without requiring `./lib/prd/prdAgentType.cjs`. executeJob throws ReferenceError on every spawn. Fix: add the require.
### Important
- The 14 scheduler test files listed above are red at HEAD (full-suite criterion); the per-PRD gate missed it for the same reason as the telemetry break.
### Minor
- src/main/lib/mcpToolCatalog.cjs:110 "; The scheduler" has a stray capital after a semicolon.
- prdBodyPatch.test.cjs:64 flaky on ms-resolution timestamp.
