---
title: Epics redesign 8/8 — workspace integration (mount, deep links, retire legacy, tests)
cwd: ~/Projects/session-manager
estimateMinutes: 25
sourcePromptId: implement-the-redesigned-two-pane-epics-workspac-7781682f
---

# Goal

Assemble PRDs 826–828's components into the shipping Epics workspace: a new
`src/renderer/components/epics/EpicsWorkspace.tsx` (left `EpicQueue`+controls, right
`EpicDetail`/`NewEpicCard`/`EpicComposer`) mounted where `ProjectsLanding` renders today,
with deep links preserved and the superseded surfaces retired. Read every sibling component
as actually landed (they may have adjusted names/props during execution) before wiring.

# Acceptance criteria

## Core functionality

- [ ] `EpicsWorkspace.tsx` composes the panes per
  `session-manager-operations/design-mocks/epics/DESIGN_SPEC.md` (layout diagram): queue
  selection drives the detail pane; "New Epic" swaps the right pane to `NewEpicCard`
  (onCreated selects the new Epic); active Epics get the `EpicComposer` under the detail
  scroller, completed ones don't.
- [ ] `TerminalStage.tsx` renders `EpicsWorkspace` in the `activeTab === null` branch
  (replacing `ProjectsLanding`). The detail header's `onOpenRawSession` prop is wired to a
  no-op stub emitting a toast "Terminal view lands with PRD 831" — do NOT wire it to
  useSessions/SessionTab creation: an Epic IS its claude session and PRD
  831-epic-session-mode-switch (queued after this one) replaces that affordance with an
  in-pane Chat ⇄ Terminal mode toggle over the SAME `claudeSessionId`. Leaving the
  workspace to a SessionTab would orphan the Epic's context (user-reported gap,
  2026-07-31). Verify the user can still reach the workspace whenever no tab is active.
- [ ] Deep links preserved: the `sm:select-prompt-session` listener +
  `takePendingPromptSessionId` priming (currently `ProjectsLanding.tsx:51-69`, producers
  `SchedulePanel.tsx:788` and `TerminalChat.tsx:185-188`) re-home into `EpicsWorkspace`;
  selecting a completed Epic opens its detail (archived events), not a crash.
- [ ] Legacy retirement: `ProjectsLanding.tsx` and `PromptSessionConversation.tsx` are
  deleted; `PromptSessionArchiveView.tsx` is deleted if `EpicDetail` now covers completed
  Epics (it should). Surviving consumers of `TagSelector`/`openPrdSlug`/`openPromptSession`
  (exports from `TerminalChat.tsx:175-188`) are re-pointed or the now-dead exports removed —
  `TerminalChat.tsx` itself (dormant-tab legacy chat) stays.
- [ ] `EPIC_BADGE_PALETTE` duplication is gone — everything uses
  `src/renderer/lib/projectColor.ts`.

## Interaction / integration

- [ ] `src/renderer/components/__tests__/ProjectsLanding.test.tsx` and
  `PromptSessionConversation.test.tsx` are rewritten against `EpicsWorkspace` (same behaviors:
  row rendering, mark-completed, resume, cwd select, deep-link selection) — deleted tests must
  be replaced, not dropped.
- [ ] Full gates: `timeout 300 npm run typecheck`, `npm run lint:selectors`, and
  `timeout 600 npm run test:unit` all pass.

## Validation artifact (author only — do NOT run the app)

- [ ] A screenshot script `epics-workspace-screenshots.mjs` at the repo root, copied from the
  `prd791-screenshots.mjs` pattern (`_electron.launch`, Ctrl+K palette →
  `button[data-cmd-id="nav:terminal"]`, 1600x1000 viewport), capturing: queue+detail,
  New Epic card, PRDs tab. The script is authored and typechecks under `node --check`, but
  this PRD must NOT launch Electron or run the script (headless runs cannot drive the GUI —
  the interactive session runs it during verification).

# Implementation notes

Serial after all of 826/827/828. State in the commit message what each consumed sibling
actually delivered. Read `TerminalStage.tsx:28-48` (mount branch), `App.tsx:82`
(`sm:navigate` → terminal), `lib/promptSessionDeepLink.ts`. Keep the swap like-for-like on
the `activeTab === null` condition. Grep for every import of the deleted files before
removing them (`ProjectsLanding`, `PromptSessionConversation`, `PromptSessionArchiveView`)
and fix all consumers. The e2e suite (`tests/e2e/`) does not reference these surfaces
(verified 2026-07-31) — do not add e2e specs here.

# Out of scope

- Running the app, Playwright, or the screenshot script (interactive verification does that).
- Any change to TerminalChat's dormant-tab chat behavior beyond export cleanup.
- New features not in the spec.

## Engineering standards

Before writing any code, read
`/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md`
— it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply
to this PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands,
verify before done, the finish-protocol sentinel).
