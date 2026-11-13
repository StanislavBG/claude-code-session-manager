# Validation: MD network explorer plan (PRDs 2989-3000)

Base: 746f2ae31bc4ff0d35fd8d6421fd6241d9214593. HEAD includes unrelated sibling-plan commits (agent-cli, app-preview, epic-changes); they are outside this plan and not judged here.

## Combined run
`npx vitest run src/renderer/components/tabs/projecthome src/main/lib/__tests__ src/main/__tests__/projectPages.test.cjs src/main/lib/feedback-remote/__tests__/remoteIpcDispatch.test.cjs` (SM_* env unset): 96 files, 1212 tests, all passed. Also `mdCurate.test.ts` + `useMdCuration.test.ts` (outside that path set): 21 passed. `npm run typecheck`, `npm run lint`, `npm run lint:docs`: exit 0. The scoped gate commands of every PRD are covered by these runs (same test files, same typecheck/lint).

## Real-path probe (scanMdNetwork on main checkout, read-only)
- wall time 3270 ms; result keys include `census`.
- census.counts: tracked 396 (target ~394), network 48, records 300, unlinked 25, byRole map 1 / scoped 8 / agent 24 / record 300 / doc 63. gitWindow: 2000 commits. warnings: [].
- collections: one, `session-manager-operations/reviews/`, 305 docs, 5 linked, source heuristic.
- findings: 8; findings containing a record path: 0.
PASS.

## Per-PRD verdicts
- md-doc-census: VERIFIED. mdDocCensus.cjs present; tsconfig.main.json:26 and lib-layout.json:86 list it; mdDocCensus.test.cjs passes; census types in api.d.ts; probe shows role and collection logic works on real data.
- md-doc-refs: VERIFIED. mdDocRefs.cjs present; tsconfig.main.json:27, lib-layout.json:87; mdDocRefs.test.cjs (incl. real git grep) passes.
- md-network-census-scan: VERIFIED. census attached; probe shows records leave orphan findings (0 hits); mdNetworkScan + projectPages tests pass.
- md-map-graph-layout-options: VERIFIED. MdLinkMap.test.tsx passes with prior assertions unchanged plus new tests; MdMapGraph/onNodeClick present.
- md-network-explorer-overlay: VERIFIED. MdNetworkExplorer.test.tsx passes; Modal-based.
- md-curate-helpers: VERIFIED. mdCurate.ts (STALE_DAYS=90, 4000 cap, 2000 path cap) and tests pass; uiPrefs mdCuration added.
- md-doc-preview-panel: VERIFIED. MdDocPreview.tsx: onClickCapture interception, sm:open-editor dispatch, revealPath; no dangerouslySetInnerHTML; tests pass.
- md-doc-table-view: VERIFIED. MdDocTable.test.tsx passes.
- md-explorer-tools-wire: VERIFIED. md-link-map-expand and onExplore in MdLinkMap.tsx; ToolsPane tests pass with the new strip text.
- md-network-overrides-ipc: VERIFIED. schemas.projectPagesMdNetwork (ipcSchemas.cjs:919), handler at projectPages.cjs:308; projectPages and remoteIpcDispatch tests pass.
- md-curation-persist-and-review: VERIFIED. useMdCuration.ts, md-curation-tray/md-curation-review in ToolsPane.tsx, CURATION_MODE 'Full review'; tests pass.
- md-network-explorer-docs: VERIFIED. code-map.md lists all seven files; DESIGN_SPEC.md and project-pages/README.md (mdCuration) updated; lint:docs exit 0.

## Combined-diff review (self-review; /code-review not run separately)
Critical: none.
Important: none.
Minor:
- Probe tracked count is 396 and reviews has 305 docs vs the 394/303 in the brief; the repo grew since, within tolerance.
- Visual check of the explorer (light/dark, full screen) is left to a human after release, as the PRD says.
Security: IPC override lists are schema-validated (repo-relative, no `..`, no NUL) and used only as path prefixes; preview renders via MarkdownPreview (DOMPurify) with link clicks intercepted; no secrets or new spawn paths seen.
