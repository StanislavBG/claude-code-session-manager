# Claude Code Session Manager

Electron desktop app — local cockpit for Claude Code CLI. Terminal + 17 config/observability tabs (Settings, Skills, Hooks, MCP Servers, Tasks, Plans, Usage, Subagents, History, Scheduler, etc.).

## Stack

Electron 33 (CommonJS main + preload) · React 18 + Vite · Tailwind · zustand · xterm + node-pty · Whisper (ricky0123/vad-web + onnxruntime-web) for voice.

## Commands

- `npm run dev` — Vite + Electron with HMR. `SM_DEV=1` is set automatically.
- `npm run build` — production renderer build into `dist/`.
- `npm run typecheck` — `tsc --noEmit`. Must pass before commits.
- `npm run test:e2e` — Playwright Electron tests under `xvfb-run` (Linux).
- `npm publish` — runs `vite build` via `prepublishOnly`. Tag is `latest`.

## Architecture (load-bearing files)

**Main process** (`src/main/*.cjs`):
- `index.cjs` — BrowserWindow + IPC registration. Navigation locked: `setWindowOpenHandler` denies, `will-navigate` allows only the dev URL.
- `config.cjs` — fs layer. **All paths go through `validatePath` (allowedRoots = home dir)**. Atomic writes via tmp + rename. Chokidar watchers refcounted per absolute path.
- `transcripts.cjs` — tails `~/.claude/projects/<encoded-cwd>/<sessionUuid>.jsonl`, classifies events, ring-buffers per tab, broadcasts `transcript:event:<tabId>`.
- `scheduler.cjs` — runs PRDs from `~/.claude/session-manager/scheduled-plans/prds/` as `claude -p` jobs. Modes: `manual` / `on-reset` / `when-available` (default; polls billing usage every 2 min). Auto-pause on rate-limit, auto-resume at next 5h reset.
- `supervisor.cjs` — every 15 min, Opus probe per running job; SIGTERMs descendant bash on stuck poll-loops without killing the agent. Cost-gated by SM_SUPERVISOR_DISABLE.
- `pty.cjs` — node-pty per tab, keyed by renderer-generated UUID = claudeSessionId.
- `ipcSchemas.cjs` — zod schemas validate IPC payloads at the main-process boundary.
- `teams.cjs` — enumerates `~/.claude/teams/<name>/config.json`; gates the AppStatusBar team pill behind `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`.
- `queueOps.cjs` — scheduler PRD queue linter (unbounded-loop + post-AC overrun detection) + archive + retag.
- `pluginInstall.cjs` — hidden-pty plugin install via `claude plugin install <slug>`. Slug regex `/^[a-z0-9\-/]+$/`, 5 min kill ceiling, single in-flight per slug.
- `memoryTool.cjs` — workspace-scoped memories CRUD for the `memory_20250818` tool (NEW cycle 3).

**Renderer** (`src/renderer/`):
- `state/config.ts` — per-path FileState with dirty tracking.
- `state/live.ts` — per-tab derived state (todos, plans, agents, usage) fed by transcript events.
- `state/voice.ts` — voice store + auto-submit timer + idle-stop timer + drain watchdog.
- `components/tabs/Settings.tsx` — canonical "scoped editor" shape (ScopeSwitcher + SaveBar + JsonEditor). Other scoped tabs follow it.
- `components/tabs/Skills.tsx` — canonical "list+detail" shape. Other list tabs (Subagents, Hooks, McpServers, Plugins) follow it.
- `components/ui/` — shared primitives (Panel, ScopeSwitcher, SaveBar, JsonEditor, KVTable, ListDetail, Toggle, EmptyState).
- `components/AppStatusBar.tsx` — global model / effort / team / voice / 5h-usage chip strip. Pills navigate to Settings / Voice / Usage on click.
- `components/CommandPalette.tsx` — Cmd-K palette with fuzzy filter + emit-only dispatch. Suppressed inside Monaco / text inputs.
- `components/ui/Toast.tsx` + `state/toast.ts` — non-fatal error surfacing. `info / warn / error`. Mounted above modals, below RecordingStatus.
- `lib/agentFrontmatter.ts` + `lib/prdFrontmatter.ts` — round-trip YAML preservation for Subagents and SchedulerPrdsView.
- `components/tabs/agent/SchedulerDock.tsx` — per-running-job mini-bot strip rendered in AgentView.

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

Published as `claude-code-session-manager` on npm. Run via `npx claude-code-session-manager@latest`. `bin/cli.cjs` spawns the bundled Electron binary. `postinstall` runs `electron-rebuild` to recompile `node-pty` for the user's Electron ABI. Linux + darwin only.

## Avoid

- Adding `shell: true` to `child_process.spawn` calls — only `watchers.cjs` and `app:test-fire-hook` legitimately need it (user-supplied shell strings are part of those features). Anywhere else, pass argv arrays.
- Reading remote URLs in production — `createWindow` hard-fails if `dist/index.html` is missing rather than falling back to `localhost:5173`.
- Re-implementing the tmp+rename atomic-write pattern. Use `config.cjs`'s `writeJson` / `writeTextAtomic`.

## Future: Files API + Memory tool

Anthropic ships two platform-API features that the renderer doesn't surface yet: the **Files API** (`anthropic-beta: files-api-2025-04-14`; upload, reference by `file_id` in `{ type: "document", source: { type: "file", file_id } }`, 500 MB/file cap, ZDR-ineligible) and the **Memory tool** (`memory_20250818`; server-decided tool with client-side `/memories` store, ZDR-eligible). Cycle 2 added a documented stub at `src/main/filesApi.cjs.todo` and `src/main/memoryTool.cjs.todo` for cycle 3 to pick up — each needs a new IPC namespace, key resolution (Files API needs an Anthropic API key separate from the OAuth credentials billing reads), and CSP changes for `api.anthropic.com` uploads. Distinct from Claude Code's `autoMemoryDirectory` (filesystem convention, already in our schema).
