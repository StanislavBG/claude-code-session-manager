# Validation: ghost running rows plan (PRDs 2329–2332)

Base: eb59efe5bd425fdf216a54a2831cf365d62606f0. Commits: ff02cde2 (2329), 03f42a42 (2330), eeb59df3 (2331), 6cdc1db1 (2332).
Gate re-run: `vitest run reaperHelpers / scheduler-boot-orphans / procname-claude-spawn-sites / scheduler-heartbeat-payload` → 4 files, 117 tests pass; `npm run typecheck` exit 0; `jobWorktreeBootLive.test.cjs` 6/6 pass.
Review: `/code-review` and `/security-review` not run; self-reviewed the diff.

## reaper-strict-claude-identity — VERIFIED
- `isClaudeArgv`: reaperHelpers.cjs:25-38 (basename 'claude' / 'sm-claude-*'; node|bun with argv[1] claude path or /@anthropic-ai/claude-code/); exported at :527. The table test in reaperHelpers.test.cjs passes.
- `claudePidAlive`: :56-65 uses `readArgv` + `isClaudeArgv`; an unreadable cmdline returns true, win32 returns true.
- `findLiveProcessForJob`: :80-111 requires `isClaudeArgv`, then a worktreeDir cwd match or argv[0] === smArgv0('job', slug). No runCwd branch. `grep runCwd` in scheduler.cjs has no hits; both callers (scheduler.cjs ~7958, ~10250) dropped it.
- `killOrphanClaudePid`: scheduler.cjs:1374-1384 uses argv + `isClaudeArgv` (ps fallback split on whitespace) and returns 'mismatch' otherwise.
- Tests: updated reaperHelpers.test.cjs (+103 lines), passing.

## pidless-recovery-guards — VERIFIED
- `selectReapableJobs`: reaperHelpers.cjs:445 calls findLiveProcess only when `Number.isFinite(logMtimeMs)`; otherwise the row is reaped.
- Duplicate pid: :403-409 seeds `claimedPids` from the running rows' runtime.pid; :447-457 warns "pid N not recovered for X — already claimed by Y" (names both slugs and the pid) and reaps. The pid is added to the map on recovery.
- `isBootRowAlive` / `partitionBootOrphans`: scheduler.cjs:2832-2835 seeds `claimedPids`; :2870-2875 requires a run log, rejects a claimed pid, and adds an adopted pid.
- Tests: scheduler-boot-orphans.test.cjs (+25 lines) and reaperHelpers.test.cjs pass.

## heartbeat-hold-detail — VERIFIED
- scheduler.cjs:978 `lastTickDetail` = prefix-stripped detail `.slice(0,200)`, or null. `stripTickDetailPrefix` at :2308-2314 is shared with `forceTickOutcome` (:7569).
- scheduler-heartbeat-payload.test.cjs (+14 lines): the key-set assertion and the quiet-machine detail test pass.
- Minor: the AC says the strip uses the same regex as forceTickOutcome. The heartbeat uses `keepWord: true`, which strips only `[scheduler] `. The AC's own test requires the result to start with 'quiet-machine: lease held', so the landed shape is the intended one.

## doc-ghost-running-row-runbook — VERIFIED
- scheduler-operations.md section 7 table has both rows (lines ~262-263) with the required symptom, distinguisher and remedy. They match the landed behavior (claude argv[0], run log required, no double adoption; `lastTickDetail` exists).
- Section 5 (~line 222) has a paragraph describing pidless recovery with no cwd match. No `runCwd` text remains.
- Length: 36,801 chars against 35,756 before, a growth of 1,045 (under the 1,500 limit).

## Full unit suite
`timeout 600 npm run test:unit` (SM_* unset): 824 files passed, 1 failed; 7720 tests passed, 1 failed.

## Findings
### Important
- `tests/unit/chatRunner.spec.ts:943` "cancel then immediate re-run of the same sessionId waits for the slow exit, then starts with --resume" fails reproducibly (`spawned` length 1, expected 2). It failed in the full run and on 2 isolated re-runs. It is outside these 4 PRDs. `src/main/chatRunner.cjs` changed in the base..HEAD range (14+/7−), likely from the epic turn-1 isolation plan (e7853de7 / c42adad7). Needs an owner.
### Minor
- heartbeat `lastTickDetail` keeps the `<word>:` prefix, unlike the AC wording (see above).
- The `/code-review` and `/security-review` skills were not run. The self-review of the diff found no unsafe input handling: `ps -p ${pid}` interpolates a numeric pid only, and `/proc` paths are built from validated numeric names.
