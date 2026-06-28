# claude-code-session-manager

Local cockpit for the Claude Code CLI — multi-tab terminal, configuration surface, scheduler, voice dictation, and live observability, all in one Electron desktop app.

## The 30-second pitch

You already use the `claude` CLI. This wraps it in a cockpit so you can run multiple sessions at once, edit every config file Claude Code reads, queue overnight work as PRDs, talk to it with your microphone, and watch transcripts in real time — without ever leaving the window.

New tabs open as a lightweight **chat box** and stay dormant — no PTY, no `claude` process — until you actually send a message, so a window full of tabs costs almost nothing. Prefer a single bare terminal? Launch with `--simple`.

Single-author hobby project. Linux and macOS only. Free, MIT, zero telemetry.

## Screenshots

| | |
|---|---|
| ![Overview cockpit](screenshots/overview-cockpit.png) | ![Agent view](screenshots/agent-view.png) |
| Overview tab — AppStatusBar + cockpit strip + instrument grid | Agent-View — animated workshop with subagents and todo board |
| ![Command palette](screenshots/command-palette.png) | ![Scheduler](screenshots/scheduler.png) |
| Cmd-K command palette (41+ commands) | Scheduler panel with PRD queue + health linter |
| ![Voice](screenshots/voice.png) | ![Hooks events](screenshots/hooks-events.png) |
| Voice subsystem — local Whisper + Silero VAD | Hooks tab — 29 documented events with inline docs |

Screenshots are placeholders right now; see `screenshots/README-screenshots.md` if you want to help capture them.

## Features tour

- **Dormant tabs + chat box** — every new tab opens as a chat box and stays dormant (no PTY, no `claude` process) until you send the first message. The headless chat-run engine drives it through `claude -p` with `stream-json`, session resume, and a stop signal, so a tab is a real conversation without holding a live terminal open. Hydrate into a full terminal whenever you need one.
- **Simple mode** — `npx claude-code-session-manager@latest --simple` boots a chrome-free, single-terminal cockpit: no nav, no tabs, no config surface, just one `claude` session in the launch directory.
- **AppStatusBar** — five always-visible pills at the very top of the window: active model, thinking effort, team, voice state, and the current 5-hour usage percentage. Each pill is a shortcut into the relevant settings panel.
- **Overview cockpit** — the home tab is a real instrument cluster:
  - CockpitStrip at the top with critical session info.
  - Two-by-five instrument grid (one tile per live signal).
  - Teams card when `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` is on.
  - System row with cwd, model, branch, and git status.
  - Quick-actions footer for the things you do every day.
- **Cmd-K command palette** — 41+ commands organised into bands (session, voice, scheduler, config, nav). Fuzzy filter, emit-only dispatch so commands stay decoupled from views.
- **17 tabs** — every Claude Code surface, broken into three groups:
  - Workspace: Overview · Terminal · System Prompt · Agent-View · Memory.
  - Config: Settings · Permissions · Skills · Plugins · MCP Servers · Hooks · Subagents · Keybindings.
  - Activity: Plans · Tasks · Projects · History · Usage.
  - Footer dock: Scheduler panel and microphone status, both pinned above the active tab.
- **Scheduler / PRD queue** — drop a markdown file into `~/.claude/session-manager/scheduled-plans/prds/` and the scheduler will pick it up as a headless `claude -p` job. Multi-select bulk archive and reset. Queue-health linter catches unbounded poll loops and post-AC overrun patterns before they burn tokens. Structured frontmatter editor with a raw-yaml escape hatch for power users.
- **Agent-View** — animated workshop scene rendered as a friendly cartoon: subagent dock, plan whiteboard, todo board, and a SchedulerDock with mini-bots that mirror each running scheduler job. Watching a job is more legible than tailing its log.
- **Memory tab** — new this cycle. Workspace-scoped memory entries that the `memory_20250818` tool can read and write, surfaced as a real UI rather than a JSON blob.
- **Hooks** — all 29 documented events with inline tooltips explaining what each event fires on. Definitions editor plus a test-fire runner so you can verify a hook without rebuilding state.
- **Subagents** — full frontmatter editor with tool and skill pickers. Live invocation status while you watch agents spawn off the active session.
- **Plugins** — manifest inspector for installed plugins plus a Discover panel that lists the 23 first-party plugins with one-click install (pty-wrapped `claude plugin install`).
- **MCP servers** — five transports (stdio, http, streamable-http, ws, sse) with a reserved-name linter so you don't waste a launch on a server Claude refuses to load.
- **Voice** — local Whisper ASR plus Silero VAD running in a Web Worker. Push-to-talk hotkey, continuous listening, auto-submit, and barge-in that ducks TTS playback. Nothing leaves the machine.
- **Toast notifications + 4-scope drift surfacing** — non-fatal errors land in a corner toast instead of being swallowed. Settings show drift across the default / user / project / local scopes so you always know which value actually wins.
- **npm update checker** — new this cycle. Quietly polls `registry.npmjs.org` and surfaces a toast when a newer version is published. Update on your schedule, not theirs.

## Install

```bash
npx claude-code-session-manager@latest
```

Linux and macOS only. The first launch downloads Electron (~200 MB) and runs `electron-rebuild` on `node-pty` so it links against the bundled Electron ABI. Subsequent launches are instant from the npx cache.

macOS needs Xcode Command Line Tools: `xcode-select --install`.
Linux needs `build-essential` and `python3` for the rebuild.

## Quick start

1. Run the install command above.
2. The app opens on the Overview tab — you should see your AppStatusBar pills populate and a fresh Terminal tab ready to go.
3. Hit Cmd-K (Ctrl-K on Linux) and try `terminal new`, `voice start`, or `scheduler open`.
4. Drop a markdown file into `~/.claude/session-manager/scheduled-plans/prds/01-my-first-prd.md` and watch the Scheduler dock pick it up.
5. Press F7 to open the microphone setup wizard, then F1 to start dictating.

## Privacy

**Zero telemetry by default.**

- No analytics, no error reporting, no crash uploads.
- The Content-Security-Policy restricts `connect-src` to two hosts: `api.anthropic.com` (so the in-app `/usage` panel can read the billing endpoint) and `registry.npmjs.org` (for the version-check toast).
- All settings, skills, hooks, scheduler PRDs, transcripts, and voice configuration stay on disk under `~/.claude/`. The `claude` CLI itself is the only network egress for AI work — the cockpit never proxies your prompts.
- An opt-in OpenTelemetry exporter lives under Settings → Telemetry. It is off until you turn it on.
- The recording-status pill is always mounted at the top of the window whenever the microphone is hot, above every other UI layer. There is no way to record without seeing the indicator.

## Voice setup

- Press F7 to open the first-run wizard. It enumerates your input devices, lets you pick one, records a sample utterance, and persists the choice in `voice.json`.
- Press F1 for push-to-talk. Hold or toggle, configurable in Keybindings.
- Models download once on first use, then run entirely locally via onnxruntime-web.
- Auto-submit fires Enter at a configurable countdown (default 6 s); the mic stays open across turns until silence (default 30 s) or an explicit stop.

## Scheduler / PRD workflow

A PRD is a self-contained markdown file with frontmatter (`title`, absolute `cwd`, `estimateMinutes`) and a body that `claude -p` runs without conversation context. They live in `~/.claude/session-manager/scheduled-plans/prds/<NN>-<kebab-slug>.md` where the `NN` prefix groups parallel work.

Three run modes:

- `manual` — only fires when you click Run.
- `on-reset` — fires at the next 5-hour usage reset.
- `when-available` — the default. Polls the billing usage endpoint every ten minutes and fires when tokens fall below the configured threshold. Auto-pauses if a job hits a rate limit, auto-resumes at the next reset.

The queue-health linter scans every queued PRD for two patterns that have caused real stuck jobs in this project: unbounded poll loops with unsatisfiable conditions, and post-AC fixture generators that overrun the acceptance criteria. Both incidents are documented in `PRD_AUTHORING.md`.

## Keyboard cheatsheet

| Key | Action |
|---|---|
| Cmd-K / Ctrl-K | Open command palette |
| F1 | Push-to-talk |
| F7 | Microphone setup wizard |
| Ctrl-N | New terminal tab |
| Ctrl-W | Close tab |
| Ctrl-Shift-R | Reboot active session (preset-aware) |
| Ctrl-Shift-B | Toggle build mode for active tab |

## Architecture

Electron 33 with a CommonJS main process and a Vite-built React 18 renderer. xterm and node-pty drive the terminals. zustand owns renderer state. Whisper via `@huggingface/transformers` plus Silero VAD via `@ricky0123/vad-web` runs voice on-device through onnxruntime-web. Tailwind for styling. Single-author project, no backwards-compat shims — when something needs renaming, it gets renamed.

## Contributing / development

```bash
git clone https://github.com/StanislavBG/claude-code-session-manager
cd claude-code-session-manager
npm install
npm run dev          # Vite + Electron with HMR (SM_DEV=1)
npm run typecheck    # tsc --noEmit, must pass before commits
npm run test:e2e     # Playwright Electron under xvfb-run (Linux)
```

PRs welcome. Before authoring a scheduler PRD, read `PRD_AUTHORING.md` — the two stuck-job postmortems in there will save you tokens.

## License

MIT. Built by one person on evenings and weekends.
