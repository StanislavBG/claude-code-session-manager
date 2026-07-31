---
title: Route dev-work Prompt Queue tickets + their PRD-finished notifications into scoped PromptSessionConversation
cwd: ~/Projects/session-manager
estimateMinutes: 25
---

# Goal

PRD 813 (read its actual landed diff first — this PRD depends on it and scope may have shifted
during execution) gives every 'develop'-classified Prompt Queue ticket chain a real, persisted
`PromptSession` with its own `claudeSessionId`. Today that conversation still renders inline in
the tab's shared `TerminalChat.tsx` transcript, and the scheduler's PRD-finished notification for
that chain — delivered via `chatRunner.cjs`'s `enqueueExternalPrompt` as an `external: true`
`PromptTicket` — gets appended into whatever tab happens to be active, interleaved with unrelated
conversation. This is the exact symptom a user screenshot showed: multiple unrelated
"PRD N finished" notifications and their discussion all sharing one continuous transcript. This
PRD makes a dev-work ticket's conversation open in its own scoped `PromptSessionConversation`
(PRD 804, already built) instead, and routes its scheduler completion notification into that
session's own event/transcript instead of the tab's.

# Acceptance criteria

- [ ] Ticket rows for a dispatched-to-prd ticket that has a `promptSessionId` (set by PRD 813) —
  in the Prompt Queue panel / `QueueTicketPanel` (`TerminalChat.tsx`, search for where
  `ticketHistory`/`activeTicket` render ticket rows) — render a link/button that opens
  `PromptSessionConversation` scoped to that `promptSessionId`. Reuse the existing open mechanism
  (`window.dispatchEvent(new CustomEvent('sm:select-prompt-session', ...))` /
  `src/renderer/lib/promptSessionDeepLink.ts`) — the same one `ProjectsLanding` rows and PRD 807's
  scheduler-row deep link use. Do not invent a second open path.
- [ ] The scheduler-completion notification path (`chatRunner.cjs`'s `enqueueExternalPrompt`, and
  whatever call site in `src/main/` dispatches a PRD-finished chat notification) is changed so
  that when the finishing PRD's `sourcePromptId` resolves to a known `PromptSession`, it appends a
  `'response'` `PromptSessionEvent` to THAT session (via `appendPromptSessionEvent`, chained to
  its current tail) instead of enqueuing an `external: true` `PromptTicket` into whatever tab
  happens to be active.
- [ ] Verify by: two concurrent PRDs finishing for two different PromptSessions produce two
  separate, non-interleaved event chains, and neither shows up as a turn in an unrelated tab's
  `TerminalChat` transcript.
- [ ] If a finishing PRD's `sourcePromptId` does NOT resolve to any known `PromptSession` (e.g.
  queued before PRD 813 landed, or authored outside the Prompt Queue), fall back to today's
  behavior — inline `external` ticket into the originating tab — so no notification is silently
  dropped.
- [ ] A component test (extend `PromptSessionConversation.test.tsx`, or the Prompt Queue panel's
  existing test file — read what exists first) asserts: opening a dispatched-to-prd ticket's row
  renders `PromptSessionConversation` scoped to its own `claudeSessionId`, and a second, unrelated
  ticket's turns never appear inside it.
- [ ] `timeout 300 npm run typecheck` passes
- [ ] the relevant `timeout 300 npx vitest run <test files touched above>` passes

# Implementation notes

Depends on PRD 813 landing first — `PromptTicket.promptSessionId` and persisted `PromptSession`s
must exist. Read PRD 813's actual landed diff before starting (`git log` for its commit), since
it may have adjusted the exact field name/shape from what was planned. Read `chatRunner.cjs`'s
scheduler-notification send site (search for where a PRD's finish triggers a chat notification —
near `enqueueExternalPrompt`, or wherever the scheduler reads a completed job's `sourcePromptId`
off `queue.json` to notify the originating chat) and `src/renderer/lib/promptSessionDeepLink.ts`
for the existing open-session event contract (`sm:select-prompt-session`).

# Out of scope

- PRD 807's own scheduler-UI-side deep link work (concurrent, separate PRD) — don't duplicate
- Non-'develop' inline chat tickets — remain tab-scoped, unchanged
- Any change to PRD 804's `PromptSessionConversation.tsx` component itself beyond what's needed
  to open it from a ticket row (reuse as-is)

## Engineering standards

Before writing any code, read
`/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md` —
it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply to
this PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands,
verify before done, the finish-protocol sentinel).
