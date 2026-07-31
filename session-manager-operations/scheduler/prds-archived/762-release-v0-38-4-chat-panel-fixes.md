---
title: Release v0.38.4: publish npm package with PRD 760/761 chat-panel fixes
cwd: ~/Projects/session-manager
estimateMinutes: 15
---
# Goal

PRD 759 published v0.38.3 (npm, confirmed via `npm view claude-code-session-manager version` = 0.38.3), but PRDs 760 (commit 5e8854a, merge ChatSessionRail + QueueTicketPanel into one right-hand panel) and 761 (commit dd07985, fix the Prompt Queue panel's scroll-jump with a stick-to-bottom guard) both landed AFTER that publish and were never released. Bump package.json to 0.38.4 and publish a patch release so `npx claude-code-session-manager@latest` includes both fixes.

# Acceptance criteria

- [ ] package.json `version` field is bumped from 0.38.3 to 0.38.4.
- [ ] A release commit is made with an appropriate message (follow the style of prior release commits, e.g. `git log --oneline | grep 'chore(release)'` for the pattern — e.g. `chore(release): bump to v0.38.4`).
- [ ] `npm publish` completes successfully and tags the release `latest` (per this repo's CLAUDE.md Distribution section: `npm publish` runs `vite build` via `prepublishOnly`).
- [ ] Verify the publish landed: `npm view claude-code-session-manager version` (bounded, e.g. `timeout 30 npm view claude-code-session-manager version`) reports `0.38.4`.
- [ ] `timeout 300 npm run typecheck` passes before publishing (don't publish on a red gate).

# Implementation notes

Follow the exact same pattern as PRD 759 (759-release-v0-38-3-chat-link-and-admin-token-fixes.md, already completed — read it for the release commit message style and publish sequence used last time). This repo publishes as `claude-code-session-manager` on npm; `bin/cli.cjs` spawns the bundled Electron binary. Commits to release: 5e8854a and dd07985 (both already landed on the current branch, no further code changes needed here — this is a version-bump-and-publish-only PRD). Confirm npm auth/login state is already configured in this environment (PRD 759 published successfully, so credentials should still be valid) before attempting `npm publish` — if publish fails on auth, stop and report rather than working around it.

# Out of scope

- (none)

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
