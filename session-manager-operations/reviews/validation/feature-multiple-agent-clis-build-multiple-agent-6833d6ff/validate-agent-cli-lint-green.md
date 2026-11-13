# Validation: agent-cli lint green (fix wave)

Base: 03b01cff (known). Commit in range: abf228a0 (test(agent-cli): replace source-text catalog parity test with cross-boundary spec).

## agent-cli-catalog-parity-cross-boundary — VERIFIED
- Old test deleted: `ls src/main/lib/agent-cli/__tests__/agentCliCatalogParity.test.cjs` → No such file (abf228a0 shows D).
- New spec tests/unit/agentCliCatalog-crossBoundary.spec.ts:10-16 imports AGENT_CLI_LABELS/agentCliLabel and loads AGENT_CLI_CATALOG via createRequire; :19-22 deep-equal; :25-27 undefined/'claude' null, 'codex' 'Codex'. No readFileSync/readFile.
- Header comment src/renderer/lib/agentCliCatalog.ts:5 names the spec; diff is that one line only.
- allowlist untouched (not in diff); `smells --check: OK` in lint output.
- Gate: `npx vitest run tests/unit/agentCliCatalog-crossBoundary.spec.ts` → 2 passed. `npm run lint` → exit 0.

## agent-cli-state-root-via-scheduler-paths — VERIFIED (re-check)
- schedulerPaths.cjs:126-127 agentCliStateRoot() = assertNotLiveRoot(path.join(schedulerHome(),'agent-cli'),…) with JSDoc; exported at :217.
- agentCliSessionStore.cjs:21-24 rootDir() uses SM_AGENT_CLI_STATE_DIR when non-blank else schedulerPaths.agentCliStateRoot(); no os usage remains.
- `node scripts/check-ops-path-literals.cjs` → clean, exit 0.
- Tests: schedulerPaths.test.cjs:76-78; agentCliSessionStore.test.cjs:46 (unset env → under SM_SCHEDULER_HOME).
- Gate vitest (6 files: path-literals, schedulerPaths, sessionStore, transcripts-agent-cli-path, chatRunner-agent-cli, remoteTranscriptTail-agent-cli) → 55 passed.
- `npm run lint` now exits 0 (the sole prior REFUTED reason is resolved).

## Full suite
`npm run test:unit` → exit 0; 1033 files passed, 10065 tests passed, 1 skipped. No flakes seen.

## Combined diff review
abf228a0 only: 3 files (+30/−30). Self-review: no secrets, no path handling, no file reads; spec reuses the established createRequire pattern. Note: worktree shows project-pages/*.html as deleted — foreign WIP, unrelated.

## Findings
- Critical: none
- Important: none
- Minor: none
