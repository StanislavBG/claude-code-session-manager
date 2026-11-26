# Validation — sandbox-limits repair wave (4706, 4707)

Base: none given in the PRD; used `git log -30 -- <Files>`. Commits: 65b7bc08 (4706), 867abe1d (4707). No `Follow-up:` trailers.

## 4706-repair-sandbox-limit-detect-decoded-errors — VERIFIED

- ac-1: `sandboxEnvironmentLimit.cjs:49-84` `sandboxLimitFromStreamJson` splits lines, skips non-JSON, tracks Bash `tool_use` ids, decodes string/array `tool_result` content, runs `detectPerLine`; final `result` via reused `runVerify.cjs:347 scanSentinelReason`. Vitest 20/20 pass.
- ac-2: tests at `__tests__/sandboxEnvironmentLimit.test.cjs:35-60`. Independent probe: full shipped "Job sandbox limits" section and whole PRD_AUTHORING.md inside a Read tool_result → null; Bash is_error `PermissionError: [Errno 1] Operation not permitted: socket(AF_UNIX)` → unix-socket; `/tmp` Read-only → readonly-tmp; result `SCHEDULER_VERDICT: FAIL sandbox blocks writes under .claude/skills…` → claude-dir-write; PASS result quoting the strings → null.
- ac-3: `scheduler.cjs:6998` calls `sandboxLimitFromStreamJson(readTail(logPath,16384))`; `scheduler.cjs:9579` uses `environmentLimitStamp`.
- ac-4: `scheduler-transient-failure.test.cjs:151-158` — fail-environment beats networkError retry; absent → investigate. Pass.
- ac-5: `npm run typecheck` exit 0.

## 4707-repair-sandbox-limits-minor-wave — VERIFIED

- ac-1: `PRD_AUTHORING.md:159` "jobs under the OS sandbox (dev-lead, validator, any `osSandboxRequired` environment) must not depend on…"; matches `LEGACY_PERSONA_ENVIRONMENTS` (`jobSandboxPolicy.test.cjs:52`). Stamp `v33` line 1; seed test passes.
- ac-2: `prdSandboxWarnings.cjs:8` `rm(?=$|[\s.,;:)\`'"])`; tests add 'remove it with rm', 'use rm.', 'use rm, then', 'rm' and negatives 'perform', 'rmdir'. 24/24 pass.
- ac-3: `prdSandboxWarnings.test.cjs:9-13` evicts config.cjs from require cache in afterAll (same as 03866661; addAllowedRoot is in-memory only, `config.cjs:78`); temp dir removed in `finally` (`:69-71`).

Gates: 4706 vitest 20/20 + typecheck 0; 4707 vitest 24/24 + lint:docs ok + typecheck 0.

## Findings

### Important
- `src/main/lib/scheduler/sandboxEnvironmentLimit.cjs:66` — any Bash tool_result is scanned, `is_error` is ignored. Probe: a successful Bash `cat`/`grep` of the shipped Job sandbox limits section → `unix-socket`. The PRD Goal says "decoded **error** tool_result content"; a job that greps the doc near the end of its run and then fails for a code bug is still stamped fail-environment and skips auto-fix (the original defect class, via Bash instead of Read). ac-1 wording ("decoded Bash tool_result content") is met. (spec-gap)

### Minor
- `sandboxEnvironmentLimit.cjs:80-82` — only `ev.result` text is passed to `scanSentinelReason`; a `structured_output.failReason` (validator-style StructuredOutput runs) is not mapped, so a structured FAIL reason naming the sandbox is never classified (probe → null). (behavior-wrong)
- `sandboxEnvironmentLimit.cjs:13` (pre-existing, 4699) — real bwrap refusals like `mv: … '.claude/skills/b': Operation not permitted` lack the word "sandbox", so claude-dir-write only fires via the FAIL reason. (other)
- `sandboxEnvironmentLimit.cjs:54` — a Bash tool_use earlier than the 16 KB tail drops its tool_result (false negative; safe direction). (other)
- `runVerify.cjs:348` reuse also matches `SCHEDULER_VERDICT: NEEDS_HUMAN` reasons — harmless, undocumented. (other)
- `prdSandboxWarnings.test.cjs:48-69` — body inside the new `try` is not re-indented. (other)
- No http result for this plan; both PRDs are pure helpers/docs, so a live http criterion is not applicable.
