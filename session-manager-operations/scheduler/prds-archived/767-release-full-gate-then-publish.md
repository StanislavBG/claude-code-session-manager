---
title: "Release: full test/CI/health gate then publish npm package if green"
cwd: ~/Projects/session-manager
estimateMinutes: 12
---
# Goal

Run this repo's headless-safe verification harness (typecheck, unit tests, production build, and the health entrypoint) against current `main`, and only if every gate is green, bump `package.json`'s patch version, make a release commit, and `npm publish` so `npx claude-code-session-manager@latest` picks up everything landed since the last publish (currently 0.38.4 on npm — verified via `npm view claude-code-session-manager version`; at minimum this includes commit 700bdc4, the dead-DocumentViewer.tsx cleanup, commit 16080ac collapsing PRD editing into shared EditorView, plus whatever else has landed on main by the time this PRD runs, e.g. PRD 766 if it's completed by then). This follows the exact same release pattern already used successfully by PRDs 759 and 762 (read 762-release-v0-38-4-chat-panel-fixes.md in the same prds directory, or its archived/completed record under prds-archived/ or scheduled-plans/runs/ if already swept, for the release-commit-message style and publish sequence), except this time the gate is broader than just typecheck.

**e2e is deliberately EXCLUDED from this gate** — a prior run of this exact PRD (767, first attempt) included `xvfb-run npm run test:e2e` and was SIGTERM'd/aborted at ~108s. Per this repo's own memory/incident record (`no_schedule_self_e2e.md`): session-manager's e2e specs read/write the REAL `~/.claude/session-manager/scheduled-plans/queue.json` (not a temp dir — see e.g. `tests/e2e/scheduler-archive.spec.ts`), which is the SAME queue the live scheduler running THIS headless job owns, so a scheduled job running its own e2e collides with itself and also boots a second Electron under xvfb. This is a known, previously-hit failure mode (PRDs 115/116, 2026-06-15), not something to work around here — e2e for this repo stays interactive-only until a `SM_SCHEDULER_ROOT`-style isolation lands. Do not add e2e back into this PRD's scope.

# Acceptance criteria

- [ ] `timeout 300 npm run typecheck` passes.
- [ ] `timeout 300 npm run test:unit` (vitest run) passes — full unit suite green, 0 failures.
- [ ] `timeout 300 npm run build` (production renderer build into dist/) completes successfully.
- [ ] `timeout 120 npm run health` reports GREEN (exit 0).
- [ ] **Do NOT run `npm run test:e2e` or any Playwright/xvfb command in this PRD** — see Goal section above for why; this is a hard exclusion, not an oversight.
- [ ] **Gate discipline**: if ANY of the above checks fails or times out, STOP — do not bump the version, do not commit, do not publish. Report exactly which gate failed, the relevant error/log tail, and stop. Do not attempt to fix unrelated pre-existing failures as part of this PRD (that's a separate PRD) — this PRD's job is gate-then-publish, not fix-then-publish.
- [ ] Only if all gates above are green: bump `package.json`'s `version` field by one PATCH version (e.g. 0.38.4 -> 0.38.5).
- [ ] A release commit is made following the existing style (`git log --oneline | grep 'chore(release)'` for the pattern, e.g. `chore(release): bump to v0.38.5`).
- [ ] `npm publish` completes successfully (runs `vite build` again via `prepublishOnly` per this repo's Distribution section — expected).
- [ ] Verify the publish landed: `timeout 30 npm view claude-code-session-manager version` reports the new bumped version.
- [ ] Final report states, per gate, pass/fail and (if published) the confirmed live npm version; if any gate failed, state clearly that publish was skipped and why.

# Implementation notes

Precedent: `759-release-v0-38-3-chat-link-and-admin-token-fixes.md` and `762-release-v0-38-4-chat-panel-fixes.md` (same `prds/` directory, or their archived/completed records under `prds-archived/` or `scheduled-plans/runs/` if already swept) both did a version-bump-and-publish following this exact style, but gated only on typecheck. This PRD raises the bar per the original user request ("run all tests, CIs, harness... if green publish") to typecheck + unit tests + build + health — e2e is explicitly excluded per the Goal section's explanation (self-collision with the live scheduler queue); this is not a scope reduction the executor should second-guess.

Confirm npm auth/login state is already configured in this environment (PRD 759 and 762 both published successfully, so credentials should still be valid) before attempting `npm publish` — if publish fails on auth, stop and report rather than working around it (do not store/echo credentials, do not attempt `npm login` non-interactively).

Current published version at PRD-authoring time: 0.38.4 (confirmed via `npm view claude-code-session-manager version`). `package.json`'s `version` field was also already 0.38.4 at authoring time, meaning nothing has bumped it since — this PRD does the bump itself, don't assume it's already been incremented.

This repo publishes as `claude-code-session-manager` on npm; `bin/cli.cjs` spawns the bundled Electron binary; `postinstall` runs `electron-rebuild`. Commands referenced (`npm run typecheck`, `npm run test:unit`, `npm run build`, `npm run test:e2e`, `npm run health`) are all defined in `package.json` per this repo's CLAUDE.md Commands section — use them as-is, don't reinvent equivalent ad hoc commands.

This PRD was queued with NN=767, after PRDs 765 and 766 (both unrelated Chat/Scheduler UI work). PRD 765 has already landed (commit 16080ac) as of this rewrite; PRD 766 may or may not have completed by the time this PRD executes — either way, run against whatever is actually on `main` at execution time and publish if the gates are green, don't block on 766's status.

**Retry note:** this file was rewritten after a first execution attempt (run at 2026-07-29T17:15:30Z, exit 143) that included an e2e step and got SIGTERM'd — see the e2e-exclusion explanation in the Goal section above. That attempt got through typecheck, unit tests, and the production build successfully before being killed on the e2e step; only e2e was ever the problem.

# Out of scope

- Fixing any test/typecheck/e2e/health failures discovered by this PRD's gate — report them, don't fix them here (that belongs in a separate targeted PRD)
- Bumping a minor or major version — patch only, unless the user has separately indicated a larger version jump is warranted
- Publishing under any dist-tag other than the default `latest`

## Engineering standards

Before writing any code, read `/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands, verify before done, the finish-protocol sentinel).
