---
title: Epics redesign 3/8 — EpicDetail shell + Discussion view (header, meta, tabs, thread)
cwd: ~/Projects/session-manager
estimateMinutes: 20
sourcePromptId: implement-the-redesigned-two-pane-epics-workspac-7781682f
---

# Goal

Build the right "Epic detail" pane shell and its Discussion view as
`src/renderer/components/epics/EpicDetail.tsx`, per
`session-manager-operations/design-mocks/epics/DESIGN_SPEC.md` (§"Right pane") and the decoded
mock `session-manager-operations/design-mocks/epics/epics-mock.jsx` (EpicDetail/Turn/
ToolStrip — translate inline styles to Tailwind Almanac tokens). This supersedes
`PromptSessionConversation.tsx` as the Epic conversation surface (that file is retired by
PRD 829, not here).

# Acceptance criteria

## Core functionality

- [ ] Header: `EpicStatusChip` + `EpicKindTag` (from `epics/epic-primitives.tsx`, PRD 827
  sibling — if it hasn't landed yet, define them here and the sibling reuses) + project tag
  (`projectColorFor` from `src/renderer/lib/projectColor.ts` — do NOT copy the duplicate
  `EPIC_BADGE_PALETTE` in PromptSessionConversation.tsx); serif title (font-serif, ~text-2xl),
  goal paragraph; action buttons: "Open raw session" (calls an `onOpenRawSession` prop — the
  navigation target is wired in PRD 829), "Mark completed" for active Epics (calls
  `usePromptSessions.markCompleted`), "Resume" for completed Epics (calls `resumeArchived`).
  These two actions MUST exist here — the old ProjectsLanding rows were their only UI and
  PRD 829 retires those.
- [ ] Meta row: opened (createdAt), last activity, turns + tool calls when `epicStats` returns
  data (omit when null). Label muted + mono value, per the mock's EMeta.
- [ ] View tabs "Discussion N | PRDs N | Runs N" using `ui/ViewTabs.tsx`; PRDs/Runs panels
  render placeholder empty states here (real content is PRD 828's sibling); tab state resets
  to Discussion on epic change.
- [ ] Discussion view: merged timeline exactly as `PromptSessionConversation.tsx:96-103` does
  today (chat turns from `useChat` hydrated via `window.api.exchanges.list`, interleaved with
  `prd_created`/`closed` events from `usePromptSessions`), rendered with the existing `Turn`
  from `src/renderer/components/ChatTranscriptTurn.tsx`. Above the thread: an attached-PRD
  chip strip (from `epicPrds`) whose chips switch to the PRDs tab. `prd_created` events render
  as chips that call the existing `openPrdSlug` mechanism.
- [ ] Per-assistant-turn collapsible ToolStrip: "used N tools" / "working · N tools" button
  expanding to per-tool ×count chips, from `ChatTurn.toolUses` (`state/chat.ts:34-43`). If
  `ChatTranscriptTurn` already renders tool uses, extend it behind a prop rather than forking
  a parallel turn renderer (API-reuse standard).
- [ ] Needs-input turns (chat `questions` pending) get the red-tinted card treatment + "NEEDS
  YOUR DECISION" mono label, with the existing answer-option buttons still functional.
- [ ] Thread auto-scrolls to bottom on epic switch and on switching back to the Discussion tab.

## Edge cases

- [ ] Completed (archived) Epic: Discussion renders from the archived events (hydrated by
  PRD 826), composer area is absent/disabled (composer itself is PRD 827-composer), and
  "Resume" is offered instead of "Mark completed".
- [ ] Epic with no chat turns yet: shows the goal as the seed context, no crash.

## Tests

- [ ] vitest jsdom tests: header renders status/kind/actions correctly for active vs
  completed; timeline interleaving (chat turn + prd_created chip ordering by timestamp);
  needs-input styling branch; tab switching resets on epic change. `timeout 300 npx vitest
  run <new files>` passes; `timeout 300 npm run typecheck` and `npm run lint:selectors` pass.

# Implementation notes

Depends on PRD 826 (epicDerive.ts, archived hydration). Read
`src/renderer/components/PromptSessionConversation.tsx` first — reuse its timeline merge,
`respondedTurnIds` guard (chat.ts effect at ~line 109), and `openPrdSlug` import; keep that
file compiling (PRD 829 deletes it). `useChat.hydrate({tabId: epicId, cwd, sessionId:
claudeSessionId})` is one-shot per key — call it on mount/epic change like the current
component does. ViewTabs: `src/renderer/components/ui/ViewTabs.tsx`. Almanac tokens from
`tailwind.config.js`. Wave siblings (827-epic-queue-pane, 827-epic-composer,
827-new-epic-card) run in parallel — touch only your own files plus `epic-primitives.tsx`
additions; coordinate by keeping that file append-only.

# Out of scope

- PRDs/Runs tab real content (PRD 828 sibling).
- The composer (827-epic-composer) and New Epic card (827-new-epic-card).
- Mounting, navigation, deep links, retiring PromptSessionConversation (PRD 829).
- "Split into" affordance, branch display, token counts (dropped — no data source).

## Engineering standards

Before writing any code, read
`/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md`
— it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply
to this PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands,
verify before done, the finish-protocol sentinel).
