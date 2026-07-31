---
title: Fix chatRunner exit/close race dropping final text-only turns
cwd: ~/Projects/session-manager
estimateMinutes: 20
---
# Goal

A chat turn run via `src/main/chatRunner.cjs` (headless `claude -p --output-format stream-json`) that ends in plain assistant text with no trailing tool call can silently fail to surface in the renderer's chat UI. Root cause (already investigated — do not re-diagnose): the child process's terminal-event fallback is wired to `child.on('exit', ...)` (chatRunner.cjs:610-639) rather than `child.on('close', ...)`. Node only guarantees all buffered stdout 'data' events have been delivered by 'close', not 'exit'. When the final stdout write (last assistant text line + the terminating `result` JSON line) hasn't yet reached the 'data' handler (chatRunner.cjs:587-594) at the moment 'exit' fires, the exit-fallback branch runs first: it sets the one-shot `terminalSent` latch (chatRunner.cjs:398-406) and broadcasts a misleading `chat:run:error` ("process exited without a result event"). When the real final chunk arrives moments later, `processLine` correctly parses the `result` event and tries to call `emitTerminal('chat:run:complete', ...)` but it silently no-ops because `terminalSent` is already true — the genuine assistant answer is dropped. This explains the tool-call asymmetry: a turn with a preceding tool call has real wall-clock gaps between stdout writes (tool execution time) so no race occurs; a turn ending in plain text can have its last text line and result line flush in the same final write, immediately followed by process exit — the tightest possible race window.

# Acceptance criteria

- [ ] Read session-manager-operations/feedback/processed/2026-07-27-01-chat-final-text-turn-not-surfaced.md (after this triage pass archives it) for the full incident report before starting.
- [ ] The exit-fallback listener in chatRunner.cjs (currently child.on('exit', ...) around line 610) is changed so a legitimately-completed result event that arrives after 'exit' but before stdout is fully drained still wins over the generic fallback error — e.g. switch to child.on('close', ...) (which Node guarantees fires after all stdout data has been delivered) or otherwise close the race so processLine's real emitTerminal('chat:run:complete', ...) is not blocked by an already-set terminalSent latch from a premature fallback.
- [ ] A new test simulates a child process emitting its final assistant text block and the terminating result JSON line in a single stdout write immediately before the process exits, and asserts chat:run:complete is broadcast (not the generic exit-fallback chat:run:error).
- [ ] Existing behavior for a genuinely hung/crashed process (child exits or is killed with no result event ever emitted) still correctly fires the fallback chat:run:error — do not remove that safety net, only fix its race against a real completion.
- [ ] timeout 300 npm run typecheck passes.
- [ ] The relevant test file (locate chatRunner's existing test suite, e.g. src/main/chatRunner.test.* or similar naming) passes: timeout 120 npx vitest run <that file>.

# Implementation notes

Read `~/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md` before writing any code — it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply to this PRD; every rule in it is mandatory, especially Execution discipline (bounded commands, verify before done, the finish-protocol sentinel).

Key files/lines: `src/main/chatRunner.cjs:516-518` (per-text-block `chat:run:output` emit), `:519-522` (per-tool_use `chat:run:tool-use` emit), `:398-406` (`emitTerminal`'s one-shot `terminalSent` latch — "Guarantees the renderer receives EXACTLY ONE terminal event per run"), `:539-576` (result-event handling — the one true completion path), `:587-594` (stdout 'data' handler / processLine), `:610-639` (the buggy `child.on('exit', ...)` fallback that races against late-arriving stdout data).

Renderer side was already checked and has no exclusionary logic (this is a main-process-only bug): `state/chat.ts` (`pushTurn`/`onComplete`) and `assistantTurnPresentation.ts:11-15` render any non-empty finalMessage as text regardless of whether the turn had tool calls — no renderer change needed, confirm this stays true after the fix but don't add renderer changes unless the fix surfaces a genuine second issue there.

Full incident report + investigation notes are in `session-manager-operations/feedback/processed/2026-07-27-01-chat-final-text-turn-not-surfaced.md` (this triage pass archives it there) — read it in full before designing the fix.

# Out of scope

- Renderer-side changes to state/chat.ts or assistantTurnPresentation.ts — investigation found no bug there; this is a main-process race only.
- Redesigning the chat:run:* IPC event protocol beyond fixing this one race.

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
