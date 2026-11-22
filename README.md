# claude-code-session-manager

> A free desktop app for Claude Code. Each piece of work is a session with its own agent, its own mission and its own copy of the repo. Queued work runs on its own, within your plan's usage limits. It is checked before it counts as done. Agents drive the app through an MCP server with <!-- gen:mcp-tool-count -->36<!-- /gen:mcp-tool-count --> tools and a plugin with <!-- gen:skill-count -->4<!-- /gen:skill-count --> skills. It runs on your machine. MIT license.

## Facts

| Key | Value |
| --- | --- |
| Kind | Desktop app built on Electron. It is not a library. It has no JS API. |
| Run | `npx claude-code-session-manager@latest` |
| Installers | Mac `.dmg` and `.zip` (`arm64`, `x64`). Windows `.exe` (`x64`, `arm64`). Linux `AppImage` (`x64`). Get them from [GitHub Releases](https://github.com/StanislavBG/claude-code-session-manager/releases/latest). |
| Needs | The Claude Code CLI, installed and signed in with your own account. `git`. Node <!-- gen:node-floor -->22.12.0<!-- /gen:node-floor --> or newer, for `npx` only. |
| npx platforms | Linux and macOS. On Windows, use the installer. |
| MCP server | `session-manager-scheduler`. It uses stdio. The app adds it for you. It needs the app to be running. |
| Plugin | `session-manager-dev@session-manager` |
| Agent CLIs | Claude Code is the default. Codex, Gemini CLI, Antigravity CLI, Cursor Agent and OpenCode work in Chat and Terminal only. |
| Where state lives | App state: `~/.claude/session-manager/`. Per project: `<repo>/session-manager-operations/`. Session copies: `~/.local/state/session-manager/`, or `$XDG_STATE_HOME/session-manager/` when `XDG_STATE_HOME` is set. |
| Telemetry | Anonymous and on by default. Turn it off with `SM_TELEMETRY=0`. |
| License | MIT |

## Not

- It is not a hosted or cloud service. It is a desktop app. Your sessions and files stay on your machine.
- It is not made, backed or supported by Anthropic. One person builds it as an open-source project.
- It does not give you Claude access or replace a Claude plan. You need Claude Code, signed in with your own account.
- It has no paid, pro or trial tier. The app and the Field Manual are both free.
- It is not a team or business product. It has no support deal and no uptime promise.
- It is not a library. You cannot `import` it.

## Features

A few words first. A **session** (in code: an Epic) is one unit of work. A **Mission** is the kind of work. A **persona** is an agent's role file. A **worktree** is a separate copy of the repo on its own git branch. A **PRD** is a written work order that the scheduler runs.

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
| App preview | Runs one `npm` script per session on a free port. It opens the first local URL in your browser. | You can see the app from that session's copy. | Session view |

### Scheduler

| Feature | What it does | Why it helps | Where |
| --- | --- | --- | --- |
| Headless jobs | Runs each PRD as a `claude -p` job with a pinned `--model`. | Work goes on while you do other things. | Scheduler |
| Run modes | `when-available` runs jobs while usage is under a set limit. `manual` runs a job only when you press Run. | Work fits inside your plan's limits. | Scheduler |
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

| Feature | What it does | Why it helps | Where |
| --- | --- | --- | --- |
| Agents library | Lists the personas on this machine. You can edit them. | You see each agent's role in one place. | Agents |
| Macros | A macro saves an agent, a Mission and a prompt. One press starts one new session. | You can repeat common work fast. | Sessions |
| Context packs | A pack adds a plugin and rules to one session. | A session gets extra skills only when it needs them. | New session form |

### Claude Code settings

| Feature | What it does | Why it helps | Where |
| --- | --- | --- | --- |
| CLAUDE.md | Edits your `~/.claude/CLAUDE.md`. | You set rules for every session. | CLAUDE.md |
| Claude config | Shows one project's `CLAUDE.md`, `.claude/settings.json`, `.mcp.json`, skills and memory folder. | You see what Claude loads for that repo. | Claude config |
| Settings | Edits `settings.json` for each scope. It shows which scope wins. | You know which value is live. | Settings |
| Hooks | Edits hooks. You can test-fire one. | You can check a hook before you rely on it. | Settings |
| Extensions | Lists skills, MCP servers and plugins. | You see what is installed. | Extensions |

### Project Home

| Feature | What it does | Why it helps | Where |
| --- | --- | --- | --- |
| Pages | Shows pages about the project. | New people learn the project fast. | Project Home |
| Videos | Shows short demo videos. | You can show what the project does. | Project Home |
| Competitor matrix | Compares the project with others, feature by feature. | You see where you lead and where you lag. | Project Home |
| Video character | A saved look for the people in demo videos. | Videos look the same over time. | Project Home |
| Written by agents | Agents write all of these through MCP tools. | You do not have to write them by hand. | MCP tools |

### Across projects

| Feature | What it does | Why it helps | Where |
| --- | --- | --- | --- |
| Cross-project feedback | An agent sends a finding to another repo on this machine. It lands there as a `proposed` session. | A bug gets fixed in the repo that owns it. | `/send-feedback` |
| Feedback to the maker | You send feedback about the app. | The maker hears what is wrong. | Feedback panel |

### See what is going on

| Feature | What it does | Why it helps | Where |
| --- | --- | --- | --- |
| Dashboard | Shows every project and every active session on this machine. | You see all work in one place. | Dashboard |
| Usage meters | Show how much of your plan's limits you used. | You know when work will slow down. | Dashboard |
| History | Shows spend, tokens and time across all projects. | You see where your usage goes. | History |
| File Explorer | Browse and edit files. | You can fix a file without a second app. | File Explorer |

### Input and remote

| Feature | What it does | Why it helps | Where |
| --- | --- | --- | --- |
| Voice input | Turns speech into text on your machine. Nothing leaves it. | You can talk instead of type. | App Settings |
| Recording light | A light shows on top of every screen while the mic is on. | You always know when the mic is on. | Top of window |
| Phone remote | Drive the app from your phone through the bilko.run relay. | You can check work when you are away. | App Settings |
| Simple mode | `--simple` opens one plain terminal. | Use it when you want just a terminal. | Launch flag |
| Command palette | `Cmd-K` or `Ctrl-K` opens a list of commands. | You can run any command from the keys. | Anywhere |

## Headless surface (for agents)

### MCP server

The MCP server is `session-manager-scheduler`. It lets an agent queue PRDs, read the queue, write Project Home pages and more.

The app adds it at user scope in `~/.claude.json` on first launch. To add it by hand, run:

```bash
claude mcp add session-manager-scheduler --scope user -- node <app>/scripts/scheduler-mcp-server.cjs
```

In an installed build, the command is the app's own binary, with `-e ELECTRON_RUN_AS_NODE=1`.

The server needs the app to be running. Each call goes to the app's local HTTP API. The token for it is in `~/.claude/session-manager/admin-api.json`.

Two ways it can fail:

- A tool returns an error that says the app is not running. Start the app, then try again.
- The tools are not in your tool list. The server is not added. Delete `~/.claude/session-manager/.scheduler-mcp-seeded` and restart the app.

Start with `session_manager_help`:

- No args: it lists every tool.
- `tool`: it explains one tool, with example args.
- `topic`: it shows one recipe.

Recipes:

<!-- gen:mcp-recipes -->
- `queue-work-via-develop` — Queue work into an already-approved Epic (/develop)
- `unstick-needs-review-job` — Unstick a job stuck in needs_review
- `hand-finding-to-another-project` — Hand a finding to another project
- `reply-to-the-project-that-asked` — Reply to the project that asked
- `add-project-video-tool` — Add a project video tool
<!-- /gen:mcp-recipes -->

Tools:

<!-- gen:mcp-tools -->
| Tool | Group | Required args | What it does |
| --- | --- | --- | --- |
| `scheduler_reset_job` | scheduler | `slug` | Reset a stuck job so the scheduler runs it again. |
| `scheduler_pause` | scheduler | — | Pause new job starts for every project on this machine. |
| `scheduler_resume` | scheduler | — | Lift a scheduler pause so jobs start again. |
| `scheduler_list_jobs` | scheduler | — | List queued, running and finished jobs on this machine. |
| `scheduler_create_prd` | scheduler | `title`, `goal`, `acceptanceCriteria`, `implementationNotes`, `gate`, `files` | Queue one PRD (a written work order) in an Epic a human approved. |
| `scheduler_create_prds` | scheduler | `prds` | Queue a whole plan of PRDs in one all-or-nothing call. |
| `scheduler_list_prds` | scheduler | — | List PRDs and their job status, by project, Epic or status. |
| `scheduler_get_prd` | scheduler | `slug` | Read one PRD in full, with its frontmatter. |
| `scheduler_update_prd` | scheduler | `slug` | Edit a PRD that has not run yet or has stopped. |
| `scheduler_archive_prd` | scheduler | `slugs` | Archive PRDs that are done or no longer needed. |
| `scheduler_cancel_job` | scheduler | `slug` | Cancel a job that has not finished. |
| `scheduler_retag_prd` | scheduler | `items` | Change a PRD's group number or time estimate. |
| `chat_send_prompt` | chat | `tabId`, `prompt` | Send a prompt to a session tab that is already open. |
| `feedback_list_projects` | feedback | — | List the other projects on this machine that can take feedback. |
| `feedback_open_session` | feedback | `toCwd`, `fromCwd`, `title`, `motivation`, `acceptanceCriteria`, `body` | Hand a finding to another project as a proposed session there. |
| `feedback_reply` | feedback | `message`, `outcome` | Answer the project that sent this session its feedback. |
| `project_home_write` | project-home | `html` | Write the Overview page of Project Home (same as project_page_write). |
| `project_page_write` | project-home | `pageId`, `title`, one of `html` / `htmlPath` | Write one HTML knowledge page for Project Home. |
| `project_matrix_read` | project-home | — | Read the saved competitor feature matrix and its schema. |
| `project_matrix_write` | project-home | one of `matrix` / `matrixPath` | Save the competitor feature matrix as one JSON object. |
| `project_video_write` | project-home | `videoId`, `title`, `kind`, `lengthS`, `meta`, one of `html` / `htmlPath` | Save one self-contained HTML video for Project Home. |
| `project_demo_video_write` | project-home | one of `html` / `htmlPath` | Save a 30-second or 1-minute demo video (same as project_video_write). |
| `project_character_write` | project-home | `json`, one of `js` / `jsPath` | Save the reusable character used in this project's videos. |
| `project_video_review_write` | project-home | `videoId`, `text`, `imagePaths` | Save a script and images for a human to review a video. |
| `customer_feedback_list` | customer-feedback | — | List feedback that users sent to the owner's inbox. |
| `customer_feedback_set_status` | customer-feedback | `id`, `status` | Set the status of one feedback item, with an optional note. |
| `customer_feedback_submit` | customer-feedback | `goal`, `description`, `tag` | Send feedback about Session Manager to its maintainers. |
| `macro_list` | macros | — | List this project's saved one-click macros. |
| `macro_save` | macros | `label`, `agentName`, `tag`, `prompt` | Create or change a saved one-click macro (agent, mission, prompt). |
| `macro_delete` | macros | `id` | Delete one saved macro. |
| `epic_list` | epics | `cwd` | List the open sessions of one project and what state each is in. |
| `epic_get` | epics | `cwd`, one of `id` / `externalRef` | Read one session by its id or by the outside reference it was opened with. |
| `agent_list` | agents | — | List the agents you can launch and the model each one runs on. |
| `task_list` | tasks | `cwd` | List a project's Tasks with their status, model and cost. |
| `task_get` | tasks | `cwd`, `id` | Read one Task in full, with its prompt and output. |
| `session_manager_help` | help | — | Start here: list every tool, or explain one tool or recipe. |
<!-- /gen:mcp-tools -->

Rules the server enforces:

- A new PRD must join a session that a person already approved. The server never creates a session.
- A new PRD must have a `gate` and a `files` list.
- A headless job cannot queue PRDs, unless it runs as `architect`. A session a person is in can queue PRDs.
- A job with `SM_SCHEDULER_JOB_MCP_TOOLS` set can call only the tools in that list.
- A pause set by an agent ends after 30 minutes. A pause set by a person stays until `scheduler_resume`.

### Headless jobs

Each PRD job runs as the PRD's persona, `dev-lead` by default, in its own worktree. It runs the PRD's gate, then commits. Its last line is a verdict such as `SCHEDULER_VERDICT: PASS`.

### Scripts

A script can start a macro with `POST /admin/macros/run`. It works only for a macro a person marked "Can be started by a script".

## Skills

### Plugin session-manager-dev

On first launch, the app installs this plugin with no network. It comes from the bundled `session-manager` marketplace. The app keeps it up to date. To skip it, set `SM_SEED_DEV_PLUGIN_DISABLE=1`. To install it outside the app, run:

```bash
claude plugin marketplace add StanislavBG/claude-code-session-manager
claude plugin install session-manager-dev@session-manager
```

`/develop` and `/send-feedback` call the MCP server. So the app must be running for them.

<!-- list:skills -->
| Skill | Use it to |
| --- | --- |
| `/develop` | Split work into PRDs, queue them, and track them until they are checked. |
| `/builder` | Publish the project's npm package and keep its Field Manual in step. |
| `/send-feedback` | Send a finding to a different project on this machine. |
| `/maintaining-md-network` | Review a project's `CLAUDE.md` and docs so each fact lives in one place. |
<!-- /list:skills -->

### Context packs

You pick packs for each session. A pack adds its skills and rules to that session only.

<!-- list:packs -->
| Pack | What it adds | Skills |
| --- | --- | --- |
| `apple-design` | Apple design rules for iOS app screens. | `hig-layout-and-accessibility`, `liquid-glass-adoption` |
| `apple-swift-core` | Swift 6 and SwiftUI rules for iOS apps. | `swift-concurrency`, `swiftui-state-and-navigation` |
<!-- /list:packs -->

### Agent personas

The app copies these into `~/.claude/agents/` on first launch.

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
<!-- /list:personas -->

## Install

### Pick a path

| Path | How | Needs | Platforms |
| --- | --- | --- | --- |
| Installer | Download from [GitHub Releases](https://github.com/StanislavBG/claude-code-session-manager/releases/latest). | Nothing else. The app helps you set up `git` and Claude Code. | macOS, Windows, Linux |
| npx | `npx claude-code-session-manager@latest` | The Node version in [Facts](#facts), `git`, Claude Code | Linux, macOS |
| From source | `git clone`, `npm install`, `npm run dev` | Node, `git`, Claude Code | Linux, macOS |

### What the first launch changes

| What | Where | Turn off |
| --- | --- | --- |
| MCP server entry | `~/.claude.json` | `SM_SEED_SCHEDULER_MCP_DISABLE=1` |
| Plugin | `~/.claude/plugins/` | `SM_SEED_DEV_PLUGIN_DISABLE=1` |
| Personas | `~/.claude/agents/`. Old copies are backed up to `~/.claude/session-manager/persona-backups/`. Files you edited are left alone. | `SM_SEED_AGENT_PERSONAS_DISABLE=1` |
| Demo video kit | `~/.claude/session-manager/demo-video-kit/` | `SM_SEED_DEMO_VIDEO_KIT_DISABLE=1` |
| Guard hook shims | `~/.claude/session-manager/hooks/`. A project uses them once you accept its setup banner. | Do not accept the banner. |
| App state | `~/.claude/session-manager/` | None |
| Project folder | `<repo>/session-manager-operations/` | None |
| Session worktrees | `$XDG_STATE_HOME/session-manager/`, by default `~/.local/state/session-manager/` | None |
| Telemetry | Sent to bilko.run | `SM_TELEMETRY=0` |

### Start at login

Off by default. Turn it on in App Settings, Startup.

An npx install starts through `npx claude-code-session-manager@latest`, so each login fetches the newest release; if that fails within two minutes, it retries with the cached copy. The script is `~/.claude/session-manager/start-at-login.sh`, run by a desktop entry in `~/.config/autostart/` (Linux) or a launch agent in `~/Library/LaunchAgents/` (macOS).

A packaged build starts the installed app: a login item on macOS and Windows, the autostart folder for a Linux AppImage.

To remove it, turn the switch off, or delete the script and `claude-code-session-manager.desktop` (Linux) or `run.bilko.session-manager.login.plist` (macOS). For a packaged macOS or Windows build, remove it from login items.

It is not offered for an npx install on Windows, or in a dev run.

### Check it worked

```bash
claude mcp get session-manager-scheduler
claude plugin list
```

Then have an agent call `session_manager_help` with no args.

### If it fails

| Problem | Fix |
| --- | --- |
| Node is too old | Install the Node version in [Facts](#facts) or newer. Or use the installer. |
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

| Var | What it does |
| --- | --- |
| `SM_TELEMETRY=0` | Turns off telemetry. |
| `SM_SEED_SCHEDULER_MCP_DISABLE=1` | Do not add the MCP server. |
| `SM_SEED_DEV_PLUGIN_DISABLE=1` | Do not install the plugin. |
| `SM_SEED_AGENT_PERSONAS_DISABLE=1` | Do not copy personas. |
| `SM_SEED_DEMO_VIDEO_KIT_DISABLE=1` | Do not copy the demo video kit. |
| `SM_WORKTREE_ROOT` | Moves where session and job worktrees are made. |
| `SM_SCHEDULER_HOME` | Moves app state away from `~/.claude/session-manager/`. Use it for tests. |
| `ELECTRON_MIRROR` | Where `npx` gets Electron from. |

### Network

Your prompts go only to the agent CLI you chose. The app never sends them anywhere else. The app itself talks to:

| Host | Why |
| --- | --- |
| `api.anthropic.com` | Reads your usage, for the meters and the scheduler. |
| `registry.npmjs.org` | Checks for a new app version. |
| `json.schemastore.org`, `www.schemastore.org` | Checks JSON files as you edit them. |
| bilko.run | Telemetry and the phone remote relay. |

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

```bash
git clone https://github.com/StanislavBG/claude-code-session-manager
cd claude-code-session-manager
npm install
npm run dev
npm run typecheck
npm run lint
npm run test:unit
npm run test:e2e
```

Read [CONTRIBUTING.md](https://github.com/StanislavBG/claude-code-session-manager/blob/main/CONTRIBUTING.md) before you open a PR. Report security bugs as told in [SECURITY.md](https://github.com/StanislavBG/claude-code-session-manager/blob/main/SECURITY.md), not in a public issue. See also [CODE_OF_CONDUCT.md](https://github.com/StanislavBG/claude-code-session-manager/blob/main/CODE_OF_CONDUCT.md). Read [PRD_AUTHORING.md](https://github.com/StanislavBG/claude-code-session-manager/blob/main/src/main/templates/PRD_AUTHORING.md) before you write a PRD.

Run `npm run readme:build` after you change MCP tools, skills, packs, personas or `engines`. `npm run lint` fails if this page is out of date.

## Links

| Link | URL |
| --- | --- |
| Field Manual | https://bilko.run/manual |
| Product page | https://bilko.run/projects/session-manager/ |
| Source | https://github.com/StanislavBG/claude-code-session-manager |
| Releases | https://github.com/StanislavBG/claude-code-session-manager/releases |
| Issues | https://github.com/StanislavBG/claude-code-session-manager/issues |
| Buy me a coffee | https://bilko.run/coffee |
| Talk to Bilko | https://bilko.run/book?utm_source=session-manager&utm_medium=readme |

## License

MIT. The app and the Field Manual are free. There is no paid tier.
