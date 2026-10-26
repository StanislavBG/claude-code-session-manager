# Validation: claude prompts off argv

Base: 604bae39a0da6417ec4f1ba2f92c81f4661c2dfd. Commits b338386e, 5e23c0c2, 1b40e808, b87128ca (+ merges).

## claude-stdin-feed-helper — VERIFIED
- `src/main/lib/process/childStdin.cjs`: error listener attached first, logs once, `stdin.end(text,'utf8')`, returns true; false when child/stdin missing.
- `childWithLog.cjs:324` calls `feedChildStdin(child, stdinText, { log: safeLog })`; old tests unchanged and pass.
- `scripts/lib-layout.json:12` has `"childStdin": "process"`.
- `__tests__/childStdin.test.cjs` exists (300 KB byte-exact, EPIPE, no-stdin cases).
- Gate (childStdin + childWithLog tests): 2 files, 17 tests pass.

## chat-runner-prompt-via-stdin — VERIFIED
- `chatRunner.cjs:631` `'-p'` is followed by `'--model'`; `fullPrompt` is no longer in buildArgs.
- stdio `['pipe','pipe','pipe']`; `feedChildStdin(thisChild, fullPrompt, …)` runs inside `startAttempt`, so it covers both attempts. Comment rewritten.
- `tests/unit/chatRunner.spec.ts` was updated, and the 300 KB test was added.
- Gate (4 files): 59 tests pass.

## run-claude-p-and-doc-edit-prompt-via-stdin — VERIFIED
- `runClaudeP.cjs:33` and `docEdit.cjs:98` have `-p` then `--model`. Both spawn with a stdin pipe and call `feedChildStdin` right after spawn. Header and inline comments rewritten.
- `runClaudeP.test.cjs` added; `docEdit.test.cjs` extended (`runClaude` newly exported).
- Gate (2 files): 24 tests pass.

## classify-and-supervisor-prompt-via-stdin — VERIFIED
- `classifyPromptTicket.cjs:66-88`: prompt built once, `-p` has no prompt after it, stdin is a pipe and is fed. A child without stdin returns false from `feedChildStdin`, so nothing throws.
- `supervisor.cjs:251-262`: `-p` is followed by `--model`; `--allowedTools`, `Bash` are still last. `runProbe` is exported.
- `supervisor-probe-stdin.test.cjs` added; classify test updated.
- Gate (3 files): 12 tests pass.

## Combined promise
- `grep` over `src/main/**/*.cjs` (non-test) for `-p` spawn argv: chatRunner:631, classifyPromptTicket:68, supervisor:251, docEdit:98, runClaudeP:33, scheduler.cjs:4220 and :5350 (stdinText) — every one is followed by a flag. The other `-p` hits are ps/pstree/git/systemd, not claude.
- Every site closes stdin after writing, through `feedChildStdin` (`stdin.end`) or `withChildAndLog` stdinText (childWithLog.cjs:315-324).
- Full unit suite with all SM_* unset (`timeout 900 npm run test:unit`): 831 files pass, 7783 tests pass, 1 skipped. No reds, so no base comparison was needed.

## Findings
- Critical: none.
- Important: none.
- Minor: none. The /code-review and /security-review skills were not run as separate passes; I read the diff by hand. It has no secrets, path handling or injection surface, and it reuses the one helper rather than duplicating it.
