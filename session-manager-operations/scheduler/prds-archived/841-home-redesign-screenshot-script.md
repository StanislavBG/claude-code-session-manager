---
title: Author (never run) the Home-redesign screenshot capture script
cwd: ~/Projects/session-manager
estimateMinutes: 8
sourcePromptId: home-redesign-global-machine-home-per-project-br-fa12799f
dependsOn: [836-home-global-active-recent-sessions, 839-project-home-live-blocks, 840-project-home-brief-blocks]
---

# Goal

Author `home-redesign-screenshots.mjs` at the repo root — a Playwright-Electron capture script for the redesigned surfaces, written in the exact style of the existing `epics-workspace-screenshots.mjs` — so the user can interactively validate the Home redesign against the mock afterwards. **This PRD writes the script only; it MUST NOT launch Electron, run the script, or run any e2e** (headless `claude -p` cannot drive the GUI — a launch attempt just gets SIGTERM'd).

# Acceptance criteria

- [ ] `home-redesign-screenshots.mjs` exists at the repo root, modeled on `epics-workspace-screenshots.mjs` (same launch/bootstrap helpers, output naming `home-redesign-<n>-<label>.png`), and captures in sequence: (1) machine Home via the fixed TabBar Home chip (hero + usage/projects grid), (2) machine Home scrolled to Active + Recent sessions, (3) Project Home with no brief (Generate-the-brief empty state + live blocks), (4) Project Home with a brief present — seeded by writing a small fixture `brief.json` into the test project's `session-manager-operations/project-brief/` from inside the script before navigation (fixture inline in the script, matching the schema in `/home/bilko/Projects/session-manager/session-manager-operations/design-mocks/home/DESIGN_SPEC.md`).
- [ ] The script is syntax-valid without executing its body: `timeout 60 node --check home-redesign-screenshots.mjs` passes.
- [ ] Static guard that nothing here runs the app: the PRD run's transcript contains no `xvfb-run`, `playwright test`, or Electron launch; verification is limited to `node --check` above plus `timeout 300 npm run typecheck` passing (unchanged code) — both bounded.
- [ ] A short header comment in the script states how the USER runs it manually (one line, e.g. `xvfb-run node home-redesign-screenshots.mjs`) and that it is not part of CI.

# Implementation notes

Read `epics-workspace-screenshots.mjs` (repo root) first and mirror its structure — electron launch args, dist/dev handling, wait/settle helpers, screenshot dir. Selectors: prefer stable testids/text that PRDs 835–840 actually shipped (grep the landed components for `data-testid` and headings like "This machine", "The brief" before hard-coding). The three dependency PRDs are landed by the time this runs — read their files, not the spec, for ground truth on selectors.

# Out of scope

- Running the script or any Playwright/Electron process (interactive validation happens later, by the user).
- Adding the script to package.json scripts or CI.
- Editing any application code.

## Engineering standards

Before writing any code, read `/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands, verify before done, the finish-protocol sentinel).
