---
title: Epics redesign 5/8 — New Epic creation card (project picker, type, references)
cwd: ~/Projects/session-manager
estimateMinutes: 12
sourcePromptId: implement-the-redesigned-two-pane-epics-workspac-7781682f
---

# Goal

Build the New Epic creation card as `src/renderer/components/epics/NewEpicCard.tsx`, per
`session-manager-operations/design-mocks/epics/DESIGN_SPEC.md` (§"New Epic card") and the
mock's NewEpic (`session-manager-operations/design-mocks/epics/epics-mock.jsx`). It replaces
ProjectsLanding's "New starting prompt" form and renders in the right pane (not a modal) when
the queue's "New Epic" button is pressed.

# Acceptance criteria

## Core functionality

- [ ] Centered max-w-[620px] card: "NEW EPIC" mono micro-label, serif heading "What are we
  trying to achieve?", subtitle "One goal per Epic. Its discussion, PRDs and agent runs all
  stay inside it.", title input, goal textarea, type selector (Feature / Bug / Discussion
  pill group), Cancel + "Create Epic" buttons.
- [ ] Project picker: a labeled select over `useKnownProjects` exactly like today's
  `new-prompt-cwd` select in `ProjectsLanding.tsx:200-210` (keep
  `data-testid="new-prompt-cwd"`). Required — Create is disabled until a cwd and a goal
  exist. Default to the active tab's project when one exists.
- [ ] Create calls `usePromptSessions.createPromptSession(cwd, goalText, tag)` — the
  three-arg signature added by PRD 826 — then invokes `onCreated(id)` so the parent selects
  the new Epic; Cancel invokes `onCancel()`.
- [ ] References attach tray (paste ⌘V / drop / Attach button) matching the mock's
  AttachTray: chips with thumbnail/name/size/remove. On create, reference file paths are
  folded into `goalText` as trailing "Reference: <path>" lines (same convention as the
  composer PRD). If the composer sibling (827-epic-composer) already landed a shared
  `useAttachments`/`AttachTray`, import from it; otherwise implement here in
  `src/renderer/components/epics/attachments.tsx` so the composer can reuse.

## Edge cases

- [ ] Title is optional (goal is the identity — title defaults to the first ~60 chars of the
  goal if left blank); goal-only submission works.
- [ ] Form state resets after successful create and on Cancel.

## Tests

- [ ] vitest jsdom tests: Create disabled until cwd+goal; createPromptSession called with
  (cwd, goal, tag); onCreated fires with the new id; reference paths folded into goalText.
  `timeout 300 npx vitest run <new files>` passes; `timeout 300 npm run typecheck` and
  `npm run lint:selectors` pass.

# Implementation notes

Depends on PRD 826 (tag param on createPromptSession). Read `ProjectsLanding.tsx:180-235`
(current form + useKnownProjects usage) and the mock's NewEpic/AttachTray before building.
Tailwind Almanac tokens; `ui/Button.tsx` if it fits. Wave siblings run in parallel — own
files only: `NewEpicCard.tsx`, optionally `attachments.tsx`, tests.

# Out of scope

- Mounting/showing the card (PRD 829 wires the queue's onNew → this card in the right pane).
- Epic templates, description AI-assist, or any main-process changes.

## Engineering standards

Before writing any code, read
`/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md`
— it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply
to this PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands,
verify before done, the finish-protocol sentinel).
