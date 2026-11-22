# Validation: headless-runs-deny-secrets

Base: d58913ddee662e64f88eb537677da98f9a6f4b5c. Commits: 60eb84a6 (tasks), cbcef7b1 (aux), 251c5f9f (doc).
Code review/security review: self-reviewed (diff is small; no new input handling, paths come from os.homedir()/process.cwd()).

## task-runs-deny-secrets — VERIFIED
- Skip-permissions pushes `policy.argv, ...headlessPermissionArgs()` from `buildJobSandboxSettings({agentType:'task',...deps:{available:false}})`: taskRun.cjs:64-73. `--settings` is outside the variadic block (comment :67).
- No flag set: args unchanged, no `--settings`: taskRun.test.cjs "no dangerouslySkipPermissions" test asserts exact array.
- deny includes `Read(//<home>/.npmrc)` and `Edit(//<home>/.ssh/**)`: taskRun.test.cjs "tool-rules level denies home secrets".
- taskAdminRoutes.test.cjs and jobSandboxPolicy.test.cjs: zero diff since base; green.
- Gate: vitest (7 files, 84 tests) exit 0; `npm run typecheck` exit 0.

## aux-runs-deny-secrets — VERIFIED
- runClaudeP.cjs:34-41, docEdit.cjs:99-106, supervisor.cjs:251-261: `buildJobSandboxSettings({agentType:'aux', root=process.cwd(), ...})`, `...sandbox.argv` before `headlessPermissionArgs()`. No bare `--dangerously-skip-permissions` remains (grep clean in all four files).
- Exactly one skip flag and one `--settings`, deny has `Read(//home/.npmrc)`: runClaudeP.test.cjs new test (stub spawn captures argv).
- Variadics: in all three, `--settings` follows `--model <v>` / `--max-budget-usd <v>`; `--allowedTools Bash` comes after (supervisor.cjs:262). No variadic directly before `--settings`.
- oneShotNoMcp, modelCatalog, supervisor-probe-stdin tests unmodified and green.

## headless-runs-deny-secrets-doc — VERIFIED
- scheduler-operations.md section 11 gains "Coverage — every headless `claude` spawn" (only an insertion, diff +17 lines, no other section changed).
- Levels match code: SANDBOX_PROFILES has validator and dev-lead only (jobSandboxPolicy.cjs:50-52); scheduler.cjs:5745 (jobs) and :6444 (investigation) call the policy; Tasks/aux as above; interactive chats listed as not covered.
- Note that tool-rules blocks Read/Write/Edit and plain `cat` but not python3 interpreters, only os-sandbox contains Bash: present.
- Gate: `npm run lint:docs` ok.

## Findings
- Critical: none. Important: none.
- Minor: taskRun.cjs:68 roots the policy at `path.resolve(base)` rather than raw `base` as the PRD wrote; harmless (absolute-izes only).
- Minor: the Tasks coverage sentence ("without the flag no policy is added") goes beyond the PRD text but is accurate (taskRun.test.cjs).
