# Validation: demo-video target rules (PRD 3177)

Base: 9810b218f0d57fd1164381991129df7f315854cd. Six commits, eca065ab..fdd71d4d, 16 files. PRD files found in prds-archived/.

## video-meta-records-target — VERIFIED
- src/main/ipcSchemas.cjs:981 `target: z.string().max(300).optional()` in projectVideoMeta; the object is still strict. The admin write body is built from `projectVideoMeta.omit`.
- src/preload/api.d.ts:1653 `target?: string` with a doc comment.
- scripts/scheduler-mcp-server.cjs:639-645: kind description lists the three kinds, meta description lists the keys, and `meta` is in `required`.
- Gate: projectPagesMetaSchema.test.cjs 18/18 pass. `npm run typecheck` exits 0.

## video-blank-target-blocks-generate — VERIFIED
- composerTemplates.ts `canGenerate` returns `'kind' in cfg && (kind==='Project demo' || target.trim()!=='')`. The feature template has `target: ''`.
- LibraryEmptyState.tsx: `nameLabel` is 'Name a topic', 'Name a post' or 'Name a feature', and the click routes to onCustomize.
- GenerateComposer.tsx:338 `note="required" required`. The Feature placeholder reads 'Name one feature, e.g. the search box'.
- Gate: the 4 projectpages test files pass (107 tests).

## project-home-templates-project-neutral — VERIFIED
- The chips and covers in the composerTemplates.ts diff match the PRD's lists exactly. The header comment notes the deliberate deviation from the prototype. The banned-terms test is in composerTemplates.test.ts, and the gate passes.

## video-card-shows-target — VERIFIED (see Important 1)
- VideosPane.tsx has the `data-col="target"` span and `videoSub` includes the target.
- `videoCfgFromEntry` sets `target: meta.target?.trim() ?? ''`.
- Gate passes (VideosPane and composerTemplates tests).

## demo-video-macro-v9-no-target-rule — VERIFIED (see Important 2)
- builtinMacros.cjs: builtin-demo-video has builtinVersion 9 and 8 priorPrompts.
- A script check shows v9 with the inserted sentence removed equals priorPrompts[7] exactly (the v8 prompt).
- The prompt contains 'never pick a post or feature yourself'.
- Gate: builtinMacros.test.cjs passes.

## demo-video-persona-v13-target-rules — VERIFIED
- demo-video-builder.md has seedVersion 13. `<kind_and_target>` has the no-target fallback, the phrase 'never pick a post or feature yourself' (count 1), the report-the-fallback instruction, and the claims-check rule.
- Step 8 meta keys are title, kind, target, style, lengthS, character, sources, report, macroVersion, seedVersion, model, effort. These match projectVideoMeta (ipcSchemas.cjs:977-995) minus id and createdAt. The 'audience' key is gone.
- shippedPersonaSeeds.cjs has a `seed-v13` entry. The gate (builtinMacros + seedAgentPersonas, 66 tests) passes.
- The phrase appears in both the persona and the macro prompt.

## Full-tree checks
- `npm run lint`: exit 0.
- `npm run test:unit`: 4 failed, 10466 passed. 3 distinct failing files (the 4th failure is in one of them). All three are regressions caused by this plan (Important 1-3).

## Findings

### Critical
- none

### Important
1. src/renderer/components/tabs/projecthome/projectpages/__tests__/ProjectPagesSection.test.tsx:~366 "Regenerate… rebuilds the selected video in place" is red. It Regenerates a blog-post video whose meta has no target. Since 3172, `canGenerate` blocks a blank target, so Generate is disabled and `onLaunch` gets no calls. The test needs `target` in its fixture meta (or a typed target). It is outside every PRD's Files list, and the scoped gates missed it.
2. src/main/lib/persona-macro/__tests__/macroLibrary.test.cjs: "re-stamped project-home v2 and demo-video v6 copies upgrade to v3 and v8" fails with `expected 9 to be 8`. The test still pins the demo-video upgrade target at v8, but the macro is now v9.
3. src/main/lib/__tests__/schedulerMcpServerProjectHome.test.cjs: "project_page_write and project_video_write are listed … required fields" fails. It expects the old `required` list for project_video_write. The list now includes 'meta' (scheduler-mcp-server.cjs:645).

Items 2 and 3 are stale pins in tests that no PRD listed. All three need a fix wave.

### Minor
- composerTemplates.ts: `canGenerate` for a video relies on `'kind' in cfg`. A page cfg passed with kind 'video' returns false silently. This is harmless today.
