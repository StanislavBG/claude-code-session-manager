---
title: Project Brief backend — projectBrief.cjs synthesis module + IPC
cwd: ~/Projects/session-manager
estimateMinutes: 20
sourcePromptId: home-redesign-global-machine-home-per-project-br-fa12799f
---

# Goal

Build the main-process backend for the per-project "Brief" (the LLM-maintained project summary the new Project Home surface renders): `src/main/projectBrief.cjs` with three IPC calls — `projectBrief:get` (read `brief.json` + cheaply computed source/drift metadata), `projectBrief:refresh` (cost-gated headless `claude -p` synthesis that respects pins and the machine session-slot pool), and `projectBrief:setPin`. Persistence lives at `<cwd>/session-manager-operations/project-brief/brief.json`. The renderer surface is built by PRDs 838/840; this PRD is backend + preload only.

# Acceptance criteria

## Core functionality

- [ ] `src/main/projectBrief.cjs` exists and is registered from `src/main/index.cjs`; all three channels validate payloads with zod schemas added to `src/main/ipcSchemas.cjs`; `cwd` inputs pass through `config.cjs`'s `validatePath` (allowedRoots = home dir) before any fs access.
- [ ] `projectBrief:get { cwd }` returns `{ brief: <parsed brief.json or null>, sources: [{ label, detail, mtimeMs, drift }] }` where sources are computed WITHOUT any LLM call: CLAUDE.md (line count + mtime), Epics (counts from `<cwd>/session-manager-operations/prompt-sessions/` active-index.json + archived `*.json`), sessions (count of `.jsonl` under `~/.claude/projects/<encodedCwd>/`), git (`git -C <cwd> rev-list --count HEAD` via spawn with argv array, 5s timeout, tolerating non-git → source omitted). `drift: true` when a source's mtime > `brief.synthesizedAt`.
- [ ] `projectBrief:refresh { cwd }` spawns one `claude -p` synthesis following the `src/main/memoryAggregate.cjs` pattern exactly: fires only on this explicit call, stdin closed, `--model` pinned explicitly (same model constant style memoryAggregate uses), hard timeout, `SM_KG_INTERNAL=1` in env, brace-matching JSON extractor on stdout. Before spawning it MUST acquire a slot from `src/main/lib/sessionSlots.cjs` and release it in a finally; when no slot is free it returns a structured `{ ok: false, error: 'no session slot free…' }` instead of queueing. Result is written atomically with `config.cjs`'s `writeJson`.
- [ ] The synthesis prompt includes: CLAUDE.md text, Epic goalTexts + statuses (active + archived), last ≤50 lines of `git log --oneline`, a depth-2 directory listing of `src/`, and — for every pinned block — the frozen pinned content with the instruction to return it verbatim. The requested output shape matches the `brief.json` schema documented in `/home/bilko/Projects/session-manager/session-manager-operations/design-mocks/home/DESIGN_SPEC.md` ("Persistence"): `version, synthesizedAt, model, purpose, what[], areas[], scope[], conventions[], pins{}, pinned{}`.
- [ ] Pinned blocks are enforced in CODE, not just in the prompt: after extracting the model's JSON, `refresh` overwrites any pinned block with the stored `pinned.<block>` copy before persisting.
- [ ] `projectBrief:setPin { cwd, block: 'what'|'conventions', pinned: boolean }` updates `pins` and freezes/clears `pinned.<block>` from the current brief content, written atomically.
- [ ] Preload bridge (`src/preload/*.cjs` + `src/preload/api.d.ts`) exposes `window.api.projectBrief.{get,refresh,setPin}` with typed signatures.

## Edge cases

- [ ] Missing or corrupt `brief.json` → `get` returns `{ brief: null, sources }` (never throws); a second `refresh` for the same cwd while one is in flight returns `{ ok: false, error: 'refresh already running' }` (single in-flight per cwd, mirroring `pluginInstall.cjs`'s single-in-flight-per-slug guard).
- [ ] Model output that fails JSON extraction or schema-shape sanity → `{ ok: false, error }`, existing brief.json left untouched.

## Tests

- [ ] Pure logic lives in `src/main/lib/projectBriefCore.cjs` (source metadata assembly from stat inputs, drift computation, prompt assembly, output-shape validation + pin enforcement merge) and has vitest coverage with plain-object inputs: `timeout 120 npx vitest run src/main/lib/__tests__/projectBriefCore.test.ts` passes.
- [ ] `timeout 300 npm run typecheck` passes and `timeout 120 npm run lint:selectors` passes.

# Implementation notes

Read `/home/bilko/Projects/session-manager/session-manager-operations/design-mocks/home/DESIGN_SPEC.md` (section "Surface 2", "Data mapping notes (the Brief)") first — it fixes the brief.json schema and the source list. Read `src/main/memoryAggregate.cjs` in full before writing the spawn path; reuse its helpers where importable rather than copying (API-reuse standard). Encoded-cwd derivation for the transcripts dir: mirror what `memoryAggregate.cjs`/`transcripts.cjs` already do for `~/.claude/projects/<encoded>` — reuse, don't fork. Atomic writes: `config.cjs` `writeJson` (never hand-roll tmp+rename). The session-slot pool: `src/main/lib/sessionSlots.cjs` — read its acquire/release signatures first; scheduler jobs AND chat runs already go through it, and this synthesis is a third client (machine-wide cap 3 is a hard rule — see CLAUDE.md "Avoid"). Keep child_process spawns argv-array only (no `shell: true`).

This PRD is independent of 835/836/838 and may run in parallel with them.

# Out of scope

- Any renderer/UI (PRDs 838–840 render this data).
- Auto-regeneration triggers (every-Nth-epic-turn from the mock is deferred; manual refresh only).
- Admin-API/MCP exposure of the brief.

## Engineering standards

Before writing any code, read `/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands, verify before done, the finish-protocol sentinel).
