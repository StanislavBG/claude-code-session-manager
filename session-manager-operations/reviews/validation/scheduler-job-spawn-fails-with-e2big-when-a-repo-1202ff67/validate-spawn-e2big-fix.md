# Validation: scheduler spawn E2BIG fix

Base: 604bae39a0da6417ec4f1ba2f92c81f4661c2dfd. Commits: 5696bab4 (cap-foreign-wip), d19dff14 (child-with-log-stdin-text), ed0518e0 (scheduler-prompt-via-stdin), bc2d79f7 (classify-spawn-e2big). PRD files were in prds-archived/ (found).

## cap-foreign-wip-prompt-section — VERIFIED
- Cap by count+bytes, both branches: scheduler.cjs `limitForeignWipPaths` / `buildForeignWipSection` (FOREIGN_WIP_SECTION_MAX_BYTES = 16*1024, exported); loop stops at PRE_RUN_DIRTY_PATHS_CAP or byte budget.
- Summary line (top 5 dirs, "N elsewhere", en-US counts) in `foreignWipSummaryLine`; `+N more` marker popped and added to omittedCount.
- Delimiters first/last verbatim; empty lists return ''; validateForeignWipBlockClaim and row fields untouched (not in diff).
- New tests in scheduler-foreign-wip-manifest.test.cjs (+47 lines). Gate: 12/12 passed.

## child-with-log-stdin-text — VERIFIED
- childWithLog.cjs: `stdinText` string → stdio ['pipe', fd, fd], else 'ignore'; error listener attached before `stdin.end(text,'utf8')`, logged once via safeLog; sync-throw path unchanged (handleDone spawnFailed before stdin touched).
- claudeStub.cjs prelude `readPrompt()` with private `__fs`.
- New tests (300 KB, 2 MB early-exit, no stdinText EOF). Gate: 14/14 passed.

## scheduler-prompt-via-stdin — VERIFIED
- buildClaudeSpawnArgs no longer takes/emits prompt; argv '-p','--model',...; executeJob and spawnInvestigation pass `stdinText: prompt`; comment updated and keeps the --disallowedTools rule.
- New scheduler-large-prompt-spawn.test.cjs; lockdown/digest/resume/persona tests updated. worktree-exec-cwd and procname-claude-spawn-sites needed no edits and pass. Gate: 7 files, 76 tests passed.

## classify-spawn-e2big-as-launch-failure — VERIFIED
- launchFailure.cjs: MAX_ARG_BYTES, findOversizedArg (+NUL), isArgvTooLargeSpawnError, deriveTerminalReason case placed after completed, before exit-code cases.
- executeJob pre-spawn guard + onExit error branch set launchError; classifyFailureOutcome returns fail-launch first; spawnJob fail-launch branch sets error, spawns no investigation. The argv guard result carries `launchError` only, never `res.launchFailure`, so handleLaunchFailure (scheduler.cjs ~6247) is not reached and the per-persona breaker is not armed.
- Tests in launchFailure, transient-failure, prd-persona-spawn. Gate: 4 files, 48 tests passed.

## Combined promise
- 5,000 dirty paths → capped section ≤16 KB with summary (test); no argv element ≥128 KB (large-prompt test + investigation lockdown test); E2BIG → launch_failure:argv_too_large, no investigation, no breaker (code read above, tests).
- Full suite, SM_* unset, `timeout 900 npm run test:unit`: 827 files passed, 7770 passed / 1 skipped, exit 0. No red files.

## Findings
- Critical: none. Important: none.
- Minor: the pre-spawn guard measures only job argv; the sibling PRDs 2361-2367 (other claude -p sites) are still queued, outside this plan.
- Minor: the fail-launch row error text depends on `res.error`; rows hit via the pre-spawn guard never touch the retry counter (intended).
