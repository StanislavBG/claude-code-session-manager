---
title: classifyLine becomes multi-emit and stops destroying data at classify time
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 22
sourcePromptId: session-chat-conversion-into-simplified-chat-so--7cda6827
---
# Goal

src/main/lib/classifyTranscriptLine.cjs is lossy at three verified points, and every downstream Chat/Terminal rendering improvement is blocked on fixing them. (a) The `for (const block of content)` loop `return`s on the FIRST tool_use block, so an assistant message containing text plus 3 tool calls emits ONE event and the text plus 2 calls are silently discarded. (b) The `if (obj.usage || msg?.usage)` check runs first, so any message carrying both usage and content is classified 'usage' and its content is never emitted at all. (c) `makeRaw()` keeps only `message.content`, discarding every top-level field on the line. Make classifyLine return an ARRAY of events per line, preserve the whole line, and replace classify-time string truncation with a byte-offset reference so full payloads stay recoverable without holding them in memory.

# Acceptance criteria

- [ ] Read src/main/lib/classifyTranscriptLine.cjs in full before changing it, plus its three consumers: src/main/transcripts.cjs (doFlush), src/renderer/state/live.ts (ingest, the switch at ~line 193), and src/main/otel.cjs (recordTranscriptEvent).
- [ ] classifyLine(obj) returns an ARRAY of events (empty array instead of null for an unclassifiable line). No call site may assume a single object.
- [ ] CORE: an assistant message whose content array holds [text, tool_use, tool_use] emits 3 events, not 1. Unit test asserts exactly this.
- [ ] CORE: a message carrying BOTH a usage field and a non-empty content array emits the usage event AND the content event(s). Unit test asserts exactly this — this is the bug where usage short-circuits everything.
- [ ] CORE: makeRaw() preserves every top-level field on the line, not just message.content. Specifically these must survive to the renderer (all verified present in real transcripts): attributionSkill, attributionPlugin, attributionMcpServer, attributionMcpTool, effort, gitBranch, isSidechain, isMeta, requestId, isApiErrorMessage, interruptedByShutdown, permissionMode, promptSource, toolUseResult.
- [ ] CORE: replace MAX_RAW_STR classify-time truncation with a bounded preview PLUS a byte reference. Each event carries { previewText, ref: { filePath, byteOffset, byteLength } } so the full untruncated line can be re-read from disk on demand. Do NOT simply delete the truncation and store full text — a large Read tool_result in a 500-entry buffer is a memory cliff. The preview cap belongs to the event; the full payload stays on disk.
- [ ] INTERACTION EFFECT (load-bearing, do not skip): src/renderer/state/live.ts derives todos/agents/usage per ingested event. A line that previously emitted 1 event now emits up to N, so agent_spawn, tool_result and usage accounting can DOUBLE-COUNT. Audit every case in that switch and add a unit test proving a multi-block message does not double-count agents or usage.
- [ ] INTERACTION EFFECT: classifyTranscriptLine.cjs's own header comment states that `raw` is structurally parsed by orchestrator.ts and race.ts, and that tool_result/tool_use are EXEMPT_TYPES for that reason. Grep both files, confirm what they read off `raw`, and prove with a test that the new shape does not break their digest parsing.
- [ ] transcripts.cjs doFlush handles the array shape and still enforces its 500-entry ring cap across the flattened event stream (not per line).
- [ ] otel.recordTranscriptEvent is called once per emitted event, not once per line; confirm this does not change the meaning of any existing OTEL query.
- [ ] `npm run typecheck` passes.
- [ ] `npm run test:unit` passes with no regressions, and `node scripts/check-unstable-selectors.cjs` passes.

# Implementation notes

Primary file: src/main/lib/classifyTranscriptLine.cjs (~90 lines, exports MAX_RAW_STR, EXEMPT_TYPES, trimContentArray, makeRaw, classifyLine).

Current lossy control flow, quoted so you do not have to grep:
  if (obj.usage || msg?.usage) return { kind: 'usage', ... }   // <- (b), runs before content is ever examined
  if (Array.isArray(content)) { for (const block of content) { ... return ... } }  // <- (a), returns on first match
  function makeRaw(obj) { return { message: { content: trimContentArray(obj?.message?.content) } } }  // <- (c)

Consumers to update: src/main/transcripts.cjs doFlush() (the `const ev = classifyLine(obj); if (!ev) continue;` block, ~line 105); src/renderer/state/live.ts ingest switch (~line 193, cases todo_write/tool_use/plan/agent_spawn/usage/tool_result plus an explicit `default: break`); src/main/otel.cjs recordTranscriptEvent.

The byte reference is cheap to produce: readDelta in transcripts.cjs already tracks sub.offset and splits on newlines, so the absolute offset of each line is known at parse time — thread it through rather than re-deriving it.

Keep classifyLine a PURE function of (obj, ref) so it stays unit-testable without fs. Existing tests live under src/main/__tests__/ — check for an existing classify test file and extend it rather than adding a parallel one.

This PRD is the gate for the rest of the Simplified Chat chain; do not also change any rendering.

# Out of scope

- Any renderer/UI change — this PRD is main-process + store ingest only
- Changing the Chat view's feed source (separate PRD)
- Replacing the 500-entry ring buffer with paged reads (separate PRD)
- Adding new typed renderers for attachment/mode/queue-operation events (separate PRD)

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
