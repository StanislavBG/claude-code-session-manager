---
title: Expose @-import parsing for CLAUDE.md files over IPC
cwd: ~/Projects/session-manager
estimateMinutes: 15
---

# Goal

Add a new IPC channel `config:parse-imports` (main-process handler + preload bridge + zod
schema) that lets the renderer resolve the `@path`/`@~/path` import chain of any CLAUDE.md-like
file, reusing the existing parser in `src/main/lib/personaImportHealth.cjs` (currently wired
only into the health-check codepath, `src/main/health.cjs`) instead of reimplementing @-import
parsing in the renderer. This is foundation plumbing for a new "referenced files" panel in the
System Prompt tab (a follow-up PRD, `801-system-prompt-file-references-panel.md`) — the panel
needs, per referenced file: its resolved absolute path, whether it exists, its byte size (for a
token estimate), and whether the import chain considers it broken.

# Acceptance criteria

- [ ] Export a new pure function `listReferencedFiles(rootPath)` — either added to
  `src/main/lib/personaImportHealth.cjs` or a thin new module alongside it,
  `src/main/lib/importReferences.cjs`, that imports `walkImports`/`extractImportPaths`/
  `resolveImportPath` from `personaImportHealth.cjs` (do not re-implement the @path regex) —
  that calls `walkImports(rootPath)` and maps each result to
  `{ path: importPath, exists, sizeBytes, tokenEstimate, ok }`: `sizeBytes` via
  `fs.statSync(importPath).size` when it exists else 0, `tokenEstimate` as
  `Math.round(sizeBytes / 4)` matching the existing `estimateTokens` convention already used in
  `src/renderer/components/tabs/SystemPrompt.tsx:14-16`
- [ ] Add `ipcMain.handle('config:parse-imports', validated(schemas.configParseImports, async
  ({ path }) => ({ ok: true, imports: listReferencedFiles(path) })))` in `src/main/index.cjs`,
  placed near the other `config:*` handlers — wrap in try/catch returning
  `{ ok: false, error: string }` on failure (e.g. path outside allowed roots), consistent with
  other handlers' error shape
- [ ] Add a zod schema `configParseImports = z.object({ path: z.string().min(1) })` to
  `src/main/ipcSchemas.cjs` alongside the other `config*` schemas, and validate the resolved
  `path` through the SAME `validatePath` allowed-roots check `config.cjs` already uses for reads
  (home dir root) — do not open filesystem access beyond that existing boundary
- [ ] Add the bridge in `src/preload/index.cjs` under the `config:` object:
  `parseImports: (path) => ipcRenderer.invoke('config:parse-imports', { path })`, and add the
  matching type to `src/preload/api.d.ts`'s `config` interface:
  `parseImports: (path: string) => Promise<{ ok: true; imports: ImportRef[] } | { ok: false; error: string }>`
  plus an exported `ImportRef` interface
  `{ path: string; exists: boolean; sizeBytes: number; tokenEstimate: number; ok: boolean }`
- [ ] Unit test in `src/main/lib/__tests__/importReferences.spec.cjs` (check
  `src/main/lib/__tests__/` first for an existing `personaImportHealth` test file to extend
  instead) covering: a file with 2 valid @imports returns 2 entries with correct
  sizeBytes/tokenEstimate/ok=true; a file referencing a missing path returns ok=false for that
  entry; a file with zero @import lines returns an empty array
- [ ] `timeout 120 npx vitest run src/main/lib/__tests__/importReferences.spec.cjs` (or wherever
  the test lands) passes
- [ ] `npm run typecheck` passes (preload API type change must not break any existing renderer
  usage)

# Implementation notes

Read `src/main/lib/personaImportHealth.cjs` first — `walkImports(rootPath)` already returns
`[{ importPath, exists, nonEmpty, ok }]` recursively (depth-capped at `MAX_IMPORT_DEPTH`,
dedup'd via a `seen` Set), which is 90% of what's needed; this PRD's job is exposing it over IPC
with the extra `sizeBytes`/`tokenEstimate` fields, not reparsing imports.

Existing IPC pattern to follow exactly: `src/main/index.cjs` registers handlers via
`ipcMain.handle('config:read-text', validated(schemas.configReadText, async ({ path }) => {...}))`
— `validated()` is a wrapper already defined in that file that runs the zod schema before
invoking the handler body; find it and reuse it rather than hand-rolling validation.

Preload exposure pattern: `src/preload/index.cjs` (around the `config` object, roughly
lines 150-163) shows the full existing `config` object shape (`readJson`, `readText`,
`writeJson`, `writeText`, `listDir`, `exists`, `watch`, `unwatch`, `onChanged`) — add
`parseImports` alongside these, same object.

Token-estimate convention: `src/renderer/components/tabs/SystemPrompt.tsx:13-16` already has
`estimateTokens(text) = Math.round(text.length / 4)` for loaded text content — mirror that
~4-chars-per-token ratio using byte size instead of loaded text (this endpoint returns metadata
without loading full file content into the IPC payload, so use `sizeBytes / 4` not
`text.length / 4`).

Path-safety: `config.cjs` has a `validatePath` helper (allowedRoots = home dir) used by existing
`config:read-text`/`config:read-json` handlers — reuse it for the resolved import paths in
`config:parse-imports` rather than adding a new boundary check.

## Engineering standards

Before writing any code, read
`/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md`
— it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply
to this PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands,
verify before done, the finish-protocol sentinel).

# Out of scope

- Any renderer UI work — that's PRD 801
- Loading full file content over this IPC call (the renderer already has `config:read-text` for
  that and will reuse it per-file when a user expands an entry)
- Git ahead/behind reporting (`checkRepoAheadBehind`) — not needed for the UI panel, skip wiring
  it
