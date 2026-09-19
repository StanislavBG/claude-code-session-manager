# claude-code-session-manager

Local cockpit for the Claude Code CLI — multi-tab terminal, configuration surface, scheduler, voice dictation, and live observability, all in one Electron desktop app.

## The 30-second pitch

You already use the `claude` CLI. This wraps it in a cockpit so you can run multiple sessions at once, edit every config file Claude Code reads, queue overnight work as PRDs, talk to it with your microphone, and watch transcripts in real time — without ever leaving the window.

New tabs open as a lightweight **chat box** and stay dormant — no PTY, no `claude` process — until you actually send a message, so a window full of tabs costs almost nothing. Prefer a single bare terminal? Launch with `--simple`.

Single-author hobby project. Linux and macOS only. Free, MIT, anonymous opt-out telemetry (see [Privacy](#privacy)).

## Features tour

- **Dormant tabs + chat box** — every new tab opens as a chat box and stays dormant (no PTY, no `claude` process) until you send the first message. The headless chat-run engine drives it through `claude -p` with `stream-json`, session resume, and a stop signal, so a tab is a real conversation without holding a live terminal open. Hydrate into a full terminal whenever you need one.
- **Simple mode** — `npx claude-code-session-manager@latest --simple` boots a chrome-free, single-terminal cockpit: no nav, no tabs, no config surface, just one `claude` session in the launch directory.
- **Cmd-K command palette** — commands organised into bands (session, voice, scheduler, config, nav). Fuzzy filter, emit-only dispatch so commands stay decoupled from views.
- **Sidebar groups** — the left nav is organised into three groups: Workspace (where you do the work), Configure (how Claude behaves), and Tools (one-off utilities).
- **Scheduler / PRD queue** — PRDs live under `<cwd>/session-manager-operations/scheduler/epics/<epic-id>/prds/` and the scheduler picks them up as headless `claude -p` jobs. Author them through the `scheduler_create_prd` MCP tool. Multi-select bulk archive and reset. Queue-health linter catches unbounded poll loops and post-AC overrun patterns before they burn tokens.
- **Memory tab** — workspace-scoped memory entries that the `memory_20250818` tool can read and write, surfaced as a real UI rather than a JSON blob.
- **Hooks** — all 29 documented events with inline tooltips explaining what each event fires on. Definitions editor plus a test-fire runner so you can verify a hook without rebuilding state.
- **Plugins** — manifest inspector for installed plugins plus a Discover panel that lists first-party plugins with one-click install (pty-wrapped `claude plugin install`).
- **MCP servers** — five transports (stdio, http, streamable-http, ws, sse) with a reserved-name linter so you don't waste a launch on a server Claude refuses to load.
- **Voice** — local Whisper ASR plus Silero VAD running in a Web Worker. Push-to-talk hotkey, continuous listening, auto-submit, and barge-in that ducks TTS playback. Nothing leaves the machine.
- **Toast notifications + 4-scope drift surfacing** — non-fatal errors land in a corner toast instead of being swallowed. Settings show drift across the default / user / project / local scopes so you always know which value actually wins.
## Install

```bash
npx claude-code-session-manager@latest
```

Linux and macOS only. The first launch downloads Electron (~200 MB) and runs `electron-rebuild` on `node-pty` so it links against the bundled Electron ABI. Subsequent launches are instant from the npx cache.

macOS needs Xcode Command Line Tools: `xcode-select --install`.
Linux needs `build-essential` and `python3` for the rebuild.

## Quick start

1. Run the install command above.
2. The app opens on the Overview tab — you should see a fresh session ready to go.
3. Hit Cmd-K (Ctrl-K on Linux) and try `terminal new`, `voice start`, or `scheduler open`.
4. Create a PRD with the `scheduler_create_prd` MCP tool and watch the Scheduler pick it up.
5. On first run the microphone setup wizard opens automatically; then use the push-to-talk hotkey (see Voice setup) to dictate.

## Privacy

**Anonymous product telemetry is on by default.** It posts event, log, error, and crash records to bilko.run. Opt out with `SM_TELEMETRY=0` or Settings → Telemetry. Details: [telemetry.md](session-manager-operations/architecture/telemetry.md).

- The Content-Security-Policy restricts `connect-src` to four hosts: `api.anthropic.com` (so the in-app `/usage` panel can read the billing endpoint), `registry.npmjs.org`, `json.schemastore.org`, and `www.schemastore.org`.
- All settings, skills, hooks, scheduler PRDs, transcripts, and voice configuration stay on disk under `~/.claude/`. The `claude` CLI itself is the only network egress for AI work — the cockpit never proxies your prompts.
- The recording-status pill is always mounted at the top of the window whenever the microphone is hot, above every other UI layer. There is no way to record without seeing the indicator.

## Voice setup

- The mic setup wizard auto-opens on first run. It enumerates your input devices, lets you pick one, records a sample utterance, and persists the choice in `voice.json`.
- Push-to-talk defaults to Cmd+Option+V on macOS and Ctrl+Shift+Space elsewhere. Hold or toggle, configurable in the Voice tab.
- Models download once on first use, then run entirely locally via onnxruntime-web.
- Auto-submit fires Enter at a configurable countdown (default 6 s); the mic stays open across turns until silence (default 30 s) or an explicit stop.

## Scheduler / PRD workflow

A PRD is a self-contained markdown file with frontmatter (`title`, absolute `cwd`, `estimateMinutes`) and a body that `claude -p` runs without conversation context. They live under `<cwd>/session-manager-operations/scheduler/epics/<epic-id>/prds/` and are authored through the `scheduler_create_prd` MCP tool.

Three run modes:

- `manual` — only fires when you click Run.
- `on-reset` — fires at the next 5-hour usage reset.
- `when-available` — the default. Polls the billing usage endpoint every ten minutes and fires when tokens fall below the configured threshold. Auto-pauses if a job hits a rate limit, auto-resumes at the next reset.

The queue-health linter scans every queued PRD for two patterns that have caused real stuck jobs in this project: unbounded poll loops with unsatisfiable conditions, and post-AC fixture generators that overrun the acceptance criteria. Both incidents are documented in [`src/main/templates/PRD_AUTHORING.md`](src/main/templates/PRD_AUTHORING.md).

## Keyboard cheatsheet

| Key | Action |
|---|---|
| Cmd-K / Ctrl-K | Open command palette |
| Alt-1 … Alt-5 | Activate tab 1–5 |
| Cmd/Ctrl-N | Open / Start Project |
| Cmd/Ctrl-Shift-R | Restart the app |
| Cmd/Ctrl-Shift-S | Restart terminal in active tab |
| Cmd/Ctrl-R | Reload app window |
| F12 | Toggle developer tools |
| Cmd/Ctrl-Q | Quit |

## Architecture

Electron 42 with a CommonJS main process and a Vite-built React 18 renderer. xterm and node-pty drive the terminals. zustand owns renderer state. Whisper via `@huggingface/transformers` plus Silero VAD via `@ricky0123/vad-web` runs voice on-device through onnxruntime-web. Tailwind for styling. Single-author project, no backwards-compat shims — when something needs renaming, it gets renamed.

## Contributing / development

```bash
git clone https://github.com/StanislavBG/claude-code-session-manager
cd claude-code-session-manager
npm install
npm run dev          # Vite + Electron with HMR (SM_DEV=1)
npm run typecheck    # tsc --noEmit, must pass before commits
npm run lint         # unstable selectors, conditional hooks, unregistered tests
npm run test:unit    # vitest run
npm run test:e2e     # Playwright Electron under xvfb-run (Linux)
```

PRs welcome. Before authoring a scheduler PRD, read [`src/main/templates/PRD_AUTHORING.md`](src/main/templates/PRD_AUTHORING.md) — the two stuck-job postmortems in there will save you tokens.

## License

MIT. Built by one person on evenings and weekends.
