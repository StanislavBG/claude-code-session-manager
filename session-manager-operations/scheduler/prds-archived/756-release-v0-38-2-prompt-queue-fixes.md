---
title: Release v0.38.2: publish npm package with prompt-queue fixes (PRDs 753/754/755)
cwd: ~/Projects/session-manager
estimateMinutes: 15
---
# Goal

Cut and publish a new npm release once PRDs 753 (external prompt-enqueue plumbing), 754 (scheduler-completion notify hook), and 755 (unlock the chat input so the queue is actually reachable + always-visible queue panel) have all landed on main, so `npx claude-code-session-manager@latest` picks up all three fixes together. This mirrors the existing release convention already used in this repo's git history (see `git log --oneline | grep 'chore(release)'` — e.g. 5e13e8c "bump to v0.38.1", 2091769 "bump to v0.38.0").

# Acceptance criteria

- [ ] Before doing anything else, verify PRDs 753, 754, and 755 are all present in `git log` on the current branch (i.e. their commits actually landed) — check via `git log --oneline -20` for commit messages/PRD references matching those three slugs. If any of the three has NOT landed yet (still pending/running/failed in ~/.claude/session-manager/scheduled-plans/queue.json), STOP and exit via the finish protocol with SCHEDULER_VERDICT: FAIL and a one-line reason naming which PRD(s) are missing — do not publish a partial release.
- [ ] Bump the version in package.json (currently 0.38.1) to the next patch version (0.38.2) following this repo's existing semver-patch convention for bugfix-only releases (no breaking changes, no new user-facing feature surface beyond what 753/754/755 shipped).
- [ ] Run `npm run typecheck` and `npm run test:unit` (vitest) and confirm both pass before proceeding — do not publish on red checks.
- [ ] Commit the version bump with message `chore(release): bump to v0.38.2` (matching the exact convention of prior release commits, e.g. 5e13e8c, 2091769) and push to the current branch's remote tracking branch.
- [ ] Run `npm publish` from the repo root (prepublishOnly already runs `vite build` automatically per package.json). Confirm the published version via `npm view claude-code-session-manager version` equals 0.38.2 after publish.
- [ ] Verify npm auth is available before attempting publish (`npm whoami` should already resolve to the account used for prior releases on this machine — if it does not, or `npm publish` fails with an auth/OTP error, STOP and exit via the finish protocol with SCHEDULER_VERDICT: FAIL and the exact error, do not attempt workarounds or retries beyond one clean retry of the same command.

# Implementation notes

This PRD is release mechanics only, not feature work. Read package.json first (version field, prepublishOnly script) and CLAUDE.md's "Distribution" section (documents `npm publish` running `vite build` via prepublishOnly, tag `latest`). Check `~/.claude/session-manager/scheduled-plans/queue.json` for the live status of jobs `753-external-prompt-enqueue-main-process-ipc-push-into-a-tab-s-c`, `754-scheduler-prd-completion-hook-auto-enqueue-status-prompt-int`, and `755-fix-unreachable-prompt-queue-unlock-input-while-running-trac` before doing any work — this PRD must not run (and should self-fail cleanly per the AC above) until all three show `status: completed`. As of authoring time, 753 is completed, 754 was reset to pending after an earlier failed run (an MCP-consent-gate stall, not a code defect — no action needed here beyond waiting for it to complete), and 755 is pending. Because the scheduler processes PRDs roughly in NN order but 30-minute-window/concurrency-cap timing is not strictly guaranteed, this PRD's own AC gate (first bullet) is the real enforcement mechanism, not the NN number alone.

# Out of scope

- Any code changes — this PRD only bumps version, verifies, commits, and publishes
- Updating CHANGELOG or release notes beyond the standard chore(release) commit message, unless this repo already has a CHANGELOG.md convention (check first; if none exists, don't create one)
- Retrying npm publish more than once on auth failure — escalate via FAIL instead of looping

## Engineering standards

Before writing any code, read `/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
