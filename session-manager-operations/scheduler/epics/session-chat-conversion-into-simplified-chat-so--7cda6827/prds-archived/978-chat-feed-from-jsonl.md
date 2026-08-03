---
title: Chat view reads the JSONL transcript as its source of truth
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 24
sourcePromptId: session-chat-conversion-into-simplified-chat-so--7cda6827
dependsOn: [transcript-classifier-multi-emit]
---
# Goal

The Epic Chat view currently renders from chatRunner.cjs's stream-json output, which is a strictly thinner feed than the on-disk JSONL transcript. Whole classes of real session events exist ONLY in the JSONL and are therefore unreachable by Chat today — verified counts across the last 20 real sessions: attachment 317, last-prompt 252, ai-title 217, queue-operation 122, mode 94, permissionMode 24, file-history-snapshot 5. Make the JSONL tail the source of truth for the Chat view's transcript, demoting chatRunner's stream to a low-latency live tap for in-flight text only. Without this, the typed-renderer PRD downstream has no data to render.

# Acceptance criteria

- [ ] Read src/renderer/state/chat.ts in full first (ChatTurn/ChatTurnRole/ToolUseTrace shapes, the chat:run:* IPC event handlers, pushTurn call sites), plus src/main/chatRunner.cjs's stream-json handling (the `event.type === 'assistant' | 'user' | 'result'` branches around lines 643-720), and src/main/transcripts.cjs's subscribe/release/closeTab lifecycle.
- [ ] CORE: an Epic's Chat view renders its transcript from the JSONL events emitted by transcripts.cjs for that Epic's claudeSessionId, not from chatRunner's stream-json. Verify by confirming a `mode`, `queue-operation` or `attachment` event — none of which exist in chatRunner's stream — reaches the Chat view's store.
- [ ] CORE: chatRunner's stream remains wired as a live tap so in-flight assistant text still streams token-by-token with no added latency; the JSONL is authoritative once the line lands. Document the reconciliation rule in a code comment: how a streamed-then-persisted turn is de-duplicated so the user never sees the same assistant text twice.
- [ ] EDGE: a headless Chat run and an attached Terminal session are mutually exclusive views over ONE claude session (see CLAUDE.md domain model). Confirm switching views mid-Epic does not duplicate, drop, or reorder transcript history.
- [ ] EDGE: an Epic whose JSONL transcript does not yet exist (brand-new session, first prompt not yet written to disk) renders an empty-but-valid Chat view rather than erroring or spinning forever.
- [ ] EDGE: transcripts.cjs handles inode-change rotation and truncation by resetting offset; confirm a rotated transcript mid-session does not wedge the Chat view.
- [ ] INTERACTION EFFECT: transcripts.cjs enforces MAX_TRANSCRIPT_SUBS = 20 and an LRU_CAP = 6 pool of released subs. Chat now holds a subscription per open Epic — confirm opening many Epics does not silently evict a live Chat view's own subscription. State the resulting cap behavior explicitly in a code comment.
- [ ] INTERACTION EFFECT: must not regress the Terminal view, which already consumes the same transcript:event:<tabId> broadcast. Grep every subscriber before changing the broadcast shape.
- [ ] INTERACTION EFFECT: appendResponseEvent / capturePromptSessionTurn in chat.ts persist Epic turns to promptSessionTranscript.cjs. Confirm the feed change does not double-write or drop those persisted turns — they back the Epic event chain and the expand-to-full-text path.
- [ ] Unit tests cover: a JSONL-only event kind reaching the chat store; the streamed-then-persisted de-duplication rule; the empty/missing-transcript case.
- [ ] `npm run typecheck`, `npm run test:unit`, and `node scripts/check-unstable-selectors.cjs` all pass.

# Implementation notes

Depends on transcript-classifier-multi-emit having landed — read its actual landed diff first to confirm the event shape (array emit, preserved top-level fields, { previewText, ref } payload) before building against it; its scope may have shifted during execution.

Key files: src/renderer/state/chat.ts (the store; note ChatTurnRole is currently a 5-value union 'user'|'assistant'|'question'|'error'|'notice' — it will need to widen, but keep that widening minimal here and leave presentation to the renderer PRDs). src/main/transcripts.cjs (subscribe({ tabId, cwd, sessionUuid }), release(tabId), closeTab(tabId), the transcript:event:<tabId> broadcast). src/main/chatRunner.cjs (stream-json branches ~643-720). src/renderer/state/live.ts already subscribes to the same broadcast — follow its subscription/teardown pattern rather than inventing a second one.

CLAUDE.md invariant that constrains this: EPIC : claude-session is 1:1, and Chat and Terminal are two VIEWS over that ONE session (mutually exclusive attachment). tabId equals the Epic's claudeSessionId in the Epic-rendered case — chat.ts's capturePromptSessionTurn already relies on exactly that identity, use it rather than adding a new id mapping.

Do not cross-subscribe zustand stores (CLAUDE.md 'Avoid'): chat.ts must not read live.ts or vice versa. Both may independently subscribe to the same IPC broadcast.

Do not return freshly-built values from zustand selectors (CLAUDE.md 'Avoid', three prior blank-app incidents) — select raw slices, derive in the component, and keep scripts/check-unstable-selectors.cjs green.

# Out of scope

- Adding typed renderers for the newly-reachable event kinds (separate PRD — this one only makes the data reach the store)
- Replacing the 500-entry ring buffer with paged reads (separate PRD)
- Any change to the three-zone turn frame or grounding-card rendering
- Removing chatRunner's stream entirely — it stays as the live tap

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
