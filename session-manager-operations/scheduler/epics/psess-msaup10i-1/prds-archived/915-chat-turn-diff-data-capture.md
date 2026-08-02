---
title: Capture Edit/Write tool-use diff payloads through to ChatTurn
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 25
sourcePromptId: psess-msaup10i-1
---
# Goal

The Epics design mock renders a colored, collapsible diff card (file header, +/- line counts, Accept/Retry/Reject) whenever the agent edits a file — the real app has NO equivalent: `ChatTurn.toolUses` (src/renderer/state/chat.ts) only carries `{id, kind, label}`, with no diff content, so a real Edit/Write tool call just shows a generic "used N tools" chip and the agent's own prose description. Confirmed the underlying data DOES exist and is already classified: src/main/lib/classifyTranscriptLine.cjs's `classifyLine()` already returns `{ kind: 'tool_use', data: { name: block.name, input: block.input, id: block.id } }` for every tool call — for an Edit tool call, `input` carries `file_path`/`old_string`/`new_string` (or equivalent fields depending on the tool schema); for Write, `file_path`/`content`. This PRD threads that already-classified data through to the renderer-side ChatTurn shape — NO new main-process capture logic is needed, only wiring. Rendering the diff itself is a SEPARATE, dependent PRD (chat-turn-diff-rendering) — this PRD is data-plumbing only.

# Acceptance criteria

- [ ] Read src/main/lib/classifyTranscriptLine.cjs in full (37-90 lines, already read this session) and src/main/transcripts.cjs's consumption of `classifyLine()`'s output (around lines 114-125) to see exactly how a 'tool_use' event's `data.input` currently flows (or doesn't) into whatever the renderer subscribes to.
- [ ] Trace forward from there into src/renderer/state/chat.ts's toolUses-building logic (wherever ToolUseTrace entries are constructed from live transcript events) and confirm/verify whether `input` is available at that point or gets dropped earlier in the pipeline — do not assume; verify by adding a temporary log or reading the actual data shape if uncertain.
- [ ] Extend `ToolUseTrace` (chat.ts) with an optional `diff?: { filePath: string; oldText?: string; newText?: string } ` (or a shape that matches whatever the real Edit tool's `input` schema actually uses — verify the field names against a real Edit tool_use payload rather than guessing 'old_string'/'new_string' blindly) populated ONLY for Edit/Write tool_use events, left undefined for every other tool kind.
- [ ] Cap the captured diff content size (reuse whatever existing raw-content size guard this pipeline already has — grep MAX_RAW_STR in classifyTranscriptLine.cjs — apply an equivalent cap here) so a huge file write doesn't bloat the in-memory ChatTurn/localStorage-persisted chat state.
- [ ] Add unit test coverage asserting an Edit tool_use event produces a ToolUseTrace with the expected `diff` payload, and a non-Edit/Write tool_use event does NOT get a `diff` field.
- [ ] `npm run typecheck` passes; existing chat.ts/transcripts tests pass with no regressions.

# Implementation notes

This is exploratory data-tracing work — the exact field names Claude Code's Edit tool uses in its `input` object (old_string/new_string vs from/to, etc.) must be verified against a real transcript line, not assumed. If a real transcript with an Edit tool_use is available under ~/.claude/projects/<encoded-cwd>/*.jsonl, read one line directly to confirm the shape before writing the type.

# Out of scope

- Rendering the diff in the UI (separate dependent PRD chat-turn-diff-rendering)
- Plan-step or permission-gate data capture (ExitPlanMode already classifies as kind:'plan' separately — out of scope for this PRD unless trivially free to include; note in your own PR if you find it's free)

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
