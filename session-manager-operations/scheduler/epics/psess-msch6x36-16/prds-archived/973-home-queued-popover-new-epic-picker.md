---
title: Home dashboard — Queued-job detail popover + New-epic project picker drawer (final Home Screen A fidelity pass)
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 60
sourcePromptId: psess-msch6x36-16
---
# Goal

Close the last two real-data-backed interaction gaps between the Home dashboard and the Home Screen A mock (variants/home-a.jsx). (1) The mock's Queued card opens a per-job popover with job details and actions; today clicking anywhere on the card just navigates to Scheduler. (2) The mock's "New epic" button opens a project-picker drawer before starting the epic; today it just navigates to the Epics screen for whatever tab happens to be active. Both must be backed only by actions this app really has — no stub buttons.

# Acceptance criteria

- [ ] Clicking a job row inside QueuedCard opens a small anchored popover (mock: home-a.jsx queuePop) showing that job's REAL details: title/slug, project (cwd basename), estimateMinutes when set, and status — popover closes on second click, outside click, or Escape
- [ ] Popover actions are REAL only: audit window.api.schedule (preload/api.d.ts) first — 'Open in Scheduler' (navigate) is always present; include 'Run next tick' wired to schedule.runNow() ONLY if that API semantically applies to a pending job (read scheduler.cjs's runNow handler to confirm what it does and reflect that in the button label/title); do NOT ship a 'Skip next' button since no per-job skip API exists — if an action has no backend, omit it
- [ ] The QueuedCard container is no longer one whole-card button once rows are individually clickable — keep an explicit 'Open Scheduler →' affordance (header link or footer row) so the old navigate-to-Scheduler path is still reachable
- [ ] The Hero's 'New epic' button opens a right-side drawer (reuse the HomeSessionDrawer/drawer primitive landed by PRD 967 — do not build a second drawer) listing known projects as a radio list (mock: A_PROJECTS picker), sourced from the same useKnownProjects/buildHomeProjectRows data the Projects card already renders — no fabricated project names
- [ ] Confirming the picker activates-or-opens that project's tab (same openProject logic ProjectsCard already has — extract/reuse, don't duplicate) and lands the user in the Epics workspace with the New Epic flow reachable; audit EpicsWorkspace.tsx first for any existing deep-link/intent mechanism to auto-open NewEpicCard (grep for showNewEpic / pending intents) — if none exists, landing on the Epics screen for the chosen project is sufficient and the drawer copy must say that ('Continue in <project> → Epics'), rather than inventing a new cross-component signal ad hoc
- [ ] Popover open/close behavior, action-button presence rules, and the picker drawer's project list + confirm flow are covered by RTL/jsdom unit tests with store fixtures (existing patterns: QueuedCard tests from PRD 966, drawer tests from PRD 967)
- [ ] The InteractionsLegend rows for 'Queued' and 'New epic' are updated to describe the new real behaviors
- [ ] npm run typecheck passes; node scripts/check-unstable-selectors.cjs passes; npm run test:unit (vitest run) passes in full
- [ ] Do NOT run npm run test:e2e, Playwright, or launch a second Electron instance — the scheduler runs concurrent claude -p jobs on this machine and a second Electron/e2e launch SIGTERMs them (project CLAUDE.md 'Avoid'). Verify via code + automated jsdom tests only, and say so explicitly in the final report

# Implementation notes

This is the FINAL fidelity pass for Epic psess-msch6x36-16 (Home Screen A). Prior landings: commit 8a3e979 (PRD 966: QueuedCard empty-state + InteractionsLegend) and fcb4180 (PRD 967: slide-in session detail drawer) — read both diffs first; build on their primitives, don't fork them. Files: src/renderer/components/tabs/Home.tsx (QueuedCard ~line 453, Hero/HeroButton ~line 154-250, InteractionsLegend ~line 255-280), the drawer component PRD 967 added under src/renderer/components/tabs/home/, src/renderer/lib/homeProjectRows.ts + useKnownProjects for the project list, ProjectsCard's openProject handler for tab activation (extract into a shared helper in Home.tsx or lib/ rather than copy-pasting). Mock reference: variants/home-a.jsx — queuePop popover (absolute-positioned card, width ~226, shadow, mono details block, action row) and the newEpic ADrawer (radio list, Cancel/Continue footer). Use this app's Tailwind tokens (bg-bg-hi, border-line, text-fg-faint, font-mono) not the mock's raw hex. Escape-to-close: follow whatever key-handling pattern PRD 967's drawer landed. The design was already imported via claude_design MCP in this Epic's session — re-fetch variants/home-a.jsx via claude_design read_file on project 0ca33cd3-c2fa-4644-b728-bde42292abbd only if needed.

# Out of scope

- The mock's Pace sparkline card and Usage per-project breakdown split — both require fabricated data this app has no source for (deliberate exclusion, documented in Home.tsx's file header)
- The mock's Run-now/Skip-next scheduling semantics where no matching backend API exists — no stub buttons, no toast('not implemented')
- Any new backend/IPC surface — renderer-only work against existing APIs

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
