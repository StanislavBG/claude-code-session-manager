# Validation: readme-precision-fixes (PRD 3287)

Base: 3e05505779ff9c4a5d663569e6b5cbf5212ffed3. Commit: 41a35b7d (README.md only, 7+/4-).

## readme-precision-fixes — VERIFIED
- Plugin install: README.md `### Plugin session-manager-dev` bash block now has `claude plugin marketplace add StanislavBG/claude-code-session-manager` + `claude plugin install session-manager-dev@session-manager`; no `<app folder>`. New line: "`/develop` and `/send-feedback` call the MCP server. So the app must be running for them."
- State paths: Facts row `Where state lives` and table row `Session worktrees` give `~/.local/state/session-manager/` or `$XDG_STATE_HOME/session-manager/`; matches `persistentWorktreeBase` (schedulerPaths.cjs:142-146; absolute-only XDG nuance not stated, see Minor).
- Env vars: `SM_WORKTREE_ROOT` row added; matches `worktreeBase` (schedulerPaths.cjs:149-151).
- Queue rule: "A headless job cannot queue PRDs, unless it runs as `architect`. A session a person is in can queue PRDs." Matches `headlessQueueRefusal` (scripts/scheduler-mcp-server.cjs:871-883) and `SM_SCHEDULER_JOB_MAY_QUEUE` (src/main/scheduler.cjs:5098).
- No other change: `git diff <base>..HEAD --stat` = README.md only; hunks limited to the four edits.
- Gate: `npm run lint:readme` exit 0; `npm run lint` exit 0 (re-run by validator).

## Review
Docs-only diff; no code, secrets, or input handling touched.

## Findings
- Critical: none.
- Important: none.
- Minor: README.md Facts/Session worktrees rows say `$XDG_STATE_HOME` is used when set, but code ignores it unless it is an absolute path (schedulerPaths.cjs:143).
- Minor: the SM_WORKTREE_ROOT row does not say a path equal to a live root is rejected (assertNotLiveRoot); negligible.
