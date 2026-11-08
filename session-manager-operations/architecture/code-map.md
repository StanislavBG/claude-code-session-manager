# Code map — load-bearing files + renderer data flow

> Orientation for "which file owns this?" — current state only, no history. Read the relevant
> entry before editing a subsystem. Paths are relative to `src/main/`, `src/renderer/`, or `scripts/`.

## Architecture (load-bearing files)

**Main process** (`src/main/*.cjs`):
- `index.cjs` — BrowserWindow + IPC registration. Navigation locked: `setWindowOpenHandler` denies, `will-navigate` allows only the dev URL.
- `config.cjs` — fs layer. **All paths go through `validatePath` (allowedRoots = home dir)**. Atomic writes delegate to `lib/util/atomicFs.cjs`. Chokidar watchers refcounted per absolute path.
- `transcripts.cjs` — tails `~/.claude/projects/<encoded-cwd>/<sessionUuid>.jsonl`, classifies events, ring-buffers per tab, broadcasts `transcript:event:<tabId>`.
- `lib/epic/restorableSessions.cjs` — which of ONE project's CLI transcripts a new Epic may adopt (UUID name, first recorded `cwd` exactly the project's, a real first prompt, no Epic claiming the id); read-only and bounded (one project dir, 64 KiB head/tail reads, ≤ 200 head reads per call). `listRestorableSessions` backs IPC `promptSessions:list-restorable`; `checkRestorableSessionSync` is `epicMint.cjs`'s restore gate.
- `memoryAggregate.cjs` — Memory Clusters backend. Reads one project's workspace memories (the store `memoryTool.cjs` owns) and, on explicit `refresh: true` only, runs one cost-gated `claude -p` pass that groups them into clusters with `[[wikilink]]` connections. Cache: `<cwd>/session-manager-operations/memory-clusters/clusters.json`.
- `chatRunner.cjs` — runs a dormant Terminal tab's chat command as a headless `claude -p --output-format stream-json` job (first command `--session-id`, later `--resume`). FIFO queue; queued runs start when `sessionSlots` grants a slot. Stop-signal protocol `<<<SM_NEEDS_INPUT>>>`+JSON lets a run ask questions.
- `scheduler.cjs` — runs each active project's PRDs (`<cwd>/session-manager-operations/scheduler/epics/<epic-id>/prds/`, resolved via `lib/prd/prdLocations.cjs`) as `claude -p` jobs; per-project queue/history live in `<cwd>/session-manager-operations/scheduler/state/`. Dispatch, the `needs_review` ladder, and reap/orphan machinery: [`scheduler-operations.md`](scheduler-operations.md).
- `supervisor.cjs` — every 15 min, Opus probe per running job; SIGTERMs descendant bash on stuck poll-loops without killing the agent. Cost-gated by `SM_SUPERVISOR_DISABLE`.
- `lib/scheduler/dodDrainHook.cjs` — definition-of-done gate, fired fire-and-forget at queue-drain: re-verifies each completed PRD's AC, flags risky surfaces, writes `runs/<ts>/definition-of-done-<key>.md`. Idempotent per completed set (`batchKey` + `reportExists`). Skipped when paused or cancelled. Kill-switch: `SM_DOD_DISABLE=1`.
- `scripts/scheduler-watchdog.cjs` + `scripts/scheduler-watchdog.sh` — external check-and-exit watchdog (systemd user timer or cron): heartbeat-gated liveness check, then relaunch if stale-and-dead. Queue reconciliation lives in `scheduler.cjs`, not here. Install via `scripts/install-scheduler-watchdog.sh` (`SM_WATCHDOG_DRYRUN=1` previews).
- `webRemote.cjs` — desktop half of Web Remote (bridge to the bilko.run relay for the phone app); UI is Settings → Phone remote.
- `pty.cjs` — node-pty per tab, keyed by renderer-generated UUID = claudeSessionId.
- `ipcSchemas.cjs` — zod schemas validate IPC payloads at the main-process boundary.
- `lib/telemetry/telemetrySettings.cjs` / `lib/machineProfile.cjs` / `lib/telemetry/telemetryClient.cjs` / `lib/telemetry/telemetryBacklog.cjs` — anonymous, on-by-default telemetry to bilko.run: consent + identity, machine-class profile, egress client, error-log backlog drainer. Detail: [`telemetry.md`](telemetry.md).
- `lib/feedback-remote/customerFeedbackClient.cjs` / `lib/feedback-remote/customerFeedbackInbox.cjs` / `lib/feedback-remote/customerFeedbackIpc.cjs` / `lib/feedback-remote/customerFeedbackAdminRoutes.cjs` — in-app customer feedback: submit + status lookup, owner inbox, renderer IPC, admin routes behind the `customer_feedback_*` MCP tools. Detail: [`customer-feedback.md`](customer-feedback.md).
- `lib/persona-macro/macroJobDispatch.cjs` — `dispatchMacroJob`: turns a built-in macro press into ONE artifact-only scheduler PRD (key `macroId`) inside an existing Epic; never mints an Epic. Chat path stays for revisions in that Epic.
- `lib/persona-macro/macroJobStatus.cjs` — `macroJobStatuses`: read-only state of each macro's newest background job (live queue row, else bounded history tail).
- `lib/persona-macro/macroJobIpc.cjs` — IPC `macros:dispatch-job` / `macros:job-status` (renderer: `window.api.macros.dispatchJob` / `jobStatus`). Rows carrying `macroId` skip the sweep validator and the PLAN SETTLED digest.
- `lib/mdNetworkScan.cjs` — Project Home Tools › Review MD network's markdown link network, no LLM, read-only: `scanMdNetwork(cwd)` lists docs with one `git ls-files -z` and reads them breadth-first from the root `CLAUDE.md` (bounded by `MAX_DOCS` / `MAX_DOC_BYTES`); pure `buildMdNetwork` returns nodes, edges and `broken-link` / `orphan` findings. IPC `project-pages:md-network` (`window.api.projectPages.mdNetwork`).
- `queueOps.cjs` — scheduler PRD queue linter (unbounded-loop + post-AC overrun detection) + archive + retag.
- `pluginInstall.cjs` — hidden-pty plugin install via `claude plugin install <slug>`. Slug regex `/^[a-z0-9][a-z0-9\-/]*$/`, 5 min kill ceiling, single in-flight per slug.
- `memoryTool.cjs` — workspace-scoped memories CRUD for the `memory_20250818` tool.
- `lib/feedback-remote/localAdminHttp.cjs` — loopback-only, token-authed HTTP admin API (token in `~/.claude/session-manager/admin-api.json`). Wrapped as MCP tools by `scripts/scheduler-mcp-server.cjs`; those tools work only while the Electron app runs.

**Renderer** (`src/renderer/`):
- `state/config.ts` — per-path FileState with dirty tracking, backed by `config.cjs` IPC.
- `state/live.ts` — per-tab derived state (todos, plans, agents, usage) fed by `transcript:event:<tabId>`.
- `state/voice.ts` — voice store + auto-submit timer + idle-stop timer + drain watchdog.
- `state/scheduleState.ts` — scheduler queue state (jobs, history, filters, per-project group ordering).
- `state/toast.ts` — toast message queue, consumed via `useToast()`.
- `components/tabs/Settings.tsx` — canonical "scoped editor" shape (ScopeSwitcher + SaveBar + JsonEditor).
- `components/tabs/Skills.tsx` — canonical "list+detail" shape; Hooks, McpServers, Plugins follow it.
- `components/tabs/Scheduler.tsx` — Scheduler cockpit; renders Queue/PRDs/History via SchedulePanel + scheduleState.
- `components/tabs/Memory.tsx` → `tabs/memory/explorer/` (`MemoryExplorer` shell, `useMemoryExplorer` hook, `model.ts`, view components) over main-side `lib/memoryOps.cjs` + `memoryAssist.cjs` + `memoryAggregate.cjs`.
- `components/tabs/projecthome/ProjectHome.tsx` — Project Home (NavKey `project-home`): the Pages / Videos / Tools key buttons over `projectpages/ProjectPagesSection.tsx`, fed by one `useProjectPagesOutput` + `useMacroJobStatus`; presses every `surface: 'project-home'` macro through `lib/useMacroLaunch.ts`; owns the active tab, this window's last launch per macro, the `“<title>” is ready` toast and the Tools findings count.
- `components/tabs/projecthome/projectpages/ProjectHomeKeyButtons.tsx` — the three key buttons. `libraryKeyStats` / `libraryKeyMeta` give Pages and Videos their ready + building badge and meta line; Tools shows the last link-map findings count, hidden until scanned. Presentational.
- `components/tabs/projecthome/projectpages/PagesPane.tsx` — Pages tab: knowledge-page list (Rename · Delete) beside the page in `HtmlFrame`. Generate page / Regenerate… open `GenerateComposer`; its lines go out as `builtin-project-home`'s `extraInstructions`, fitted under the 4000-char cap by `fitInstructions` (Regenerate's `Replace entry: <id>` is never cut). Also the building / failed rows and the `LibraryEmptyState` starter gallery.
- `components/tabs/projecthome/projectpages/VideosPane.tsx` — Videos tab in the Pages layout: thumbnail rows beside `VideoPlayer` plus SOURCES / QUALITY REPORT cards from `meta.json`; Generate video / Regenerate… launch `builtin-demo-video` the same way.
- `components/tabs/projecthome/projectpages/ToolsPane.tsx` — Tools tab: `builtin-review-md-network` first, then every other `surface: 'project-home'` macro except the two library built-ins. Add a tool opens `MacroEditor` preset to Project Home. Review MD network's Scope / Mode / Run review sit over one `projectPages.mdNetwork` scan per cwd (Refresh re-scans; never polled).
- `components/tabs/projecthome/projectpages/GenerateComposer.tsx` — the Generate page | video modal (a portal on `lib/zLayers.ts`): template list + settings in Generate mode; settings only, pre-filled from the entry, in Regenerate mode. Hands the caller the prompt lines and the entry id to replace.
- `components/tabs/projecthome/projectpages/composerTemplates.ts` — pure composer data: page / video templates and option lists; `pagePromptLines` / `videoPromptLines` (the `Page:` `Audience:` `Length:` `Read from:` and `Video kind:` `Video target:` `Video style:` `Video length:` `Character:` lines the two library macro prompts read); Regenerate pre-fills `pageCfgFromEntry` / `videoCfgFromEntry`; `canGenerate`.
- `components/tabs/projecthome/projectpages/MdLinkMap.tsx` — Review MD network's LINK MAP (SVG; four columns by link depth, crowded folders collapsed, Missing and orphan nodes) and FINDINGS cards. Pure `layoutMdNetwork` does the layout. Presentational.
- `components/SchedulePanel.tsx` — reusable pane (Queue/PRDs/History). Owns filter state.
- `components/tabs/scheduler/sched-primitives.tsx` — shared scheduler primitives: SchBadge (status color/mark), ProjectTag, DetailBlock/Line.
- `components/ui/` — shared primitives (Panel, ScopeSwitcher, SaveBar, JsonEditor, KVTable, ListDetail, Toggle, EmptyState).
- `components/ui/Toast.tsx` — non-fatal error surfacing (`info / warn / error`). Mounted above modals, below RecordingStatus.
- `components/layout/AlmanacFooter.tsx` — the BOTTOM bar and the app's only status strip: connection dot, session (5h) + weekly (7d) usage pills, scheduler-paused pill, active tab + branch (`lib/useBranch.ts`), last-activity, todos, version. Usage pills route to Home's `components/tabs/home/UsageMeters.tsx`; both share `lib/usageWindow.ts` so percentages and reset times can't drift.
- `components/TabBar.tsx` — the TOP bar: navigation ONLY (Home pill plus one tab per open project). Status, usage, and branding belong to the footer. Its scrollbar is hidden via `.no-scrollbar` (styles.css) because the global 10px scrollbar eats a fixed-height bar. E2E "app booted" waits key off `[data-testid="tour-tabbar"]`.
- `components/CommandPalette.tsx` — Cmd-K palette with fuzzy filter + emit-only dispatch. Suppressed inside Monaco / text inputs.
- `components/epics/RestoreSessionPanel.tsx` — New Session card's "Restore a session" picker on the advanced face, above Context Injections: lists `window.api.promptSessions.listRestorable` minus sessions open as tabs, loads only while mounted, renders every failure as a state; the picked id rides to the mint as `restoreSessionId`.
- `lib/prdFrontmatter.ts` — round-trip YAML preservation for the scheduler PRD views.
- `lib/chatVerbosity.ts` + `state/chatPrefs.ts` — chat-feed density dial (`VerbosityDial` in `components/epics/EpicDetail.tsx`). Five levels, numbered loudest-first (1 `raw` … 5 `summary`); `turnMinVerbosity(turn)` maps each turn to the quietest level showing it; unknown kinds map to `raw`. A turn asking the human something is never hidden or clamped, and the in-flight bubble always keeps its tool strip. Nothing leaves the store. Prefs persist to `~/.claude/session-manager/chat-prefs.json` (global default + sparse per-Epic override).
- `lib/promptPreamble.ts` — `splitInjectedPreamble(text)` peels the instruction blocks `chatRunner.cjs` prepends to every prompt so the feed shows only the human's words (level 1 shows them). Blocks are anchored on first and last sentence only, guarded by `src/main/__tests__/chat-preamble-anchors.test.cjs`. `turn.text` is never rewritten. `state/chat.ts` dedupes optimistic user turns by comparing the preamble-stripped body, upgrading the optimistic turn in place.
- `lib/knownProjectAggregate.ts` — **a PROJECT is a CWD**, enforced in one pure place. `aggregateProjectsByCwd` folds per-folder rows from `~/.claude/projects/` into one aggregate per unique `normalizeCwd(cwd)` and keeps every contributing folder in `encodedIds`. A row whose cwd never resolved is DROPPED, never guessed. Every "list the projects" surface consumes `useKnownProjects().projects`; raw `rows`/`enriched` are folder-level bookkeeping only.
- `lib/historyProjectFold.ts` — applies the same cwd rule to History: `foldHistoryDaysByCwd` re-keys each day's `byProject` (from `historyAggregator.cjs`'s `encodedCwd` buckets) to the resolved cwd, merging `toolBreakdown` and `byModel`. Excluded folders are summed and stated on screen (`history-excluded-note`), never silently discarded.
- `lib/homeProjectRows.ts` — row shaping for Home's projects card and the New-epic drawer.
- `lib/terminalSettings.ts` — terminal theme (`dark`/`light`/`paper`) + font size: one APP-WIDE preference in `localStorage['sm.terminal.settings']`, read at mount by every xterm surface and repainted live on the `sm:terminal:settings` window event. Edited only from `components/tabs/home/TerminalAppearanceCard.tsx`; don't add a per-pane copy. Distinct from `state/editorPrefs.ts` (Monaco theme); the app chrome has no theme switch.
- `lib/prettyModel.ts` — single source of truth for model-name shortening (incl. `[1m]` suffix); import it, never copy it.
- `lib/dataModelErd.ts` + `components/tabs/DataModel.tsx` — hand-maintained MIRROR of the app's persisted shapes (entities, paths, owners, fields, relations), not a scanner. Update it in the same PR that changes a persisted shape; the `dataModelErd.ts` header lists each entity's source. Home face only, via `lib/navGroups.ts`.

## Renderer data flow

The renderer uses isolated zustand stores (no cross-store subscription). Data flows: **main process → IPC broadcast → store subscription → selector → component hook**.

1. **Main process** publishes events (`config:changed`, `transcript:event:<tabId>`, `schedule:snapshot-changed`, etc.) as IPC broadcasts.
2. **Zustand stores** subscribe and update independently; components cannot trigger store-to-store updates.
3. **Components** consume stores via hooks (`useConfig()`, `useLiveTab()`, `useScheduleState()`). For multi-store queries, compose selectors in the component or use memoized helpers.
4. **Panes** (SchedulePanel, History views) own local UI state (filters, collapsed sections) and accept props for the data they display.

## Future: Files API (not yet surfaced)

The **Files API** (`anthropic-beta: files-api-2025-04-14`; reference by `file_id`, 500 MB/file, ZDR-ineligible)
is not yet surfaced. Needs: new IPC namespace, separate Anthropic API key resolution, CSP changes for
`api.anthropic.com` uploads.
