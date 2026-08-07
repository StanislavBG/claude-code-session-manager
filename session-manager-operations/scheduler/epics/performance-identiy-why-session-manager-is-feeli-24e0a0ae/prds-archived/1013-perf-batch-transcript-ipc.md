---
title: Perf P8: batch transcript events into one IPC message and one store commit per flush tick
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 45
sourcePromptId: performance-identiy-why-session-manager-is-feeli-24e0a0ae
sourceTabId: performance-identiy-why-session-manager-is-feeli-24e0a0ae
---
# Goal

transcripts.cjs's doFlush sends ONE IPC message per classified event (`sendIfAlive(window, 'transcript:event:' + sub.tabId, ev)` inside a per-event loop at transcripts.cjs:144-146), and the renderer does one zustand commit per received event — live.ts:340 runs `set({ tabs: { ...get().tabs, [tabId]: next } })`, an O(tabs) object spread, once per event, and chat.ts's ingestTranscriptEvent likewise. One JSONL line can classify into several events, and measured peak burst on a real local transcript is 11 lines in a single second, so a single flush can fan out into dozens of IPC round-trips and dozens of store notifications where one would do. Batch per flush: one message carrying the event array, one store commit applying them all.

# Acceptance criteria

- [ ] transcripts.cjs's doFlush accumulates the events produced by one flush and sends them as a SINGLE IPC message per tab (an array payload), instead of one message per event.
- [ ] The preload wrapper and the renderer subscription accept the batched payload. Whether the renderer-facing onEvent callback signature stays per-event (with the preload fanning the array out) or becomes array-shaped is the implementer's call — state which was chosen and why in the result.
- [ ] live.ts applies a whole batch with ONE `set()` call rather than one per event, so N events cause 1 store notification, not N.
- [ ] chat.ts's ingestTranscriptEvent path likewise commits once per batch.
- [ ] Event ORDER is preserved exactly — transcript events are causally ordered and the feed's dedupe logic (findRecentDuplicateTurn / turnIdentity) depends on it. Add a test asserting order is identical to the pre-batch behaviour for a multi-event flush.
- [ ] No event is dropped or duplicated: a test feeds a fixture transcript through the batched path and asserts the resulting store state is byte-identical to what the per-event path produced for the same input.
- [ ] The OTEL mirror (otel.recordTranscriptEvent, transcripts.cjs:152) still records one span per event, not one per batch.
- [ ] Backpressure is bounded: a very large flush (e.g. an 8 MB delta replayed at once) must not produce one unbounded array — cap the batch size with a named constant and send multiple batches if exceeded. State the cap in the result.
- [ ] A benchmark or test reports IPC message count and store-commit count before and after for a fixture flush containing at least 20 events.
- [ ] timeout 300 npm run typecheck passes.
- [ ] timeout 600 npm run test:unit passes.
- [ ] timeout 120 npm run lint passes.

# Implementation notes

Target project: /home/bilko/Projects/session-manager

Key files: src/main/transcripts.cjs (doFlush per-event loop 144-160, MAX_DELTA_BYTES 48, MAX_TRANSCRIPT_SUBS 281), src/preload/index.cjs (transcripts.onEvent wrapper), src/renderer/state/live.ts (per-event commit at 340), src/renderer/state/chat.ts (attachTranscriptFeed / ingestTranscriptEvent around 1173-1179).

This is the documented renderer data flow (CLAUDE.md: main process -> IPC broadcast -> store subscription -> selector -> component hook). Batching changes the granularity of step 1-2 only; do not change the store-island rule (no cross-store subscription) or introduce a shared event bus.

live.ts's commit currently spreads the entire `tabs` map per event. Batching should also mean spreading it once per batch rather than once per event — that is where most of the win is, not the IPC round-trip itself.

There is an existing paged-read path (readPage) that deliberately does NOT touch OTEL — keep that separation intact.

Regression risk to watch: chat.ts's dedupe compares `turnIdentity` within a DEDUP_WINDOW of trailing turns and UPGRADES an optimistic turn in place. If batching changes the order or the timing of when turns land relative to the optimistic push, duplicate bubbles reappear in the Discussion — the exact bug the asymmetry at chat.ts:955-994 was written to fix. Test this explicitly.

Tests that seed ~/.claude/projects folders must delete them in afterEach — leaked fixture dirs previously caused phantom-project bugs (see transcripts-doFlush-array / transcripts-paged-reads).

Main-process tests live in src/main/__tests__/; renderer tests use vitest.

# Out of scope

- Changing MAX_DELTA_BYTES, MAX_TRANSCRIPT_SUBS or the LRU cap
- Changing how lines are classified into events (classifyLine)
- Adding a shared/global event bus across zustand stores
- Virtualizing any list

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
