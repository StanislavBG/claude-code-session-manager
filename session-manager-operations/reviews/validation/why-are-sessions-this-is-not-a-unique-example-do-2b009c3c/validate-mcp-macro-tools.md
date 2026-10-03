# Validation: macro-admin-routes (1492) + mcp-macro-tools (1493)

Base: `90ddb082b208d43aa0f1e99affd9c6d9c1383c39`
Commits in range: `c6a59569` (1492), `774e315f` (1493) — one commit per PRD, found via
`git log --oneline <base>..HEAD -- <each PRD's Files>`.

Note: `session-manager-operations/scheduler/` is gitignored runtime state and does not exist
inside this job's isolated worktree — PRD files were read from the fixed scheduler home at
`/home/bilko/Projects/session-manager/session-manager-operations/scheduler/epics/why-are-sessions-this-is-not-a-unique-example-do-2b009c3c/prds-archived/`.
That checkout is on the same commits as this worktree's `HEAD` and has `node_modules` installed,
so all gate commands below were run there; the diff reviewed is identical (`git diff --stat` is
scoped to this worktree's branch).

## 1492 macro-admin-routes — VERIFIED

| AC | Evidence |
| --- | --- |
| `registerAdminRoute(adminHttp, { onChanged })` registers GET `/admin/macros` + POST `/admin/macros/save` | `src/main/lib/macroAdminRoutes.cjs:108-110`; asserted by test `registers GET /admin/macros and POST /admin/macros/save` |
| save resolves cwd via `projectHomeAdminRoutes.resolveCwd`; create always `projects:[resolvedCwd]`, `surface:'sessions'`; rejects `builtin-*` id (400), unknown id (400), foreign-project update (400); field validation via `MacroSaveSchema` | `macroAdminRoutes.cjs:58-62` (builtin-id check), `:71-78` (schema parse → 400 on zod error), `:80-89` (unknown-id / foreign-project checks), `:91` (create sets `projects`/`surface`) |
| success calls `onChanged()` once, returns `{ok:true, macro}`; wired in `index.cjs` next to `projectHomeAdminRoutes`, passing `broadcastMacrosChanged` | `macroAdminRoutes.cjs:93-94`; `src/main/index.cjs:64` — `macroAdminRoutes.registerAdminRoute(adminHttp, { onChanged: () => broadcastMacrosChanged() })`; `broadcastMacrosChanged` is a hoisted `function` declaration (`index.cjs:574`) so the forward reference at line 64 is safe |
| new test `macroAdminRoutes.test.cjs` covers create→projects=[cwd], list filters by cwd + `*`, builtin refused, foreign-project update refused, non-absolute cwd refused, `onChanged` called exactly once on success / never on failure | `src/main/__tests__/macroAdminRoutes.test.cjs` (9 tests, all present) |

`resolveCwd` was exported from `projectHomeAdminRoutes.cjs` (one-line addition, `projectHomeAdminRoutes.cjs:247`) rather than duplicated, per the PRD's explicit instruction.

Gate (run at `/home/bilko/Projects/session-manager`, same commits as this worktree's HEAD):
```
$ timeout 300 npx vitest run src/main/__tests__/macroAdminRoutes.test.cjs src/main/__tests__/projectHomeAdminRoutes.test.cjs
 Test Files  2 passed (2)
      Tests  70 passed (70)
$ timeout 300 npm run typecheck
> tsc --noEmit && tsc --noEmit -p tsconfig.main.json
(exit 0, no output)
```

## 1493 mcp-macro-tools — VERIFIED

| AC | Evidence |
| --- | --- |
| `macro_list({cwd?})` → GET `/admin/macros?cwd=<encoded>`, `macro_save({cwd?, id?, label, agentName, tag, prompt})` → POST `/admin/macros/save`, both via `resolveCwdArg(args)`; `macro_save` returns `errorResult` on missing/non-string `label`/`agentName`/`tag`/`prompt` | `scripts/scheduler-mcp-server.cjs:659-676` |
| header comment lists both tools with routes, matching existing format | `scripts/scheduler-mcp-server.cjs:17-19` |
| `mcpToolCatalog.cjs` gains `macro_list`/`macro_save` catalog entries (new `macros` group) with purpose/whenToUse/whenNotToUse/exampleArgs/notes; whenNotToUse states project-scoping, builtin-immutability, and "never create unasked" | `src/main/lib/mcpToolCatalog.cjs:26` (schema gains `'macros'`), `:296-329` (both entries) |
| new test `schedulerMcpServerMacros.test.cjs` asserts both tools listed, `macro_save` forwards body+resolved cwd, missing `label` → error result; `mcpToolCatalog.test.cjs` / `schedulerMcpServerHelp.test.cjs` pass unmodified (diff confirms neither file was touched — they don't enumerate the full tool list) | `src/main/lib/__tests__/schedulerMcpServerMacros.test.cjs` (8 tests); `git diff --stat` shows no changes to the other two files |

Gate:
```
$ timeout 300 npx vitest run src/main/lib/__tests__/schedulerMcpServerMacros.test.cjs src/main/lib/__tests__/schedulerMcpServerProjectHome.test.cjs src/main/lib/__tests__/mcpToolCatalog.test.cjs src/main/lib/__tests__/schedulerMcpServerHelp.test.cjs
 Test Files  4 passed (4)
      Tests  109 passed (109)
$ timeout 300 npm run typecheck   # same run as above, shared across both PRDs — exit 0
```

## Combined diff review

`git diff --stat 90ddb082b2..HEAD`: 7 files, +640/-1 — exactly the union of both PRDs' declared
`# Files` sections (`scripts/scheduler-mcp-server.cjs`, `src/main/index.cjs`,
`src/main/lib/macroAdminRoutes.cjs`, `src/main/lib/mcpToolCatalog.cjs`,
`src/main/lib/projectHomeAdminRoutes.cjs`, and the two new test files). No out-of-scope files,
no scope creep (macro-delete, renderer changes, and `*`-creation via admin API were all
explicitly out of scope and none appear in the diff).

Ran `/code-review` and `/security-review` against the combined diff (see Findings below) plus an
independent subagent security pass targeting the three named escalation paths. All three hold:

- **Cannot create a `*` macro**: create always hardcodes `projects:[resolved.cwd]`
  (`macroAdminRoutes.cjs:91`); `resolveCwd` requires an absolute, validated, existing-project
  path, so `cwd:'*'` is rejected before reaching macro logic; `body.projects` is never read.
- **Cannot edit a `builtin-*` macro**: explicit `id.startsWith('builtin-')` 400 at
  `macroAdminRoutes.cjs:58-62`, checked before any lookup.
- **Cannot edit a macro scoped to a different project**: update path requires
  `existing.projects.includes(resolved.cwd)` (`macroAdminRoutes.cjs:95-99`); `MacroSaveSchema.parse`
  is called with an explicit field allowlist (`id/label/agentName/tag/prompt`) so a request body's
  `projects` can never be used to launder a scope change.

All three are also directly asserted by `macroAdminRoutes.test.cjs`.

### Findings

**Important — `macro_save` cannot update a macro that is only visible via the global `*` scope,
contradicting `macro_list`'s own visibility and the tool's own description.**
`macroAdminRoutes.cjs:33` (list filter) treats `projects.includes('*')` as visible to every cwd,
but the update-authorization check at `macroAdminRoutes.cjs:95-99` only checks
`existing.projects.includes(resolved.cwd)` — it never also accepts
`existing.projects.includes(ALL_PROJECTS)`. An agent that calls `macro_list`, sees a `*`-scoped
macro returned as visible, then calls `macro_save` with that macro's `id` to tweak its
label/prompt (exactly what `macro_save`'s catalog description says it's for — "update an existing
macro already visible to this project") gets a confusing 400 ("macro `<id>` is not visible to
`<cwd>`") despite the macro being visible per the tool it just called. This fails safe (over-restrictive,
not a security hole) but is a real, reachable UX/correctness gap in the new surface, not a
pre-existing one — the admin API is the only new way to attempt this. Out of this PRD's literal
acceptance criteria text ("rejects … an update of a macro whose projects do not include the
resolved cwd" — `'*'` is indeed not `resolved.cwd`), so not a PRD-AC failure, but worth a
follow-up PRD if `*`-macro editing via MCP is wanted.

**Minor — `macro_save`-created macros store a realpath'd cwd in `projects`, while the pre-existing
renderer IPC path (`index.cjs:579` → `macroLibrary.saveMacro(payload)`) stores the raw,
non-realpath'd cwd.** `resolveCwd` → `config.validatePath` (`src/main/config.cjs:117-129`)
realpath-resolves the path (confirmed by the existing test asserting
`body.macro.projects).toEqual([fs.realpathSync(cwd)])`), whereas `macroLibrary.normalizeCwd`
(used by the direct IPC save path) only collapses/trims slashes. If a project's path has a symlink
component, a macro created via `macro_save` would be stored under the realpath and may not match
the raw cwd the renderer's Sessions HOT KEYS strip compares against for that project, making the
new macro silently invisible there. This realpath-vs-raw inconsistency pattern already exists for
`project_home_write`/`project_demo_video_write` (same `resolveCwd`), so it predates this PRD
architecturally, but `macro_save` is a new write surface that inherits it. Narrow impact (only
triggers for symlinked project paths); no fix applied — flagged for awareness, not a correctness
failure of either PRD's stated acceptance criteria.

No HIGH/CRITICAL findings. No security vulnerability found in either PRD's diff.

VALIDATION: macro-admin-routes VERIFIED
VALIDATION: mcp-macro-tools VERIFIED
SCHEDULER_VERDICT: PASS
