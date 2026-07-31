---
title: Scoped Agent conversation view (no top TabBar, no right nav)
cwd: ~/Projects/session-manager
estimateMinutes: 30
---

# Goal

Link 3/5. When a user opens a specific `PromptSession` row from the Projects list (PRD 803),
render a dedicated Agent conversation view scoped to just that goal — reusing the existing
Chat/composer/transcript machinery in `TerminalChat.tsx` (chatRunner integration, composer,
markdown transcript rendering) — but WITHOUT creating a top-level `SessionTab`/TabBar entry, and
WITHOUT the right-nav sidebar. Per explicit user direction: "no Right Nav in Terminal going
forward" — remove `ChatSessionRail` (`TerminalChat.tsx:248-320`, currently rendering both the
redundant `session-manager/cwd/idle` card, already duplicated at `TabBar.tsx:82` and
`AlmanacFooter.tsx:100`, and the "THIS TURN" tool-activity card) from this new scoped view
entirely — its role was to show session/tool context that a goal-scoped, single-purpose view no
longer needs, since the composer and transcript ARE the whole view now. The user works this one
conversation until the initial goal is met; the conversation must not be allowed to spill into
unrelated work beyond that goal (scope discipline — later PRDs may add lint/guardrails; this PRD
establishes the scoped container itself).

# Acceptance criteria

- [ ] A new view component (e.g. `PromptSessionConversation.tsx`) renders for an opened
  `PromptSession` (PRD 802/803): composer + transcript, reusing `TerminalChat.tsx`'s existing
  chatRunner send/receive wiring and markdown rendering rather than reimplementing them —
  extract/share, don't duplicate (API-reuse standard)
- [ ] Opening a `PromptSession` does NOT call `useSessions.getState().addTab(...)` and does NOT
  create any entry in the top `TabBar.tsx` strip
- [ ] The view does NOT render `ChatSessionRail` or any equivalent right-nav sidebar — verify by
  confirming the rendered view has no cwd/idle card and no "THIS TURN" tool-activity card
- [ ] Sending a prompt from this view's composer runs it through chatRunner scoped to the
  `PromptSession`'s own independent `claudeSessionId` (from PRD 802), and appends a
  `PromptSessionEvent` (`'response'` kind, `causedByEventId` pointing at the prompt/prior event)
  to that session's chain via `appendPromptSessionEvent`
- [ ] `timeout 300 npm run typecheck` passes
- [ ] A component test asserts: no `SessionTab` is created when opening a `PromptSession`, the
  rendered view contains no `ChatSessionRail`/right-nav markup, and sending a message appends a
  correctly-chained `PromptSessionEvent`

# Implementation notes

Depends on PRD 802 (data model/store) and PRD 803 (Projects list that opens into this view) —
read both PRDs' actual landed diffs first. Read `TerminalChat.tsx` in full: composer
(~around line 924 area where `ChatSessionRail` is invoked), transcript rendering
(`renderChatMarkdown`, line ~585), and the chatRunner send path, to identify exactly what to
extract/reuse vs what to drop (`ChatSessionRail`, the top browser-tab dependency). Confirm via
`src/renderer/state/chat.ts` how `send()` is parameterized by `tabId`/`sessionId` today
(~lines 265-276, 667-676) — this view needs to call the equivalent send path using the
`PromptSession`'s own `claudeSessionId` instead of a `SessionTab`'s.

This is link 3 of the 5-PRD chain (802-806). PRD 805 (next) wires link/file rendering reuse
inside this new view; PRD 806 wires the completion+archive action.

## Engineering standards

Before writing any code, read
`/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md`
— it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply
to this PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands,
verify before done, the finish-protocol sentinel).

# Out of scope

- Link-to-internal-Browser and file/markdown-renderer reuse (PRD 805)
- The "Mark completed" action and archive/kill-process workflow (PRD 806)
- Any change to the existing per-tab `TerminalChat.tsx` view used by ordinary `SessionTab`s —
  it must keep working unchanged; this PRD adds a new, separate view rather than modifying that
  one in place
