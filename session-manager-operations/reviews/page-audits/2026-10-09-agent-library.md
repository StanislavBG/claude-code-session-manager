# Agent Library page audit — 2026-10-09

- key: `agent-library`
- label: Agent Library
- faces: home
- entry: `src/renderer/components/tabs/AgentLibrary.tsx`
- base SHA: `b9d01c23`
- surface counts (`node scripts/page-surface.cjs agent-library`): owned 3, shared 43, api 5, tests 5

Note: the surface tool needs `typescript`, which the job worktree does not install. It was run with
`NODE_PATH=<main checkout>/node_modules`. Only this page's five test files were run
(`vitest run src/renderer/components/tabs/__tests__/AgentLibrary* src/renderer/lib/__tests__/personaSavePayload.test.ts`:
5 files passed, 41 tests green).

## Known context: the `title` save fix holds

- `AgentLibrary.tsx` `save()` builds `existing ? toPersonaSaveInput(existing, editorFields) : editorFields`.
  `toPersonaSaveInput` (`src/renderer/lib/personaSavePayload.ts`) carries `title`, `projects`, `action`, `actionLabel`, `effort`.
- Defence in depth: `savePersona` in `src/main/agentLibrary.cjs` carries over an undefined `seedVersion`/`title`/`projects`/`action`/`actionLabel` from the file on disk, so `seedVersion` survives too.
- Coverage: `AgentLibrary.test.tsx` "editing the description of a persona with a title saves the same title" and `personaSavePayload.test.ts`. Both pass.
- Remaining gap: Duplicate (`duplicate()`, then `isNew`) sends `editorFields` only, so the copy has no `title`/legacy keys. See F4.

## Principles

### 1. Stateless
Verdict: PASS

No `localStorage`/`sessionStorage`. `personas` is a projection of `agents:list-personas` and is re-read on mount, `agents:changed` and the dir watch. Component state is limited to the selection, filter, draft and confirm flags (transient UI). The draft is an unsaved edit buffer and is cleared on save or revert.

### 2. Physical files
Verdict: PASS

Reads and writes are `~/.claude/agents/<name>.md` and `<cwd>/.claude/agents/<name>.md` through `agents:*` IPC, using `validatePath` and `writeTextAtomic` (`src/main/agentLibrary.cjs`). The overlay is frontmatter-only (`saveOverlay`). Rename unlinks the old file. No app-private copy.

### 3. Current, not hardcoded
Verdict: FINDINGS

- Models and effort come from `models.catalog` (the `MODELS`/`EFFORTS` literals are only the null-catalog fallback, as the charter allows).
- The `TOOLS` list is a hand-written catalog of Claude Code tools (F2).
- `COLORS` mirrors the agent `color` frontmatter vocabulary (F3).

### 4. One API per feature
Verdict: FINDINGS

`--duplicates` reports `agents.listPersonas`, `agents.onChanged` (agent-library, project-home, tag-library) and `agents.savePersona` (agent-library, tag-library). See F1 and the analysis below.

### 5. Clear separation and platform adherence
Verdict: FINDINGS

The page imports only `ui/`, `lib/` and `state/`, never another page's owned file. Errors go through `toast`. There is no `process.platform` use and no z-index literal. The only issue is stale doc text (F5). Frontmatter keys follow Claude Code's agent format. I did not run `npm run lint`; the findings are static reads.

### 6. Lean tests
Verdict: FINDINGS

Five files, 1171 lines. Two are marked `review (smell:mock-only)` and one `merge` (F6).

## Judgement on the duplicate-API candidates

**`listPersonas`/`onChanged`: this is a principle-4 finding (F1).** The page re-implements the load and `onChanged` loop that `useAgentPersonas` already provides. Tag Library does the same (`TagLibrary.tsx:49,62`), and `NewEpicCard.tsx:205` calls `listPersonas` directly. These are three private copies of the shared hook plus the hook itself.

What adopting it takes. The hook is read-only and lacks four things this page needs:
1. A loading state distinct from empty (the page shows `loading…` while `personas === null`). The hook starts at an empty array.
2. The `loadSeq` stale-response guard.
3. An error surface. The hook swallows errors into `[]`; this page toasts them.
4. The `useAgentsDirWatch(activeCwd, …)` external-edit watch, which `onChanged` does not cover (it is only a write echo).

Extend the hook to `useAgentPersonas(opts?: { cwd?: string | null })` returning `{ personas: AgentPersona[] | null, reload: () => Promise<AgentPersona[]>, error }`, with the `loadSeq` guard and the dir watch inside it. Existing callers can keep a thin `useAgentPersonas()` wrapper that returns the array, so ProjectHome and SessionActionsBar do not change.

Select-after-load stays in the page. It is already derived: `saved = personas.find(name === selectedName) ?? personas[0]`. After a save the page does `await reload()` and then `setSelectedName(name)`, so the `selectAfter` parameter moves out of the loader into the caller. The first-load default is already covered by the `?? personas[0]` fallback. The page keeps the draft, selection and toast behavior.

The new hook lives in `src/renderer/lib/` (shared, not this page's owned file), so the PRD for it must list that file and the other consumers.

**`savePersona`: not a finding.** Both pages already build the payload through the single `toPersonaSaveInput` / `toKnownTags` in `personaSavePayload.ts` and call one IPC handler. Tag Library only changes `tags`. This is the shared-lib shape the charter asks for. Keep as is.

## Findings

| id | severity | principle | file + symbol | evidence | fix shape | owner page |
| --- | --- | --- | --- | --- | --- | --- |
| agent-library-F1 | Important | 4 | `src/renderer/components/tabs/AgentLibrary.tsx` `load` + `useEffect(() => window.api.agents.onChanged(...))` + `useAgentsDirWatch` | `node scripts/page-surface.cjs --duplicates` → `agents.listPersonas -> agents:list-personas (3) agent-library, project-home, tag-library`; code: `const list = await window.api.agents.listPersonas()` / `useEffect(() => window.api.agents.onChanged(() => load()), [])`, while `src/renderer/lib/useAgentPersonas.ts` already implements the same load + `onChanged` loop | wire: extend `useAgentPersonas` (cwd option, loading/error, `loadSeq`, `reload`), adopt it here, in `TagLibrary.tsx`, and in `NewEpicCard.tsx` | agent-library (hook is shared lib; also tag-library, epics for the other call sites) |
| agent-library-F2 | Important | 3 | `AgentLibrary.tsx` `TOOLS` | `const TOOLS =['Read', 'Grep', 'Glob', 'Bash', 'Write', 'Edit', 'WebFetch', 'WebSearch', 'Task']`; the hint reads `${obj.tools.length} of ${TOOLS.length} granted`. A persona that lists `NotebookEdit` or an `mcp__*` tool keeps it in `obj.tools`, but no chip is shown for it and the count exceeds the denominator | behavior: render the union of the known list and the persona's own `tools`, so unknown entries are visible and removable; name the source of the known list (Claude Code tool names) in a comment, or source it from the CLI/MCP server list | agent-library |
| agent-library-F3 | Minor | 3 | `AgentLibrary.tsx` `COLORS` / `COLOR_SWATCH` | `const COLORS = ['', 'red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'pink']` | doc: add a comment naming Claude Code's agent `color` frontmatter as the source, and show an unrecognized on-disk color instead of dropping it | agent-library |
| agent-library-F4 | Minor | 2 | `AgentLibrary.tsx` `duplicate` / `save` (`isNew` branch) | `setDraft({ ...obj, name: obj.name + '-copy' }); setCreating(true)`, then `existing = isNew ? null : saved` sends `editorFields` only, so a duplicate of a titled persona is written without `title`/`projects`/`action`/`actionLabel` | behavior: decide intentionally. If the copy should keep `title`, keep the source persona on the draft and apply `toPersonaSaveInput(source, { name, originalName: undefined, ...editorFields })`. Add a test either way | agent-library |
| agent-library-F5 | Minor | 5 | `AgentLibrary.tsx` header docblock (lines 21-40) | the docblock says writes are "scoped to the global persona directory only … never created, since this page has no per-tab cwd context", but `saveOverride` writes `<cwd>/.claude/agents/<name>.md` through `savePersona({ projectName })` and `activeCwd` comes from `useSessions` | doc: rewrite the docblock to describe the project overlay block | agent-library |
| agent-library-F6 | Minor | 6 | the 5 test files (see below) | `page-surface.cjs`: `AgentLibrary.configWatch.test.tsx  merge`, `AgentLibrary.projectOverride.test.tsx  review (smell:mock-only)`, `AgentLibrary.test.tsx  review (smell:mock-only)` | test-reduction | agent-library |

## Test reduction candidates

All deletions or merges are subject to the Reduction rule in `tests/README.md` (`coverage-guard.cjs --base <sha>` exits 0 and `mutants.cjs` with the same `--seed` shows no newly surviving mutant).

| test file | verdict | reasons | proposed action |
| --- | --- | --- | --- |
| `src/renderer/components/tabs/__tests__/AgentLibrary.configWatch.test.tsx` | merge | uniqueS<=3; its top source (`AgentLibrary.tsx`) is covered by 4 other test files; 5 tests for one watch behavior | merge into `AgentLibrary.test.tsx` as one "external edit refreshes the list" scenario. If F1 lands, move the watch cases to a test of the shared hook instead |
| `src/renderer/components/tabs/__tests__/AgentLibrary.test.tsx` | review (smell:mock-only) | asserts on `savePersona.mock.calls` | keep as the page's scenario test. Replace the mock-call assertions with the serialized file result where possible; absorb the configWatch cases |
| `src/renderer/components/tabs/__tests__/AgentLibrary.projectOverride.test.tsx` | review (smell:mock-only) | mock-only assertions on overlay IPC calls | keep. Assert the effect (the overlay row and badge after reload) rather than only the IPC call, or merge into `AgentLibrary.test.tsx` |
| `src/renderer/components/tabs/__tests__/AgentLibrary.modelPicker.test.tsx` | keep | no bloat verdict | keep |
| `src/renderer/components/__tests__/screenMemoization.test.tsx` | keep | cross-page (452 lines); not this page's to cut | keep |
