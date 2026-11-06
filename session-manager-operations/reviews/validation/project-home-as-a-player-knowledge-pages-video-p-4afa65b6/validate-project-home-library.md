# Validation: project-home-library plan (Base a43a8be5)

Method: per-PRD commits via `git diff a43a8be5..HEAD --stat` (50 files, 28 commits); all per-PRD gate commands re-run; `npm run typecheck` (exit 0); `lint:selectors` OK, `lint:hooks` OK; full `npm run test:unit` run twice with SM_* unset.

Combined gate re-run (every PRD's vitest files together): 19 files / 436 tests passed. Covers projectPagesMetaSchema, pagesLibrary, playerBridge, projectPages, projectHomeAdminRoutes (incl. Burrow `/admin/project-home/demo-video/write` alias, `projectHomeAdminRoutes.cjs:295`, tested green), schedulerMcpServerProjectHome, mcpToolCatalog, smfileHeaders, projecthome renderer tests, persona-macro, seedAgentPersonas, personaToolScope.

**Full `npm run test:unit`: RED, 2 failures, reproducible on rerun (880/882 files):**
1. `src/preload/__tests__/apiSurface.test.cjs` — preload exposes `projectPages.rename` and `projectPages.delete` (`src/preload/index.cjs:381` block) but the apiSurface table lacks them.
2. `src/renderer/components/__tests__/ProjectHomeEmptyState.test.tsx` — `ProjectPagesSection.tsx:331` throws `Cannot read properties of undefined (reading 'length')`; the test stub (`ProjectHomeEmptyState.test.tsx:23`) returns `{output:null}` for `projectPages.get`, so `knowledge`/`videos` are undefined. Test passes in isolation of `projecthome/` dir only because it lives elsewhere.

Screenshots (project-home-library-screenshots): `screens/{knowledge,videos}-{dark,light}.png` exist; viewed videos-light (2 videos, Product tour + Release notes, player) and knowledge-dark (2 pages, Project overview + How it works).

## Per-PRD verdicts
- pages-meta-schemas — VERIFIED (`ipcSchemas.cjs` +81; test passes)
- pages-library-read — VERIFIED (`lib/project-pages/pagesLibrary.cjs`; 161-line test passes)
- pages-get-ipc-types — VERIFIED (`projectPages.cjs`, `api.d.ts`; test passes)
- video-player-bridge — VERIFIED (`playerBridge.cjs`; test passes)
- pages-write-routes — VERIFIED (routes test passes incl. demo-video/write alias returning {ok,path,bytes} and adding an entry)
- pages-write-mcp-tools — VERIFIED (`mcpToolCatalog.cjs`, `scheduler-mcp-server.cjs`; tests pass)
- viewer-fence-videos — VERIFIED (`smfileHeaders.cjs`; test passes)
- video-player-component — VERIFIED (`VideoPlayer.tsx`; test and lints pass)
- knowledge-video-pages-ui — REFUTED — its change left ProjectHomeEmptyState spec red (undefined knowledge/videos crash); component also unguarded at `ProjectPagesSection.tsx:331`
- library-rename-delete-ipc — REFUTED — added `projectPages.rename/delete` to preload without updating the apiSurface table; contract spec red
- library-rename-delete-ui — VERIFIED (UI tests pass)
- macro-job-entry-id — VERIFIED
- project-home-builder-seed-hash — VERIFIED
- project-home-builder-v4-pages — VERIFIED
- project-home-macro-page-input — VERIFIED
- docs-knowledge-vs-video-pages — VERIFIED (`project-pages/README.md` +73, `conventions.md` +15)
- project-home-library-screenshots — VERIFIED (4 PNGs, 2 videos / 2 pages)

## Findings
### Critical
none
### Important
- `src/preload/__tests__/apiSurface.test.cjs` table missing `projectPages.rename`, `projectPages.delete` (suite red).
- `src/renderer/components/tabs/projecthome/projectpages/ProjectPagesSection.tsx:331` assumes `knowledge`/`videos` arrays; `src/renderer/components/__tests__/ProjectHomeEmptyState.test.tsx:23` stub needs `{knowledge:[],videos:[]}` (or the component/hook should default them). Suite red.
- Both are the "scoped gates hide contract breaks" pattern: per-PRD gates never ran these specs.
### Minor
- Foreign uncommitted `project-pages/home.html` present in tree; not reviewed.
- `/code-review` and `/security-review` not run separately; self-review of the diff found no path traversal or secret issues in the new write routes (cwd/id handling goes through existing helpers); not exhaustively audited.
