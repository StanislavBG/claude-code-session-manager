# claude-code-session-manager

> A free desktop app for Claude Code. Each piece of work is a session with its own agent, mission and copy of the repo. Queued work runs on its own, within your plan's usage limits. It is checked before it counts as done. Agents drive the app through an MCP server with <!-- gen:mcp-tool-count -->55<!-- /gen:mcp-tool-count --> tools and a plugin with <!-- gen:skill-count -->4<!-- /gen:skill-count --> skills.

## Facts

| Key | Value |
| --- | --- |
| Kind | Desktop app built on Electron. It has no JS API. |
| Run | `npx claude-code-session-manager@latest` |
| Installers | Mac `.dmg` and `.zip` (`arm64`, `x64`). Windows `.exe` (`x64`, `arm64`). Linux `AppImage` (`x64`). Get them from [GitHub Releases](https://github.com/StanislavBG/claude-code-session-manager/releases/latest). |
| Needs | The Claude Code CLI, installed and signed in with your own account. `git`. Node <!-- gen:node-floor -->22.12.0<!-- /gen:node-floor --> or newer, for `npx` only. |
| MCP server | `session-manager-scheduler`. It uses stdio. The app adds it for you. It needs the app running. |
| Agent CLIs | Claude Code is the default. Codex, Gemini CLI, Antigravity CLI, Cursor Agent and OpenCode work in Chat and Terminal only. |
| Where state lives | App state: `~/.claude/session-manager/`. Per project: `<repo>/session-manager-operations/`. Session copies: `${XDG_STATE_HOME:-~/.local/state}/session-manager/`. |
| Telemetry | Anonymous and on by default. Turn it off with `SM_TELEMETRY=0`. |

## Not

- It is not a hosted or cloud service. Your sessions and files stay on your machine.
- It is not made or backed by Anthropic. One person builds it as open source.
- It does not replace a Claude plan.
- It has no paid, pro or trial tier.
- It is not a team product. It has no support deal or uptime promise.

## Features

A **session** (in code: an Epic) is one unit of work. A **Mission** is the kind of work. A **persona** is an agent's role file. A **worktree** is a copy of the repo on its own git branch. A **PRD** is a written work order that the scheduler runs.

### Sessions

| Feature | What it does | Why it helps | Where |
| --- | --- | --- | --- |
| Sessions | Each session has an agent, a Mission and an agent CLI. | You pick who does the work, and what kind. | Sessions |
| Missions | There are seven: Feature, Bug, Discussion, Build, Project Home Builder, 3D Art, Portfolio Optimization. | Each Mission gives the agent a fitting start. | New session form |
| Life cycle | A session is `proposed`, then `active`, then `completed`. | You can see what is waiting, running and done. | Sessions |
| Human start | Only a person can create a session. Agents cannot. | No agent can make work for itself. | New session button |
| Own copy | An active session runs in its own worktree, on branch `sm-epic/<id>`. | Many sessions can work on one repo at once. | On disk |
| Chat and Terminal | These are two views of one CLI session. | Switch views and keep the same chat. | Session view |
| Idle tabs | A tab starts no process until you send the first message. | Many open tabs cost almost nothing. | Sessions |
| Changes | Shows what the session changed. | You can review the work before you merge it. | Session, Changes tab |
| App preview | Runs one `npm` script per session on a free port. It opens its first local URL. | You can see the app from that session's copy. | Session view |

### Scheduler

| Feature | What it does | Why it helps | Where |
| --- | --- | --- | --- |
| Headless jobs | Runs each PRD as a `claude -p` job with a pinned `--model`. | Work goes on while you do other things. | Scheduler |
| Run modes | `when-available` runs jobs while usage is under a set limit. `manual` runs a job when you press Run. | Work fits inside your plan's limits. | Scheduler |
| Order | A PRD waits for the PRDs named in its `dependsOn`. | Steps run in the right order. | PRD fields |
| No clashes | Two PRDs that touch the same file never run at once. | Jobs do not break each other's edits. | Scheduler |
| One slot pool | One pool of slots for the whole machine, plus a free-memory check. | The machine does not run out of memory. | Scheduler |
| Retry first | A job that stops in `needs_review` tries to fix itself first. | Fewer stuck jobs need a person. | Scheduler |

### Checking the work

| Feature | What it does | Why it helps | Where |
| --- | --- | --- | --- |
| Gate | Each PRD lists commands that must pass. The job runs them last. | A job only passes when its checks pass. | PRD `# Gate` |
| Validator | A last job checks each PRD of a plan. It writes `VERIFIED` or `REFUTED` to a record file. | A second agent checks the first one's claims. | Scheduler |
| Guard hooks | Four hooks: `guard-destructive-git`, `guard-inline-implementation`, `guard-prd-writes`, `guard-self-schedule`. | They block risky git commands and stray work. | Project `.claude/settings.json` |

### Agents, Missions and macros

| Feature | What it does | Where |
| --- | --- | --- |
| Agents library | Lists the personas on this machine. You can edit them. | Agents |
| Macros | A macro saves an agent, a Mission and a prompt. One press starts one new session. | Sessions |
| Context packs | A pack adds a plugin and rules to one session. | New session form |

### Claude Code settings

| Feature | What it does | Where |
| --- | --- | --- |
| CLAUDE.md | Edits your `~/.claude/CLAUDE.md`. | CLAUDE.md |
| Claude config | Shows one project's `CLAUDE.md`, `.claude/settings.json`, `.mcp.json`, skills and memory folder. | Claude config |
| Settings | Edits `settings.json` for each scope. It shows which scope wins. | Settings |
| Hooks | Edits hooks. You can test-fire one. | Settings |
| Extensions | Lists skills, MCP servers and plugins. | Extensions |

### Project Home

| Feature | What it does | Where |
| --- | --- | --- |
| Pages | Shows pages about the project. | Project Home |
| Videos | Shows short demo videos. | Project Home |
| Competitor matrix | Compares the project with others, feature by feature. | Project Home |
| Video character | A saved look for the people in demo videos. | Project Home |
| Written by agents | Agents write all of these through MCP tools. | MCP tools |

### Across projects

| Feature | What it does | Where |
| --- | --- | --- |
| Cross-project feedback | An agent sends a finding to another repo on this machine. It lands there as a `proposed` session. | `/send-feedback` |
| Feedback to the maker | You send feedback about the app. | Feedback panel |

### See what is going on

| Feature | What it does | Where |
| --- | --- | --- |
| Dashboard | Shows every project and every active session on this machine. | Dashboard |
| Usage meters | Show how much of your plan's limits you used. | Dashboard |
| History | Shows spend, tokens and time across all projects. | History |
| File Explorer | Browse and edit files. | File Explorer |

### Input and remote

| Feature | What it does | Where |
| --- | --- | --- |
| Voice input | Turns speech into text on your machine. Nothing leaves it. | App Settings |
| Recording light | A light shows on top of every screen while the mic is on. | Top of window |
| Web remote | Drive the app from your phone, or let a paired service send work, through the bilko.run relay. | App Settings |

## Headless surface (for agents)

### MCP server

The MCP server lets an agent queue PRDs, read the queue, write Project Home pages and more.

The app adds it at user scope on first launch. To add it by hand, run:

```bash
claude mcp add session-manager-scheduler --scope user -- node <app>/scripts/scheduler-mcp-server.cjs
```

An installed build uses the app's own binary, with `-e ELECTRON_RUN_AS_NODE=1`.

Each call goes to the running app's local HTTP API. Its token is in `~/.claude/session-manager/admin-api.json`.

Two ways it can fail:

- A tool says the app is not running. Start the app and try again.
- The tools are missing: the server is not added. Delete `~/.claude/session-manager/.scheduler-mcp-seeded` and restart the app.

Start with `session_manager_help`. No args lists every tool. `tool` explains one tool. `topic` shows one recipe.

Recipes:

<!-- gen:mcp-recipes -->
- `queue-work-via-develop` — Queue work into an already-approved Epic (/develop)
- `unstick-needs-review-job` — Unstick a job stuck in needs_review
- `hand-finding-to-another-project` — Hand a finding to another project
- `reply-to-the-project-that-asked` — Reply to the project that asked
- `add-project-video-tool` — Add a project video tool
- `script-press-demo-video` — Let a project's own script press Demo Video and read the outcome
<!-- /gen:mcp-recipes -->

The full list of tools, with what each one needs, is in [MCP tools](https://github.com/StanislavBG/claude-code-session-manager/blob/main/session-manager-operations/architecture/mcp-tools.md).

Rules the server enforces:

- A new PRD must join a session a person approved. The server never creates one.
- A new PRD must have a `gate` and a `files` list.
- Only a session a person is in, or a job run as `architect`, can queue PRDs.
- A job with `SM_SCHEDULER_JOB_MCP_TOOLS` set can call only the tools in that list.
- A pause set by an agent ends after 30 minutes. A pause set by a person stays until `scheduler_resume`.

### Headless jobs

Each PRD job runs as the PRD's persona (`dev-lead` by default) in its own worktree, then commits. Its last line is a verdict such as `SCHEDULER_VERDICT: PASS`.

### Scripts

A script can start a macro with `POST /admin/macros/run`, if a person marked it "Can be started by a script".

## Skills

### Plugin session-manager-dev

The app installs and updates it offline from its bundled `session-manager` marketplace. To install it outside the app, run:

```bash
claude plugin marketplace add StanislavBG/claude-code-session-manager
claude plugin install session-manager-dev@session-manager
```

`/develop` and `/send-feedback` call the MCP server, so the app must run.

<!-- list:skills -->
| Skill | Use it to |
| --- | --- |
| `/develop` | Split work into PRDs, queue them, and track them until they are checked. |
| `/builder` | Publish the project's npm package and keep its Field Manual in step. |
| `/send-feedback` | Send a finding to a different project on this machine. |
| `/maintaining-md-network` | Review a project's `CLAUDE.md` and docs so each fact lives in one place. |
<!-- /list:skills -->

### Context packs

<!-- list:packs -->
| Pack | What it adds | Skills |
| --- | --- | --- |
| `apple-design` | Apple design rules for iOS app screens. | `hig-layout-and-accessibility`, `liquid-glass-adoption` |
| `apple-swift-core` | Swift 6 and SwiftUI rules for iOS apps. | `swift-concurrency`, `swiftui-state-and-navigation` |
<!-- /list:packs -->

### Agent personas

<!-- list:personas -->
| Persona | Role |
| --- | --- |
| `architect` | Talks with you, plans the work, and splits it into PRDs. |
| `dev-lead` | Runs one PRD, start to finish, with no one watching. |
| `validator` | Checks a finished plan, one PRD at a time. |
| `project-home-builder` | Writes one page for Project Home. |
| `demo-video-builder` | Makes a short demo video for Project Home. |
| `competitive-analyst` | Builds the competitor matrix. |
| `competitive-researcher` | Looks up one rival product for the matrix. |
| `blender-artist` | Makes 3D game art in Blender. |
| `plan-reviewer` | Checks a queued plan's PRDs before they run. |
| `md-network-curator` | Keeps a project's markdown docs short and free of drift. |
<!-- /list:personas -->

## Install

### Pick a path

| Path | How | Needs | Platforms |
| --- | --- | --- | --- |
| Installer | See Installers in [Facts](#facts). | Nothing else. The app helps you set up `git` and Claude Code. | macOS, Windows, Linux |
| npx | See Run in [Facts](#facts). | Node per [Facts](#facts), `git`, Claude Code | Linux, macOS |
| From source | `git clone`, `npm install`, `npm run dev` | Node, `git`, Claude Code | Linux, macOS |

### What the first launch changes

| What | Where | Turn off |
| --- | --- | --- |
| MCP server entry | `~/.claude.json` | `SM_SEED_SCHEDULER_MCP_DISABLE=1` |
| Plugin | `~/.claude/plugins/` | `SM_SEED_DEV_PLUGIN_DISABLE=1` |
| Personas | `~/.claude/agents/`. Old copies are backed up to `~/.claude/session-manager/persona-backups/`. Files you edited are left alone. | `SM_SEED_AGENT_PERSONAS_DISABLE=1` |
| Demo video kit | `~/.claude/session-manager/demo-video-kit/` | `SM_SEED_DEMO_VIDEO_KIT_DISABLE=1` |
| Guard hook shims | `~/.claude/session-manager/hooks/`. A project uses them once you accept its setup banner. | Do not accept the banner. |

It also makes the state folders in [Facts](#facts). They have no off switch.

### Start at login

Off by default. Turn it on in App Settings, Startup. It is not offered in a dev run.

An npx install runs `npx claude-code-session-manager@latest` at each login, or the cached copy if that fails within two minutes. Its script, `~/.claude/session-manager/start-at-login.sh`, runs from `~/.config/autostart/claude-code-session-manager.desktop` (Linux) or `~/Library/LaunchAgents/run.bilko.session-manager.login.plist` (macOS). A packaged build uses a login item (macOS, Windows) or the autostart folder (Linux AppImage).

To remove it, turn the switch off, or delete the script and `claude-code-session-manager.desktop` (Linux) or `run.bilko.session-manager.login.plist` (macOS). On a packaged macOS or Windows build, use login items.

### Check it worked

```bash
claude mcp get session-manager-scheduler
claude plugin list
```

### If it fails

| Problem | Fix |
| --- | --- |
| Node is too old | Install the Node in [Facts](#facts), or use the installer. |
| The Electron download failed | Try again. Or set `ELECTRON_MIRROR` to a mirror you can reach. |
| No `node-pty` build for your platform | macOS: run `xcode-select --install`. Linux: install `build-essential` and `python3`. |
| Anything else | Read the logs. Linux: `~/.config/claude-code-session-manager/logs`. macOS: `~/Library/Application Support/claude-code-session-manager/logs`. Windows: `%APPDATA%\claude-code-session-manager\logs`. |

## Reference

### Flags

| Flag | What it does |
| --- | --- |
| `--simple` | Opens one plain terminal with no other screens. |
| `--ozone-platform=x11` or `--ozone-platform=wayland` | Linux only. Picks the display system. On Wayland with `DISPLAY` set, the app picks `x11` for you. |

### Env vars

`SM_TELEMETRY`: see [Facts](#facts). `SM_SEED_*`: see [What the first launch changes](#what-the-first-launch-changes).

| Var | What it does |
| --- | --- |
| `SM_WORKTREE_ROOT` | Moves where session and job worktrees are made. |
| `SM_SCHEDULER_HOME` | Moves app state away from `~/.claude/session-manager/`. Use it for tests. |
| `ELECTRON_MIRROR` | Where `npx` gets Electron from. |

### Network

Your prompts go only to the agent CLI you chose. The app itself talks to:

| Host | Why |
| --- | --- |
| `api.anthropic.com` | Reads your usage, for the meters and the scheduler. |
| `registry.npmjs.org` | Checks for a new app version. |
| `json.schemastore.org`, `www.schemastore.org` | Checks JSON files as you edit them. |
| bilko.run | Telemetry and the Web remote relay. |

### Keyboard

| Key | What it does |
| --- | --- |
| `Cmd-K` / `Ctrl-K` | Open the command palette |
| `Alt-1` to `Alt-5` | Go to tab 1 to 5 |
| `Cmd/Ctrl-N` | Open or start a project |
| `Cmd/Ctrl-Shift-R` | Restart the app |
| `Cmd/Ctrl-Shift-S` | Restart the terminal in this tab |
| `Cmd/Ctrl-R` | Reload the window |
| `F12` | Show or hide dev tools |
| `Cmd/Ctrl-Q` | Quit |
| `Cmd+Option+V` (macOS), `Ctrl+Shift+Space` (others) | Push to talk. You can change it in App Settings. |

## Development

Setup and the checks to run (`typecheck`, `lint`, `test:unit`) are in [CONTRIBUTING.md](https://github.com/StanislavBG/claude-code-session-manager/blob/main/CONTRIBUTING.md). Read it before you open a PR. The Electron tests run with `npm run test:e2e`. Report security bugs as told in [SECURITY.md](https://github.com/StanislavBG/claude-code-session-manager/blob/main/SECURITY.md), not in a public issue. Read [PRD_AUTHORING.md](https://github.com/StanislavBG/claude-code-session-manager/blob/main/src/main/templates/PRD_AUTHORING.md) before you write a PRD.

Run `npm run readme:build` after you change MCP tools, skills, packs, personas or `engines`. `npm run lint` fails if this page is out of date.

## Links

| Link | URL |
| --- | --- |
| Field Manual | https://bilko.run/manual |
| Product page | https://bilko.run/products/session-manager |
| Source | https://github.com/StanislavBG/claude-code-session-manager |
| Issues | https://github.com/StanislavBG/claude-code-session-manager/issues |
| Buy me a coffee | https://bilko.run/coffee |
| Talk to Bilko | https://bilko.run/book?utm_source=session-manager&utm_medium=readme |

## License

MIT. The app and the Field Manual are free.
