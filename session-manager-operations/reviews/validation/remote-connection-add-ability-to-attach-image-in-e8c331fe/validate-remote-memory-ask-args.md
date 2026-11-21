# Validation: remote-memory-ask-target-args (PRD 3260)

Base: 9efef7b4. Commit: 45895f01 `fix(memory): flatten ask/proposeFix target in main schema so remote calls validate` (4 files, exactly the PRD's # Files).

## remote-memory-ask-target-args — VERIFIED

- AC1 preload forwards unchanged: `src/preload/index.cjs:413-414` `ask: (arg) => ipcRenderer.invoke('memory:ask', arg)` / proposeFix likewise. `api.d.ts` not in the diff (unchanged).
- AC2 preprocess wrapping: `src/main/ipcSchemas.cjs:848-869` `flattenMemoryTarget` merges truthy workspace/cwd/agent over top level (target wins), drops falsy contextName; `memoryProposeFix = z.preprocess(flattenMemoryTarget, memoryNamed)` (:861), `memoryAsk` wraps a `.strict()` object (:862-869). memoryVerify/Archive/Restore remain `memoryNamed` (:834-836). Exported at :1632-1633.
- AC3 same shape for old flat and new nested: test "legacy flat shape parses to the same object as the nested shape" passes; `memoryTool.cjs:469-470` consumes via `v(s.memoryAsk, askMemory)` / `v(s.memoryProposeFix, proposeFix)`; memoryTool.cjs is untouched, so askMemory/proposeFix receive the same flat object as the old preload built. Unknown keys inside target (non-allowed key leaves `target` in place -> strict rejects) and outside are rejected (tests at test.cjs:45, :50).
- AC4 `apiSurface.test.cjs` diff removes 2 lines (memory.ask / memory.proposeFix no longer in KNOWN_UNDESCRIBED); drift test passes.
- AC5 `memory-target-schema.test.cjs` has 7 tests: ask nested, proposeFix nested, legacy flat, falsy dropped, unknown key in target, unknown top-level key, verify/archive/restore unchanged.
- Desktop payload unchanged: old preload `{question, contextName?(truthy), ...truthy target keys}` == new flattened output (verified by reading both and by the equivalence test).

## Gate re-run
- `vitest run` (7 files from the PRD gate): 7 files / 54 tests passed.
- `npm run typecheck`: exit 0.

## Combined diff review
`git diff base..HEAD --stat` also shows `web/remote-app/src/__tests__/ws-package.d.ts` (+3 type decls), from another PRD in the plan, not 3260; benign. Self-review (code-review/security-review done by reading): no secrets, no path handling added (cwd/workspace still validated by existing MEMORY_CWD / MEMORY_WORKSPACE_RE regexes and config.validatePath downstream), no duplicated helper beyond the intentional main-side port of `memoryTarget()` (still defined in preload, still used by other memory rows).

## Findings
- Critical: none.
- Important: none.
- Minor: `src/preload/index.cjs:4-11` `memoryTarget()` may still be used by other rows; if it is now unused by any, it is dead code (not checked beyond ask/proposeFix). Minor behavioral change: a non-object `target` or a target with extra keys was previously silently dropped by the preload and is now rejected by main. This is in line with the PRD's AC3 (unknown keys rejected).
