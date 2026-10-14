# Validation: memory-fix-triage-apply (second half of the Memory fix plan)

Base: 55d4c540 (given). Commits in range: 33b8d2de (memory-fix-triage), 5ba1031f (memory-fix-triage-hook), fd337c4b (memory-fix-triage-ui).
Note: the job worktree had no `node_modules`; I temporarily symlinked the main checkout's (gitignored) and removed it after the gates. The untracked `<path>` file is the known sqlite-MCP placeholder, not mine.

## memory-fix-triage — VERIFIED
- Result shape + invalid-action / missing summary|reason rejection: `src/main/memoryAssist.cjs` proposeFix (`ACTIONS` set, `base = {ok,action,summary,reason,content:'',fold:null}`); content only set for update.
- makeRefResolver + listTrackedFiles + extractRoots-backed scoreMemories; `defaultGitLsFiles` removed (diff); prompt uses "Unresolved paths", FIX_POLICY has no "no longer exists" claim (only the prohibition "Never write that a path no longer exists…").
- collectMdNetwork in prompt (root CLAUDE.md, docs list, coverage); FIX_SYSTEM / FIX_POLICY match the PRD's exact strings.
- Fold rules (allowlisted target, 1–3 lines, ≤600 chars, anchor '' or exactly-once line) in proposeFix; frontmatter check kept for update.
- Tests: `memoryAssist.test.cjs` has happy paths, invalid action, fold rejections, "unresolved"/not "no longer exists", coverage line.
- Gate: `vitest run memoryAssist/memoryRefResolve/memoryMdNetwork/memoryStale` → 4 files, 44 tests passed.

## memory-fix-triage-hook — VERIFIED
- `src/preload/api.d.ts` exports `MemoryFixProposal` with the exact shape; `memory.proposeFix` returns `Promise<MemoryFixProposal>`; doc comment updated.
- `useMemoryExplorer.ts`: `proposeFix: (name) => Promise<MemoryFixProposal>`; `fail()` returns action 'keep', reason '', fold null.
- `MemoryExplorer.hook.test.tsx:143` fold pass-through test.
- Gate: `npm run typecheck` rc 0; hook test passed (within the 3-file run, 29 tests).

## memory-fix-triage-ui — VERIFIED
- MemoryReader: per-action header (`actionHeader`), summary + reason, diff only for update, fold '+' rows under `target · anchor|append at end`.
- `ACTION_UI` labels/hints match the AC exactly (Apply/Archive/Mark verified/Copy for an Epic).
- MemoryExplorer.applyFix: delete→archive with undo→restore; keep→verify; fold→`window.api.clipboard.writeText` of the specified text then `say('Fold copied — paste it into a New Epic')`; update→saveBody with undo, sets `appliedSlug`.
- `appliedStill={appliedSlug === selRow.slug && selRow.stale}` → "Applied — still flagged: <reason>".
- "Review with assistant" (testid mx-reader-fix) on non-stale, non-archived idle rows; checking/proposed panels no longer gated on row.stale.
- Tests: reader test `it.each` over the four actions (header/label/hint), fold rows, appliedStill, Review on non-stale row.
- Gates: typecheck rc 0; `npm run lint` rc 0; reader+shell+hook vitest → 3 files, 29 tests passed.

## Plan-level — VERIFIED
- Diff `55d4c540..HEAD` over `src/main`: no added writeFile/appendFile/rename/unlink/mkdir/validateWrite (grep → none); `memoryTool.cjs` untouched; the only fs access added is `readFile` of the fold target. The fold clipboard path writes no repo file.
- FIX_POLICY never tells the model a path "no longer exists"; it forbids saying so without a candidate.

## Findings
### Critical
- none
### Important
- none
### Minor
- `MemoryExplorer.tsx` applyFix 'keep' → `actions.verify`: the existing reader hides "Mark verified" for dead-ref stale rows (reader test line 63), so a 'keep' verdict on such a row may not clear the flag and could look like a no-op; only the update path gets the "Applied — still flagged" note. Not exercised by any test.
- `memoryAssist.cjs` buildFixPrompt: root CLAUDE.md truncation is byte-based via `subarray` (safe via utf8 re-decode) but silently cuts the doc mid-line; acceptable given the cap.
- Fold target is validated against the collected docs, and the anchor check reads `path.join(cwd, target)` only from that allowlist, so no path traversal.
