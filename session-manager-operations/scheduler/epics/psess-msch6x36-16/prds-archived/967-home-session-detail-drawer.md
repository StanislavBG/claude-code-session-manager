---
title: Home dashboard — Active/Recent session rows open a real slide-in detail drawer, matching Home Screen A
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 75
sourcePromptId: psess-msch6x36-16
dependsOn: [966-home-dashboard-fix-blank-queued-card-add-interactions-legend]
---
# Goal

The single biggest visual/interaction gap between the live Home dashboard and the Home Screen A design (variants/home-a.jsx's ADrawer pattern) is that clicking an Active-session or Recent-session row today just fires a flat action (navigate/resume) instead of the mock's slide-in right-side drawer showing real session detail (KeyVals block + live tail / last exchange) with contextual footer actions. Build a real (not mocked) HomeSessionDrawer matching the mock's slide-in visual pattern, backed entirely by data this app already has — no fabricated tail lines, costs, or turn counts.

# Acceptance criteria

- [ ] New HomeSessionDrawer component (or equivalent) in src/renderer/components/tabs/home/ renders a right-side slide-in panel matching home-a.jsx's ADrawer shape: backdrop, header (title + sub + close), scrollable body, footer action row — reuse this app's existing modal/drawer conventions (check components/ui/ for an existing Drawer/Modal primitive before writing a new one from scratch)
- [ ] Clicking an Active-sessions row (ActiveSessionsCard) opens the drawer showing real KeyVals: Epic/goal title, started-at, project, kind (scheduler job / chat run), and slot info — every value sourced from activeSessionRows()/existing store state, none fabricated
- [ ] If the Active session is a running chat run for an Epic, the drawer's 'live tail' section shows the real last few chat turns/tool-use lines for that Epic (useChat store) — if no such data is practically extractable within scope, the drawer omits the tail section entirely rather than showing placeholder text
- [ ] Clicking a Recent-sessions row (RecentSessionsCard) opens the drawer showing real KeyVals (session id, project, ended/mtime, size) and a 'Resume' footer action wired to the existing resume() handler (unchanged behavior, now inside the drawer instead of an inline button)
- [ ] Before adding Fork/Export footer buttons from the mock, verify a real backend action exists (grep usePromptSessions for a resume-from-archived/fork-style action; grep main config IPC for any transcript-export capability) — if no real action exists for one of these, OMIT that button rather than wiring it to a stub or toast('not implemented')
- [ ] Opening/closing the drawer and its rendered KeyVals are covered by RTL/jsdom unit tests using representative store fixtures (follow the existing pattern in src/renderer/lib/__tests__/homeSessionRows.test.ts and homeNeedsYou.test.ts for fixture shape)
- [ ] npm run typecheck passes
- [ ] node scripts/check-unstable-selectors.cjs passes
- [ ] npm run test:unit (vitest run) passes in full, including the new tests
- [ ] Do NOT run npm run test:e2e, Playwright, or launch a second Electron instance — the scheduler runs concurrent claude -p jobs on this machine and a second Electron/e2e launch SIGTERMs them (project CLAUDE.md 'Avoid' section). Verify via code + automated jsdom tests only, and say so explicitly in the final report

# Implementation notes

Depends on PRD 966 landing first (same file, avoid merge churn). Primary file: src/renderer/components/tabs/Home.tsx (ActiveSessionsCard, RecentSessionsCard, activeSessionRows()/recentSessionEpicTitle() come from src/renderer/lib/homeSessionRows.ts). The mock's ADrawer (variants/home-a.jsx) is the visual reference: position:absolute inset:0 wrapper, backdrop with onClick-to-close, aside sliding in via transform translateX, header/body/footer grid-template-rows layout, transition .22s cubic-bezier(.32,.72,.28,1). Match this app's existing color tokens (bg-bg-hi, border-line, text-fg/text-fg-dim/text-fg-faint, font-serif for the title) rather than the mock's raw hex Almanac object — this app already has those tokens wired as Tailwind classes (see AlmanacSidebar.tsx, existing Home.tsx cards for the pattern). Check components/ui/ (e.g. any existing slide-in panel used by WatchersPopover or similar) before building a new drawer primitive from scratch — reuse over duplicate. For the 'live tail', useChat's per-Epic TabChat.turns / toolUses (see lib/useChatSignals.ts's doc comment for the shape) is the real data source; do not invent a terminal-style ANSI tail like the mock's ATail component unless real lines are available to fill it. This Epic (psess-msch6x36-16) already imported the Home Screen A design via claude_design MCP — re-read its session transcript for the exact ADrawer/AKeyVals/ATail JSX if you need the precise visual reference, or re-fetch via claude_design MCP read_file on project 0ca33cd3-c2fa-4644-b728-bde42292abbd, path variants/home-a.jsx.

# Out of scope

- (none)

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
