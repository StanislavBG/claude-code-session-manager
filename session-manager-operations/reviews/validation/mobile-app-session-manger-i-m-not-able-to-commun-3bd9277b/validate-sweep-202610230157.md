# Validation sweep — fix-phone-drop-summary-state (PRD 2111-fix-phone-drop-summary-state)

Base: 4060a376 (stated). Commit for this PRD: `27de06cd` fix(prd): refuse duplicate bare slug within an Epic before NN allocation (2 files: prdCreate.cjs, prdCreateDuplicateSlug.test.cjs).

## fix-phone-drop-summary-state — VERIFIED

- 409 before NN allocation: `src/main/lib/prd/prdCreate.cjs` ~L447-469 — guard scans Epic `prds/` + `prds-archived/`, strips `^\d+-`/`.md`, returns `{ok:false,status:409,...}`; sits before `remote.allocateParallelGroup` (~L471).
- Other Epic / distinct slug accepted; fix plans exempt: guard is scoped to the resolved Epic dirs and skipped when `isFixPlanSlug("0-"+slug)`.
- Test file covers the four cases (see test list in file); gate run: 6 files, 83 tests passed.
- `npm run typecheck`: exit 0.
- Nothing under `web/remote-app/` changed after base: `git diff 4060a376..HEAD --stat -- web/remote-app` empty.

Gate re-run (scoped vitest on 6 files + typecheck): green.

## Findings

- Critical: none.
- Important: none.
- Minor: `prdCreate.cjs` ~L450 — guard only runs when `input.sourcePromptId` is set; a PRD created without an Epic id is unguarded (and has no Epic to scan, so by design).
- Minor: the PRD's `# Files` list omitted nothing, but self-review (no `/code-review` run) found no path-traversal issue: epic dir comes from `resolveEpicPrdWriteDir`, unsafe ids caught.
