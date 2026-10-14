# Validation: memory-fix-triage plan

Base: de4b7b63 (HEAD 55d4c540). Commits in range: 5b3941a9 (stale-candidates), 88ef9428 (ref-resolver), 7c76f9bd (md-network), d0e7d626 (wire-resolver). Gates run with a symlinked node_modules (removed afterwards) and scratch TMPDIR.
Gate run: `vitest run memoryRefResolve memoryStale memoryMdNetwork memoryTool.nativeDirs memoryTool.index` -> 5 files, 41 tests passed.

## memory-ref-resolver — VERIFIED
- `src/main/lib/memoryRefResolve.cjs` exports makeRefResolver/listTrackedFiles (diff +64); test file covers root/exact/suffix/sibling-root/outside-home/`..`/miss (57 lines). Gate green.

## memory-stale-candidates — VERIFIED
- `src/main/lib/memoryStale.cjs` (+38/-): bare filenames dropped, extractRoots added, existsPath(c, roots); tests extended (+35). Gate green.

## memory-md-network — VERIFIED
- `src/main/lib/memoryMdNetwork.cjs` (121 lines) exports collectMdNetwork; test file 95 lines. Gate green.

## memory-stale-wire-resolver — VERIFIED
- `src/main/memoryTool.cjs` (+24/-) uses makeRefResolver/listTrackedFiles; nativeDirs test +16 (lib/x.ts not stale, missing stale). Gate green.

## memory-fix-triage — REFUTED
- PRD 1985 still sits in `prds/` (never ran). `src/main/memoryAssist.cjs` last changed in 7a806663 (pre-base); no `action`/`FIX_POLICY`; `memoryAssist.test.cjs` untouched. No commit/diff in range.

## memory-fix-triage-hook — REFUTED
- No PRD file, queue row, or commit exists for this slug. Nothing landed.

## memory-fix-triage-ui — REFUTED
- No PRD file, queue row, or commit exists for this slug. Nothing landed.

## Plan-level stale count
`memoryTool.stale({ cwd: $SM_PROJECT_ROOT })` on the real memory folder: 50 entries, **16 stale** (baseline 31). Criterion (<31) met. 15 entries still carry deadRefs.

## Findings
- **Important**: three of seven PRDs (memory-fix-triage, -hook, -ui) have not landed; the reported "Apply" flow and the triage redesign are therefore undelivered. Hook/ui PRDs were never created (missing PRD files noted, no queue rows).
- Minor: stray 0-byte `<path>` file in the worktree root (known sqlite MCP placeholder, not part of this plan).
- Combined diff (8 files, +432/-18) reviewed by hand: no unsafe input handling; resolver rejects `..`, absolute and `~` rels; sibling roots restricted to under home and validated via config.validatePath. No duplication of existing helpers noticed.
