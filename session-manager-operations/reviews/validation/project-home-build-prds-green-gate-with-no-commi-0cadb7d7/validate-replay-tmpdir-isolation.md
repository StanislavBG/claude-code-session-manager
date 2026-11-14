# Validation: replay-tests-private-tmpdir (PRD 3124)

Base: 41300c91. Commit: 52040ef2 (only `src/main/lib/git/__tests__/gitWorktree.test.cjs`, +59/-13; gitWorktree.cjs untouched).

## replay-tests-private-tmpdir — VERIFIED
- AC1: every `rpIdxDirs` caller (test file lines 2639, 2647, 2657, 2664, 2682) sits inside `withPrivateTmpdir` (def 2618; mkdtemp under original `os.tmpdir()`; sets TMPDIR/TMP/TEMP).
- AC2: the `finally` block restores each key (deletes if unset) and `rmSync`s the private folder. No `sm-test-private-tmp-*` dirs were left in /tmp after the runs.
- AC3: the decoy test (about line 2650) creates `sm-mergefile-*` in `originalTmp`, asserts `os.tmpdir()===privateTmp` and the decoy still exists, and `rpIdxDirs()` equals before. The decoy is removed in an outer `finally`.
- AC4: the cleanup assertions are unchanged in meaning (`rpIdxDirs` filter untouched).
- AC5 / gate `timeout 300 npx vitest run …/gitWorktree.test.cjs`: 154 passed, exit 0.
- Plan-specific check: I disabled the `process.env[k] = priv` line locally. The decoy test then FAILED with `expected '/tmp' to be '/tmp/sm-test-private-tmp-…'`, and the other 153 passed. I restored the file from a backup, and `git status` for it is clean. Nothing was committed from the experiment.

## Findings
- Critical: none.
- Important: none.
- Minor: with the override disabled, the decoy test fails at the `os.tmpdir()` precondition (line ~2656), not at the `rpIdxDirs` equality. It still proves the env redirect, and the equality assertion is a second guard.
- Minor: the code-review and security-review skills were not run. I self-reviewed instead: test-only change, no secrets or untrusted input, and paths come from mkdtemp.
