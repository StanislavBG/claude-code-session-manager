import type { NavKey } from '../lib/navKey'

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
  'project-home': {
    headline: 'The Brief — what this project is, and what is in flight',
    intro:
      'Home for a project tab is a synthesized brief: what the project is for, how it is structured, and what is currently in flight across its Epics. Content is scaffolded for now — the synthesis pipeline lands in a later update.',
    sections: [
      {
        title: 'What you see',
        items: [
          { body: 'A header naming the active project, resolved from the active tab\'s working directory.' },
        ],
      },
    ],
  },
  'overview': {
      headline: 'Your home base — a calm landing page for your local Claude Code cockpit',
      intro:
        'Overview is the first screen you see. It greets you by time of day and frames Session Manager as a local cockpit that wraps the Claude CLI alongside skills, hooks, MCP servers, and a scheduler. Nothing here phones home. The page is a launchpad, not a settings screen: a live 5-hour usage card, a few quick-start buttons, your most-recent sessions, and a peek at what is queued in the scheduler. Click any of them to jump straight into the relevant tab.',
      sections: [
        {
          title: 'What you see',
          items: [
            { term: 'Billing meters', body: 'A live read of your subscription usage — plan chip, the current 5-hour rolling window, and the weekly windows — each with percent used, a color bar, and the reset time. Same data the CLI /usage command reads.' },
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
  'system-prompt': {
      headline: 'Edit ~/.claude/CLAUDE.md — the house rules every session on this machine starts with',
      intro:
        'CLAUDE.md is a plain-text file Claude reads at the start of every session. Whatever you write here is added to its instructions — so it\'s where you put coding standards, communication preferences, and “always do X / never do Y” rules. This tab edits exactly ONE of them: the User file at ~/.claude/CLAUDE.md, which applies everywhere, in every project. A project can also carry its own <repo>/CLAUDE.md and <repo>/CLAUDE.local.md — those are contextual to that project and are read by the CLI from the session\'s own directory when it launches there, so they are edited with the project\'s files, not from this machine-wide screen.',
      sections: [
        {
          title: 'Editor / Presets toggle',
          items: [
            { term: 'Editor', body: 'Edit the real ~/.claude/CLAUDE.md. Save writes it to disk; Claude picks it up on its next session start.' },
            { term: 'Presets', body: 'Browse a library of starter prompts. Use one as a starting point, then refine it in the editor.' },
          ],
        },
        {
          title: 'What this file reaches — and what it doesn\'t',
          items: [
            { term: 'User (edited here)', body: 'Lives at ~/.claude/CLAUDE.md. Applies to every session you start, in every repo. Best for personal style: communication tone, default tooling preferences, things you always want.' },
            { term: 'Project (not edited here)', body: 'Lives at <repo>/CLAUDE.md, checked into git — shared team context: stack, architecture, do/don\'t lists. It only means anything relative to a project directory, so it is picked up when a session launches in that repo; open it from the project\'s own files.' },
            { term: 'Local (not edited here)', body: 'Lives at <repo>/CLAUDE.local.md, gitignored — personal overrides that shouldn\'t reach teammates. Same story as Project: contextual to one repo, applied at session launch.' },
            { body: 'At runtime every file that is present combines; more-specific wins: Local > Project > User. This screen only owns the base layer.' },
          ],
        },
        {
          title: 'What\'s shown in the header',
          items: [
            { term: 'chars / tokens', body: 'A rough size estimate (~4 chars per token). The bigger the file, the more of Claude\'s context window it consumes before your real prompt — keep it tight.' },
            { term: 'unsaved edits', body: 'Save and Revert live in the bottom bar; navigating away does NOT auto-save.' },
            { body: 'If the file doesn\'t exist yet, the bottom bar notes it will be created on save.' },
          ],
        },
      ],
      tips: [
        'New users: start with 3–5 bullets here (“be concise”, “use Python type hints”, “always run tests after changes”). That alone changes Claude\'s behavior noticeably.',
        'Don\'t write essays. Claude reads CLAUDE.md before every reply, so every word costs tokens. One-line rules beat paragraphs.',
        'Rule of thumb for what belongs here: if it would still be true in a repo you haven\'t created yet, it is a User rule. If it names this stack, this architecture, or this team, it belongs in that project\'s own CLAUDE.md.',
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
            { term: 'permissions', body: 'Allow / Ask / Deny lists for Bash commands, file edits, MCP tools, web fetches. The Permissions tab of this page is a friendlier UI for this same key.' },
            { term: 'hooks', body: 'Shell commands the CLI runs in response to events (pre/post tool use, session start, etc.). See the Hooks tab of this page.' },
            { term: 'env', body: 'Environment variables injected into every claude process — handy for API keys or DEBUG flags.' },
            { term: 'mcpServers', body: 'External tool servers Claude can call. Edit via Extensions › MCP Servers for a structured form.' },
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
  'memory': {
    headline: 'A window onto Claude Code\'s own memory files for this project and its subagents',
    intro:
      'Claude Code can keep notes between conversations. These are plain markdown files, stored on your machine. For a project they live in ~/.claude/projects/<project>/memory/. MEMORY.md is the index. Topic files hold the details. At the start of each session Claude loads only the first 200 lines or 25KB of MEMORY.md, whichever comes first, so keep the index short. This tab shows those files and lets you read, edit and delete them. Nothing leaves your machine.',
    sections: [
      {
        title: 'What memory is',
        items: [
          { term: 'Index + topics', body: 'MEMORY.md is a short list of one-line pointers. Each pointer names a topic file that holds the full note. Claude reads the index every session and opens a topic file when it needs it.' },
          { term: 'Load limit', body: 'Only the first 200 lines / 25KB of MEMORY.md are loaded per session. Lines past that are never seen, so a long index quietly loses its tail.' },
          { term: 'Who writes', body: 'Claude writes memories when you ask it to remember something, or when it decides a fact is worth keeping. You can also edit the files here by hand.' },
        ],
      },
      {
        title: 'Workspace memories',
        items: [
          { term: 'Where', body: 'The project\'s auto memory, at ~/.claude/projects/<project>/memory/. It is picked from the active tab\'s folder, so a different folder shows a different set.' },
          { term: 'Worktrees', body: 'All git worktrees of the same repository share one workspace memory. A note saved in one worktree is visible in the others.' },
          { term: 'Editing', body: 'Open a file to read or edit it, add a new one, or delete one. The list refreshes when Claude writes to these files mid-session.' },
        ],
      },
      {
        title: 'Subagent memories',
        items: [
          { term: 'Opt-in', body: 'A subagent keeps memory only if its definition has `memory: user`, `memory: project` or `memory: local` in its frontmatter. Without that line it has none.' },
          { term: 'Where', body: 'user: ~/.claude/agent-memory/<agent>/. project: <project>/.claude/agent-memory/<agent>/ (can be committed and shared). local: <project>/.claude/agent-memory-local/<agent>/ (kept out of version control).' },
          { term: 'Agent picker', body: 'Pick an agent to see its memory directory. Its files look the same as workspace memory: a MEMORY.md index plus topic files.' },
        ],
      },
      {
        title: 'What this tab adds',
        items: [
          { term: 'Stale badge', body: 'Marks a memory that has not been touched for a long time, so you can check whether it is still true.' },
          { term: 'Not in index', body: 'Marks a topic file that MEMORY.md does not point to. Claude will not find it on its own until you add a line to the index.' },
          { term: 'Index budget', body: 'A strip showing how many lines and KB of MEMORY.md you have used against the 200-line / 25KB limit. It warns when you are close or over.' },
          { term: 'Clusters', body: 'Groups related memories so you can spot duplicates and merge them. It asks a model to do the grouping, so it costs tokens and only runs when you press the button.' },
          { term: 'Natural console', body: 'A chat-style box for the workspace. Type list, show <name>, search <text>, remember <text>, forget <name> or help. Free-form text never writes by itself: you choose to send it to Claude in the terminal or add it as a new memory.' },
        ],
      },
    ],
    tips: [
      'Auto memory off means nothing here is read. Turn it back on if the files seem to have no effect.',
      'Keep MEMORY.md lines short and move detail into topic files so the index stays under the limit.',
      'Check the "not in index" count after Claude has been writing for a while.',
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
  'scheduler': {
      headline: 'Author PRDs and run them as claude -p jobs against your 5-hour window',
      intro:
        'One home for the headless-batch workflow, split into three tabs. The Queue tab combines global Options (session pool, fire policy, on-disk paths) with monitoring this project\'s jobs; the PRDs tab is where you author the markdown files those jobs execute; the History tab lists recent completed and failed jobs. PRDs live in each active project\'s own <cwd>/session-manager-operations/scheduler/prds/. A status strip across the top shows when the window resets, how many jobs are pending / running / completed today, and how much of the 5-hour window you have used. Jobs auto-pause on rate-limit and auto-resume on the next 5-hour reset.',
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
        {
          // Folded in from the retired standalone 'sm-config' key — now
          // part of the combined Options + Queue view on the Queue tab.
          title: 'Options — the session pool (global, not per-project)',
          items: [
            { term: 'One pool, every consumer', body: 'Session-Manager owns a machine-wide pool of concurrent Claude sessions (3 by default). Scheduler jobs and Epic chat runs each request a slot before launching and release it when they finish — no subsystem has a private cap that can stack with another\'s.' },
            { term: 'Guardrails', body: 'Beyond the slot cap, a memory gate defers new jobs when free RAM drops below a per-job budget, and each job gets an OOM-score bias so the kernel prefers killing a restartable job over the app itself.' },
          ],
        },
      ],
      tips: [
        'Use the /prd skill to create a fresh PRD with the right structure — manually-written ones often miss the cwd or estimate fields.',
        'Read PRD_AUTHORING.md before queueing a new job — it codifies two real stuck-job incidents (the fizzpop poll-hang and the etch-engine post-AC overrun).',
        'SM_SESSION_SLOTS (0–32, default 5) overrides the pool size for one launch; chat runs and scheduler jobs share the same pool.',
      ],
    },
  'editor':           { headline: 'View and edit files in-app', intro: 'Opens when you click a file in the File Explorer sidebar or a file link in the terminal. Text files open in Monaco (syntax highlighting, font zoom, word wrap, minimap, Dark/Paper theme); Markdown adds Edit / Wysiwyg / Preview / Split, HTML adds Edit / Preview. Images, PDFs, CSV/TSV tables, and JSONL records each get their own viewer; binary or oversized files show a summary instead. URLs still open in your browser.', sections: [{ title: 'Editing', items: [{ term: 'Cmd/Ctrl-S', body: 'Save the active file. With Autosave on (the "Auto" toggle), edits also save automatically ~1.2 s after you stop typing.' }, { term: 'Cmd/Ctrl-Shift-F', body: 'Toggle Focus mode — hides the tabs and header for distraction-free editing. Esc exits.' }, { term: 'Close guard', body: 'Closing a tab with unsaved changes asks before discarding.' }], }, { title: 'Markdown', items: [{ term: 'Wysiwyg', body: 'A rich-text mode built on Tiptap with a floating formatting toolbar (bold, italic, headings, lists, code, blockquote, links) — edit the rendered document directly instead of raw markdown. YAML frontmatter is split off, kept read-only, and rejoined on save; switch to Edit for surgical edits to PRDs and agent files, since Wysiwyg normalizes list markers and heading style.' }, { term: 'Outline', body: 'In Preview or Split mode, a document outline lists headings; click to jump. Toggle it with the Outline button.' }, { term: 'Toolbar', body: 'A formatting toolbar sits above the editor for Markdown files.' }], }], tips: ['Use the view toggle (Edit / Wysiwyg / Preview / Split) for Markdown, or Edit / Preview for HTML. HTML previews are sandboxed — page scripts run with no access to your files or session.', 'Open and Reveal buttons hand the file to your OS default app or file manager.'] },
  'agent-library': {
      headline: 'Agent Library — every persona available to this machine',
      intro: 'Global agent definitions live at ~/.claude/agents/*.md. A project can overlay a same-named agent at <project>/.claude/agents/<name>.md, which Claude Code prefers over the global definition whenever both exist. New / Duplicate / Save / Delete here write the matching global .md file directly.',
      sections: [
        {
          title: 'What it shows',
          items: [
            { term: 'Global personas', body: 'Every agent .md file under ~/.claude/agents, with its frontmatter (name, description, model, color, tools) and body.' },
            { term: 'Overriding projects', body: 'For each agent, which of your currently-open project tabs has a local overlay of the same name — that overlay is what actually runs in that project. Dropping one here deletes that project\'s local .md file.' },
          ],
        },
      ],
      tips: [
        'Home face only — this is machine-wide data, not scoped to one project.',
        'Only the global definition is editable here — a project overlay is created by Claude Code convention (a same-named file under <project>/.claude/agents/), not from this page.',
      ],
    },
  'extensions': {
    headline: 'Extensions — skills, MCP servers and plugins in one place',
    intro:
      'Three tabs, one page. Each tab edits the real file Claude Code reads (shown as a chip at the top): ~/.claude/skills for skills, ~/.claude.json mcpServers for MCP servers, installed_plugins.json plus settings.json enabledPlugins for plugins. The Add button opens that tab\'s catalog.',
    sections: [
      {
        title: 'Tabs',
        items: [
          { term: 'Skills', body: 'Markdown files Claude loads on demand, at User or Project scope. Each skill has frontmatter saying when to trigger it.' },
          { term: 'MCP Servers', body: 'External tools Claude can call. User scope lives in ~/.claude.json; project scope in <repo>/.mcp.json.' },
          { term: 'Plugins', body: 'Bundles of skills, subagents, hooks and MCP servers installed together and enabled per scope.' },
        ],
      },
    ],
    tips: ['Home face only — User-scope config is machine-wide.'],
  },
  'app-settings': {
    headline: 'App Settings — Session Manager\'s own preferences',
    intro:
      'Everything here configures this app, not Claude Code: voice input, appearance, telemetry, phone remote, updates and retention, startup behavior, and a map of where the app stores its data. Claude Code\'s own settings.json lives on the Settings page.',
    sections: [
      {
        title: 'Tabs',
        items: [
          { term: 'Voice', body: 'On-device transcription, push-to-talk hotkey, microphone and text-to-speech.' },
          { term: 'Storage map', body: 'A hand-maintained ERD of what Session Manager persists, its paths and single-writer owners.' },
        ],
      },
    ],
    tips: ['Home face only — these preferences are machine-wide.'],
  },
}
