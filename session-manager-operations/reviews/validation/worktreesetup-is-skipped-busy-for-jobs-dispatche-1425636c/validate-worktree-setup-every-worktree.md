# Validation: worktreeSetup skipped 'busy' / outcome never recorded

Base: be604cff94adf0e9aa9f80fd802b00857cda85c1 (known). Commits 63d40657, 6e39355c, bc629f75, bf4c59de, 4355a9cc, 371260f8, 4d3d8671, 8e38099a.
All SM_* env unset. Every PRD `# Gate` re-run in the foreground: all exit 0.

## isolated-gate-sequence-runner — VERIFIED
- definitionOfDone.cjs: `runIsolatedSequence` exported; `runGateSequence` sets/clears `gateInFlight` in try/finally and delegates; runIsolatedSequence never touches the flag.
- isolatedSequence.test.cjs (concurrent, vs in-flight gate both ways, CI/TMPDIR, exit-3) + scheduler-gate-shadow + dod-reverify: 3 files / 49 tests pass; `lint:test-smells` OK.
## worktree-setup-per-project-runner-and-outcome — VERIFIED
- worktreeSetup.cjs: per-project `setupChains` keyed on `path.resolve(mainCwd||worktreeCwd)`, later call waits (never skipped), runs via runIsolatedSequence; outcome `{ran,ok,reason,waitedMs,ms,commands}`; never throws.
- worktreeSetup.test.cjs L99 (second waits, starts after first), L113 (different projects overlap), L124 (setup during gate runs; gate during setup not busy) pass. worktreeDeps/gitWorktree/jobWorktree: 4 files / 151 tests pass.
## worktree-setup-log-lines-and-settled-check — VERIFIED
- worktreeSetup.cjs `formatSetupOutcome` (500-char clip, silent for no-config/in-place, no command output) and `isSetupSettled` (ok or no-config/not-declared/opt-out); worktreeSetup.test.cjs L142-180 pass.
## worktree-result-carries-setup-outcome — VERIFIED
- gitWorktree.cjs createWorktree result includes `setup` (also on disabled/error paths); worktreeDeps.cjs passes mainCwd and returns `setup`; gitWorktree.test.cjs added cases pass.
## spawnjob-cleans-preflight-worktree-on-early-return — VERIFIED
- scheduler.cjs `releasePreflightWorktree` called on the launch-gate and `dispatchSkippedAlreadyCompleted` early returns; scheduler-deferral-worktree-cleanup + cap-defer + launch-failure pass.
## run-log-and-meta-record-worktree-setup — VERIFIED
- scheduler.cjs executeJob takes `worktreeSetup`, writes `formatWorktreeSetupOutcome` lines atop the run log, spreads `setupMeta` into every meta.json write and prdArchivedSkipResult; in-place jobs pass reason 'in-place'. scheduler-worktree-setup-record, exec-cwd, launch-failure, prd-missing-skip, inplace-salvage pass (10 files / 36 tests with the group below).
## baseline-scratch-records-setup-outcome — VERIFIED
- scheduler.cjs: baseline scratch uses `linkDependencyDirs(...).setup`; unsettled -> `base-setup-<reason>` unavailable (gate not run); `gateShadow.baseline.setup` recorded and memoized. scheduler-baseline-setup, gate-shadow, baselineGateWiring pass.
## doc-worktree-setup-cwd-and-outcome — VERIFIED
- PRD_AUTHORING.md v13 §7 states cwd = worktree root, serialized/never skipped, run-log + meta.json outcome; scheduler-operations.md updated (setup, `base-setup-<reason>`, meta.json). develop-skill-planning-rules passes; `lint:docs` ok.

## Plan-level criterion — VERIFIED
Two same-project runWorktreeSetup calls serialize and both run (worktreeSetup.test.cjs L99; no 'gate runner busy' string remains in worktreeSetup.cjs). Setup during in-flight runGateSequence runs and gate during setup is not busy (L124; isolatedSequence.test.cjs).

## Full unit suite (`npm run test:unit`, once)
816 files passed, 1 failed; 7678 tests passed. No persona-estimate ReferenceError failures (PRD 2240 present: dfd0f7fc).

## Findings
### Critical
- none
### Important
- none
### Minor
- `src/main/__tests__/historyFinalizeResume.test.cjs:80` red in full suite (`lastDir` '-a' vs expected '-b'). Outside this plan (history resumable finalize cursor, commit 513c95df/related); report to its owner, not a refute. May be order/timing flaky.
- worktree-setup serialization means a hung setup blocks later same-project setups until the command timeout; bounded by each command's timeout, acceptable.
- Security/code self-review (skill not run separately): setup commands come from a tracked repo config validated by `validateGate`; outputs clipped to 1000 chars; no new path-traversal or secret handling.
