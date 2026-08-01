---
title: Render live streaming output and tool-use activity in the Epic chat thread
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 18
---
# Goal

After sending a message in an Epic, the user sees nothing at all until the whole turn finishes. src/renderer/state/chat.ts:749 accumulates `chat.stream` from every `chat:run:output` delta and :752 records `chat:run:tool-use`, but NO component reads either — a grep for `.stream` across src/renderer/components returns only comments (EpicDetail.tsx:273, EpicsWorkspace.tsx:37), and src/renderer/lib/useChatSignals.ts:7-9 deliberately excludes it. EpicDetail.tsx renders only completed `turns`, so the entire turn is dead air. Render the in-flight stream as a live assistant bubble and surface tool-use as visible operation chips in the thread, so the session's operations are reported back to the user as they happen.

# Acceptance criteria

- [ ] ## Core functionality
- [ ] - [ ] While a turn is in flight for the selected Epic, src/renderer/components/epics/EpicDetail.tsx renders the accumulating `chat.stream` text as a live assistant bubble at the tail of the timeline, updating as `chat:run:output` deltas arrive.
- [ ] - [ ] Tool-use events recorded by the `chat:run:tool-use` handler (src/renderer/state/chat.ts:752) render as visible chips/lines in the same thread, showing which operation the session is performing.
- [ ] - [ ] When `chat:run:complete` fires and `pushTurn` appends the finished assistant turn, the live bubble is replaced by that turn with no duplicated text and no flicker of both at once.
- [ ] ## Edge cases
- [ ] - [ ] `stream` is reset to empty on completion AND on `chat:run:error` (chat.ts:801) and on cancel, so it cannot grow unbounded across turns. Verify the reset in `pushTurn` (chat.ts:371) actually covers every terminal path; add the missing ones.
- [ ] - [ ] A queued turn (`chat:run:queued`, chat.ts:743) shows its queue position rather than an empty live bubble.
- [ ] - [ ] Switching the selected Epic mid-stream does not leak the previous Epic's partial stream into the newly selected thread — the live bubble is keyed by epic id.
- [ ] ## Interaction / integration
- [ ] - [ ] The live bubble is derived in the component from the raw `chats[epicId]` slice already selected at EpicDetail.tsx:223 — do NOT return a freshly-built value (array/object literal, .map/.filter) from a zustand selector. That pattern causes React #185 and a blank app; see the CLAUDE.md 'Avoid' section and `npm run lint:selectors`.
- [ ] - [ ] If `useChatSignals` (src/renderer/lib/useChatSignals.ts) needs the stream, extend it deliberately rather than bypassing it in one component; if it stays excluded, update its comment at :7-9 to say why now that a consumer exists.
- [ ] ## Tests
- [ ] - [ ] Vitest coverage for: stream accumulation rendering, replacement on complete, reset on error/cancel, and epic-id keying on selection switch.
- [ ] - [ ] `timeout 300 npm run lint:selectors` passes.
- [ ] - [ ] `timeout 300 npm run typecheck` passes.
- [ ] - [ ] `timeout 300 npm run test:unit` passes.

# Implementation notes

Live surfaces (note: PromptSessionConversation.tsx no longer exists — it was retired in PRDs 827/829; stale references remain in comments):
- src/renderer/components/epics/EpicDetail.tsx — thread render. `const chat = useChat((s) => s.chats[epicId])` at :223, `turns` at :250, `timeline` composed at :256-263 (chat turns merged with usePromptSessions events), mapped at :486-535 with the `<Turn>` component at :492-504. This is where the live bubble and tool chips belong.
- src/renderer/components/epics/EpicComposer.tsx — composer, `submit()` at :144-164.
- src/renderer/components/epics/EpicsWorkspace.tsx — mounts both, :200-202.

Store: src/renderer/state/chat.ts. Broadcast subscriptions are module-load-time at :742-819. `chat:run:output` -> `c.stream += delta` at :749; `chat:run:tool-use` at :752; `chat:run:complete` -> `pushTurn` at :755; `pushTurn` itself at :371; `chat:run:error` at :801; `chat:run:queued` at :743.

Preload listeners: src/preload/index.cjs:388-431. Emitters: src/main/chatRunner.cjs `broadcast()` at :356, output at :606, tool-use at :611.

Follow the existing Almanac visual language — reuse chips/badges from src/renderer/components/tabs/scheduler/sched-primitives.tsx or the existing Turn styling rather than inventing new primitives. Import primitives by explicit name, never wildcard.

Do not write interactive/GUI acceptance criteria — a headless claude -p run cannot drive the Electron GUI. Prove behavior with vitest over the store + component render, not by launching the app.

# Out of scope

- Any main-process changes to chatRunner.cjs
- The promptSession response-event broadcast (sibling PRD)
- Redesigning the Epic thread layout beyond adding the live bubble and tool chips
- Launching the Electron app for visual confirmation

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
