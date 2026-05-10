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
    headline: 'Your home base — at-a-glance status of everything Claude Code knows about',
    intro:
      'The Overview is the first thing you see when you open Session Manager. It summarises your install: how many projects you have, how many past sessions are recorded, your billing usage for the current 5-hour and weekly windows, and quick counts of your skills, subagents, MCP servers, and plugins. Use it as a dashboard — if a number looks off, click into the matching tab to investigate.',
    sections: [
      {
        title: 'What you see',
        items: [
          { term: 'Counts', body: 'Projects, sessions, skills, subagents, MCP servers, and plugins. Each one is a folder under ~/.claude/ that Claude Code reads at startup.' },
          { term: 'Billing usage', body: 'Live read of your subscription quota: a 5-hour rolling bucket (refills every 5h) and a weekly bucket. Filled bar = used; empty bar = remaining. Pulled from the same endpoint Claude Code uses for /usage.' },
          { term: 'Open tabs', body: 'How many terminal sessions you currently have running inside Session Manager.' },
          { term: 'CLAUDE.md / settings.json present', body: 'Quick health checks. If either is missing, the corresponding tab will offer to create one when you first save.' },
        ],
      },
      {
        title: 'Behaviors this affects',
        items: [
          { body: 'Nothing here is editable — Overview only reads. Changing any of these numbers means going to the relevant tab (Projects, Skills, Settings, etc.) and saving there.' },
          { body: 'Billing data refreshes every 60 seconds. If you see "auth needed" the OAuth token in ~/.claude/.credentials.json has expired — log in again with the Claude CLI.' },
        ],
      },
    ],
  },

  'terminal': {
    headline: 'A real Claude Code CLI running inside the app, with extra superpowers',
    intro:
      'The Terminal tab is a normal terminal session that runs the claude CLI for you. It looks identical to running claude in your own shell, but Session Manager keeps the process alive across nav switches, lets you script multi-tab broadcasts, attach background watchers, and restart cleanly. Each tab is one Claude session — its tab id IS the session id, so you can find its transcript on disk.',
    sections: [
      {
        title: 'Top-bar controls',
        items: [
          { term: 'Restart Session', body: 'Kills the current claude process and spawns a fresh one in the same directory. Use this after editing settings, hooks, or skills so Claude reloads them.' },
          { term: 'Restart App', body: 'Kills every session, quits Session Manager, and relaunches. All your tabs come back automatically. Use when something feels stuck.' },
          { term: 'Broadcast', body: 'Send the same prompt to multiple selected tabs at once. Great for "run the test suite" across several worktrees.' },
          { term: 'Watchers', body: 'Attach a long-running shell command (npm test --watch, tail -f log) to this tab. Each line of stdout streams back as a toast and is buffered in a 200-line ring. Survives tab switches, dies when the tab closes.' },
        ],
      },
      {
        title: 'Things that are easy to miss',
        items: [
          { body: 'The cwd shown in the header is the working directory the tab was opened in. Claude inherits that cwd.' },
          { body: 'Closing a tab kills its claude process. Resuming the same session later from the History tab restarts claude with --session-id pointing at the old transcript.' },
          { body: 'Voice input (microphone in the left sidebar) types into whichever tab is focused — no separate "voice tab".' },
        ],
      },
    ],
    tips: [
      'Press Ctrl+C inside the terminal to interrupt Claude mid-response — same as the standalone CLI.',
      'If the prompt looks frozen, scroll up: Claude often produced output but the cursor is below the visible window.',
    ],
  },

  'system-prompt': {
    headline: 'Edit the CLAUDE.md files that shape Claude\'s personality and house rules',
    intro:
      'CLAUDE.md is a plain-text file Claude reads at the start of every session. Whatever you write here is appended to its system prompt — so it\'s where you put coding standards, communication preferences, project context, and "always do X / never do Y" rules. Three files merge together at runtime: User (global, applies everywhere), Project (this repo), and Local (your personal overrides for this repo, gitignored by convention).',
    sections: [
      {
        title: 'Editor / Presets toggle',
        items: [
          { term: 'Editor', body: 'Edit the actual CLAUDE.md file at the selected scope. Saves to disk; Claude picks it up on next session start.' },
          { term: 'Presets', body: 'Browse a library of starter prompts (e.g. "concise responses", "TDD workflow", "prefers Python"). Click one to copy it into your editor, then refine.' },
        ],
      },
      {
        title: 'Scope (User / Project / Local)',
        items: [
          { term: 'User', body: 'Lives at ~/.claude/CLAUDE.md. Applies to every session you start, in every repo. Best for personal style: communication tone, default tooling preferences, things you always want.' },
          { term: 'Project', body: 'Lives at <repo>/CLAUDE.md. Applies only when working in this repo. Best for shared team context: stack, architecture, do/don\'t lists, conventions. Should be committed to git.' },
          { term: 'Local', body: 'Lives at <repo>/CLAUDE.local.md. Applies only when working in this repo, only on your machine. Best for personal overrides that shouldn\'t leak to teammates. Should be gitignored.' },
          { body: 'At runtime all three are concatenated. If they disagree, more-specific wins: Local > Project > User.' },
        ],
      },
      {
        title: 'What\'s shown in the header',
        items: [
          { term: 'chars / tokens', body: 'Rough size estimate (~4 chars per token). The bigger the file, the more of Claude\'s context window is consumed before your real prompt — keep it tight.' },
          { term: 'dirty marker (•) on a scope', body: 'You have unsaved edits at that scope. Switching away does NOT auto-save; click Save in the bottom bar.' },
        ],
      },
    ],
    tips: [
      'New users: start by writing 3-5 bullets at User scope ("be concise", "use Python type hints", "always run tests after changes"). That alone changes Claude\'s behavior noticeably.',
      'Don\'t write essays. Claude reads CLAUDE.md before every reply, so every word costs tokens. One-line rules beat paragraphs.',
    ],
  },

  'settings': {
    headline: 'The settings.json files that control Claude Code\'s behavior',
    intro:
      'Claude Code is configured by JSON files named settings.json. This tab shows three of them merged together: User (global), Project (shared with the repo), and Local (your private overrides). The Effective view shows the merged result Claude actually sees; Tree shows individual values; Raw lets you hand-edit JSON. Schemas come from schemastore.org, so you get autocomplete and validation as you type.',
    sections: [
      {
        title: 'Views',
        items: [
          { term: 'Effective', body: 'The final merged config Claude reads. Each value shows which scope provided it. Click a row to override it at the current scope.' },
          { term: 'Tree', body: 'Same data, expandable as a JSON tree. Useful when settings have nested objects (e.g. permissions, hooks).' },
          { term: 'Raw', body: 'The JSON file at the active scope, edited directly. Save validates against the schema before writing.' },
          { term: 'Telemetry', body: 'Privacy / data-collection toggles for the CLI itself.' },
        ],
      },
      {
        title: 'Common settings to know',
        items: [
          { term: 'model', body: 'Default model used when you start a session ("opus", "sonnet", "haiku"). Override per-session with /model in the terminal.' },
          { term: 'permissions', body: 'Allow/deny lists for Bash commands, file edits, MCP tools, web fetches. See the dedicated Permissions tab — it\'s a friendlier UI for the same key.' },
          { term: 'hooks', body: 'Shell commands the CLI runs in response to events (pre/post tool use, session start, etc.). See the Hooks tab.' },
          { term: 'env', body: 'Environment variables injected into every claude process — handy for API keys or DEBUG flags.' },
          { term: 'mcpServers', body: 'External tool servers Claude can call. Edit via the MCP Servers tab for a structured form.' },
        ],
      },
      {
        title: 'Scope precedence',
        items: [
          { body: 'Local overrides Project overrides User. So a Project-scoped setting beats a User-scoped one when you\'re working in that repo, and your personal Local file beats both.' },
          { body: 'Lists merge (allow + allow), but objects do not — a Project-scoped { permissions: { allow: [...] } } REPLACES the user-scoped object wholesale unless you copy the entries you want to keep.' },
        ],
      },
    ],
    tips: [
      'When in doubt, edit at User scope. Project-scoped settings get committed to git; teammates inherit them.',
      'After changing settings.json, restart any open sessions (Restart Session button on the terminal tab) so Claude reloads.',
    ],
  },

  'permissions': {
    headline: 'Decide which tools Claude can run automatically and which need your OK',
    intro:
      'Every action Claude takes — running a Bash command, editing a file, calling an MCP tool — passes through a permission check. This tab is a structured editor for the permissions block in settings.json. You build three lists (Allow / Ask / Deny) of glob-style rules; Claude consults them in order. Get this right and you barely see permission prompts; get it wrong and either you\'re hammered with confirmations or Claude runs something you didn\'t want.',
    sections: [
      {
        title: 'The three lists',
        items: [
          { term: 'Allow', body: 'Claude runs matching actions silently — no confirmation prompt. Use for safe, repetitive things: "Bash(npm test:*)", "Read(*)", "Edit(src/**)".' },
          { term: 'Ask', body: 'Claude pauses and asks you before running. The default for anything not explicitly allowed (depending on defaultMode).' },
          { term: 'Deny', body: 'Claude refuses outright, even if you\'d say yes interactively. Use for genuinely dangerous things: "Bash(rm -rf:*)", "Edit(.env)".' },
        ],
      },
      {
        title: 'Rule shape',
        items: [
          { term: 'Tool(pattern)', body: 'Format is "<ToolName>(<glob>)". Examples: Bash(git push:*), Edit(src/**/*.ts), WebFetch(domain:*.example.com).' },
          { term: ':*', body: 'Trailing colon-star means "any arguments". Bash(npm:*) allows every npm subcommand; Bash(npm test) only allows the literal "npm test".' },
          { body: 'Deny wins ties. If a request matches both Allow and Deny, Deny takes effect.' },
        ],
      },
      {
        title: 'defaultMode',
        items: [
          { term: 'default', body: 'Out-of-the-box behavior: ask for risky operations, allow harmless reads.' },
          { term: 'acceptEdits', body: 'Auto-approve file edits within the session\'s working tree. Speeds up iterative coding; disable for prod repos.' },
          { term: 'plan', body: 'Read-only mode. Claude can explore and propose, but cannot edit or run shell commands. Good for code review sessions.' },
          { term: 'bypassPermissions', body: 'Skip ALL prompts. Equivalent to --dangerously-skip-permissions. Use only in throwaway sandboxes.' },
        ],
      },
    ],
    tips: [
      'Start permissive at User scope (your common safe commands), then tighten at Project scope for repos with secrets.',
      'additionalDirectories lets Claude read files outside the cwd. Add reference repos here without cd\'ing into each one.',
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
          { term: 'Left column', body: 'Every skill installed at the current scope (User: ~/.claude/skills/, Project: <repo>/.claude/skills/). Click one to open its markdown.' },
          { term: 'Editor', body: 'Standard markdown. The frontmatter (the --- block at the top) controls discovery; the body is what Claude reads when the skill fires.' },
          { term: 'Library tab', body: 'Browse a curated collection of community skills. Click Install to copy one into your local skills folder.' },
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
          { body: 'Commands (in ~/.claude/commands/ or .claude/commands/) are skills you invoke explicitly with /name. Skills proper are auto-loaded; commands are user-triggered.' },
          { body: 'This tab edits both — same shape on disk, different folders.' },
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
      'A plugin is a directory under ~/.claude/plugins/<name>/ that packages multiple Claude Code primitives (skills, subagents, hooks, MCP servers) under one name. Installing a plugin adds all of them at once; uninstalling removes them cleanly. Use plugins when you want to share a coherent toolkit — "react-frontend-pack", "data-pipeline-helpers" — instead of asking teammates to copy ten files into the right places.',
    sections: [
      {
        title: 'What this tab shows',
        items: [
          { body: 'Every plugin folder Claude Code can discover, plus whether it has a plugin.json manifest (most should).' },
          { term: 'Installed view', body: 'Read-only inspector for plugins already on disk. Click one to see its contents — if you need to edit, use the dedicated Skills/Subagents/Hooks tabs which point at the same files.' },
          { term: 'Library view', body: 'Browse and install community plugins.' },
        ],
      },
      {
        title: 'Plugin layout on disk',
        items: [
          { term: 'plugin.json', body: 'The manifest — name, version, description, what the plugin includes. Required for the plugin to register cleanly.' },
          { term: 'skills/', body: 'Same shape as ~/.claude/skills/. Show up in the Skills tab.' },
          { term: 'agents/', body: 'Same shape as ~/.claude/agents/. Show up in the Subagents tab.' },
          { term: 'hooks.json', body: 'Hooks contributed by the plugin, merged into your effective hook set.' },
        ],
      },
    ],
    tips: [
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
        ],
      },
      {
        title: 'Server types',
        items: [
          { term: 'stdio', body: 'Local process — Claude spawns the command and talks to it via stdin/stdout. Most common for tools you ship as a CLI. Fields: command, args, env.' },
          { term: 'http', body: 'Remote HTTP endpoint with JSON-RPC. Field: url. Use headers for auth.' },
          { term: 'sse', body: 'Server-Sent Events — like http but with streaming responses. Same fields.' },
        ],
      },
      {
        title: 'Per-server controls',
        items: [
          { term: 'env / headers', body: 'Secrets like API keys go here. Project-scope env values get committed to git — be careful, prefer User scope for anything sensitive.' },
          { term: 'args', body: 'Command-line arguments passed to a stdio server\'s command. Often used to point at a specific config file or directory.' },
        ],
      },
    ],
    tips: [
      'After adding/editing a server, restart the affected sessions so Claude reconnects and rediscovers tools.',
      'If a server fails to start, the terminal will show "MCP server X failed" — open the server\'s logs (often in ~/.claude/logs/) for details.',
    ],
  },

  'hooks': {
    headline: 'Run scripts when Claude does something — pre/post-tool, session start/end, more',
    intro:
      'Hooks let you run a shell command, HTTP request, prompt, or subagent in response to events Claude Code emits. Want to log every Bash command Claude runs to a file? PreToolUse hook. Want a subagent to review every edit before it sticks? PostToolUse hook. Want a Slack ping when a long session ends? Stop hook. Hooks compose with permissions and can block actions outright.',
    sections: [
      {
        title: 'The four hook types',
        items: [
          { term: 'command', body: 'Run a shell string. The script receives the event as JSON on stdin and can return a JSON decision (allow/block/transform).' },
          { term: 'http', body: 'POST the event JSON to a URL. The response body becomes the decision.' },
          { term: 'prompt', body: 'Send a templated prompt to Claude itself for a quick gut-check. Useful for "should I really run this command?" guards.' },
          { term: 'agent', body: 'Spawn a subagent (defined in the Subagents tab) with the event as input. The agent\'s output is the decision.' },
        ],
      },
      {
        title: 'Common events',
        items: [
          { term: 'PreToolUse / PostToolUse', body: 'Before / after Claude calls any tool. Most-used hooks live here — gating, logging, transforming.' },
          { term: 'UserPromptSubmit', body: 'Fires when you press Enter on a prompt. Good for prepending context (current branch, recent errors) before Claude sees the prompt.' },
          { term: 'SessionStart / SessionEnd', body: 'Boot/teardown housekeeping — refresh tokens, save transcripts, post a summary.' },
          { term: 'Stop / SubagentStop', body: 'When the main loop or a subagent finishes. Good for "ping me when done" notifications.' },
          { term: 'PreCompact / PostCompact', body: 'Around the auto-compaction step. Useful for archiving the full transcript before it\'s shrunk.' },
        ],
      },
      {
        title: 'Decisions',
        items: [
          { term: 'allow', body: 'Action proceeds normally.' },
          { term: 'block', body: 'Action is refused. Claude sees the refusal and either tries another approach or asks you.' },
          { term: 'modify', body: 'Hook returns a transformed event (e.g. rewritten Bash command, sanitised prompt). Claude proceeds with the modified version.' },
        ],
      },
    ],
    tips: [
      'Test new hooks with the Test Fire button in the editor — runs your hook script with synthetic event data so you can debug without waiting for a real session.',
      'Hooks run synchronously and block Claude until they return. Slow hooks (>1s) are noticeable. Use http or fire-and-forget shell commands for things you don\'t need to wait on.',
    ],
  },

  'subagents': {
    headline: 'Specialised mini-Claudes that handle focused tasks for the main session',
    intro:
      'A subagent is a separate Claude instance with its own system prompt, model, and tool restrictions. When the main Claude needs to delegate something focused — code review, security audit, large search — it spawns a subagent, which works in isolation and returns a single summary. Subagents protect the main context window from drowning in intermediate output and let you specialise prompts per task type.',
    sections: [
      {
        title: 'Three views',
        items: [
          { term: 'Configured', body: 'Edit the subagents you have defined. Each one is a markdown file in ~/.claude/agents/ (User) or .claude/agents/ (Project), same as skills.' },
          { term: 'Live', body: 'Subagents that have spawned in any of your active terminal tabs in the last 60 seconds. Shows status and the prompt they were given.' },
          { term: 'Library', body: 'Browse community subagent definitions and install them.' },
        ],
      },
      {
        title: 'Subagent anatomy',
        items: [
          { term: 'name', body: 'Referenced by the main Claude when delegating ("Task tool, subagent_type: code-reviewer"). Should be a stable identifier.' },
          { term: 'description', body: 'When to use this subagent. Main Claude reads descriptions to choose. Be specific about scope.' },
          { term: 'tools', body: 'Optional whitelist. If set, the subagent can ONLY use these tools. Tightening this is the easiest way to make a subagent safer.' },
          { term: 'model', body: 'Optional. Use a cheaper model (haiku) for simple agents to save cost; opus for complex reasoning.' },
          { term: 'Body', body: 'The system prompt the subagent runs with. Be explicit about what it should and shouldn\'t do.' },
        ],
      },
    ],
    tips: [
      'A subagent that returns 5000 words of debug logs has failed at its job — the whole point is to compress. Tell it to summarise.',
      'The "explorer" pattern (read-only subagent for codebase search) is a common starting point if you\'re building your first one.',
    ],
  },

  'plans': {
    headline: 'Two views: scheduler PRDs (queued for later) and live session plans',
    intro:
      'Claude does two kinds of planning: short-term (the to-do list inside one session) and long-term (work scheduled across many sessions). This tab handles both. Scheduler PRDs are markdown files you queue up; the scheduler runs them as headless claude -p jobs when budget is available. Session Plans are the in-flight planning state Claude maintains during a single conversation.',
    sections: [
      {
        title: 'Scheduler PRDs',
        items: [
          { body: 'Live in ~/.claude/session-manager/scheduled-plans/prds/. Each file is one task — frontmatter (title, cwd, estimateMinutes) plus a self-contained body Claude can act on without conversation context.' },
          { term: 'Filename prefix (NN-)', body: 'A two-digit group number. PRDs in the same group run in parallel; different groups run sequentially. Pick a higher number to run later.' },
          { term: 'estimateMinutes', body: 'Roughly how long you expect the job to take. The scheduler uses this to pick jobs that fit in your remaining 5-hour budget.' },
        ],
      },
      {
        title: 'Session Plans',
        items: [
          { body: 'Read-only view of the plan Claude maintains during the active session — its current goal, sub-tasks, and progress notes.' },
          { body: 'Updated whenever Claude calls TaskCreate / TaskUpdate or its plan tool. Useful for "where is it stuck?" debugging.' },
        ],
      },
    ],
    tips: [
      'Use the /prd skill to create a fresh PRD with the right structure — manually-written ones often miss the cwd or estimate fields.',
      'The scheduler\'s default mode (when-available) only runs jobs while budget remains in the current 5h window. Switch to manual or on-reset for tighter control.',
    ],
  },

  'tasks': {
    headline: 'Live view of Claude\'s in-session to-do list',
    intro:
      'When Claude tackles a complex request, it usually breaks it into tasks via TodoWrite, marking them pending → in_progress → completed as it works. This tab shows that list in real time for the active session, so you can see what Claude has decided to do, what it\'s currently on, and what it has finished — without scrolling the terminal.',
    sections: [
      {
        title: 'How to read it',
        items: [
          { term: 'pending', body: 'Claude has identified the task but hasn\'t started yet. Order matters — usually executed top to bottom.' },
          { term: 'in_progress', body: 'Currently being worked on. Should normally be exactly one at a time; multiple usually means something stalled.' },
          { term: 'completed', body: 'Finished. Claude marks tasks done as it goes; if a task stays in_progress for a long time, Claude is likely stuck.' },
        ],
      },
      {
        title: 'Behaviors',
        items: [
          { body: 'Read-only — you can\'t edit Claude\'s tasks from here. To change direction, message Claude in the terminal ("skip task 3", "add a step for X").' },
          { body: 'Updates stream from the same transcript file Claude writes to (~/.claude/projects/<encoded-cwd>/<sessionUuid>.jsonl).' },
        ],
      },
    ],
    tips: [
      'A task list with one giant "fix everything" item suggests Claude didn\'t actually plan — interrupt and ask it to break the work down.',
    ],
  },

  'projects': {
    headline: 'Every directory you\'ve ever run Claude Code in, with quick-resume',
    intro:
      'Whenever you start a Claude session in a new cwd, Claude Code remembers that directory by writing transcripts under ~/.claude/projects/<encoded-cwd>/. This tab lists those directories: how many sessions each has, when you last worked there, total transcript size, and a one-click button to open a fresh tab in that cwd. It\'s your project picker.',
    sections: [
      {
        title: 'Columns',
        items: [
          { term: 'displayPath', body: 'The actual directory path. May be missing if you\'ve since moved or deleted the folder — Session Manager flags this.' },
          { term: 'sessionCount', body: 'How many session transcripts exist for this project. High numbers mean you work here often.' },
          { term: 'lastSession', body: 'Modification time of the most recent transcript. Sorted by default — most recent first.' },
          { term: 'sizeBytes', body: 'Disk usage of all transcripts for this project. Old projects can balloon; safe to delete the folder if you don\'t need the history.' },
        ],
      },
      {
        title: 'Per-row actions',
        items: [
          { term: 'Open tab', body: 'Spawns a new terminal tab with claude in this cwd.' },
          { term: 'CLAUDE.md drawer', body: 'Quick peek at this project\'s CLAUDE.md without opening the tab. Edit-in-place via the drawer.' },
        ],
      },
    ],
    tips: [
      'Sort by sizeBytes to find runaway transcript folders. A 500MB project usually means many long sessions — safe to archive if you don\'t need them.',
    ],
  },

  'history': {
    headline: 'Every individual Claude session you\'ve ever run, ready to resume',
    intro:
      'Where the Projects tab shows directories, the History tab shows individual sessions — one row per .jsonl transcript file under ~/.claude/projects/. You can search across them, open one to see the conversation, or resume any past session in a new tab (Claude picks up exactly where it left off, with full context).',
    sections: [
      {
        title: 'What\'s in each row',
        items: [
          { term: 'sessionId', body: 'UUID identifying the session. Same id appears in --session-id flags and Claude\'s own logs.' },
          { term: 'projectEncoded', body: 'The project folder this session belongs to (paths get encoded to safe directory names).' },
          { term: 'mtimeMs', body: 'When the session was last active. Sorted newest first.' },
          { term: 'sizeBytes', body: 'Transcript size. Big = long conversation.' },
        ],
      },
      {
        title: 'Resuming a session',
        items: [
          { body: 'Click a row → opens a new tab in the original cwd, runs claude --resume <sessionId>. Claude reads the full transcript and continues. The tab id matches the session id.' },
          { body: 'If the original cwd is gone (you moved/deleted it), resume fails. Use the Projects tab to spot orphaned histories.' },
        ],
      },
    ],
    tips: [
      'The filter box matches session id substrings, project name, and the first user message in the transcript — useful for "find that session where I asked about X".',
    ],
  },

  'keybindings': {
    headline: 'Customise the keyboard shortcuts the Claude Code CLI responds to',
    intro:
      'The CLI ships with sensible defaults (Ctrl+C interrupts, Esc cancels input, etc.) but you can override or add chord bindings via ~/.claude/keybindings.json. This tab is a JSON editor for that file with autocomplete from the schemastore schema. Bindings apply to every claude session — including the ones running inside Session Manager terminal tabs.',
    sections: [
      {
        title: 'File shape',
        items: [
          { term: '$schema', body: 'Optional but recommended — points at the schemastore JSON schema so Monaco can autocomplete and validate as you type.' },
          { term: 'bindings', body: 'Array of { keys, command, when? } objects. Each entry maps a key combo to a command Claude knows about.' },
          { term: 'keys', body: 'Standard accelerator syntax: "Ctrl+S", "Cmd+Shift+P", multi-step chords ("Ctrl+K Ctrl+S").' },
          { term: 'command', body: 'Built-in command name (submit, cancel, history-up, toggle-plan-mode, etc.). Unknown commands are ignored at runtime.' },
          { term: 'when (optional)', body: 'Context predicate: only fires when the predicate is true ("inputFocused", "planMode", etc.).' },
        ],
      },
    ],
    tips: [
      'Defaults stay in effect for any binding you don\'t override — you don\'t need to redeclare them.',
      'After saving, restart any open sessions so the CLI picks up the new bindings.',
    ],
  },

  'usage': {
    headline: 'Token-by-token cost breakdown of the active session',
    intro:
      'This tab takes the transcript of the currently-focused session, sums up input/output tokens by model, and converts to a USD estimate using prices you can edit. It also shows your subscription billing status (5h and weekly buckets). Use it to spot expensive sessions, decide whether to switch to a cheaper model, or just satisfy curiosity about how much that big refactor cost.',
    sections: [
      {
        title: 'Two cost views',
        items: [
          { term: 'Subscription billing', body: 'How much of your Claude Code plan you\'ve used in the rolling 5-hour window and the weekly window. Pulled live from the same API /usage shows.' },
          { term: 'Per-session estimate', body: 'Tokens × your editable prices. Useful for API-based billing or for understanding which kind of request is expensive.' },
        ],
      },
      {
        title: 'Editable prices',
        items: [
          { body: 'Defaults reflect Apr 2026 pricing (Opus $5/$25, Sonnet $3/$15, Haiku $1/$5 per million tokens, input/output respectively). Pricing drifts — update here when it does.' },
          { body: 'Saved to localStorage, applied to all sessions. Not synced to Claude itself — purely for this dashboard.' },
        ],
      },
    ],
    tips: [
      'Output tokens cost roughly 5× input. If a session is expensive, look at how much Claude is generating — long markdown reports, redundant summaries, large tool outputs.',
    ],
  },

  'agent-view': {
    headline: 'A whimsical workshop visualisation of what Claude is doing right now',
    intro:
      'Agent-View is a fun, low-information-density alternative to the terminal — a little robot at a workbench, reading from a todo board, walking off to spawn subagents. State is derived live from the active session\'s transcript: idle vs working, current verb, todo progress. It\'s not meant to replace the terminal; it\'s a calmer place to glance at while a long task runs.',
    sections: [
      {
        title: 'What you see',
        items: [
          { term: 'Robot', body: 'Working when transcript events are recent (<3s); idle when quiet for longer; offline when no claude process is attached. Idle robots occasionally wander or doze off.' },
          { term: 'Workbench', body: 'Current tool calls — a quick visual flicker for each Bash / Edit / Read.' },
          { term: 'TodoBoard', body: 'Same data as the Tasks tab but rendered as a chalkboard.' },
          { term: 'SubagentDock', body: 'Recently-spawned subagents as little helpers next to the robot.' },
          { term: 'PlanWhiteboard', body: 'Current plan if Claude is in plan mode.' },
        ],
      },
    ],
    tips: [
      'Pin this to a second monitor during long sessions — gives you "is it stuck?" awareness without scrolling logs.',
      'No interaction here, just observation. To act, switch back to Terminal.',
    ],
  },
}
