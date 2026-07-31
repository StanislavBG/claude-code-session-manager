---
title: Delete now-dead legacy ticket-queue/right-rail components, if truly unreferenced
cwd: ~/Projects/session-manager
estimateMinutes: 15
---

# Status (implemented inline, same day, main-loop session — read before starting)

The routing half of this PRD already landed directly, not through this queue:
`src/renderer/App.tsx`'s `handleNewSession` (backs the sidebar "+ New session" button —
`AlmanacSidebar.tsx`'s `ProjectCaption`, `data-testid="tour-new-session"` — plus the Home tab's
quick action) no longer calls `createPickedSession()` (which minted a legacy dormant
`SessionTab` and made it active). It now only calls `useLayout.getState().openPanel('terminal')`
— so "+ New session" lands on `ProjectsLanding` (the Epic experience), never a fresh legacy
`SessionTab`. Verified at landing time: `timeout 300 npm run typecheck`,
`timeout 300 npm run test:unit` (145 files / 1427 tests), and `npm run lint:selectors` all
passed with this change in place.

Deliberately left untouched (separate, still-legitimate power-user paths, out of scope):
- Command Palette's `new-tab-pick` / `new-tab-here` commands (`App.tsx` ~line 729-738) — still
  create real dormant `SessionTab`s directly, bypassing `handleNewSession` entirely.
- The OS menu "Ctrl+N" handler (`window.api.app.onNewSession`, `App.tsx` ~line 309) — also calls
  `createPickedSession()` directly, without the `openPanel('terminal')` force-nav, so it isn't
  the same "always lands on Epics nav" flow this PRD is about.
- `src/renderer/components/Terminal.tsx`'s `isDormant` → `<TerminalChat>` rendering path itself —
  NOT touched. Only the one creation path that used to funnel into it by default was changed.

**This is why `QueueTicketPanel`/`ChatSessionRail`/`TicketDetailView` are NOT dead code and must
NOT be deleted outright** — the two paths above still create dormant `SessionTab`s that render
through exactly that legacy UI. This PRD's remaining scope is real but narrow: confirm precisely
how live those two remaining paths still are, and decide whether anything is safely prunable —
it may be that nothing is, in which case the correct outcome is "no deletion, confirmed still
needed," not a forced cleanup.

# Goal

Determine whether `QueueTicketPanel`, `ChatSessionRail`, and `TicketDetailView` (in/near
`src/renderer/components/TerminalChat.tsx` and `TicketDetailView.tsx`) are still genuinely
reachable now that the primary "+ New session" entry point no longer creates a legacy
`SessionTab`, and either document why they remain necessary (if Command Palette's
`new-tab-pick`/`new-tab-here` or the OS menu shortcut are real, actively-used paths) or delete
them if a fuller investigation shows they're truly orphaned. Do not guess — verify by tracing
actual call sites and, if possible, checking whether these commands appear in real usage (e.g.
recent `session-manager-operations/` logs or git history of the feature) before deciding.

# Acceptance criteria

- [ ] Grep every call site of `<TerminalChat`, `<QueueTicketPanel`, `<ChatSessionRail`, and
      `<TicketDetailView` in `src/renderer` and classify each: reachable only via the retired
      "+ New session" path (now dead), or reachable via Command Palette / OS menu / another
      surface (still live).
- [ ] If ALL call sites trace back to now-dead paths: delete `QueueTicketPanel`, `ChatSessionRail`,
      `TicketDetailView`, their now-unused supporting state in `src/renderer/state/chat.ts` (the
      `PromptTicket` queue machinery — only the parts nothing else reads; `chat.ts` also now
      exports `dispatchPromptSessionToPrd`/`appendPrdCreatedEvent`, used by
      `PromptSessionConversation` — do not touch those), and the now-orphaned
      `src/renderer/components/__tests__/QueueTicketPanel.test.tsx`.
- [ ] If ANY call site is still live (expected, given Command Palette's `new-tab-pick`/
      `new-tab-here` and the OS menu shortcut both still create dormant `SessionTab`s that render
      via this exact path): do NOT delete anything. Instead, add a one-line comment at
      `QueueTicketPanel`'s and `ChatSessionRail`'s definitions noting they're reachable only via
      Command-Palette/menu-created raw sessions, not the primary Epics "+ New session" flow, so a
      future reader doesn't mistake them for fully dead code.
- [ ] `timeout 300 npm run typecheck` passes.
- [ ] `timeout 300 npm run test:unit 2>&1 | tail -80` passes with no new failures.
- [ ] `npm run lint:selectors` passes.

# Implementation notes

Read `/home/bilko/.claude/session-manager/scheduled-plans/PRD_AUTHORING.md` and
`/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md`
before starting.

Start from `src/renderer/App.tsx`'s `handleNewSession` (~line 167) to confirm the current state
described above, then trace forward from the two still-live creation paths (Command Palette
`new-tab-pick`/`new-tab-here` ~line 729-738, and `onNewSession` OS-menu handler ~line 309) to
confirm they really do still reach `Terminal.tsx`'s `isDormant` → `TerminalChat` render path
(~line 39/263) unchanged. This determines whether any deletion in this PRD is safe.

Be conservative: given the investigation above already strongly suggests two live paths remain,
the most likely correct outcome for this PRD is "confirmed still needed, comment added, no
deletion" rather than an actual removal. That is a valid, complete outcome for this PRD — do not
force a deletion to make the PRD feel more substantial than the investigation supports.

# Out of scope

- Any visual/label changes — already landed (PRD 822-epics-nav-rename, archived).
- PRD-dispatch/traceability logic inside `PromptSessionConversation` — already landed (PRD
  822-promptsession-prd-trace-events, archived).
- Changing Command Palette's `new-tab-pick`/`new-tab-here` or the OS menu "Ctrl+N" behavior —
  these are legitimate, separate power-user flows; do not alter them in this PRD.

## Engineering standards

Before writing any code, read
`/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md`
— it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply
to this PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands,
verify before done, the finish-protocol sentinel).
