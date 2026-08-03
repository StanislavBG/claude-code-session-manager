---
title: Home dashboard — fix blank Queued card + add Interactions legend to match Home Screen A mock
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 45
sourcePromptId: psess-msch6x36-16
---
# Goal

The user reported (screenshot attached to the Epic) that the live Home dashboard "doesn't look at all like the design" — the top-right "Queued" card region rendered as a blank box with no header/border content visible, and the mock's "Interactions" legend toggle (home-a.jsx's `legend` state, a small reference panel explaining what each interactive element does) was never built. Diagnose and fix the Queued card with a permanent regression test, and add a real (non-fabricated) Interactions legend toggle to the Home header, closing two concrete fidelity gaps between src/renderer/components/tabs/Home.tsx and the Home Screen A design (variants/home-a.jsx + variants/almanac.jsx, already read into this Epic's session).

# Acceptance criteria

- [ ] Reproduce the blank-QueuedCard report with a jsdom/RTL render test of QueuedCard (or Home) asserting the 'Queued' label text and 'Nothing pending.' text are present in the DOM both (a) before useScheduleState has ever received a snapshot (store's initial null state) and (b) once it has received an empty-jobs snapshot — this is the leading hypothesis (snapshot arrives async after mount) and the fix + regression test must cover both states
- [ ] If the render test reveals no bug (component already renders correctly in both states), leave a code comment explaining the verified-safe behavior and still land the regression test — do not skip landing the test just because no bug was found
- [ ] Home.tsx header gains an 'Interactions' toggle button (next to All history / New epic) that expands a small reference card listing what each interactive element on the page does, adapted from home-a.jsx's own `legend` panel copy list (Usage card, Queued job, Needs-you row, Active session row, Recent row, New epic) to this app's ACTUAL wired behavior — every line must describe a real action this codebase performs, not the mock's fictional ones (e.g. do not claim 'Pace chart toggles line/bars' since no Pace chart exists here)
- [ ] Legend toggle state and visibility covered by a unit/RTL test
- [ ] npm run typecheck passes
- [ ] node scripts/check-unstable-selectors.cjs passes
- [ ] npm run test:unit (vitest run) passes in full, including the new tests
- [ ] Do NOT run npm run test:e2e, Playwright, or launch a second Electron instance to verify this visually — the scheduler runs concurrent claude -p jobs on this machine and a second Electron/e2e launch SIGTERMs them (see project CLAUDE.md 'Avoid' section, 'No 2nd Electron while jobs run'). Verify via code + automated jsdom tests only, and say so explicitly in the final report

# Implementation notes

Files: src/renderer/components/tabs/Home.tsx (QueuedCard, Hero, HeroButton, NeedsYouSection are all in this one file). Related: src/renderer/state/scheduleState.ts (snapshot starts null until 'schedule:state' IPC resolves). The Home Screen A mock's legend panel (variants/home-a.jsx, `legend &&` block) is the copy/structure reference — reuse its visual shape (grid of term/description pairs, dotted-underline toggle button) but every description must map to a REAL wired interaction in this codebase (grep Home.tsx for what each card's onClick actually does before writing its legend line). Do not add legend rows for interactions that don't exist (Pace chart, per-project breakdown drawer popovers, etc. were deliberately not built in the prior PRD for this Epic since they'd require fabricated data — see Home.tsx's file-header doc comment for that reasoning). Keep the toggle's own styling consistent with the existing aLabel/aCard patterns already used elsewhere in Home.tsx (bg-bg-hi/border-line/font-mono classes, not new one-off styles). This PRD's Epic (psess-msch6x36-16) already imported the design via claude_design MCP earlier in this Epic's session — variants/home-a.jsx and variants/almanac.jsx content is in that session's transcript if you need to re-read exact copy; do not re-run /design-login or re-import, just read the transcript or re-fetch via claude_design MCP read_file on project 0ca33cd3-c2fa-4644-b728-bde42292abbd if the transcript isn't available to you.

# Out of scope

- (none)

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
