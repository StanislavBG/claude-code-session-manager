# Validation — memory native index plan

Base: 0e53d9bd (given in PRD). Commits: 816d5b31, 93fdb9de, a1d745e9, 1511ea9f, 885f6aa2, 09e68625.
Gates re-run (node_modules symlinked from the main checkout, scratch TMPDIR):
- `vitest run` memoryIndex, memoryStale, memoryDirResolve, memoryTool.nativeDirs, memoryTool.index, memoryAggregate, MemoryIndexHealth, MemoryNaturalPanel.voiceButton — 8 files / 53 tests passed.
- `npm run typecheck` — exit 0. `npm run lint` — exit 0.

## memory-index-lib — VERIFIED
- src/main/lib/memoryIndex.cjs exports parseIndex/addIndexLine/removeIndexLines/indexHealth (98 lines, pure); test memoryIndex.test.cjs (112 lines) green incl. gate.

## memory-dir-resolve-lib — VERIFIED
- src/main/lib/memoryDirResolve.cjs:30 resolveWorkspaceMemoryDir (local>project>user, ~ expansion, encodeCwd(repoRoot||cwd)); :44 autoMemoryEnabled; :48 resolveAgentMemoryDir (name regex, scope, root throws); :112 listMemoryAgents (project shadows user, skips unreadable); :131 gitRepoRoot (5000 ms, `/.git` parent, null on error, memoized). Test green.

## memory-tool-native-dirs — VERIFIED
- memoryTool.cjs:84 resolveDir (agent > cwd > legacy workspace); all paths via config.validatePath; list() returns `dir` + `autoMemoryEnabled`; `agents` handler registered as memory:agents (:371); memoryAggregate.cjs:36 delegates to resolveDir; ipcSchemas.cjs adds cwd/agent to six schemas + memoryAgents. Tests + typecheck green.

## memory-index-maintenance — VERIFIED
- create() adds one idempotent index line and skips MEMORY.md itself (memoryTool.cjs ~:281); deleteEntry() rewrites index, returns `indexError` without failing delete; stale() returns `index` from same dir. memoryTool.index.test.cjs green.

## memory-ipc-contract — VERIFIED
- api.d.ts has MemoryAgentTarget/MemoryTarget/MemoryAgent/MemoryIndexHealth, list `dir`/`autoMemoryEnabled`, stale `index?`, `memory.agents`; preload accepts MemoryTarget; Memory.tsx and MemoryNaturalPanel.tsx callers pass { workspace, cwd }. MemoryClustersPanel.tsx unchanged because `aggregate(workspace, refresh, cwd)` keeps its signature (PRD says aggregate is unchanged) — acceptable. Typecheck + voiceButton test green.

## memory-tab-index-health-ui — VERIFIED
- memory/MemoryIndexHealth.tsx (banner, strip, amber/red, counts, nothing for undefined); Memory.tsx:121 watch uses stored `memDir`; orphan "not in index" badge; hooks above early returns (lint green); MemoryIndexHealth.test.tsx green.

## Findings

### Critical
- none

### Important
- src/main/memoryTool.cjs:~104 `config.addAllowedRoot(realRoot)` runs inside resolveDir for every renderer-supplied `cwd`, permanently widening the process-wide write allow-list to `<root>/.claude` for any directory under $HOME the renderer names. Intended for project agent-memory, but it is a global side effect of a read-shaped call (list/stale); consider registering only when an agent target with scope project/local is requested.

### Minor
- memoryTool.cjs:~104-120 `autoMemoryDirectory` is honored from project-level `.claude/settings.json` (checked-in, untrusted repo content). It is bounded by validatePath/validateWrite (home boundary) but lets a cloned repo redirect where the tab writes; consider ignoring the project scope for this key.
- memoryTool.cjs list(): a missing agent/native dir returns the listDir ENOENT error (not `entries: [], error: null` as the PRD implementation notes intended), so a fresh agent dir surfaces a "Memory list failed" toast. Not an acceptance criterion.
- memoryTool.cjs resolveDir: `gitRepoRoot` memoization is per-cwd for the process lifetime; a repo created/moved later at the same cwd is not re-detected until restart.
- No unsafe input handling, secrets, or duplicated helpers found otherwise (encodeCwd and config.writeTextAtomic reused).
