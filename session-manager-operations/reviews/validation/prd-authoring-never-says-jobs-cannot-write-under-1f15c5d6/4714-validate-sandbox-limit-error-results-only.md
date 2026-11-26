# Validation: 4713-repair-sandbox-limit-error-results-only

Base: unknown (no `Base:` line in PRD 4714); judged commit `18b90c7f` against `18b90c7f^`. Commit touches exactly the 4 files in the PRD's # Files; no `Follow-up:` trailers.

## 4713-repair-sandbox-limit-error-results-only — VERIFIED

- ac-1: `sandboxEnvironmentLimit.cjs:74` `if (hit || item.is_error !== true) continue;`. Probe (node -e, shipped `### Job sandbox limits` section, 995 chars): Bash is_error:false → null; is_error absent → null; Read tool_result → null (also with is_error:true → null); is_error Bash `socket(AF_UNIX, SOCK_STREAM): Operation not permitted` → unix-socket. Test at `__tests__/sandboxEnvironmentLimit.test.cjs:62-70`.
- ac-2: `sandboxEnvironmentLimit.cjs:61-66` reads `ev.structured_output ?? ev.structuredOutput` and passes it as `structuredOutput` (`:85-88`), matching `runVerify.cjs:150-151`. Probe: result event with either key, `{schedulerVerdict:'FAIL', failReason:'the job sandbox refused mv into .claude/skills/x'}` → claude-dir-write; PASS with same text → null. Test `:71-77`.
- ac-3: `sandboxEnvironmentLimit.cjs:13` new alternatives. Probe: is_error `mv: cannot move 'a' to '.claude/skills/b': Operation not permitted` → claude-dir-write; `Bash writes under .claude/ are refused` → null; `cat: x: Permission denied` → null. Test `:78-83`.
- ac-4: `runVerify.cjs:343-347` JSDoc names NEEDS_HUMAN; `git show -w 18b90c7f -- src/main/lib/prd` is empty (whitespace-only re-indent).
- ac-5: `npm run typecheck` exit 0.

Gate: `npx vitest run sandboxEnvironmentLimit.test.cjs prdSandboxWarnings.test.cjs scheduler-transient-failure.test.cjs` → 3 files, 41 tests passed; `npm run typecheck` → exit 0.

## Findings

### Critical
- none

### Important
- none

### Minor
- `src/main/lib/scheduler/sandboxEnvironmentLimit.cjs:36-43` — detection is per physical line, so a real Python traceback (`s = socket.socket(socket.AF_UNIX)` on one line, `PermissionError: [Errno 1] Operation not permitted` on the next) in an is_error Bash result returns null. The ac-1 test uses a synthetic single line `PermissionError: … on socket(AF_UNIX)` that real Python does not print. Pre-existing scope from 4706, not a regression.
- `src/main/lib/scheduler/sandboxEnvironmentLimit.cjs:74` — an is_error Bash whose output echoes the doc (e.g. `grep -r AF_UNIX … ; exit 1`, or the full section) still classifies; with the full section, `claude-dir-write` (pattern order, line "Why: the CLI sandbox protects `.claude/`") wins over unix-socket. Residual false-positive surface, much smaller than before.
- PRD 4714 has no `Base:` line; base inferred from the single landed commit.
