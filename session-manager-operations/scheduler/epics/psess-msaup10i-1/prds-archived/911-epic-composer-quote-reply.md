---
title: Composer quote-reply — reply to a Turn from the Epic composer
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 18
sourcePromptId: psess-msaup10i-1
---
# Goal

Add a quote-reply affordance to the Epic Discussion thread: hovering a turn shows a small "Quote" button; clicking it seeds a dismissible reply-context strip above EpicComposer's textarea showing the quoted snippet, so a follow-up prompt can visibly reference an earlier message. This closes the one gap identified in the 2026-08-01 Epics-design re-sync that the design mock (variants/epic-thread.jsx's TUser component) has and the real ChatTranscriptTurn.tsx Turn renderer does not yet.

# Acceptance criteria

- [ ] Read src/renderer/components/ChatTranscriptTurn.tsx in full first (574 lines) to find where each turn role/type is rendered, and src/renderer/components/epics/EpicComposer.tsx and EpicDetail.tsx (both already read/edited this session) to see how Turn is invoked from EpicDetail's Discussion view.
- [ ] Turn (ChatTranscriptTurn.tsx) accepts a new optional prop `onQuote?: (text: string) => void`. A turn (at minimum: user turns; extend to assistant turns too if it's a small addition given the existing structure) shows a 'Quote' text button on hover that calls onQuote(turn.text) when present — hidden entirely when onQuote is not passed, so every OTHER caller of Turn (Terminal transcript view, raw session view, wherever else Turn is used — grep for `<Turn` first) is unaffected.
- [ ] EpicDetail.tsx passes onQuote={(text) => setQuote(text)} (new local state) down to each Turn it renders in the Discussion timeline, and passes that `quote` state through to EpicComposer as a new `quote`/`onClearQuote` prop pair.
- [ ] EpicComposer.tsx renders a dismissible strip above its textarea when `quote` is set: an accent-colored left border, the quoted text (truncated with an ellipsis if long — reuse whatever truncation convention exists elsewhere in this file, or a simple CSS line-clamp), and an X button calling onClearQuote. The quote clears automatically after a successful submit() (does not persist across the epic.id reset effect that already exists — verify it doesn't fight with that effect).
- [ ] The quoted text is NOT silently prepended into the sent prompt text (that would be a decision to make text-processing choices for the user) — it's purely a visual reply-context affordance; the user still types their own follow-up in the textarea. Confirm this matches the design mock's TReply/quote intent (session-manager-operations/design-mocks/epics/epic-thread-mock.jsx) before assuming otherwise.
- [ ] `npm run typecheck` passes; `timeout 120 npx vitest run src/renderer/components/epics/__tests__` passes with no regressions; add at least one new test asserting the quote strip appears after clicking Quote on a turn and clears on X / after send.

# Implementation notes

EpicComposer.tsx (read in full earlier this session) currently has no quote-related props at all — its Props interface is `{ epic, snapshots, onSent? }`; add `quote?: string` and `onClearQuote?: () => void`. EpicDetail.tsx (also read in full earlier) renders `<Turn turn={t} cwd={cwd} tabId={epicId} sessionId={sessionId} ... />` inside the `timeline.map(...)` block in its Discussion view — add the onQuote wiring there. Design intent reference only (do not port inline styles or JSX structure): session-manager-operations/design-mocks/epics/epic-thread-mock.jsx describes TUser's hover Quote button and the reply-context strip; translate the INTENT to this codebase's existing Tailwind/Almanac token conventions (see how EpicComposer.tsx already styles its drag-over hint and attach tray for the established pattern), not the mock's inline hex styles.

# Out of scope

- Prepending quoted text into the sent prompt automatically
- Quote support in the Terminal/raw-session transcript view (Discussion-only for now)
- The row-menu rename/duplicate/delete work (separate PRDs)

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
