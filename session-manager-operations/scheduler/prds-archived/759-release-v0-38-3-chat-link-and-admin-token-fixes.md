---
title: Release v0.38.3: publish npm package with PRD 757/758 fixes (missed by v0.38.2)
cwd: ~/Projects/session-manager
estimateMinutes: 15
---
# Goal

PRD 756 already published v0.38.2 (npm, confirmed 2026-07-29T04:30:11Z) covering PRDs 753/754/755, but PRDs 757 (chat file-link false-positive/wrong-cwd fix, commit f9b4b7c) and 758 (admin/browser-agent token file scoping fix, commit b1547b0) both landed AFTER that publish and were never released. Bump and publish a v0.38.3 patch release so `npx claude-code-session-manager@latest` actually includes all six PRDs' fixes (753-758).

# Acceptance criteria

- [ ] Verify via `git log --oneline -10` that commits f9b4b7c (PRD 757) and b1547b0 (PRD 758) are present on the current branch AND that package.json's version is still 0.38.2 (i.e. not already bumped/published for these two) — if either commit is missing, or if `npm view claude-code-session-manager version` already shows something newer than 0.38.2, STOP and exit via the finish protocol with SCHEDULER_VERDICT: FAIL and a one-line reason (don't publish a duplicate or partial release).
- [ ] Bump package.json's version from 0.38.2 to 0.38.3 (patch release, bugfix-only — no breaking changes, matches this repo's existing semver-patch convention for consecutive small fixes).
- [ ] Run `npm run typecheck` and `npm run test:unit` (vitest) and confirm both pass before proceeding — do not publish on red checks.
- [ ] Commit the version bump with message `chore(release): bump to v0.38.3` (matching the exact convention of prior release commits, e.g. dd94511 "bump to v0.38.2") and push to the current branch's remote tracking branch.
- [ ] Run `npm publish` from the repo root (prepublishOnly already runs `vite build` automatically per package.json). Confirm the published version via `npm view claude-code-session-manager version` equals 0.38.3 after publish.
- [ ] Verify npm auth is available before attempting publish (`npm whoami` should already resolve to the account used for prior releases on this machine — if it does not, or `npm publish` fails with an auth/OTP error, STOP and exit via the finish protocol with SCHEDULER_VERDICT: FAIL and the exact error, do not attempt workarounds or retries beyond one clean retry of the same command).

# Implementation notes

This PRD is release mechanics only, identical pattern to PRD 756 (check `~/.claude/session-manager/scheduled-plans/prds-archived/` for `756-release-v0-38-2-prompt-queue-fixes.md` if it's been archived — read it for the exact convention this repo already used successfully). Read package.json first (version field, prepublishOnly script) and CLAUDE.md's "Distribution" section. The only difference from 756 is the version number (0.38.3 not 0.38.2) and the PRDs being released (757/758, already landed, vs. 753/754/755 which 756 covered).

# Out of scope

- Any code changes — this PRD only bumps version, verifies, commits, and publishes
- Re-publishing 753/754/755's changes — those are already live in 0.38.2

## Engineering standards

Before writing any code, read `/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
