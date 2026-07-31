---
title: Rename Projects nav to EPICS and add an Epic Queue section
cwd: ~/Projects/session-manager
estimateMinutes: 10
---

# Goal

The "Projects" nav item and its landing page are the app's goal-scoped PromptSession UI
(`src/renderer/components/ProjectsLanding.tsx`, PRD 802-804) — user direction confirmed this
PromptSession IS the "Epic" unit of work going forward. Rename all user-facing "Projects"
labeling to "Epics" and add an explicit "Epic Queue" section heading above the list of active
PromptSessions, so it's visually clear each row is an independent unit of session (an Epic),
matching the terminology the user wants across the app.

# Acceptance criteria

- [ ] `src/renderer/lib/navGroups.ts`: the `NAV_ITEMS` entry with `key: 'terminal'` has `label`
      changed from `'Projects'` to `'Epics'` (the `hint` text may stay or be lightly adjusted to
      mention Epics, e.g. `'Independent goal-scoped Epics, grouped by project'`).
- [ ] `src/renderer/components/TerminalChat.tsx`: the `NAV_LABELS` map's `terminal` entry
      (currently `'Terminal'`) is reviewed — any user-facing rendering of this label must read
      "Epics", not "Projects" or "Terminal", for consistency with `navGroups.ts`.
- [ ] `src/renderer/components/ProjectsLanding.tsx`: the page heading (`<h1>Projects</h1>`)
      becomes "Epics"; the subtitle "Each row is an independent goal-oriented session you can
      jump into." is updated to reference "Epic" (e.g. "Each row is an independent Epic you can
      jump into.").
- [ ] `ProjectsLanding.tsx`: add a section heading "EPIC QUEUE" (styled consistently with the
      existing "History" section heading a few lines below it — same
      `text-[11px] font-semibold tracking-[0.05em] text-fg-faint uppercase` classes) directly
      above the active-sessions `groups.map(...)` list, visible whenever `groups.length > 0` (the
      existing empty-state message when `groups.length === 0` is unchanged).
- [ ] The two "← Back to Projects" button labels (the archive view header and the active-session
      view header) become "← Back to Epics".
- [ ] The "New starting prompt" box, `PromptSessionRow`, and `PromptSessionHistoryRow` are NOT
      renamed to "Epic" — only the page-level heading, subtitle, nav label, "Back to" buttons,
      and the new "EPIC QUEUE" section heading change, per this PRD's scope. Do not touch data
      model field names (`goalText`, `PromptSession` type, etc.) — this is a display-label-only
      PRD.
- [ ] `timeout 300 npm run typecheck` passes.
- [ ] `timeout 120 npx vitest run src/renderer/components/__tests__ 2>&1 | tail -50` shows no new
      failures introduced by this rename (existing tests referencing the literal text "Projects"
      in this component, if any, are updated to match).

# Implementation notes

Read `/home/bilko/.claude/session-manager/scheduled-plans/PRD_AUTHORING.md` and the standards
file at `/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md`
before starting — every rule in `standards.md` is mandatory (TDD, execution discipline, bounded
commands).

Files to touch:
- `src/renderer/lib/navGroups.ts` (line ~28): `{ key: 'terminal', group: 'Workspace', label:
  'Projects', ... }` → `label: 'Epics'`.
- `src/renderer/components/TerminalChat.tsx` (`NAV_LABELS` const, ~line 50-71): review the
  `terminal` entry.
- `src/renderer/components/ProjectsLanding.tsx`: the
  `<h1 className="font-serif text-[20px] font-medium text-fg">Projects</h1>` (~line 190) and the
  subtitle right below it; the two "← Back to Projects" button labels (~lines 142, 168); add a
  new heading above `groups.map(...)` (~line 235) styled like the existing History heading
  (~line 259-261: `<div className="mb-2 text-[11px] font-semibold tracking-[0.05em]
  text-fg-faint uppercase">History</div>`).

Grep for any other literal "Projects" nav-label references before finishing:
`grep -rn "'Projects'\|>Projects<" src/renderer` — some hits (`ProjectsWorkspace.tsx`,
`learningContent.ts`, `AlmanacIcon.tsx`) are unrelated to this nav item (File Explorer's
`projects` key, an icon name, or other features) and must NOT be changed — confirm each hit's
context before touching it.

This PRD is purely cosmetic/label-only. A sibling PRD in this same parallel group (822) ports
PRD-dispatch capability into `PromptSessionConversation`; a follow-on PRD (823) retires the
older ticket-queue UI. Do not attempt either of those here.

# Out of scope

- Renaming data model fields, IPC channel names, file names, or test ids (`data-testid`
  attributes) — labels only.
- Touching `TerminalChat.tsx`'s `QueueTicketPanel` / `ChatSessionRail` (the legacy ticket-queue
  UI) — that is handled in PRD 823.
- Wiring PRD-dispatch into `PromptSessionConversation` — handled in the sibling PRD
  `822-promptsession-prd-trace-events.md`.

## Engineering standards

Before writing any code, read
`/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md`
— it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply
to this PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands,
verify before done, the finish-protocol sentinel).
