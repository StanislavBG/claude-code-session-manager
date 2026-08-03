---
title: Replace the 500-entry transcript ring buffer with indexed paged reads
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 26
sourcePromptId: session-chat-conversion-into-simplified-chat-so--7cda6827
dependsOn: [transcript-classifier-multi-emit]
---
# Goal

src/main/transcripts.cjs caps each subscription's in-memory buffer at 500 entries (`if (sub.buffer.length > 500) sub.buffer.shift()`) and, on first attach to a large transcript, seeks to the last 8 MB and discards everything before it (MAX_DELTA_BYTES). Both silently destroy history on any long-running Epic, which directly contradicts the Simplified Chat promise that nothing is hidden. Replace the memory buffer with an indexed, line-offset-based paged read over the transcript file so the Chat view can scroll back to the first event of a session without holding it all in RAM.

# Acceptance criteria

- [ ] Read src/main/transcripts.cjs in full first, especially readDelta() (the inode-change reset, the stat.size < sub.offset truncation reset, and the MAX_DELTA_BYTES seek-to-tail branch with its deliberate readFrom-1 partial-line boundary handling).
- [ ] CORE: build a line-offset index per subscribed transcript (byte offset + length per JSONL line) maintained incrementally as readDelta consumes new bytes. The index, not the parsed events, is what persists in memory.
- [ ] CORE: a paging API returns events for an arbitrary [startLine, endLine] window by reading only those byte ranges from disk. Scrolling to the top of a session with more than 500 events returns the genuine first event, not a truncated window.
- [ ] CORE (RISK — state this explicitly in a code comment): the MAX_DELTA_BYTES seek-to-tail exists because materializing a several-hundred-MB transcript into a Buffer plus a decoded string OOM-killed the main process. Paging MUST be an indexed positional read (fd.read with explicit offset/length) and MUST NEVER read the whole file into memory, not even transiently, and not via fs.readFile.
- [ ] TESTS/BOUNDS: add a test asserting bounded memory — indexing a synthetic transcript with a very large number of lines (and at least one multi-MB single line) keeps resident event/index memory under an explicit, asserted ceiling. The assertion must be a real numeric bound, not a comment.
- [ ] EDGE: inode-change rotation and file truncation invalidate the index and rebuild it; a rotated transcript mid-session does not serve stale or misaligned offsets. Test both.
- [ ] EDGE: a partial trailing line (a JSONL line still being written) is never indexed as complete and is picked up correctly on the next flush — preserve readDelta's existing sub.pending semantics.
- [ ] EDGE: a malformed/unparseable JSON line is skipped for rendering but still occupies its index slot, so line numbering and offsets stay correct.
- [ ] INTERACTION EFFECT: transcripts.cjs's LRU pool (LRU_CAP = 6 released subs, MAX_TRANSCRIPT_SUBS = 20) currently preserves sub.buffer across a release/re-subscribe so a tab-switch resumes from the persisted offset rather than re-reading from byte 0. Preserve that fast-resume property with the index in place of the buffer, and test it.
- [ ] INTERACTION EFFECT: the initial-drain path emits to OTEL via otel.recordTranscriptEvent for backfilled transcripts. Confirm paging does not re-emit already-recorded events on every page request.
- [ ] `npm run typecheck`, `npm run test:unit`, and `npm run health` all pass.

# Implementation notes

Depends on transcript-classifier-multi-emit — read its landed diff first. That PRD already threads a per-line byte reference ({ filePath, byteOffset, byteLength }) through classification for the expand-to-full-text path; the index this PRD builds is the same data, so REUSE it rather than computing offsets a second time. If the two representations diverge, consolidate to one — CLAUDE.md's API-reuse / single-source-of-truth rule applies.

Primary file: src/main/transcripts.cjs. Relevant existing constants and behavior, quoted so you do not have to grep: MAX_DELTA_BYTES = 8 * 1024 * 1024; LRU_CAP = 6; MAX_TRANSCRIPT_SUBS = 20; the ring cap is a bare `if (sub.buffer.length > 500) sub.buffer.shift()` inside doFlush.

readDelta already opens an fd and does a positional `fd.read(buf, 0, length, readFrom)` — that is exactly the primitive paging needs; extend that pattern rather than introducing a new stream/readline dependency.

scheduleFlush's dirty-flag trailing-edge re-run guarantees no event is dropped when chokidar fires mid-flush. Keep that invariant intact — index maintenance must happen inside the serialized flush, not in a parallel path.

Expose paging over the existing IPC surface; validate any renderer-supplied line range at the main-process boundary (src/main/ipcSchemas.cjs holds the zod schemas — follow that pattern, do not hand-roll validation). All paths must still go through config.cjs's validatePath allowedRoots discipline.

# Out of scope

- Renderer-side virtualized scrolling UI (this PRD delivers the data layer and its API; the Chat view wiring is the renderer PRDs' job)
- Changing what gets classified or how events are shaped
- Persisting an index to disk across app restarts — rebuild in memory on subscribe
- Any change to Terminal view rendering

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
