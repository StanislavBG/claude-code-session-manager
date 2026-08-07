---
title: Perf P5a: add a bounded read to config.readText and stop reading whole transcripts to resolve a project cwd
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 35
sourcePromptId: performance-identiy-why-session-manager-is-feeli-24e0a0ae
sourceTabId: performance-identiy-why-session-manager-is-feeli-24e0a0ae
---
# Goal

First paint of Home / Epics pays ~2000 whole-file reads across the IPC boundary. useKnownProjects.ts's resolveProjectCwd calls window.api.config.readText(f.path) per project folder, and config.cjs:202's readText is an unbounded fsp.readFile(abs,'utf8') followed by r.text.split('\n') over the entire file — all to find the first line containing "cwd". Measured on the author's machine: ~/.claude/projects holds 2044 directories / 29,625 jsonl files / 3.0 GB. Add an optional bounded read to the readText IPC and have resolveProjectCwd use it, so cwd resolution reads a small prefix instead of whole transcripts.

# Acceptance criteria

- [ ] config.cjs's readText accepts an optional { maxBytes } and, when set, reads at most that many bytes from the START of the file (open + read into a buffer, not readFile-then-slice) and returns a flag indicating the result was truncated.
- [ ] The zod schema in src/main/ipcSchemas.cjs is extended to validate the new optional argument, and the preload wrapper (src/preload/index.cjs:115) forwards it.
- [ ] Existing callers of readText that pass no options behave byte-identically to today (asserted by a test).
- [ ] resolveProjectCwd in src/renderer/lib/useKnownProjects.ts uses the bounded read with a named constant (suggest 64 KB) and no longer calls .split('\n') over an unbounded string.
- [ ] If no cwd is found within the bounded prefix, resolveProjectCwd falls back to the next candidate file (it already sorts smallest-first) and ultimately returns null — it must NEVER fabricate a cwd from the encoded folder name. The knownProjectAggregate.ts contract that an unresolved row is DROPPED, not guessed, is preserved.
- [ ] A truncated read must not hand a partial final line to JSON.parse and log a spurious error — partial trailing lines are discarded.
- [ ] New main-process test under src/main/__tests__/ covers: bounded read returns the prefix; truncation flag is set; unbounded read is unchanged; maxBytes larger than the file returns the whole file with the flag clear.
- [ ] New renderer test asserts resolveProjectCwd still returns the correct cwd and still returns null for a file with no cwd field.
- [ ] timeout 300 npm run typecheck passes.
- [ ] timeout 600 npm run test:unit passes.
- [ ] timeout 120 npm run lint passes.
- [ ] The result states the measured wall-clock of a full useKnownProjects scan before and after, using a scripted node benchmark over the real ~/.claude/projects (read-only, no writes).

# Implementation notes

Target project: /home/bilko/Projects/session-manager

Key files: src/main/config.cjs (readText at line 202, IPC handler at 441), src/main/ipcSchemas.cjs, src/preload/index.cjs:115, src/renderer/lib/useKnownProjects.ts (resolveProjectCwd at line 25, runScan, runEnrichment).

All paths must still go through validatePath (allowedRoots = home dir) — CLAUDE.md lists this as a hard invariant. Do not bypass it on the bounded path.

useKnownProjects.ts already has the correct architecture (cached singleton with subscribers, two-stage enrichment, SCAN_CONCURRENCY 6) — this PRD makes each read cheaper, it does not restructure the scan. Read the long comment at useKnownProjects.ts:44 first; a previous PRD already fixed a related pathology here and the comment explains what must not regress.

The drop-never-guess rule in src/renderer/lib/knownProjectAggregate.ts is load-bearing: a fabricated cwd previously made Home report 2044 projects. Do not reintroduce a candidatePath() fallback.

Benchmark read-only against the real ~/.claude/projects; do not modify or delete anything under it.

Renderer tests use vitest; main-process tests live in src/main/__tests__/.

# Out of scope

- Restructuring the two-stage scan/enrichment in useKnownProjects
- Pruning or archiving anything under ~/.claude/projects
- Changing the historyAggregator walk (separate PRD, perf-intraday-refresh-walk)
- Code-splitting or bundle changes

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
