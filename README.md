# claude-code-session-manager

Local cockpit for Claude Code CLI — multi-tab terminal plus a full configuration and observability surface, running as an Electron desktop app.

## Usage

```bash
npx claude-code-session-manager@latest
```

First run installs Electron (~200 MB) and rebuilds `node-pty` against the bundled Electron runtime. Subsequent launches are instant from the npx cache.

## Supported platforms

- Linux
- macOS (requires Xcode Command Line Tools: `xcode-select --install`)

Windows is not supported (different node-pty backend).

## Main features

- **Multi-tab terminals.** Each tab owns its own PTY and Claude Code session. Tab id = `claudeSessionId`, so `--session-id` pass-through and JSONL transcript lookup line up automatically. Tabs persist across restarts.
- **Live transcript inspector.** Tails `~/.claude/projects/<encoded-cwd>/<sessionUuid>.jsonl` per tab and broadcasts events to the renderer in a ring buffer — no file reload, no polling.
- **Voice dictation.** Local-only Whisper + Silero VAD running in a Web Worker. No audio leaves the machine. Push-to-talk hotkey (window or global), continuous listening across turns, auto-submit with a configurable countdown, and barge-in that ducks TTS.
- **Scheduler / PRD queue.** Drop a PRD into `~/.claude/session-manager/scheduled-plans/prds/` and the scheduler runs it as a `claude -p` job. Modes: `manual`, `on-reset`, or `when-available` (the default — polls billing usage every 2 min, auto-pauses on rate-limit, auto-resumes at the next 5 h reset).
- **Engage presets.** Per-tab build/engage presets stored in `session-rules.json`, with a one-shot "reboot sessions" action that respects the active preset.
- **17 configuration and observability tabs:** Overview · Terminal · System Prompt · Agent-View · Settings · Permissions · Skills · Plugins · MCP Servers · Hooks · Subagents · Keybindings · Plans · Tasks · Projects · History · Usage.

## Configuration surface

Edit-in-place for everything Claude Code reads, with atomic writes (tmp + rename) and per-path file-watcher refcounting:

- `~/.claude/settings.json` — Monaco editor with the official schemastore.org schema for validation and completion.
- `CLAUDE.md` files — project + global, with scope switcher.
- **Skills** — list/detail editor for `~/.claude/skills/*` and project-local skills.
- **Plugins** — installed plugin inventory and toggles.
- **MCP Servers** — `mcp.json` editor with status and reconnect.
- **Hooks** — definitions plus a "test fire" runner.
- **Subagents** — agent definitions with live invocation status.
- **Permissions** — allow/ask/deny per-tool, scoped at user / project / local.
- **Keybindings** — the `~/.claude/keybindings.json` editor with chord support.

## Observability tabs

- **Plans** — current plan, in-flight tasks, decisions.
- **Tasks** — TaskCreate/Get/List feed, live.
- **Subagents** — running agents, their tools, output streams.
- **Agent-View** — assistant turn inspector tied to the active session.
- **History** — recent sessions, replayable transcripts.
- **Usage** — billing/usage from the undocumented `/api/oauth/usage` endpoint, with the active 5 h window.
- **Projects** — session inventory grouped by `cwd`.

## Optional: engage presets

If you maintain a `session-rules.json`, point to it before launch:

```bash
SESSION_MANAGER_ENGAGE_RULES=/path/to/session-rules.json npx claude-code-session-manager
```

Unset → no engage presets, no error.

## Voice dictation details

- Local Whisper-based ASR via `@huggingface/transformers` + onnxruntime-web; Silero VAD via `@ricky0123/vad-web` for endpointing. No network round-trip after the first model download.
- **Continuous listening across turns.** Auto-submit fires Enter at the configured countdown (default 6 s) and the mic stays open — only true silence (default 30 s) or an explicit hotkey/button click closes it.
- **Push-to-talk** with hold or toggle modes; per-OS default hotkey, customizable in Keybindings.
- **Barge-in:** speaking while TTS plays cancels playback and raises the VAD threshold so self-talk doesn't retrigger.
- **First-run wizard** picks a mic, verifies a sample utterance, and persists the choice in `voice.json`.
- **Privacy invariant:** the recording-status pill is always visible at the top of the window whenever the mic is hot.

## Scheduler details

- PRD format: `~/.claude/session-manager/scheduled-plans/prds/<NN>-<kebab-slug>.md`. Frontmatter `title`, absolute `cwd`, `estimateMinutes`. The `NN` prefix is the parallel group.
- The `/prd` slash command in Claude Code emits the canonical structure.
- Body is self-contained because `claude -p` runs without conversation context.
- Rate-limit handling: scheduler reads the same `/api/oauth/usage` endpoint the in-app `/usage` panel uses, with the OAuth token from `~/.claude/.credentials.json`.

## Security model

- All filesystem paths in the main process go through `validatePath` against the user's home directory.
- `setWindowOpenHandler` denies all popups; `will-navigate` only allows the dev URL.
- IPC payloads are zod-validated at the main-process boundary (`ipcSchemas.cjs`).
- `child_process.spawn` is argv-only except for two narrowly-scoped places (the watchers feature and `app:test-fire-hook`) where a user-supplied shell string is part of the feature.

## Development

```bash
git clone <repo>
cd claude-code-session-manager
npm install
npm run dev          # Vite + Electron with HMR (SM_DEV=1)
npm run typecheck    # tsc --noEmit
npm run test:e2e     # Playwright Electron under xvfb-run
```

## License

MIT.
