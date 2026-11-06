# Validation — Project Home background builds

Base: bce8e7c5 (known). HEAD 83a49bdb. 13 PRDs (2545–2557), 13 commits (65585305 … 83a49bdb), 48 files.
Combined checks: `npm run typecheck` green; `npm run lint` green; `npm run lint:docs` green; CLAUDE.md 11,994 B (< 12,000).
**`npm run test:unit`: 1 failed / 8277 passed** — `src/renderer/components/__tests__/ProjectHomeEmptyState.test.tsx > renders no hand-written live blocks…` (`Cannot read properties of undefined (reading 'jobStatus')`). Reproduced in isolation with SM_* job vars unset. Not caused by foreign WIP.

## Per-PRD
- **builder-personas-admit-write-tools (2545)** VERIFIED — `src/seed/agents/{demo-video,project-home}-builder.md` tools now end in `mcp__session-manager-scheduler__project_*_write`, seedVersion 6/3; `shippedPersonaSeeds.cjs` gains seed-v6/seed-v3 entries; seedAgentPersonas tests pass in suite.
- **scheduler-scope-boots-only-named-server (2546)** VERIFIED — `personaToolScope.cjs` emits `--mcp-config {mcpServers:{named}} --strict-mcp-config` only when every mcp__ server is known; `scheduler.cjs:4513` `knownMcpServers()`; `seedSchedulerMcp.cjs` `schedulerServerEntry`. **Real probe**: argv built from the landed code for demo-video-builder tools, `timeout 120 claude -p --model haiku` with `Reply OK` on stdin → init `mcp_servers=[{name:"session-manager-scheduler",status:"connected"}]`, tools contain `mcp__session-manager-scheduler__project_demo_video_write`.
- **builtin-macros-declare-background-job (2547)** VERIFIED — `builtinMacros.cjs` both macros have frozen `job{estimateMinutes 20/60, artifactPaths}`; macroLibrary exposes `job`.
- **prd-frontmatter-macro-id (2548)** VERIFIED — `prdFrontmatter.cjs` RECOGNIZED/EMIT keys + regex; `prdCreate.cjs` validates before NN allocation and emits `macroId:`.
- **queue-row-carries-macro-id (2549)** VERIFIED — `scheduleJobSchema.cjs` +macroId; `prdParser.cjs`; `scheduler.cjs` reconcile paths (1805, 1929, 2081) and listPrdsInternal carry it.
- **settle-runner-quiet-for-macro-builds (2550)** VERIFIED — `epicValidationHook.cjs` returns `{action:'none',reason:'macro-build'}` when all Epic rows carry macroId; macro slugs excluded from sweep candidates.
- **macro-job-dispatch-primitive (2551)** VERIFIED — `macroJobDispatch.cjs`: needs existing epicId, never creates an Epic; blocks on active row; archives stale failed row; artifact-only PRD. Gate validated with the real `validateGate`: `{"ok":true,"warnings":[]}`, single `timeout 60 node -e '…'` command, executed under bash → exit 0 when file fresh.
- **macro-job-status-primitive (2552)** VERIFIED — `macroJobStatus.cjs` maps queue rows → queued/running/done/failed, bounded history tail.
- **macro-job-ipc-handlers (2553)** VERIFIED — `macroJobIpc.cjs` zod-parses, validatePath, requires the Epic be `active` in the project's index; wired in `index.cjs:611`; schemas `ipcSchemas.cjs:667`.
- **preload-macro-job-contract (2554)** VERIFIED — `preload/index.cjs:140-141`, `api.d.ts`, `apiSurface.json`; typecheck green.
- **launch-session-job-mode (2555)** VERIFIED — `launchSession.ts`: `run==='job'` dispatches and returns before `useChat.send` (job macros never reach send); `useMacroLaunch.ts` reuses an active Epic else mints via launchSession; `remoteNewSession.ts` job-aware. Epic minting only through the pre-existing human-press path; `epicMint.cjs` untouched (diff empty).
- **project-home-build-status-line (2556)** REFUTED — ships a red test: its `useMacroJobStatus` is called unconditionally from `ProjectHome.tsx`, but `ProjectHomeEmptyState.test.tsx` (outside the PRD's scoped gate) mocks `window.api` without `macros.jobStatus`/`schedule.onState`, so the suite is red. The UI itself is sound (selectors return stable refs; hook state is component-local, no zustand fresh-object selectors).
- **doc-project-home-background-builds (2557)** VERIFIED — `src/renderer/CLAUDE.md`, `code-map.md`, `scripts/lib-layout.json`; `lint:docs` ok.

## Findings
- **Important** — `src/renderer/components/__tests__/ProjectHomeEmptyState.test.tsx:13` (api stub) lacks `macros.jobStatus`, `schedule.onState`; breaks full `test:unit`. Fix: add stubs (mirror `projectPages` stub at :44). Scoped gates hid it.
- **Minor** — `useMacroJobStatus.ts` calls `window.api.macros.jobStatus` with no guard for a missing method (older preload); a toast would fire once only on rejection, but a synchronous TypeError crashes the pane. Consider optional chaining.
- **Minor** — `macroJobDispatch.cjs` slug uses `Math.random()` suffix; acceptable, collisions negligible.
- Review checks: no `claude -p` spawn added without pinned model; no secrets/path traversal (cwd via validatePath, artifact paths are constants, gate refuses `'`/newline in paths).
