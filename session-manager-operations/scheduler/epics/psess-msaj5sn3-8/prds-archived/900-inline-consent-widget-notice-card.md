---
title: Wire InlineConsentTerminal into the chat notice card, replacing the full-screen wakeTab jump
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 20
sourcePromptId: psess-msaj5sn3-8
dependsOn: [inline-consent-pty-backend]
---
# Goal

Wire the `InlineConsentTerminal` component built in 899-inline-consent-pty-backend.md into the MCP-consent notice card so granting consent happens as a small expand-in-place widget inside the chat transcript (ChatTranscriptTurn.tsx:422-453), instead of the current "Grant consent →" button which calls `queueRawCommand` + `wakeTab` (ChatTranscriptTurn.tsx:424-432) and replaces the whole tab with a full Terminal.tsx pane. This directly addresses the user's ask: "expose the auth into the chat... as some very minimal extension of the current chat that not a full screen."

# Acceptance criteria

- [ ] In ChatTranscriptTurn.tsx's `turn.role === 'notice'` branch (currently lines 422-453), when `isConsentNotice && enableRawSessionActions`, the 'Grant consent →' button toggles local expand/collapse state (`useState`) that renders `<InlineConsentTerminal sessionId={sessionId} cwd={cwd} command="/design consent" onGranted={...} onClose={...} />` inline directly below the notice text, INSTEAD OF calling `queueRawCommand`/`wakeTab` — the tab never leaves chat mode and Terminal.tsx is never mounted for this flow
- [ ] Before mounting InlineConsentTerminal, replicate the same pre-condition wakeTab already enforces at sessions.ts:220-227 (PRD 718 guard): if `useChat.getState().chats[tabId]?.running` is true, cancel it first via `window.api.chat.cancel(tabId)` (same call wakeTab makes) so the same sessionId's PTY isn't attached twice — do this inside the expand handler, awaited, before rendering the widget, with a toast via `toast.info(...)` matching the existing wakeTab wording style at sessions.ts:226
- [ ] `onGranted` callback: shows a toast (`toast.info('Consent granted — you can retry the run now.')` or similar) and auto-collapses the widget back to just the notice text + a 'Retry' affordance (this PRD renders the affordance; actually resending the prompt is the next PRD, 03-inline-consent-retry-wiring — out of scope here beyond a visible disabled-until-next-PRD 'Retry' button is fine, or omit the button entirely and just leave the collapsed notice, whichever is less code; do not half-wire a retry action here)
- [ ] `onClose` callback (widget's own Close control) simply collapses the widget back to the plain notice card — no chat.cancel call needed here, since nothing new was started that needs cancelling
- [ ] The existing `enableRawSessionActions` prop (ChatTranscriptTurn.tsx:317-318, false for PromptSessionConversation/EpicDetail readonly views) continues to gate this entirely — views with no backing SessionTab/PTY still see the notice text with no interactive affordance at all, same as today
- [ ] Existing tests referencing the old 'Grant consent' -> queueRawCommand/wakeTab behavior (grep `git grep -l "Grant consent" -- '*.test.*'` in this repo) are updated to assert the new inline-expand behavior instead of a wakeTab call; do not leave a stale assertion asserting the old behavior
- [ ] `npm run typecheck` passes
- [ ] Relevant component test suite passes, e.g. `timeout 120 npx vitest run src/renderer/components/__tests__/ChatTranscriptTurn.test.tsx` (adjust path if the actual test file differs — locate it via `git grep -l ChatTranscriptTurn -- '*.test.*'` first)

# Implementation notes

Read /home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md before starting.

Read 899-inline-consent-pty-backend.md's actual landed diff first (via `git log`/`git show` on the commit(s) that closed it, or by reading the current InlineConsentTerminal.tsx on disk) rather than assuming its planned prop shape — confirm the real exported Props type before wiring against it.

ChatTranscriptTurn.tsx already imports `useSessions` (for `queueRawCommand`/`wakeTab`) and `useChat` (line ~345, `chatRunning`) — reuse both; the new expand handler needs `window.api.chat.cancel` which sessions.ts:225 already calls the same way (`await window.api.chat.cancel(id)`), so import it via `window.api.chat.cancel(tabId)` directly in the component, no new IPC needed.

Do not remove the old `queueRawCommand`/`wakeTab`-based full-Terminal path from the codebase entirely in this PRD — `sessions.ts`'s `wakeTab`/`queueRawCommand` are general-purpose and used elsewhere (opening a raw session is still a legitimate action from other UI, e.g. an explicit "Open raw session" affordance if one exists outside the consent-notice flow); only THIS specific consent-notice call site changes. Grep for other callers of `queueRawCommand` before assuming it's safe to delete anything.

# Out of scope

- (none)

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
