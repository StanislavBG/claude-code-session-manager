import type { NavKey } from './LeftNav'

export interface LearningItem {
  /** Optional bold lead-in (e.g. a setting name) before the explanation. */
  term?: string
  body: string
}

export interface LearningSection {
  title: string
  items: LearningItem[]
}

export interface LearningContent {
  /** Single-line subtitle shown in the collapsed panel header. */
  headline: string
  /** One-paragraph plain-English summary of what the page is for. */
  intro: string
  sections: LearningSection[]
  /** Optional short list of practical tips, shown last. */
  tips?: string[]
}

export const LEARNING_CONTENT: Record<NavKey, LearningContent> = {
  'overview': {
      headline: 'Your home base — a calm landing page for your local Claude Code cockpit',
      intro:
        'Overview is the first screen you see. It greets you by time of day and frames Session Manager as a local cockpit that wraps the Claude CLI alongside skills, hooks, MCP servers, and a scheduler. Nothing here phones home. The page is a launchpad, not a settings screen: a live 5-hour usage card, a few quick-start buttons, your most-recent sessions, and a peek at what is queued in the scheduler. Click any of them to jump straight into the relevant tab.',
      sections: [
        {
          title: 'What you see',
          items: [
            { term: '5-hour window', body: 'A live read of your subscription usage for the current 5-hour rolling bucket: a bar that fills as you use it, the percent used, the local time it resets, and a live countdown of time remaining. Same data the Usage tab and the CLI /usage command read.' },
            { term: 'Quick start', body: 'Four buttons — Start a session, Resume last (opens History), Draft a PRD (opens Scheduler), and Add a project (opens Projects) — plus a microphone button that opens voice input.' },
            { term: 'Recent sessions', body: 'Your four most-recently-touched transcripts, scanned from ~/.claude/projects. Each row shows the project, the short session id, the transcript size, and how long ago it was active. Click a row to reopen that session with claude --resume.' },
            { term: 'In the scheduler', body: 'A peek at the first three jobs in the scheduler queue, each tagged running or queued with a rough time estimate. “Open scheduler →” jumps to the full Scheduler tab.' },
          ],
        },
        {
          title: 'Behaviors this affects',
          items: [
            { body: 'Overview is read-only and click-through. It never edits anything; every button just navigates you to the tab that does the work (History, Scheduler, Projects, Voice) or starts a new session.' },
            { body: 'The 5-hour countdown refreshes on a timer. If the usage card shows a dash, billing data is not loaded yet (or the Claude login has expired — re-authenticate with the CLI).' },
          ],
        },
      ],
    },
  'terminal': {
      headline: 'A real Claude Code CLI running inside the app, kept alive across tab switches',
      intro:
        'The Terminal tab is a genuine terminal running the claude CLI for you. It behaves like running claude in your own shell, but Session Manager keeps the process alive when you switch to other tabs, makes file paths and URLs clickable, smooths over copy/paste, and lets you broadcast a prompt to several tabs or attach background watchers. Each tab is one Claude session — the tab id IS the session id, so the tab maps directly to its transcript on disk.',
      sections: [
        {
          title: 'In the terminal pane',
          items: [
            { term: 'Settings gear (top-right)', body: 'A small gear opens a popover to change the terminal theme (Dark / Light / Paper) and font size (10–22px, with a reset). Changes apply instantly to every open terminal and persist between launches.' },
            { term: 'Clickable file paths', body: 'Paths like src/main/index.cjs:42 are detected and underlined. Clicking one opens that file in the in-app editor at the right line. URLs are also clickable and open in your system browser.' },
            { term: 'Paste images', body: 'Ctrl+V pastes clipboard text as usual, but if the clipboard holds an image it is saved to a temp PNG and its path is typed in — so you can paste a screenshot and let Claude read it.' },
            { term: 'Smart Ctrl+C', body: 'With text selected, Ctrl+C copies it; with nothing selected, Ctrl+C passes through to interrupt Claude (same as a normal terminal). Ctrl+Shift+C always copies.' },
          ],
        },
        {
          title: 'Session commands (Command Palette / shortcuts)',
          items: [
            { term: 'Restart session', body: 'Ctrl+Shift+R kills this tab\'s claude process and spawns a fresh one in the same directory. Use it after editing settings, hooks, or skills so Claude reloads them.' },
            { term: 'Reboot app', body: 'Relaunches Session Manager; your tabs come back automatically. Use when something feels stuck.' },
            { term: 'Broadcast', body: 'Ctrl+Shift+B opens a bar to send the same prompt to several tabs at once. You tick which tabs to include; each row shows sent or skipped (a dead session is skipped).' },
            { term: 'Watchers', body: 'Ctrl+Shift+W attaches a long-running shell command (e.g. npm test --watch, tail -f log) to this tab. Each new line of its output pops up as a toast. Watchers survive tab switches and stop when you remove them.' },
          ],
        },
        {
          title: 'Things that are easy to miss',
          items: [
            { body: 'Open the Command Palette (Cmd-K / Ctrl-K) to reach the session commands above, plus copy-cwd, copy-transcript path, and open-transcript.' },
            { body: 'Switching to another tab does NOT kill the terminal — the claude process keeps running in the background and the screen is just hidden.' },
            { body: 'Voice input (the microphone in the sidebar) types into whichever terminal tab is focused — there is no separate voice tab.' },
          ],
        },
      ],
      tips: [
        'Press Ctrl+C with nothing selected to interrupt Claude mid-response — same as the standalone CLI.',
        'If the prompt looks frozen, scroll up: Claude often produced output but the cursor is below the visible window.',
      ],
    },
  'browser': {
      headline: 'An embedded dev browser for capturing DOM state and recording click-sequences',
      intro:
        'Browser is a foundation stub today — the tab shell exists so later work can add sub-tabs, an address bar, an embedded webview, and capture/record/observe tooling without a routing change.',
      sections: [
        {
          title: 'What you see',
          items: [
            { body: 'A placeholder page. The embedded browser, DOM capture, and click-recording features arrive in follow-up work.' },
          ],
        },
      ],
    },
  'system-prompt': {
      headline: 'Edit the CLAUDE.md files that shape Claude\'s house rules',
      intro:
        'CLAUDE.md is a plain-text file Claude reads at the start of every session. Whatever you write here is added to its instructions — so it\'s where you put coding standards, communication preferences, project context, and “always do X / never do Y” rules. Up to three files combine at runtime: User (global, applies everywhere), Project (this repo), and Local (your personal overrides for this repo, gitignored by convention). This tab is a markdown editor over whichever scope you pick.',
      sections: [
        {
          title: 'Editor / Presets toggle',
          items: [
            { term: 'Editor', body: 'Edit the actual CLAUDE.md file at the selected scope. Save writes it to disk; Claude picks it up on its next session start.' },
            { term: 'Presets', body: 'Browse a library of starter prompts. Use one as a starting point, then refine it in the editor.' },
          ],
        },
        {
          title: 'Scope (User / Project / Local)',
          items: [
            { term: 'User', body: 'Lives at ~/.claude/CLAUDE.md. Applies to every session you start, in every repo. Best for personal style: communication tone, default tooling preferences, things you always want.' },
            { term: 'Project', body: 'Lives at <repo>/CLAUDE.md. Applies only when working in this repo. Best for shared team context: stack, architecture, do/don\'t lists, conventions. Commit it to git.' },
            { term: 'Local', body: 'Lives at <repo>/CLAUDE.local.md. Applies only in this repo, only on your machine. Best for personal overrides that shouldn\'t reach teammates. Gitignore it.' },
            { body: 'Project and Local scopes need an open project — if no tab has a working directory, those scopes are unavailable and the editor prompts you to open one. At runtime all present files combine; more-specific wins: Local > Project > User.' },
          ],
        },
        {
          title: 'What\'s shown in the header',
          items: [
            { term: 'chars / tokens', body: 'A rough size estimate (~4 chars per token). The bigger the file, the more of Claude\'s context window it consumes before your real prompt — keep it tight.' },
            { term: 'dirty marker (•) on a scope', body: 'You have unsaved edits at that scope. Switching scope does NOT auto-save; use Save in the bottom bar (or Revert to discard).' },
            { body: 'If a file doesn\'t exist yet, the bottom bar notes it will be created on save.' },
          ],
        },
      ],
      tips: [
        'New users: start with 3–5 bullets at User scope (“be concise”, “use Python type hints”, “always run tests after changes”). That alone changes Claude\'s behavior noticeably.',
        'Don\'t write essays. Claude reads CLAUDE.md before every reply, so every word costs tokens. One-line rules beat paragraphs.',
      ],
    },
  'settings': {
      headline: 'The settings.json files that control Claude Code\'s behavior',
      intro:
        'Claude Code is configured by JSON files named settings.json. This tab shows up to three of them combined: User (~/.claude/settings.json), Project (<repo>/.claude/settings.json, shared with the repo), and Local (<repo>/.claude/settings.local.json, your private overrides). The Guided view is a friendly card editor; Tree shows the merged values as a JSON tree; Raw lets you hand-edit the file. A bundled schema (from schemastore.org) gives you autocomplete and validation as you type.',
      sections: [
        {
          title: 'Views',
          items: [
            { term: 'Guided', body: 'A card-based editor over the merged settings. Each setting shows which scope currently provides it; editing a card writes the change into the scope you\'ve selected.' },
            { term: 'Tree', body: 'The same merged config as an expandable JSON tree. Useful for nested settings like permissions and hooks; you can override a value into the active scope from here too.' },
            { term: 'Raw', body: 'The JSON file at the active scope, edited directly. Save validates before writing; a parse error blocks the save and is shown in the bottom bar.' },
            { term: 'Telemetry', body: 'Opt-in OpenTelemetry export of Session Manager\'s own classified transcript events (tool names, todo counts, usage tokens). Off by default, stored separately from Claude\'s settings, and excludes prompt/plan content unless you turn on “Include content”.' },
          ],
        },
        {
          title: 'Common settings to know',
          items: [
            { term: 'model', body: 'Default model used when you start a session (e.g. “opus”, “sonnet”, “haiku”). Override per-session with /model in the terminal.' },
            { term: 'permissions', body: 'Allow / Ask / Deny lists for Bash commands, file edits, MCP tools, web fetches. The dedicated Permissions tab is a friendlier UI for this same key.' },
            { term: 'hooks', body: 'Shell commands the CLI runs in response to events (pre/post tool use, session start, etc.). See the Hooks tab.' },
            { term: 'env', body: 'Environment variables injected into every claude process — handy for API keys or DEBUG flags.' },
            { term: 'mcpServers', body: 'External tool servers Claude can call. Edit via the MCP Servers tab for a structured form.' },
          ],
        },
        {
          title: 'Scope precedence',
          items: [
            { body: 'Local overrides Project overrides User. A Project-scoped setting beats a User-scoped one when you work in that repo, and your personal Local file beats both. Project and Local require an open project tab — with no working directory, only User is editable.' },
            { body: 'Lists merge (allow + allow), but objects do not — a Project-scoped { permissions: { allow: [...] } } REPLACES the user-scoped object wholesale unless you copy the entries you want to keep.' },
          ],
        },
      ],
      tips: [
        'When in doubt, edit at User scope. Project-scoped settings get committed to git; teammates inherit them.',
        'After changing settings.json, restart any open sessions (Restart session, Ctrl+Shift+R) so Claude reloads.',
      ],
    },
  'permissions': {
      headline: 'Decide which tools Claude can run automatically and which need your OK',
      intro:
        'Every action Claude takes — running a Bash command, editing a file, calling an MCP tool — passes a permission check. This tab is a structured editor for the permissions block inside settings.json (there is no separate permissions file). You build three lists — Allow / Deny / Ask — of rules; get them right and you barely see prompts, get them wrong and you\'re either hammered with confirmations or Claude runs something you didn\'t want.',
      sections: [
        {
          title: 'Views',
          items: [
            { term: 'Effective', body: 'The merged permissions Claude actually sees, as a tree, with which scope each value came from. Read-and-override here.' },
            { term: 'Rules', body: 'The structured editor: a Default Mode picker, the Allow / Deny / Ask lists (type a rule and press Enter or click add; × to remove), and Additional Directories. Edits write into the scope you\'ve selected.' },
            { term: 'Presets', body: 'A starter library of common permission sets to copy from.' },
          ],
        },
        {
          title: 'The three lists',
          items: [
            { term: 'Allow', body: 'Claude runs matching actions silently — no confirmation. Use for safe, repetitive things: Bash(ls:*), Read(~/.claude/**), Edit(src/**).' },
            { term: 'Deny', body: 'Claude refuses outright, even if you\'d say yes interactively. Use for genuinely dangerous things: Bash(rm -rf:*), Write(/etc/**).' },
            { term: 'Ask', body: 'Claude pauses and asks before running. Sits between Allow and Deny for things you want to eyeball each time.' },
          ],
        },
        {
          title: 'Rule shape',
          items: [
            { term: 'Tool(pattern)', body: 'Format is <ToolName>(<pattern>). Examples: Bash(git push:*), Edit(src/**/*.ts), WebFetch(domain:*.example.com).' },
            { term: ':*', body: 'A trailing colon-star means “any arguments”. Bash(npm:*) allows every npm invocation; Bash(npm test) only the literal “npm test”.' },
            { body: 'Deny wins ties. If a request matches both Allow and Deny, Deny takes effect. (See the “rule syntax” link in the toolbar for the full grammar.)' },
          ],
        },
        {
          title: 'Default Mode',
          items: [
            { term: 'default', body: 'Out-of-the-box behavior: ask for risky operations, allow harmless reads.' },
            { term: 'acceptEdits', body: 'Auto-approve file edits within the session\'s working tree. Speeds up iterative coding; avoid for prod repos.' },
            { term: 'plan', body: 'Read-only mode. Claude can explore and propose, but cannot edit or run shell commands. Good for review sessions.' },
            { term: 'bypassPermissions', body: 'Skip ALL prompts. Equivalent to --dangerously-skip-permissions. Use only in throwaway sandboxes.' },
          ],
        },
      ],
      tips: [
        'Start permissive at User scope (your common safe commands), then tighten at Project scope for repos with secrets.',
        'Additional Directories lets Claude read files outside the cwd — add reference repos here as absolute paths instead of cd’ing into each one.',
      ],
    },
  'skills': {
      headline: 'Reusable instructions Claude loads on demand for specific tasks',
      intro:
        'A skill is a markdown file that teaches Claude how to do one specific thing — "write Playwright tests", "review SQL migrations", "format an OpenAPI doc". Each skill has frontmatter describing when to trigger it and a body with the actual instructions. Claude doesn\'t load all skills up front; it scans titles and pulls the body in only when a relevant request arrives, keeping your context tight.',
      sections: [
        {
          title: 'List + Detail',
          items: [
            { term: 'Scope switch', body: 'Toggle User vs Project at the top. User skills live in ~/.claude/skills/ and apply everywhere; Project skills live in <repo>/.claude/skills/ and only when a tab is open in that repo. The toolbar shows the item count and the file path of the selected skill.' },
            { term: 'Sidebar', body: 'Two groups — Skills and Slash Commands — with a filter box that matches on name. Click an entry to open its markdown in the editor.' },
            { term: 'Enable toggle', body: 'Each skill has an on/off switch. Turning it off writes disable-model-invocation into the skill\'s frontmatter, so Claude stops auto-invoking it; the file stays on disk and the name shows struck-through. Slash commands have no toggle.' },
            { term: 'Remove (✕)', body: 'Deletes a skill\'s folder to the trash (recoverable). It comes out of your active set entirely — reinstall any time from the Library. This is different from the toggle, which only stops auto-invocation.' },
            { term: 'Editor', body: 'Standard markdown with a Save/Revert bar at the bottom. The frontmatter (the --- block at the top) controls discovery; the body is what Claude reads when the skill fires.' },
            { term: 'Library view', body: 'Switch to Library to browse a curated catalog of skills. Each row gives a "source" link and a "copy install" button (a git-clone command you paste into a terminal) — there is no one-click install for skills.' },
          ],
        },
        {
          title: 'Skill anatomy',
          items: [
            { term: 'name', body: 'Used in transcripts and the Library. Should be unique within a scope.' },
            { term: 'description', body: 'Critical — Claude scans descriptions to decide when to load this skill. Be specific about WHEN to use it ("when writing E2E tests with Playwright"), not just what it does.' },
            { term: 'allowed-tools', body: 'Optional. Restricts which tools Claude can use while the skill is active. Adds an extra layer of safety on top of permissions.' },
            { term: 'Body', body: 'Plain markdown. Procedures, code examples, do/don\'t lists. This is what Claude actually reads.' },
          ],
        },
        {
          title: 'Slash commands',
          items: [
            { body: 'Commands (in ~/.claude/commands/ or .claude/commands/) are skills you invoke explicitly with /name — they show with a leading "/" in the sidebar. Skills proper are auto-loaded; commands are user-triggered.' },
            { body: 'This tab lists both at the active scope — same markdown shape on disk, different folders.' },
          ],
        },
      ],
      tips: [
        'A bad description is worse than no skill — Claude either won\'t load it when needed, or will load it constantly and waste tokens.',
        'When refining a skill, use Restart Session in the terminal so Claude reloads it.',
      ],
    },
  'plugins': {
      headline: 'Bundled collections of skills, subagents, and hooks that ship together',
      intro:
        'A plugin is a directory under ~/.claude/plugins/<name>/ that packages multiple Claude Code primitives (skills, subagents, hooks, MCP servers, LSPs, monitors) under one name. Installing a plugin adds all of them at once; uninstalling removes them cleanly. Use plugins when you want to share a coherent toolkit — "react-frontend-pack", "data-pipeline-helpers" — instead of asking teammates to copy ten files into the right places.',
      sections: [
        {
          title: 'Three views',
          items: [
            { term: 'Installed', body: 'A read-only inspector for every plugin folder on disk, shown as a table: name, origin, version, whether it has a manifest, and a contents summary (counts of agents · skills · hooks · monitors · bin · lsp · mcp). Click a row for a detail panel with the manifest fields (version, license, homepage, repository, author) and the full path. To edit a plugin\'s pieces, use the dedicated Skills / Hooks tabs — they point at the same files.' },
            { term: 'Discover', body: 'A built-in list of official add-ons (LSP servers, MCP integrations). The Install button runs claude plugin install <slug> in a hidden terminal and streams its output below the row; on success the row flips to installed.' },
            { term: 'Library', body: 'Browse the curated plugin catalog. Each row has a "source" link, a "copy" button for the /plugin install command, and an Install button that wires up the marketplace and installs for you.' },
          ],
        },
        {
          title: 'Plugin layout on disk',
          items: [
            { term: 'plugin.json', body: 'The manifest — name, version, description, what the plugin includes. The canonical location is .claude-plugin/plugin.json; older installs keep it at the folder root. Both are detected.' },
            { term: 'skills/', body: 'Same shape as ~/.claude/skills/. Show up in the Skills tab.' },
            { term: 'agents/', body: 'Markdown subagents (same shape as ~/.claude/agents/), available to the main Claude to delegate to.' },
            { term: 'hooks/hooks.json', body: 'Hooks contributed by the plugin (mirrors settings.json\'s hooks shape, keyed by event), merged into your effective hook set.' },
            { term: '.mcp.json / .lsp.json / monitors/', body: 'Optional — MCP servers, language servers, and monitors the plugin bundles. Their presence shows up in the contents summary.' },
          ],
        },
      ],
      tips: [
        'The Installed view is inspect-only here — it will not let you edit or delete plugin files. Edit a plugin\'s contents through the Skills/Hooks tabs instead.',
        'Editing plugin contents directly is fine but be aware: an upgrade may overwrite your changes. Fork the plugin if you need persistent customizations.',
      ],
    },
  'mcp': {
      headline: 'Connect Claude to external tools — databases, APIs, filesystems — via MCP servers',
      intro:
        'MCP (Model Context Protocol) is the open spec for letting Claude call out to external tools. An MCP server is a small process (or HTTP endpoint) that exposes a set of functions; once you register it, Claude treats those functions as first-class tools. Common examples: a Postgres server that lets Claude run SELECTs, a Slack server that posts messages, a filesystem server that exposes a specific directory tree.',
      sections: [
        {
          title: 'Where servers are stored',
          items: [
            { term: 'User scope', body: '~/.claude.json under mcpServers. Available in every session, every repo.' },
            { term: 'Project scope', body: '<repo>/.mcp.json. Available only when working in this repo. Commit it so teammates pick up the same servers.' },
            { term: 'Editing', body: 'Use "+ new server" to add one, click a row to edit it, rename via the name field, and Save/Revert at the bottom. A filter box narrows the list; the Library view installs catalog servers for you.' },
          ],
        },
        {
          title: 'Server types',
          items: [
            { term: 'stdio', body: 'Local process — Claude spawns the command and talks to it via stdin/stdout. Most common for tools you ship as a CLI. Fields: command, args, env.' },
            { term: 'http / streamable-http', body: 'Remote endpoint with JSON-RPC. Field: url, plus headers for auth.' },
            { term: 'sse', body: 'Server-Sent Events transport — deprecated; the editor flags it and suggests streamable-http instead.' },
            { term: 'ws', body: 'WebSocket transport. Same url + headers fields as the other remote types.' },
          ],
        },
        {
          title: 'Per-server controls',
          items: [
            { term: 'env / headers', body: 'Secrets like API keys go here (env for stdio, headers for remote types). Project-scope values get committed to git — be careful; prefer User scope for anything sensitive.' },
            { term: 'args', body: 'Command-line arguments passed to a stdio server\'s command. Often used to point at a specific config file or directory.' },
            { term: 'alwaysLoad', body: 'Bypass tool-search deferral and always load this server\'s tools up front (rather than only when searched for).' },
            { term: 'enabled', body: 'Uncheck to stop loading this server in new sessions without deleting its config.' },
            { term: 'disabledTools', body: 'A comma-separated denylist of individual tool names to hide from this server.' },
            { term: 'permissions', body: 'Per-server tool gating: inherit (default), allow all, deny all, or an explicit allowlist of tool names.' },
          ],
        },
      ],
      tips: [
        'The name "workspace" is reserved — the editor warns that Claude Code will refuse to load a server with that name. Names like "ide" and "tasks" get a softer caution because they collide with commonly-bundled servers.',
        'After adding/editing a server, restart the affected sessions so Claude reconnects and rediscovers tools.',
      ],
    },
  'hooks': {
      headline: 'Run scripts when Claude does something — pre/post-tool, session start/end, more',
      intro:
        'Hooks let you run a shell command, HTTP request, prompt, subagent, or MCP tool in response to events Claude Code emits. Want to log every Bash command Claude runs to a file? PreToolUse hook. Want a subagent to review every edit before it sticks? PostToolUse hook. Want a Slack ping when a long session ends? Stop hook. Hooks are stored in settings.json and can gate, log, or transform actions.',
      sections: [
        {
          title: 'Two ways to view',
          items: [
            { term: 'Effective', body: 'The merged result of all scopes (User / Project / Local) — what actually fires. Editing here writes an override into the scope you have selected.' },
            { term: 'Events', body: 'A per-event editor. The left list shows every supported event with a count of hooks attached; pick one, then add groups (with an optional matcher) and hooks under it.' },
            { term: 'Library', body: 'Browse catalog hooks. Each event row links to the official hook reference.' },
          ],
        },
        {
          title: 'The five hook types',
          items: [
            { term: 'command', body: 'Run a shell string (with an optional args array for the no-shell exec form). The script receives the event as JSON on stdin and can return a JSON decision. Only command hooks support the Test fire button.' },
            { term: 'http', body: 'POST the event JSON to a URL. The response becomes the decision.' },
            { term: 'prompt', body: 'Send a templated prompt to Claude itself for a quick gut-check. Useful for "should I really run this command?" guards.' },
            { term: 'agent', body: 'Spawn a subagent (a markdown file under ~/.claude/agents/) with the event as input. The agent\'s output is the decision.' },
            { term: 'mcp_tool', body: 'Invoke a named MCP tool (e.g. mcp__server__tool) in response to the event.' },
          ],
        },
        {
          title: 'Common events',
          items: [
            { term: 'PreToolUse / PostToolUse', body: 'Before / after Claude calls any tool. Most-used hooks live here — gating, logging, transforming. A matcher (tool-name regex or exact match) scopes a group to specific tools.' },
            { term: 'UserPromptSubmit', body: 'Fires when you press Enter on a prompt. Good for prepending context (current branch, recent errors) before Claude sees the prompt.' },
            { term: 'SessionStart / SessionEnd', body: 'Boot/teardown housekeeping — refresh tokens, save transcripts, post a summary.' },
            { term: 'Stop / SubagentStop', body: 'When the main loop or a subagent finishes. Good for "ping me when done" notifications.' },
            { term: 'PreCompact / PostCompact', body: 'Around the auto-compaction step. Useful for archiving the full transcript before it\'s shrunk.' },
            { body: 'Many more are supported — permissions, tasks, worktrees, config/file changes, notifications. Hover any event in the list for its trigger and payload shape. Hooks saved under names Claude Code no longer recognizes are flagged in a warning banner.' },
          ],
        },
      ],
      tips: [
        'Test new hooks with the "test fire" button next to a command hook — it runs the command against an editable fake event payload (and shows whether your matcher would match) so you can debug without waiting for a real session.',
        'Each hook can set a timeout (ms) and command hooks can emit a terminalSequence (e.g. a bell). Slow synchronous hooks are noticeable — use http or fire-and-forget for work you don\'t need to wait on.',
      ],
    },
  'memory': {
    headline: 'Memories Claude can read and write across sessions — by project or by subagent',
    intro:
      'Two scopes share one tab, toggled by the Workspace / Subagent switch up top (your choice is remembered). Workspace is a cwd-scoped notebook at ~/.claude/projects/<workspace>/memory/ — plain markdown files with an optional description. Subagent is keyed by agent at ~/.claude/session-manager/agent-memory/<agentId>.json — facts about a specific agent (e.g. the "code-reviewer" agent\'s preferred test runner) that survive across projects. You can hand-edit either here; Claude writes to them during sessions when you ask it to remember things across context resets.',
    sections: [
      {
        title: 'Workspace memories',
        items: [
          { term: 'Scope', body: 'Auto-selected from the active terminal tab\'s directory. Switching to a tab in a different folder shows a different memory set. A watcher refreshes the list when Claude writes to these files mid-session.' },
          { term: 'New memory', body: 'Names are lowercase letters/digits/dashes/underscores and become the .md filename. You can add an optional one-line description. Edit the body in the markdown editor, then Save (or Delete).' },
          { term: 'Natural panel', body: 'A chat-style console for the workspace. Type plain commands — list, show <name>, search <text>, remember <text>, forget <name>, help. It never writes on its own: free-form text offers two buttons — "Send to Claude in terminal" (pastes a prompt you still press Enter on) or "Add as new memory" (writes directly).' },
        ],
      },
      {
        title: 'Subagent memories',
        items: [
          { term: 'Agent', body: 'Pick an agent from the dropdown — scanned from ~/.claude/agents and <cwd>/.claude/agents (project agents shadow same-named user ones).' },
          { term: 'Entries', body: 'Each entry has an id, a body, and an optional category: Commands, Preferences, Patterns, Avoid, or Workflow. Newest entries sort first. Add via "+ New entry"; edit the body and Save, or Delete.' },
          { term: 'Caps', body: '1 MiB per entry body. Writes above the cap are refused.' },
        ],
      },
    ],
  },
  'projects': {
    headline: 'Every directory you\'ve ever run Claude Code in, with quick-resume and bulk tools',
    intro:
      'Whenever you start a Claude session in a new directory, Claude Code remembers it by writing transcripts under ~/.claude/projects/<encoded-cwd>/. This tab lists those directories — how many sessions each has, when you last worked there, total transcript size — plus git and CLAUDE.md details it fills in as it reads each folder. Search, filter, pin your favorites, open a folder four different ways, or archive ones you\'re done with.',
    sections: [
      {
        title: 'Columns',
        items: [
          { term: 'Project', body: 'The directory path (with its detected project name). Hover to peek at the start of its CLAUDE.md if it has one.' },
          { term: 'Sessions', body: 'How many session transcripts exist for this folder. High numbers mean you work here often.' },
          { term: 'Last active', body: 'When the most recent transcript was touched. The default sort — most recent first.' },
          { term: 'Size', body: 'Disk usage of all transcripts for this project. Old projects can balloon; archiving is safe if you don\'t need the history.' },
          { term: 'Branch / Remote', body: 'The last git branch and git remote, shown once Session Manager finishes reading the folder.' },
        ],
      },
      {
        title: 'Per-row actions',
        items: [
          { term: 'Open in session', body: 'Spawns a new terminal tab running claude in this directory.' },
          { term: 'Open externally', body: 'Three more openers: your editor (VS Code / Cursor / Sublime / nano — pick a default up top, or Auto), your file manager, or a system terminal.' },
          { term: 'CLAUDE.md', body: 'A side drawer that previews this project\'s CLAUDE.md read-only (no in-drawer editing).' },
          { term: 'Pin / Archive', body: 'Star a project to keep it at the top; archive moves it to ~/.claude/projects-archive/ after a confirm.' },
        ],
      },
      {
        title: 'Finding projects',
        items: [
          { term: 'Search', body: 'Matches path, project name, git remote, and the CLAUDE.md preview.' },
          { term: 'Sort & filter', body: 'Sort by project, sessions, last active, or size (toggle direction). Filter chips narrow by recency (≤7d / ≤30d), git remote, CLAUDE.md presence, or pinned-only.' },
          { term: 'Stats header', body: 'Totals up top: project count, how many were active in 7 days, total sessions, total on-disk size, and clickable pills for your most-active projects.' },
        ],
      },
    ],
    tips: [
      'Tick the checkboxes to select several projects, then archive them all or open them all in your editor at once.',
      'Sort by size to find runaway transcript folders — a multi-hundred-MB project usually means many long sessions, safe to archive if you don\'t need them.',
    ],
  },
  'history': {
    headline: 'Every individual Claude session you\'ve ever run, ready to resume',
    intro:
      'Where the Projects tab shows directories, the History tab shows individual sessions — one row per .jsonl transcript under ~/.claude/projects/. Two views share the tab: Log is a flat, searchable list you can resume from; Dashboard rolls the same transcripts up into prompt, token, and cost charts. Your view choice is remembered.',
    sections: [
      {
        title: 'Log view',
        items: [
          { term: 'Session id', body: 'The UUID identifying the session (shown short). The same id appears in --session-id flags and Claude\'s own logs.' },
          { term: 'Project', body: 'The folder this session belongs to (the encoded directory name, decoded back to a path).' },
          { term: 'Last active / Size', body: 'When the transcript was last touched (sorted newest first) and its size — a big transcript means a long conversation.' },
          { term: 'Resume', body: 'Click Resume, pick the directory to run in, and a new tab opens running claude --resume <sessionId>. Claude reads the full transcript and continues; the tab id matches the session id.' },
          { term: 'Filter', body: 'The search box matches session id and project name (case-insensitive substring); it does not search message text.' },
        ],
      },
      {
        title: 'Dashboard view',
        items: [
          { term: 'Summary', body: 'Cards for total prompts, input tokens, output tokens, sessions, and estimated cost across the selected range.' },
          { term: 'Charts', body: 'A daily trend line (switch between prompts, tokens, sessions, errors, or cost) and a per-day input-vs-output token stack, plus a sortable per-project table with each project\'s top tool and estimated cost.' },
          { term: 'Range & refresh', body: 'Narrow by from/to date and by project name. Auto-refreshes every 30 seconds, with a manual refresh button and an "updated X ago" stamp. A yellow banner warns if a scan timed out and the numbers are partial.' },
        ],
      },
    ],
    tips: [
      'Resume lets you pick any directory — handy when you\'ve moved or renamed the original project folder since the session ran.',
    ],
  },
  'keybindings': {
    headline: 'Rebind the Claude Code CLI like a game controls screen',
    intro:
      'The CLI ships with sensible defaults, but every shortcut can be rebound via ~/.claude/keybindings.json. The Controls view works like a game settings menu: pick a context, click "+ bind" next to an action, press the keys. Presets (Claude defaults / Vim motion / Emacs flow) apply a whole layout in one click. The JSON view edits the same draft directly for chords and command: bindings.',
    sections: [
      {
        title: 'How it maps to the file',
        items: [
          { term: 'Contexts', body: 'Bindings are scoped to where you are in the CLI — Global, Chat, Select pickers, Scroll mode, Confirmation dialogs, etc. Global applies everywhere. The left sidebar shows how many keys you\'ve customized in each.' },
          { term: 'Keycaps', body: 'Each chip is one keystroke pattern ("ctrl+shift+k"). Removing a chip (the ✕) reverts that key to the Claude Code default.' },
          { term: 'Disable a key', body: 'The "+ disable a key" capture binds a key to null, turning its Claude Code default off in that context.' },
          { term: 'command: bindings', body: 'A key can fire a slash command as if typed ("command:commit"). These and any unrecognized bindings show under "Command & other bindings" but are edited in the JSON view.' },
          { term: 'Reserved keys', body: 'ctrl+c, ctrl+d and ctrl+m cannot be rebound; the capture rejects them. Cmd/meta combos are also rejected — Claude Code runs in a terminal.' },
        ],
      },
    ],
    tips: [
      'Presets replace the whole file — Save commits, Revert restores what was on disk. Editing any binding turns a preset into a "custom layout".',
      'Defaults stay in effect for any key you don\'t override; after saving, restart Claude Code so the CLI picks up changes. The "reference ↗" link opens the official docs.',
    ],
  },
  'usage': {
    headline: 'Your subscription\'s rolling-window limits — the same data as /usage',
    intro:
      'This is the in-app mirror of the claude /usage command: how much of your plan you have consumed in each rolling window, pulled live from the billing API (api.anthropic.com/api/oauth/usage) using the OAuth token in ~/.claude/.credentials.json. It refreshes about once a minute. Use it to answer one question — "am I about to hit a limit?" — without dropping to a terminal.',
    sections: [
      {
        title: 'The windows',
        items: [
          { term: 'Session · 5-hour', body: 'The rolling 5-hour block. Every meter shows percent used, a color bar (green → yellow at 70% → red at 90%), and the reset as both a countdown and an absolute Pacific time.' },
          { term: 'Weekly · all models', body: 'The 7-day cap across every model. Resets are multi-day, so they show a weekday (e.g. "Tue 3:00 PM PT").' },
          { term: 'Weekly · Opus / Sonnet / OAuth apps', body: 'Per-model and per-integration weekly sub-limits. They appear only on plans that have them, so the layout stays clean.' },
          { term: 'Extra usage', body: 'Pay-as-you-go credits, shown only when enabled — used vs. monthly limit. Any meter over 100% caps the bar at full and shows an "over limit" badge.' },
        ],
      },
      {
        title: 'Beyond raw /usage',
        items: [
          { term: 'Burn rate', body: 'Extrapolates the 5-hour window: current %, projected % at reset, and an estimated exhaust time if you are trending over 100%. A pill reads On track / Warning / Critical, and a desktop notification fires once per window when projected passes 80% then 95%.' },
          { term: 'Session topology', body: 'A secondary, collapsible view (not part of /usage): live activity across every open tab — workspace, state, turns, tokens/min, cache warmth, and active subagents — plus an alerts strip flagging things like runaway context growth or cold caches.' },
        ],
      },
    ],
    tips: [
      'Percentages can read over 100% — the API reports raw utilization; the meter caps the bar at full but shows the true number in red with an "over limit" badge.',
      'Data is cached; if a fetch is rate-limited or the token expired you will see a stale chip with a Retry button rather than a blank page.',
    ],
  },
  'scheduler': {
      headline: 'Author PRDs and run them as claude -p jobs against your 5-hour window',
      intro:
        'One home for the headless-batch workflow, split into three tabs. The Queue tab runs and monitors jobs; the PRDs tab is where you author the markdown files those jobs execute; the History tab lists recent completed and failed jobs. PRDs live in ~/.claude/session-manager/scheduled-plans/prds/. A status strip across the top shows when the window resets, how many jobs are pending / running / completed today, and how much of the 5-hour window you have used. Jobs auto-pause on rate-limit and auto-resume on the next 5-hour reset.',
      sections: [
        {
          title: 'Queue — when jobs start',
          items: [
            { term: 'when available', body: 'Default. The scheduler polls your billing usage every ~10 minutes and fires the next batch whenever your 5-hour utilization is below the "Pause above" percent (90% by default).' },
            { term: 'only on reset', body: 'Fire queued jobs shortly after each 5-hour window resets, instead of polling.' },
            { term: 'manually', body: 'Nothing fires on its own — you start work yourself with "Fire next batch now".' },
          ],
        },
        {
          title: 'Queue — controls',
          items: [
            { term: 'Up to N at once', body: 'How many jobs in the same group may run in parallel. Defaults to 3 — raising it runs more node processes at once, which can exhaust memory on a small machine.' },
            { term: 'Fire next batch now', body: 'Launches the next batch immediately, bypassing the billing-usage poll. Useful when the usage meter is itself rate-limited or you just want progress now.' },
            { term: 'Resume', body: 'When the queue is paused (rate-limit, expired sign-in, network, or a manual pause), a banner explains why and offers Resume.' },
          ],
        },
        {
          title: 'PRDs — authoring',
          items: [
            { body: 'Each file is one task — frontmatter (title, cwd, estimateMinutes, parallelGroup) plus a self-contained body Claude can act on without conversation context.' },
            { term: 'parallelGroup', body: 'The group number. Jobs in the same group run together (up to the concurrency cap); lower groups run before higher ones. If you omit it, the leading "NN-" number in the filename is used, else 99.' },
            { term: 'estimateMinutes', body: 'Roughly how long you expect the job to take. The scheduler uses this to pick jobs that fit in your remaining 5-hour budget.' },
          ],
        },
      ],
      tips: [
        'Use the /prd skill to create a fresh PRD with the right structure — manually-written ones often miss the cwd or estimate fields.',
        'Read PRD_AUTHORING.md before queueing a new job — it codifies two real stuck-job incidents (the fizzpop poll-hang and the etch-engine post-AC overrun).',
      ],
    },
  'editor':           { headline: 'View and edit files in-app', intro: 'Opens when you click a file in the File Explorer sidebar or a file link in the terminal. Text files open in Monaco (syntax highlighting, font zoom, word wrap, minimap, Dark/Paper theme); Markdown adds Edit / Wysiwyg / Preview / Split, HTML adds Edit / Preview. Images, PDFs, CSV/TSV tables, and JSONL records each get their own viewer; binary or oversized files show a summary instead. URLs still open in your browser.', sections: [{ title: 'Editing', items: [{ term: 'Cmd/Ctrl-S', body: 'Save the active file. With Autosave on (the "Auto" toggle), edits also save automatically ~1.2 s after you stop typing.' }, { term: 'Cmd/Ctrl-Shift-F', body: 'Toggle Focus mode — hides the tabs and header for distraction-free editing. Esc exits.' }, { term: 'Close guard', body: 'Closing a tab with unsaved changes asks before discarding.' }], }, { title: 'Markdown', items: [{ term: 'Wysiwyg', body: 'A rich-text mode built on Tiptap with a floating formatting toolbar (bold, italic, headings, lists, code, blockquote, links) — edit the rendered document directly instead of raw markdown. YAML frontmatter is split off, kept read-only, and rejoined on save; switch to Edit for surgical edits to PRDs and agent files, since Wysiwyg normalizes list markers and heading style.' }, { term: 'Outline', body: 'In Preview or Split mode, a document outline lists headings; click to jump. Toggle it with the Outline button.' }, { term: 'Toolbar', body: 'A formatting toolbar sits above the editor for Markdown files.' }], }], tips: ['Use the view toggle (Edit / Wysiwyg / Preview / Split) for Markdown, or Edit / Preview for HTML. HTML previews are sandboxed — page scripts run with no access to your files or session.', 'Open and Reveal buttons hand the file to your OS default app or file manager.'] },
  'voice': {
      headline: 'Voice & microphone',
      intro: 'Talk to Claude instead of typing. Speech is transcribed on-device with a Whisper model that loads the first time you record (a progress bar shows the download). A press-to-record hotkey starts and stops the mic; what you say is typed into the active terminal, and an auto-submit timer fires it for you a moment after you stop speaking. A one-time mic check confirms your microphone works.',
      sections: [
        {
          title: 'Recording controls',
          items: [
            { term: 'Hotkey', body: 'Press your mic hotkey to record. The default is Ctrl+Shift+Space (Cmd+Option+V on Mac); the panel shows the live binding. Two behaviours: \'Hold to talk\' records only while the key is held (push-to-talk), \'Tap on/off\' starts on one press and stops on the next. The default is hold-to-talk; switch with the radio buttons.' },
            { term: 'Mic button & device', body: 'The mic button toggles recording with the mouse. The device picker chooses which microphone to use, and a live level meter shows that audio is coming through.' },
            { term: 'Run mic check', body: 'Opens a short wizard that confirms your mic is picking up sound. It runs automatically once after a settings-format change, or any time you click \'Run mic check\'.' },
          ],
        },
        {
          title: 'Speaking & hearing back',
          items: [
            { term: 'Live transcript', body: 'While recording, a pulsing red dot and the latest transcribed words appear so you can see what was heard. Errors (e.g. mic blocked) surface inline in red.' },
            { term: 'TTS (read replies aloud)', body: 'The speaker button toggles text-to-speech. When on, Claude\'s replies are read back to you out loud.' },
          ],
        },
      ],
      tips: [
        'The speech model downloads on first use only, then stays cached — later recordings start instantly.',
        'Hold-to-talk is best for quick interjections; Tap on/off is better for longer dictation where you don\'t want to hold a key.',
      ],
    },
  'repoviz': {
      headline: 'Repo visualization',
      intro: 'A quick visual map of the project open in your active terminal. It walks the files, counts lines, and reads git status — all locally — then shows you the language mix, the biggest directories, and how many files are uncommitted. Nothing leaves your machine.',
      sections: [
        {
          title: 'What it shows',
          items: [
            { term: 'Summary stats', body: 'Three cards at the top: total files, total lines of code, and uncommitted files (highlighted amber when above zero). The current git branch is shown next to the folder name.' },
            { term: 'Languages', body: 'A colour-coded bar per language (top 12 by file count), each labelled with its file count and line count. Bar length is relative to the largest language.' },
            { term: 'Top directories', body: 'Treemap-style boxes for the biggest directories, sized by file count so one huge folder doesn\'t crowd out the rest. Hover a box for its exact file and line counts.' },
          ],
        },
      ],
      tips: [
        'Open a terminal tab in a folder first — the visualization analyses whichever project your active tab is in, and re-runs automatically when you switch tabs.',
        'Hit Refresh to re-scan after big changes. Very large repos stop early (5,000-file cap or a 30-second timeout) and are flagged "truncated".',
      ],
    },
  'search': {
      headline: 'Search',
      intro: 'One search surface with two modes, both scoped to the project in your active terminal. Files (⌘P) fuzzy-finds a file by name. Content (⌘⇧F) searches inside files for text. Picking a result inserts its path into the active terminal so you can @-mention it to Claude — it does not open the file.',
      sections: [
        {
          title: 'Files mode (⌘P)',
          items: [
            { term: 'Fuzzy file find', body: 'Type part of a filename to fuzzy-match files in the current project; filename and path-prefix matches rank highest. With the box empty, recently-opened files show first, then the rest alphabetically.' },
            { term: 'Insert', body: '↑/↓ to move, Enter (or click) inserts the file\'s path into the active terminal. The path is relative to the project folder when the file lives inside it.' },
          ],
        },
        {
          title: 'Content mode (⌘⇧F)',
          items: [
            { term: 'Search inside files', body: 'Type to search file contents across the whole project. Uses ripgrep when it is installed and falls back to a built-in file walk otherwise (a "fs walk (rg missing)" note appears in that case). Searching is debounced as you type.' },
            { term: 'Results', body: 'Matches are grouped by file with line numbers; the matched text is highlighted. Enter (or click) inserts that file\'s path and line as path:line into the active terminal.' },
          ],
        },
      ],
      tips: [
        'Toggle Files / Content at the top, or jump straight in with ⌘P (Files) / ⌘⇧F (Content).',
        'In Content mode, the Aa button turns on case-sensitive matching.',
      ],
    },
  'remote': {
      headline: 'Remote Access — disabled by default',
      intro: 'Lets a paired phone or web browser see your sessions and, optionally, send commands to this machine over an encrypted relay. It is off until you turn it on, and even then only a fixed list of command types is accepted — there is no "run any shell command" verb exposed to the relay. Two separate switches keep watching and controlling apart.',
      sections: [
        {
          title: 'Two switches',
          items: [
            { term: 'Allow remote control from the web', body: 'The master switch. While off, the relay refuses every connection and no remote traffic is accepted. Turning it on lets a paired device connect and watch session output.' },
            { term: 'Allow command writes (pty + scheduler)', body: 'A second switch, off by default, that must also be on before a paired device can run terminal commands or queue scheduler jobs. With it off, devices can watch but cannot change anything.' },
          ],
        },
        {
          title: 'Security model',
          items: [
            { term: 'Command allowlist', body: 'Only an enumerated set of command types is accepted (17 today: 2 plain reads, 6 sensitive reads, and 9 write/control commands). Anything unrecognised is rejected with an opaque error so the relay learns nothing.' },
            { term: 'Encrypted session + code check', body: 'Sessions establish an end-to-end key, then show a short verification code you compare with the one in the browser. Until you confirm the codes match, sensitive reads and all command writes stay blocked.' },
            { term: 'Path safety', body: 'Any folder or file path in a remote command passes through the same home-directory boundary check (validatePath) used by the local app — nothing outside your home directory can be reached.' },
            { term: 'Audit log', body: 'Every command is recorded to ~/.claude/session-manager/logs/remote-audit-YYYY-MM-DD.log (file mode 0600, stays on this machine). Token and payload values are never written. You can view the last 100 lines in-app from the Audit log section.' },
          ],
        },
      ],
      tips: [
        'Pair a device by clicking "Pair Device…" and entering the 8-character code shown under "Add Device" in the web app.',
        'Revoke a single device from the Paired Devices list, or hit Panic / "Revoke all" to tear down every session and invalidate all device tokens at once if you suspect compromise.',
      ],
    },
}
