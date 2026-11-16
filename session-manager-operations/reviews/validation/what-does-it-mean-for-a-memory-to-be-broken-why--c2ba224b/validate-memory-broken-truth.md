# Validation: memory broken-truth plan

Base: 72952588 (known). Commits: 1a641df8 (3202), 2b10ed6f (3203), 8f4b1abf (3204), c90e9777 (3205).
Review tools: `/code-review` and `/security-review` not run as separate commands; self-reviewed the diff (no fs writes outside existing helpers, regex-escaped names, home-bounded extraBases, execFile with timeout/maxBuffer, no secrets).

## Gates (re-run)
- main-process gate (memoryAssist, memoryTool.index/nativeDirs/stale, memoryStale, memoryRefResolve): 6 files, 62 tests passed.
- renderer gate (MemoryExplorer model/linksRail/reader/nav): 4 files, 46 tests passed.
- `npm run typecheck` exit 0; `npm run lint` exit 0 (tail shows check-scroll-into-view OK).

## memory-wikilink-name-resolution — VERIFIED
- `makeLinkResolver` memoryStale.cjs:71, exported :248; used by scoreMemories :170 (canonical stems, self excluded, dangling = unresolved only).
- Tests (kebab→snake, stem, dangling, self-link, collision) pass in the gate.

## memory-path-refs-ops-projects-renames — VERIFIED
- `extraBases` memoryRefResolve.cjs:26-28 (home-bounded); `listRenames` :84, exported :126.
- scoreMemories `projectRoots`/`renamedTo`/`movedRefs` memoryStale.cjs:164-241; moved refs don't set stale.
- Tests pass in the gate.

## memory-stale-wire-resolution — VERIFIED
- memoryTool.cjs:332-340 ops root via `opsOwnership.resolveOpsRoot` + `validatePath`, registered project roots, `listRenames`; wired at :366-375,:402.
- api.d.ts:1539 `movedRefs`; memoryAssist.cjs:55 link-following via makeLinkResolver, :167-169 renames/moved handling in proposeFix.
- memoryTool.stale.test.cjs + memoryAssist tests pass.

## memory-links-rail-moved-path-fix — VERIFIED
- model.ts:29,104 movedRefs, broken unchanged (:105).
- LinksRail.tsx:65-84 PATHS section, testids `mx-path-moved-i` / `mx-path-dead-i`, 'click to update', 'not found anywhere'.
- MemoryExplorer.tsx:379-398 updatePath via saveBody + say() undo, toast on error; :628-629 wired (onReviewPath → runFix).

## Real-path probe (read-only; memory dir, cwd /home/bilko/Projects/session-manager)
"Before" = base-commit (72952588) memoryStale/memoryRefResolve with no extras; "after" = HEAD modules with ops-root extraBase, project roots (dirs in ~/Projects), listRenames, as memoryTool.stale() wires them. 59 memories.

| | broken | with deadRefs | with danglingLinks | with movedRefs |
|---|---|---|---|---|
| before | 49 | 10 | 46 | n/a |
| after | 34 | 7 | 31 | 3 |

- Dangling links whose normalized target matches an existing memory filename stem or frontmatter name: **0**.
- Remaining dangling targets point at memories that do not exist (e.g. `cross-project-replies-plan`, `npm-staged-publish`) — genuinely broken; remaining dead refs are genuinely absent paths (e.g. `src/pages/SessionManagerPage.tsx`, `docs/History-pre-Design.md`).

## Findings
- Critical: none.
- Important: none.
- Minor: probe project roots were approximated from `~/Projects` directory names rather than the app's registry (`defaultProjectRoots`), so the "after" count may differ slightly in the live app. Remaining 34 broken memories are real content problems for the owner to resolve in the UI.
