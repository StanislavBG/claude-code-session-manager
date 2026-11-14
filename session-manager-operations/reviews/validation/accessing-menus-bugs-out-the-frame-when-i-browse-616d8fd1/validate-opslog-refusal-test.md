# Validation: opslog-refusal-test-location-independent

Base: 4c3750cf. Commit: 4586fac4 `test(opsErrorLog): refusal test probes a cwd outside tmpdir/SM_SANDBOX_DIR` (only src/main/__tests__/opsErrorLog.test.cjs).
PRD: prds-archived/3047-opslog-refusal-test-location-independent.md

## 3047 opslog-refusal-test-location-independent — VERIFIED

- AC1 probe outside tmpdir/SM_SANDBOX_DIR: `outsideScratchProbe()` (test.cjs ~L108-116) picks a pid+time-suffixed never-created path under homedir or fs root, rejecting any inside os.tmpdir()/SM_SANDBOX_DIR (symlink-resolved via realOrResolved); the test re-asserts `isInsideRoot(probe, r) === false` for each root.
- AC2: asserts `existedAfter === false`, `reportErrorCalls === 0`, `logLineCalls === 0`; `finally` restores the require.cache stub and rmSyncs the probe if present. No probe leftovers found in ~ or /.
- AC3: `timeout 180 npx vitest run src/main/__tests__/opsErrorLog.test.cjs` → 5 passed. The test no longer references the repo root, so it is location independent by construction. Caveat: this job worktree lives under ~/.local/state, not /tmp, and I did not make a separate /tmp checkout; the main-checkout run was not repeated either.
- AC4 mutation: deleted line 193 (`if (process.env.VITEST && !isInsideTestScratch(cwd)) return;`) locally → refusal test FAILED (AssertionError, 1 failed | 4 passed). File restored from backup; `git status` shows opsErrorLog.cjs unmodified; nothing committed.
- AC5: `git diff 4c3750cf..HEAD --stat -- src/main/lib/telemetry/opsErrorLog.cjs` is empty → unchanged.
- Gate re-run: green (above).

## Combined diff review
Single test-file change (+49/-13). Self-review: no secrets, no unsafe input; the rm is confined to the pid-suffixed probe path computed in-test. Probe is created under $HOME or `/` only if the code under test wrongly writes there, and is cleaned up. `/code-review` and `/security-review` not run separately (diff is tiny, self-reviewed).

## Findings
- Critical: none
- Important: none
- Minor: the probe may fall back to the filesystem root (`/`), which is unwritable for non-root users. In that case a regression would just throw instead of writing, which is still acceptable. test.cjs ~L108.
