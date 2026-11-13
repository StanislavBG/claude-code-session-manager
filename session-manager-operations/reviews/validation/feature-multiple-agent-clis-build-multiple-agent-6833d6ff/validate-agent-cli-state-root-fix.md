# Validation: agent-cli-state-root-via-scheduler-paths (PRD 3028)

Base: da8977b2. Landed commit: 57d7a528 (4 files, all within the PRD's # Files).

## agent-cli-state-root-via-scheduler-paths — VERIFIED (PRD gate + ACs); `npm run lint` is still red, for an unrelated reason (see Findings)

- AC1: `schedulerPaths.cjs` adds `agentCliStateRoot()`, returning `assertNotLiveRoot(path.join(schedulerHome(), 'agent-cli'), 'agentCliStateRoot')`. It has a one-line JSDoc and is exported (diff 57d7a528).
- AC2: `agentCliSessionStore.cjs` `rootDir()` returns `SM_AGENT_CLI_STATE_DIR` when it is non-blank, else `schedulerPaths.agentCliStateRoot()`. The `os` require was dropped.
- AC3: `node scripts/check-ops-path-literals.cjs` printed `check-ops-path-literals: clean` and exited 0. `check-ops-path-literals.test.cjs` passes.
- AC4: new tests exist: `schedulerPaths.test.cjs` "agentCliStateRoot() lands under SM_SCHEDULER_HOME", and `agentCliSessionStore.test.cjs` "with SM_AGENT_CLI_STATE_DIR unset the root is under SM_SCHEDULER_HOME". The store file is also added to ROUTED_MODULES.
- AC5: the gate vitest command ran 6 files with 55 tests, all passing. It covers agentCliSessionStore, transcripts-agent-cli-path, chatRunner-agent-cli and remoteTranscriptTail-agent-cli.
- The AC "including `npm run lint` exiting 0 on the landed tree" is NOT met. `npm run lint` exits 1 at `lint:test-smells`, which is a different cause from the one this PRD fixed. `lint:paths`, `lint:page-stewards` and `lint:e2e-budget` all pass.

## Full `npm run test:unit`

1032 of 1033 files passed, with 10063 tests passing. The one red test was `epicMint.test.cjs` ("a restore of a claudeSessionId an archived Epic holds is refused…"). It passes when run alone (59/59), so I treat it as a load flake. The known flakes `scheduler-resume-recovery-saturated` and `timeoutShim` did not fail on this run.

## Review of combined diff

The diff is 28 added and 3 removed lines. The path goes through the sanctioned resolver and keeps the vitest live-root guard. The env override is unchanged. There are no secrets, no path-traversal exposure and no duplicated helper. `/code-review` and `/security-review` were not run; I self-reviewed the diff. Nothing found.

## Findings

### Important
- `src/main/lib/agent-cli/__tests__/agentCliCatalogParity.test.cjs`: `npm run lint` fails at `lint:test-smells` with "new source-text smell (fix the test; do not add it to the allowlist)". The file comes from commit 41409e6e, not from this PRD. The PRD's AC requires lint to exit 0, so this needs a follow-up fix wave. Fix the test; do not allowlist it.

### Minor
- `epicMint.test.cjs` restore-refusal test failed once in the full unit run and passed alone. Load flake. Not in the known-flake list, so worth adding.
