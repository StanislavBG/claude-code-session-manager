# Claude Code Session Manager

Electron desktop app — local cockpit for Claude Code CLI. Terminal + 25+ config/observability/scheduling tabs (Settings, Skills, Hooks, MCP Servers, Tasks, Plans, Usage, Subagents, History, Scheduler, Knowledge Graph, Web Remote, Memory, Permissions, etc.). Mobile web cockpit at bilko.run (v2: same-origin relay + session state/summary protocol).

## Stack

Electron 33 (CommonJS main + preload) · React 18 + Vite · Tailwind · zustand · xterm + node-pty · Whisper (ricky0123/vad-web + onnxruntime-web) for voice.

## Commands

- `npm run dev` — Vite + Electron with HMR. `SM_DEV=1` is set automatically.
- `npm run build` — production renderer build into `dist/`.
- `npm run typecheck` — `tsc --noEmit`. Must pass before commits.
- `npm run test:e2e` — Playwright Electron tests under `xvfb-run` (Linux).
- `npm run health` — `src/main/health.cjs`. Validates build (types, dist artifact, e2e infra present) + runtime (config dir writable, scheduler queue.json + PRD count, transcripts dir). Exit 0 = GREEN, 1 = RED. Entry point for `/local-project-health`.
- `npm publish` — runs `vite build` via `prepublishOnly`. Tag is `latest`.

## Architecture (load-bearing files)

**Main process** (`src/main/*.cjs`):
- `index.cjs` — BrowserWindow + IPC registration. Navigation locked: `setWindowOpenHandler` denies, `will-navigate` allows only the dev URL.
- `config.cjs` — fs layer. **All paths go through `validatePath` (allowedRoots = home dir)**. Atomic writes via tmp + rename. Chokidar watchers refcounted per absolute path.
- `transcripts.cjs` — tails `~/.claude/projects/<encoded-cwd>/<sessionUuid>.jsonl`, classifies events, ring-buffers per tab, broadcasts `transcript:event:<tabId>`.
- `memoryAggregate.cjs` — Memory Clusters backend (replaced the old Knowledge Graph tab/`kg.cjs`). Reads one project's workspace memories (the `.md` files under `~/.claude/projects/<encodedCwd>/memory/`, the same store `memoryTool.cjs` owns) and, via a single cost-gated `claude -p` pass (only fires on explicit `refresh: true`), organizes them into named semantic clusters with `[[wikilink]]`-derived connections. Cache: `~/.claude/session-manager/memory-clusters/<workspace>.json`. Spawn pattern mirrors the old kg.cjs: stdin closed, model pinned, hard timeout, `SM_KG_INTERNAL=1` so the prompt-logging hook skips it, brace-matching JSON extractor.
- `chatRunner.cjs` — runs a dormant Terminal tab's chat command as a headless `claude -p --output-format stream-json` job that exits when done (first command `--session-id`, later `--resume`). Serialized through a FIFO queue at concurrency 1 (`SM_CHAT_CONCURRENCY`, clamp [1,3]) so bursts can't fan out into a parallel-`claude -p` OOM. Stop-signal protocol `<<<SM_NEEDS_INPUT>>>`+JSON lets a run ask questions.
- `scheduler.cjs` — runs PRDs from `~/.claude/session-manager/scheduled-plans/prds/` as `claude -p` jobs. Modes: `manual` / `on-reset` / `when-available` (default; polls billing usage every 10 min — `POLL_INTERVAL_MS` in `lib/schedulerConfig.cjs`). Auto-pause on rate-limit, auto-resume at next 5h reset. **Boot reconciliation**: on startup, reaps orphaned jobs (PIDs no longer alive) and logs outcome (success/timeout/error). **Dead-process reaper**: background process check + PID-alive validation, run-outcome classifier to detect hangs. Both reduce manual cleanup of stuck PRD jobs.
- `supervisor.cjs` — every 15 min, Opus probe per running job; SIGTERMs descendant bash on stuck poll-loops without killing the agent. Cost-gated by SM_SUPERVISOR_DISABLE.
- **Definition-of-done gate** (`lib/dodDrainHook.cjs`): fires at queue-drain (when `pickNextBatch` returns an empty batch). Re-verifies each completed PRD's AC live (`reverifyBatch`), flags risky surfaces (`flagRiskySurfaces`), writes `runs/<ts>/definition-of-done-<key>.md` (`writeReport`). Idempotent: `batchKey` (excludes dod/meta slugs) + `reportExists` make a re-drain over the same completed set a single fs-stat no-op. Non-blocking: called fire-and-forget from `tickQueue`; errors are logged not thrown. Skipped when `state.paused` (covers rate-limit), `cancelToken.cancelled`, or no completed jobs. Kill-switch: `SM_DOD_DISABLE=1`.
- `scripts/scheduler-watchdog.cjs` + `scripts/scheduler-watchdog.sh` — external check-and-exit watchdog running outside Electron via systemd user timer or cron (every 2–3 min). Heartbeat-gated `reconcileQueueOffline()` reaps orphaned jobs without Electron running; `activeProjectCwds()` detects open sessions; `sweep()` scans `~/.claude/session-manager/feedback/` and emits auto-PRDs. Install via `scripts/install-scheduler-watchdog.sh` (idempotent; `SM_WATCHDOG_DRYRUN=1` for preview).
- `pty.cjs` — node-pty per tab, keyed by renderer-generated UUID = claudeSessionId.
- `ipcSchemas.cjs` — zod schemas validate IPC payloads at the main-process boundary.
- `teams.cjs` — enumerates `~/.claude/teams/<name>/config.json`; gates the AppStatusBar team pill behind `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`.
- `queueOps.cjs` — scheduler PRD queue linter (unbounded-loop + post-AC overrun detection) + archive + retag.
- `pluginInstall.cjs` — hidden-pty plugin install via `claude plugin install <slug>`. Slug regex `/^[a-z0-9\-/]+$/`, 5 min kill ceiling, single in-flight per slug.
- `memoryTool.cjs` — workspace-scoped memories CRUD for the `memory_20250818` tool.
- `webRemoteServer.cjs` — same-origin relay server for web-remote mobile cockpit. Ping/auth/session state/summary RPC endpoints. Rate limits + audit log.
- `adminServer.cjs` — loopback-only, token-authed HTTP admin API (127.0.0.1, OS-assigned port, token in `~/.claude/session-manager/admin-api.json`). Narrow surface: list scheduler jobs + reset one stuck job. Wrapped as MCP tools by `scripts/scheduler-mcp-server.cjs` (registered in this repo's `.mcp.json`) — `scheduler_reset_job`/`scheduler_list_jobs` only work while the Electron app is running, since that's what hosts the admin server.

**Renderer** (`src/renderer/`):
- `state/config.ts` — per-path FileState with dirty tracking. Backed by config.cjs IPC.
- `state/live.ts` — per-tab derived state (todos, plans, agents, usage) fed by transcript events. Subscribed to `transcript:event:<tabId>` from main process.
- `state/voice.ts` — voice store + auto-submit timer + idle-stop timer + drain watchdog.
- `state/hives.ts` — subagent hive definitions (Configured/Library views), EditingRole, ToolChip tone + paletted rendering (HIVE_PALETTE).
- `state/orchestrator.ts` — per-running hive session state (roles, tools, lifecycle). Ephemeral, cleared on hive stop.
- `state/scheduleState.ts` — scheduler queue state (jobs, history, filter state, per-project group ordering). Subscribed to schedule IPC events.
- `state/toast.ts` — toast message queue. Consumed by components via `useToast()`.
- `components/tabs/Settings.tsx` — canonical "scoped editor" shape (ScopeSwitcher + SaveBar + JsonEditor). Other scoped tabs follow it.
- `components/tabs/Skills.tsx` — canonical "list+detail" shape. Other list tabs (Subagents, Hooks, McpServers, Plugins) follow it.
- `components/tabs/Scheduler.tsx` — Scheduler cockpit (Almanac design). Renders Queue/PRDs/History via SchedulePanel + scheduleState.
- `components/tabs/Subagents.tsx` — Hive cockpit (Launch-first editorial shell). Conductor for Configured/Library/Live sub-tabs. Reads hives.ts + live.ts.
- `components/tabs/Memory.tsx` / `MemoryNaturalPanel.tsx` — Memory Clusters UI over `memoryAggregate.cjs`'s output. Replaced the old `KnowledgeGraph.tsx` graph-visualization tab (KG feature retired; its prompt-log ingestion pipeline is gone).
- `components/tabs/WebRemote.tsx` — web-remote cockpit: relay URL, session state, device list, tunnel status.
- `components/SchedulePanel.tsx` — modular pane (Queue/PRDs/History tabs). Extracted 2026-06 to be reusable by Scheduler tab + web-remote. Owns filter state.
- `components/tabs/scheduler/sched-primitives.tsx` — Almanac design shared: SchBadge (status color/mark), ProjectTag, DetailBlock/Line (project dots hashed-color palette).
- `components/tabs/subagents/hive-primitives.tsx` — Hive design shared: ToolChip (read/write tone), StatusPill, HiveCell, HIVE_PALETTE (6 accents), hiveEstimate cost/time.
- `components/ui/` — shared primitives (Panel, ScopeSwitcher, SaveBar, JsonEditor, KVTable, ListDetail, Toggle, EmptyState).
- `components/AppStatusBar.tsx` — global model / effort / team / voice / 5h-usage chip strip. Pills navigate to Settings / Voice / Usage on click.
- `components/CommandPalette.tsx` — Cmd-K palette with fuzzy filter + emit-only dispatch. Suppressed inside Monaco / text inputs.
- `components/ui/Toast.tsx` — non-fatal error surfacing. `info / warn / error`. Mounted above modals, below RecordingStatus.
- `lib/agentFrontmatter.ts` + `lib/prdFrontmatter.ts` — round-trip YAML preservation for Subagents and SchedulerPrdsView.
- `components/tabs/agent/SchedulerDock.tsx` — per-running-job mini-bot strip rendered in AgentView.

## Renderer data flow

The renderer uses isolated zustand stores (no cross-store subscription). Data flows: **main process → IPC broadcast → store subscription → selector → component hook**.

1. **Main process** publishes events (config changes, transcript events, schedule updates, etc.) as IPC broadcasts: `config:changed`, `transcript:event:<tabId>`, `schedule:snapshot-changed`, etc.
2. **Zustand stores** subscribe to IPC broadcasts and update their state. Each store is independent; components cannot trigger store-to-store updates.
3. **Components** consume stores via hooks (`useConfig()`, `useLiveTab()`, `useScheduleState()`, etc.). For multi-store queries, compose selectors in the component or use memoized helpers.
4. **Panes** (SchedulePanel, History views) own local UI state (filters, collapsed sections) separate from global stores. Panes are stateless containers that accept props for the data they display.

## Conventions

- **Tab ID = claudeSessionId** by design. Used for `--session-id` pass-through and JSONL transcript file lookup.
- **No CommonJS in renderer**, no ES modules in main — `type: module` is set but `.cjs` files for main/preload bypass it.
- **Settings.json validation**: monaco `jsonDefaults` + schemastore.org. No hand-rolled zod for user config.
- **Hot data contiguous**: live state per tab is a flat object, not nested per-event.
- **No backwards-compat shims**: this is a single-author project; just rename and refactor.
- **Privacy invariant**: `RecordingStatus` (App-level, top of window) MUST be mounted whenever `isRecording === true`.
- **Toast is the user-facing error channel** — don't swallow errors silently; surface via `useToast().show('error', msg)` (or `toast.error(msg)`) so the user sees the failure. Background hydrate paths can stay logger-only.

### Scheduled PRD authoring

Before writing a new PRD for `~/.claude/session-manager/scheduled-plans/prds/`, read [`PRD_AUTHORING.md`](file:///home/bilko/.claude/session-manager/scheduled-plans/PRD_AUTHORING.md). It codifies two real stuck-job incidents: the **fizzpop poll-hang** (106-fizzpop-publish used an `until $(curl ... | jq .uptime)` loop whose condition was unsatisfiable because Render static-content deploys don't restart the API — hung 2h47m until the watchdog SIGKILLed) and the **etch-engine post-AC overrun** (112-etch-engine declared success at 17:44 UTC then launched a `for seed in 100..50000` fixture generator not in the AC — ran 2h44m until user killed it). The guide has 9 sections of rules and a pre-queue checklist (§10).

## Distribution

Published as `claude-code-session-manager` on npm. Run via `npx claude-code-session-manager@latest`. `bin/cli.cjs` spawns the bundled Electron binary (forwarding `process.argv` so app flags reach the main process). `postinstall` runs `electron-rebuild` to recompile `node-pty` for the user's Electron ABI. Linux + darwin only.

**Simple mode**: `npx claude-code-session-manager@latest --simple` boots a chrome-free single-terminal cockpit — no nav/tabs/config surface, just one `claude --dangerously-skip-permissions` session in the launch directory. Wired via `app:launch-mode` IPC (`process.argv.includes('--simple')` + `process.cwd()`) → `SimpleShell.tsx` (App.tsx early-returns when `simpleMode === true`). The session reuses `DEFAULT_PRESETS[0]` (sm-dangerous); hydration of persisted tabs is skipped.

## Web-remote v2 mobile cockpit

Deployed at bilko.run/projects/session-manager (Clerk auth, same-origin relay). React Native web frontend talks to relay server (`webRemoteServer.cjs`) over WebSocket. Session state protocol: ping/auth → list-sessions → select → stream state/summary updates. Desktop session-manager is the SoR; mobile is a read-mostly mirror. Rate limits (auth: 5/min, api: 50/min). Audit log to `~/.claude/web-remote-audit.log`.

## Conventions (extensions for v0.20+)

- **Almanac design** (Scheduler): SchBadge status colors + project-dot palette. Single source of truth in `sched-primitives.tsx`.
- **Hive design** (Subagents): 6-color palette (accent/sage/butter/hive-slate/hive-plum/hive-teal), ToolChip read/write tone, hiveEstimate. Single source of truth in `hive-primitives.tsx`.
- **Launch-first editorial shell** (Subagents): Configured / Library / Live sub-tabs. Subagents.tsx is the conductor; Live feeds AgentView monitor rows + results digest.
- **Knowledge graph data pipeline**: Ingest → filter (automated patterns, length caps) → extract (with EXTRACTION_SYSTEM role to prevent prompt-injection refusals) → persist. Per-project entity vocab + rate-limiting.
- **Renderer state stores** (zustand): separate concerns: `config.ts` (file-backed, dirty-tracked), `live.ts` (per-tab derived from transcripts), `voice.ts` (voice UI), `hives.ts` (subagent definitions), `orchestrator.ts` (running hive state), `scheduleState.ts` (queue + history), `toast.ts` (toast messages). Stores do NOT cross-subscribe; use composed selectors in components for multi-store queries.
- **Modular pane pattern**: extracted panes (SchedulePanel: Queue/PRDs/History tabs) are reusable by multiple parent tabs (Scheduler, web-remote). Panes own local filter state + filtering logic; parents own scope/context state.
- **Design primitive extraction**: when a design system (Almanac, Hive) is shared across components, extract `*-primitives.tsx` with explicit exports (SchBadge, ToolChip, etc.). Import primitives explicitly by name, not as wildcard — prevents cross-system pollution.

## Avoid

- Running more than **3 concurrent `claude -p` jobs** on this machine (scheduler cap, manual runners, anything that shells out to claude). Each is a node process that can exceed 1 GB; 5 in parallel OOM-killed Electron on 2026-06-10. `queue.json` concurrencyCap is 3 — keep it there.
- Adding `shell: true` to `child_process.spawn` calls — only `watchers.cjs` and `app:test-fire-hook` legitimately need it (user-supplied shell strings are part of those features). Anywhere else, pass argv arrays.
- Reading remote URLs in production — `createWindow` hard-fails if `dist/index.html` is missing rather than falling back to `localhost:5173`.
- Re-implementing the tmp+rename atomic-write pattern. Use `config.cjs`'s `writeJson` / `writeTextAtomic`.
- Reusing primitives across Almanac and Hive designs without coordination — they use different color palettes and visual conventions (SchBadge vs ToolChip). Keep them in separate files + import explicitly.
- Cross-subscribing between renderer state stores — e.g., don't read `live.ts` from `config.ts` or vice versa. Each store is an island; components compose them via hooks. Complex queries go in components or memoized selectors, not in store initialization.
- Adding pane-specific state to parent tabs — if a SchedulePanel needs filter persistence, keep it in the pane, not the tab. Panes own their UI concerns; tabs own layout + navigation.
- Importing design primitives via wildcard (`import * as SchElements from ...`) — requires explicit named imports to prevent accidental cross-system usage.
- Adding a new LeftNav tab for a live/observability feature before checking whether an existing surface (Terminal, Subagents Live, Scheduler) already owns that data. Treat each nav destination as an independent "micro-service" — before adding one, check if an existing item already owns the data/job and extend it (a sub-tab) instead of shipping a parallel UI. When two surfaces read the same underlying state, consolidate rather than duplicate. The nav has been pruned once already (2026-06-03: Scheduler/Plans/Background-Agents merged into one Scheduler destination) after growing to ~31 destinations with real overlap.

## Future: Files API

The **Files API** (`anthropic-beta: files-api-2025-04-14`; upload, reference by `file_id` in `{ type: "document", source: { type: "file", file_id } }`, 500 MB/file cap, ZDR-ineligible) is not yet surfaced. Needs: new IPC namespace, key resolution (separate Anthropic API key from OAuth credentials), CSP changes for `api.anthropic.com` uploads.
