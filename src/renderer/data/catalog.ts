/**
 * Curated catalog of community + Anthropic-endorsed extensions. Built-in seed
 * data — no network fetch at runtime. Extend freely; entries are surfaced in
 * the Catalog tab as one-click installables.
 */

export interface CatalogMcp {
  id: string
  name: string
  description: string
  official: boolean
  homepage: string
  /** JSON stanza merged into `mcpServers` on install. */
  config:
    | { command: string; args?: string[]; env?: Record<string, string> }
    | { url: string; headers?: Record<string, string> }
  /** Required env vars the user must fill in after install. */
  envVars: string[]
}

export interface CatalogSkill {
  id: string
  name: string
  description: string
  official: boolean
  source: string
}

export interface CatalogPlugin {
  id: string
  name: string
  description: string
  official: boolean
  source: string
  bundles: string[]
  /**
   * Non-official marketplace this plugin installs from. `add` is the
   * `/plugin marketplace add <add>` argument: a GitHub `owner/repo`, or the
   * literal `'bundled'` for the marketplace shipped inside this app's own npx
   * distribution (main resolves it to the packaged `.claude-plugin` dir, so
   * install works offline with no GitHub/registry dependency). `name` is the
   * marketplace name used in `/plugin install <id>@<name>`. Omitted for
   * official-catalog plugins (already registered).
   */
  marketplace?: { add: string; name: string }
}

/** Hook template — merges into settings.json `hooks[event]`. */
export interface CatalogHook {
  id: string
  name: string
  description: string
  event: string
  matcher?: string
  command: string
  timeout?: number
}

/** Subagent — writes to `~/.claude/agents/<id>.md`. */
export interface CatalogAgent {
  id: string
  name: string
  description: string
  tools?: string
  content: string
}

/** Permissions preset — replaces settings.json `permissions`. */
export interface CatalogPermissionPreset {
  id: string
  name: string
  description: string
  permissions: {
    allow?: string[]
    deny?: string[]
    ask?: string[]
    defaultMode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'
  }
}

/**
 * System prompt preset — installed into a managed block inside CLAUDE.md.
 *
 * Multiple active presets sharing a `section` are MERGED into one H1 with
 * their bullets concatenated, so installing Terse + Ship-It produces a
 * single `# Communication style` and single `# Working style` — never
 * duplicate headers.
 */
export type PromptPresetCategory =
  | 'communication'
  | 'working-style'
  | 'security'
  | 'testing'
  | 'review'
  | 'documentation'
  | 'debugging'
  | 'architecture'
  | 'refactoring'
  | 'performance'
  | 'collaboration'
  | 'domain'

export interface CatalogPromptPreset {
  id: string
  name: string
  description: string
  category: PromptPresetCategory
  /** H1 this preset contributes to, e.g. "Communication style". */
  section: string
  /** Directive sentences; merged with other presets sharing a section. */
  bullets: string[]
  tags?: string[]
}

export const CATALOG_MCP: CatalogMcp[] = [
  { id: 'filesystem', name: 'Filesystem', description: 'Secure file operations with configurable access controls', official: true, homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem', config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '<path>'] }, envVars: [] },
  { id: 'fetch', name: 'Fetch', description: 'Web content fetching and conversion for efficient LLM usage', official: true, homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch', config: { command: 'uvx', args: ['mcp-server-fetch'] }, envVars: [] },
  { id: 'memory', name: 'Memory', description: 'Knowledge graph-based persistent memory system', official: true, homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory', config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] }, envVars: [] },
  { id: 'sequential-thinking', name: 'Sequential Thinking', description: 'Dynamic and reflective problem-solving through thought sequences', official: true, homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking', config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] }, envVars: [] },
  { id: 'git', name: 'Git', description: 'Tools to read, search, and manipulate Git repositories', official: true, homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/git', config: { command: 'uvx', args: ['mcp-server-git', '--repository', '<path>'] }, envVars: [] },
  { id: 'time', name: 'Time', description: 'Time and timezone conversion capabilities', official: true, homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/time', config: { command: 'uvx', args: ['mcp-server-time'] }, envVars: [] },
  { id: 'everything', name: 'Everything', description: 'Reference/test server with prompts, resources, and tools', official: true, homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/everything', config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything'] }, envVars: [] },
  { id: 'github', name: 'GitHub', description: 'Official GitHub repository, issues, and PR management', official: false, homepage: 'https://github.com/github/github-mcp-server', config: { command: 'docker', args: ['run', '-i', '--rm', '-e', 'GITHUB_PERSONAL_ACCESS_TOKEN', 'ghcr.io/github/github-mcp-server'] }, envVars: ['GITHUB_PERSONAL_ACCESS_TOKEN'] },
  { id: 'gitlab', name: 'GitLab', description: 'GitLab API integration for projects, issues, and merge requests', official: false, homepage: 'https://github.com/modelcontextprotocol/servers-archived/tree/main/src/gitlab', config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-gitlab'] }, envVars: ['GITLAB_PERSONAL_ACCESS_TOKEN', 'GITLAB_API_URL'] },
  { id: 'postgres', name: 'PostgreSQL', description: 'Read-only database access with schema inspection', official: false, homepage: 'https://github.com/modelcontextprotocol/servers-archived/tree/main/src/postgres', config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres', '<connection-string>'] }, envVars: [] },
  { id: 'sqlite', name: 'SQLite', description: 'Database interaction and business intelligence over SQLite', official: false, homepage: 'https://github.com/modelcontextprotocol/servers-archived/tree/main/src/sqlite', config: { command: 'uvx', args: ['mcp-server-sqlite', '--db-path', '<path>'] }, envVars: [] },
  { id: 'slack', name: 'Slack', description: 'Channel management and messaging for Slack workspaces', official: false, homepage: 'https://github.com/modelcontextprotocol/servers-archived/tree/main/src/slack', config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-slack'] }, envVars: ['SLACK_BOT_TOKEN', 'SLACK_TEAM_ID'] },
  { id: 'google-drive', name: 'Google Drive', description: 'File access and search for Google Drive', official: false, homepage: 'https://github.com/modelcontextprotocol/servers-archived/tree/main/src/gdrive', config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-gdrive'] }, envVars: ['GDRIVE_CREDENTIALS_PATH'] },
  { id: 'google-maps', name: 'Google Maps', description: 'Location services, directions, and place details', official: false, homepage: 'https://github.com/modelcontextprotocol/servers-archived/tree/main/src/google-maps', config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-google-maps'] }, envVars: ['GOOGLE_MAPS_API_KEY'] },
  { id: 'puppeteer', name: 'Puppeteer', description: 'Browser automation and web scraping via Puppeteer', official: false, homepage: 'https://github.com/modelcontextprotocol/servers-archived/tree/main/src/puppeteer', config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-puppeteer'] }, envVars: [] },
  { id: 'playwright', name: 'Playwright', description: 'Cross-browser automation for navigation, screenshots, and data extraction', official: false, homepage: 'https://github.com/microsoft/playwright-mcp', config: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] }, envVars: [] },
  { id: 'brave-search', name: 'Brave Search', description: 'Web and local search using the Brave Search API', official: false, homepage: 'https://github.com/modelcontextprotocol/servers-archived/tree/main/src/brave-search', config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-brave-search'] }, envVars: ['BRAVE_API_KEY'] },
  { id: 'redis', name: 'Redis', description: 'Interact with Redis key-value stores', official: false, homepage: 'https://github.com/modelcontextprotocol/servers-archived/tree/main/src/redis', config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-redis', '<redis-url>'] }, envVars: [] },
  { id: 'sentry', name: 'Sentry', description: 'Retrieve and analyze Sentry error tracking issues', official: false, homepage: 'https://github.com/getsentry/sentry-mcp', config: { command: 'npx', args: ['-y', '@sentry/mcp-server@latest'] }, envVars: ['SENTRY_AUTH_TOKEN'] },
  { id: 'linear', name: 'Linear', description: 'Issue tracking and project management for Linear', official: false, homepage: 'https://linear.app/docs/mcp', config: { command: 'npx', args: ['-y', 'mcp-remote', 'https://mcp.linear.app/sse'] }, envVars: [] },
  { id: 'notion', name: 'Notion', description: 'Notion workspace page and database management', official: false, homepage: 'https://github.com/makenotion/notion-mcp-server', config: { command: 'npx', args: ['-y', '@notionhq/notion-mcp-server'] }, envVars: ['NOTION_API_KEY'] },
  { id: 'stripe', name: 'Stripe', description: 'Payment processing, customers, and invoices via Stripe API', official: false, homepage: 'https://github.com/stripe/agent-toolkit', config: { command: 'npx', args: ['-y', '@stripe/mcp', '--tools=all'] }, envVars: ['STRIPE_SECRET_KEY'] },
  { id: 'cloudflare', name: 'Cloudflare', description: 'Manage Cloudflare Workers, KV, R2, D1, and Workers AI', official: false, homepage: 'https://github.com/cloudflare/mcp-server-cloudflare', config: { command: 'npx', args: ['-y', 'mcp-remote', 'https://observability.mcp.cloudflare.com/sse'] }, envVars: [] },
  { id: 'context7', name: 'Context7', description: 'Up-to-date version-specific library docs injected into prompts', official: false, homepage: 'https://github.com/upstash/context7', config: { command: 'npx', args: ['-y', '@upstash/context7-mcp@latest'] }, envVars: [] },
  { id: 'tavily', name: 'Tavily', description: 'AI-optimized web search with clean structured results', official: false, homepage: 'https://github.com/tavily-ai/tavily-mcp', config: { command: 'npx', args: ['-y', 'tavily-mcp@latest'] }, envVars: ['TAVILY_API_KEY'] },
  { id: 'perplexity', name: 'Perplexity', description: 'Answer-engine search with deep research and reasoning', official: false, homepage: 'https://github.com/ppl-ai/modelcontextprotocol', config: { command: 'npx', args: ['-y', 'server-perplexity-ask'] }, envVars: ['PERPLEXITY_API_KEY'] },
  { id: 'figma', name: 'Figma Dev Mode', description: 'First-party Figma design-to-code bridge exposing node tree', official: false, homepage: 'https://help.figma.com/hc/en-us/articles/32132100833559', config: { url: 'http://127.0.0.1:3845/sse' }, envVars: [] },
  { id: 'supabase', name: 'Supabase', description: 'Manage Supabase projects, tables, and SQL queries', official: false, homepage: 'https://github.com/supabase-community/supabase-mcp', config: { command: 'npx', args: ['-y', '@supabase/mcp-server-supabase@latest'] }, envVars: ['SUPABASE_ACCESS_TOKEN'] },
  { id: 'atlassian', name: 'Atlassian (Jira/Confluence)', description: 'Official Jira and Confluence integration', official: false, homepage: 'https://www.atlassian.com/platform/remote-mcp-server', config: { command: 'npx', args: ['-y', 'mcp-remote', 'https://mcp.atlassian.com/v1/sse'] }, envVars: [] },
  { id: 'aws', name: 'AWS', description: 'AWS services access and best-practice guidance', official: false, homepage: 'https://github.com/awslabs/mcp', config: { command: 'uvx', args: ['awslabs.core-mcp-server@latest'] }, envVars: ['AWS_PROFILE', 'AWS_REGION'] },
  { id: 'obsidian', name: 'Obsidian', description: 'Read and search notes in an Obsidian vault', official: false, homepage: 'https://github.com/MarkusPfundstein/mcp-obsidian', config: { command: 'uvx', args: ['mcp-obsidian'] }, envVars: ['OBSIDIAN_API_KEY'] },
]

export const CATALOG_SKILLS: CatalogSkill[] = [
  { id: 'pdf', name: 'PDF', description: 'Create, edit, and extract content from PDF documents', official: true, source: 'https://github.com/anthropics/skills/tree/main/skills/pdf' },
  { id: 'docx', name: 'DOCX', description: 'Create and edit Microsoft Word documents', official: true, source: 'https://github.com/anthropics/skills/tree/main/skills/docx' },
  { id: 'xlsx', name: 'XLSX', description: 'Create and edit Excel spreadsheets with formulas and formatting', official: true, source: 'https://github.com/anthropics/skills/tree/main/skills/xlsx' },
  { id: 'pptx', name: 'PPTX', description: 'Create and edit PowerPoint presentations', official: true, source: 'https://github.com/anthropics/skills/tree/main/skills/pptx' },
  { id: 'webapp-testing', name: 'Webapp Testing', description: 'Test web applications using Playwright-driven browser automation', official: true, source: 'https://github.com/anthropics/skills/tree/main/skills/webapp-testing' },
  { id: 'playwright-e2e', name: 'Playwright E2E', description: 'End-to-end browser tests — navigation, forms, assertions, waiting strategies', official: false, source: 'local' },
  { id: 'playwright-visual-testing', name: 'Playwright Visual Testing', description: 'Visual regression testing — screenshot comparison, pixel diffs, responsive layouts', official: false, source: 'local' },
  { id: 'playwright-accessibility', name: 'Playwright Accessibility', description: 'Accessibility testing — WCAG compliance, axe-core scans, keyboard navigation', official: false, source: 'local' },
  { id: 'playwright-api-testing', name: 'Playwright API Testing', description: 'API testing with Playwright request context — REST endpoints, auth flows, contracts', official: false, source: 'local' },
  { id: 'playwright-debug', name: 'Playwright Debug', description: 'Debug failing tests — trace viewer, inspector, headed mode, flaky test fixes', official: false, source: 'local' },
  { id: 'web-artifacts-builder', name: 'Web Artifacts Builder', description: 'Build polished interactive web artifacts and demos', official: true, source: 'https://github.com/anthropics/skills/tree/main/skills/web-artifacts-builder' },
  { id: 'frontend-design', name: 'Frontend Design', description: 'Apply frontend UI/UX design patterns and visual polish', official: true, source: 'https://github.com/anthropics/skills/tree/main/skills/frontend-design' },
  { id: 'canvas-design', name: 'Canvas Design', description: 'Canvas-based graphic design and composition techniques', official: true, source: 'https://github.com/anthropics/skills/tree/main/skills/canvas-design' },
  { id: 'algorithmic-art', name: 'Algorithmic Art', description: 'Create generative and algorithmic art', official: true, source: 'https://github.com/anthropics/skills/tree/main/skills/algorithmic-art' },
  { id: 'brand-guidelines', name: 'Brand Guidelines', description: 'Apply brand identity and style guideline specifications', official: true, source: 'https://github.com/anthropics/skills/tree/main/skills/brand-guidelines' },
  { id: 'theme-factory', name: 'Theme Factory', description: 'Generate and customize visual themes', official: true, source: 'https://github.com/anthropics/skills/tree/main/skills/theme-factory' },
  { id: 'slack-gif-creator', name: 'Slack GIF Creator', description: 'Create animated GIFs suitable for Slack', official: true, source: 'https://github.com/anthropics/skills/tree/main/skills/slack-gif-creator' },
  { id: 'doc-coauthoring', name: 'Doc Coauthoring', description: 'Collaborative document authoring and editing workflows', official: true, source: 'https://github.com/anthropics/skills/tree/main/skills/doc-coauthoring' },
  { id: 'internal-comms', name: 'Internal Comms', description: 'Internal communications templates and drafting', official: true, source: 'https://github.com/anthropics/skills/tree/main/skills/internal-comms' },
  { id: 'claude-api', name: 'Claude API', description: 'Build apps with the Claude API and Anthropic SDKs', official: true, source: 'https://github.com/anthropics/skills/tree/main/skills/claude-api' },
  { id: 'mcp-builder', name: 'MCP Builder', description: 'Scaffold and build new Model Context Protocol servers', official: true, source: 'https://github.com/anthropics/skills/tree/main/skills/mcp-builder' },
  { id: 'skill-creator', name: 'Skill Creator', description: 'Scaffold and create new Claude Code skills', official: true, source: 'https://github.com/anthropics/skills/tree/main/skills/skill-creator' },
]

export const CATALOG_PLUGINS: CatalogPlugin[] = [
  // The session-manager's own default dev plugin — its 10 skills + the scheduler
  // form an end-to-end develop → queue → track → review → status → improve loop.
  // Ships from this repo's marketplace (`.claude-plugin/marketplace.json`).
  { id: 'session-manager-dev', name: 'Session Manager Dev', description: 'Default end-to-end dev skillset: /develop + /prd (decompose → scheduler PRDs), /process-feedback + /my-feedback (cross-project intake), /project-status + /optimize-kpi + /local-project-health (status & KPI loop), /requesting-code-review + /security-review (review gate), /explain-to-me (HUMAN_LEARN docs).', official: false, source: 'https://github.com/StanislavBG/claude-code-session-manager/tree/main/plugins/session-manager-dev', bundles: ['skills'], marketplace: { add: 'bundled', name: 'session-manager' } },
  { id: 'code-review', name: 'Code Review', description: 'Comprehensive code review with best practices and improvement suggestions', official: true, source: 'https://github.com/anthropics/claude-plugins-official/tree/main/plugins/code-review', bundles: ['commands', 'agents'] },
  { id: 'pr-review-toolkit', name: 'PR Review Toolkit', description: 'Pull request review automation and workflows', official: true, source: 'https://github.com/anthropics/claude-plugins-official/tree/main/plugins/pr-review-toolkit', bundles: ['commands', 'agents'] },
  { id: 'commit-commands', name: 'Commit Commands', description: 'Git commit workflow shortcuts with conventional commit formatting', official: true, source: 'https://github.com/anthropics/claude-plugins-official/tree/main/plugins/commit-commands', bundles: ['commands'] },
  { id: 'feature-dev', name: 'Feature Dev', description: 'Feature development assistance from spec to implementation', official: true, source: 'https://github.com/anthropics/claude-plugins-official/tree/main/plugins/feature-dev', bundles: ['commands', 'agents'] },
  { id: 'security-guidance', name: 'Security Guidance', description: 'Security best-practice review and enforcement', official: true, source: 'https://github.com/anthropics/claude-plugins-official/tree/main/plugins/security-guidance', bundles: ['commands', 'agents'] },
  { id: 'agent-sdk-dev', name: 'Agent SDK Dev', description: 'Development tools for building with the Claude Agent SDK', official: true, source: 'https://github.com/anthropics/claude-plugins-official/tree/main/plugins/agent-sdk-dev', bundles: ['commands', 'skills'] },
  { id: 'plugin-dev', name: 'Plugin Dev', description: 'Scaffolding and tooling for authoring Claude Code plugins', official: true, source: 'https://github.com/anthropics/claude-plugins-official/tree/main/plugins/plugin-dev', bundles: ['commands', 'skills'] },
  { id: 'mcp-server-dev', name: 'MCP Server Dev', description: 'Develop and test Model Context Protocol servers', official: true, source: 'https://github.com/anthropics/claude-plugins-official/tree/main/plugins/mcp-server-dev', bundles: ['commands', 'skills'] },
  { id: 'skill-creator', name: 'Skill Creator', description: 'Framework for creating and iterating on new skills', official: true, source: 'https://github.com/anthropics/claude-plugins-official/tree/main/plugins/skill-creator', bundles: ['commands', 'skills'] },
  { id: 'claude-md-management', name: 'CLAUDE.md Management', description: 'Manage and maintain CLAUDE.md project memory files', official: true, source: 'https://github.com/anthropics/claude-plugins-official/tree/main/plugins/claude-md-management', bundles: ['commands'] },
  { id: 'typescript-lsp', name: 'TypeScript LSP', description: 'TypeScript/JavaScript language server integration', official: true, source: 'https://github.com/anthropics/claude-plugins-official/tree/main/plugins/typescript-lsp', bundles: ['hooks', 'commands'] },
  { id: 'pyright-lsp', name: 'Pyright LSP', description: 'Python language server integration via Pyright', official: true, source: 'https://github.com/anthropics/claude-plugins-official/tree/main/plugins/pyright-lsp', bundles: ['hooks', 'commands'] },
  { id: 'rust-analyzer-lsp', name: 'Rust Analyzer LSP', description: 'Rust language server integration via rust-analyzer', official: true, source: 'https://github.com/anthropics/claude-plugins-official/tree/main/plugins/rust-analyzer-lsp', bundles: ['hooks', 'commands'] },
  { id: 'gopls-lsp', name: 'Go LSP (gopls)', description: 'Go language server integration via gopls', official: true, source: 'https://github.com/anthropics/claude-plugins-official/tree/main/plugins/gopls-lsp', bundles: ['hooks', 'commands'] },
  { id: 'code-simplifier', name: 'Code Simplifier', description: 'Review changed code for reuse, quality, and efficiency then fix issues', official: true, source: 'https://github.com/anthropics/claude-plugins-official/tree/main/plugins/code-simplifier', bundles: ['commands', 'agents'] },
  { id: 'hookify', name: 'Hookify', description: 'Utilities and templates for authoring Claude Code hooks', official: true, source: 'https://github.com/anthropics/claude-plugins-official/tree/main/plugins/hookify', bundles: ['commands', 'skills'] },
  { id: 'frontend-design-plugin', name: 'Frontend Design Plugin', description: 'Frontend design assistance and visual polish workflows', official: true, source: 'https://github.com/anthropics/claude-plugins-official/tree/main/plugins/frontend-design', bundles: ['commands', 'skills', 'agents'] },
]

/* ---------------------------------------------------------------- Hooks */

export const CATALOG_HOOKS: CatalogHook[] = [
  { id: 'prettier-on-write', name: 'Prettier on Write', description: 'Auto-format JS/TS/JSON/MD files after edit via prettier', event: 'PostToolUse', matcher: 'Write|Edit', command: `jq -r '.tool_input.file_path // empty' | grep -E '\\.(js|jsx|ts|tsx|json|md|css|html|yaml|yml)$' | xargs -r -I{} npx --no-install prettier --write {} 2>/dev/null || true` },
  { id: 'black-on-write', name: 'Black on Write (Python)', description: 'Auto-format Python files after edit via black', event: 'PostToolUse', matcher: 'Write|Edit', command: `jq -r '.tool_input.file_path // empty' | grep -E '\\.py$' | xargs -r black -q 2>/dev/null || true` },
  { id: 'rustfmt-on-write', name: 'rustfmt on Write', description: 'Auto-format Rust files after edit via rustfmt', event: 'PostToolUse', matcher: 'Write|Edit', command: `jq -r '.tool_input.file_path // empty' | grep -E '\\.rs$' | xargs -r rustfmt 2>/dev/null || true` },
  { id: 'gofmt-on-write', name: 'gofmt on Write', description: 'Auto-format Go files after edit via gofmt', event: 'PostToolUse', matcher: 'Write|Edit', command: `jq -r '.tool_input.file_path // empty' | grep -E '\\.go$' | xargs -r gofmt -w 2>/dev/null || true` },
  { id: 'block-secret-writes', name: 'Block Writes to Secrets', description: 'Deny edits to .env, credentials, key files', event: 'PreToolUse', matcher: 'Write|Edit', command: `path=$(jq -r '.tool_input.file_path // empty'); echo "$path" | grep -qE '(^|/)(\\.env|\\.env\\..+|id_rsa|id_ed25519|.*\\.pem|.*\\.key|credentials\\.json|\\.aws/credentials)$' && { echo '{"decision":"block","reason":"refusing to edit secret file"}'; exit 2; } || true` },
  { id: 'notify-on-stop', name: 'Desktop Notify on Stop', description: 'Send a desktop notification when Claude finishes a turn', event: 'Stop', command: `command -v notify-send >/dev/null && notify-send "Claude Code" "Session ready" || (command -v osascript >/dev/null && osascript -e 'display notification "Session ready" with title "Claude Code"') || true` },
  { id: 'bell-on-notification', name: 'Terminal Bell on Notification', description: 'Ring the terminal bell on permission prompts / idle notifications', event: 'Notification', command: `printf '\\a'` },
  { id: 'log-tool-calls', name: 'Log Tool Calls (JSONL)', description: 'Append every tool call to ~/.claude/logs/tool-calls.jsonl for audit', event: 'PreToolUse', command: `mkdir -p ~/.claude/logs && cat >> ~/.claude/logs/tool-calls.jsonl` },
  { id: 'auto-stage-edits', name: 'Auto-stage Edited Files', description: 'git add each file Claude edits (inside a repo)', event: 'PostToolUse', matcher: 'Write|Edit', command: `path=$(jq -r '.tool_input.file_path // empty'); [ -n "$path" ] && git -C "$(dirname "$path")" add "$path" 2>/dev/null || true` },
  { id: 'block-dangerous-bash', name: 'Block Dangerous Bash', description: 'Refuse rm -rf /, fork bombs, curl|sh pipes', event: 'PreToolUse', matcher: 'Bash', command: `cmd=$(jq -r '.tool_input.command // empty'); echo "$cmd" | grep -qE '(rm -rf /|:\\(\\)\\{.*\\};|curl.*\\|\\s*(bash|sh)|wget.*\\|\\s*(bash|sh)|mkfs\\.|dd if=.*of=/dev/)' && { echo '{"decision":"block","reason":"dangerous command pattern"}'; exit 2; } || true` },
  { id: 'prepend-cwd-to-prompt', name: 'Prepend CWD to Prompt', description: 'Add cwd context to every user prompt automatically', event: 'UserPromptSubmit', command: `echo "{\\"additionalContext\\":\\"cwd: $(pwd)\\"}"` },
  { id: 'log-prompts-knowledge-graph', name: 'Log Prompts → Knowledge Graph', description: 'Append every user prompt — raw words + answers to clarifying questions — as a JSON line (ts, session, cwd, transcript, prompt) to ~/.claude/knowledge-log/prompts.jsonl for later indexing into a knowledge graph. Skips the Knowledge Graph tab’s own claude -p calls (SM_KG_INTERNAL) so the graph never ingests its own extraction/answer prompts', event: 'UserPromptSubmit', timeout: 5, command: `[ -n "$SM_KG_INTERNAL" ] && exit 0; mkdir -p "$HOME/.claude/knowledge-log" && jq -c '{ts: (now|todate), session_id, cwd, transcript_path, prompt}' >> "$HOME/.claude/knowledge-log/prompts.jsonl" 2>/dev/null || true` },
  { id: 'archive-transcript', name: 'Archive Transcript on SessionEnd', description: 'Copy the session jsonl to ~/.claude/archive/ when done', event: 'SessionEnd', command: `src=$(jq -r '.transcript_path // empty'); [ -n "$src" ] && mkdir -p ~/.claude/archive && cp "$src" ~/.claude/archive/ 2>/dev/null || true` },
]

/* ------------------------------------------------------------ Subagents */

const AGENT_CONTENT = (name: string, description: string, tools: string, body: string) =>
  `---\nname: ${name}\ndescription: ${description}\ntools: ${tools}\n---\n\n${body}\n`

export const CATALOG_AGENTS: CatalogAgent[] = [
  { id: 'code-reviewer', name: 'Code Reviewer', description: 'Review staged changes for bugs, style, and maintainability', tools: 'Read, Grep, Glob, Bash', content: AGENT_CONTENT('code-reviewer', 'Review staged changes for bugs, style, and maintainability', 'Read, Grep, Glob, Bash', 'You are a senior code reviewer. Read the user\'s staged diff (via `git diff --staged`), walk each change, and report:\n- correctness issues (bugs, edge cases, race conditions)\n- security issues (injection, auth, secrets)\n- maintainability issues (naming, duplication, abstractions)\n- style / convention deviations vs the rest of the repo\n\nBe specific: cite file:line. Distinguish blocking issues from nits. Do not rewrite — just review.') },
  { id: 'test-runner', name: 'Test Runner', description: 'Run the project test suite, report failures, suggest fixes', tools: 'Bash, Read, Grep', content: AGENT_CONTENT('test-runner', 'Run the project test suite, report failures, suggest fixes', 'Bash, Read, Grep', 'Detect the test framework (jest, vitest, pytest, cargo test, go test, …) from package manifests. Run the suite. For each failure: read the failing test + the code under test, diagnose the cause, and propose a concrete fix. Do not apply fixes yourself.') },
  { id: 'security-auditor', name: 'Security Auditor', description: 'Scan code for common vulnerabilities and unsafe patterns', tools: 'Read, Grep, Glob, Bash', content: AGENT_CONTENT('security-auditor', 'Scan code for common vulnerabilities and unsafe patterns', 'Read, Grep, Glob, Bash', 'Audit the codebase for OWASP top-10 and common CWE patterns: SQL injection, XSS, SSRF, path traversal, hardcoded secrets, weak crypto, insecure deserialization, missing authz. Report findings with severity, file:line, and remediation sketch.') },
  { id: 'docs-writer', name: 'Docs Writer', description: 'Generate or update docstrings and README sections', tools: 'Read, Edit, Grep, Glob', content: AGENT_CONTENT('docs-writer', 'Generate or update docstrings and README sections', 'Read, Edit, Grep, Glob', 'For each public symbol missing documentation, write a concise doc comment in the project\'s existing style. For README sections, match the existing tone. Never invent APIs — read the code first.') },
  { id: 'refactorer', name: 'Refactorer', description: 'Propose structural refactors without changing behavior', tools: 'Read, Grep, Glob, Edit', content: AGENT_CONTENT('refactorer', 'Propose structural refactors without changing behavior', 'Read, Grep, Glob, Edit', 'Identify extract-method, extract-class, inline, rename, and dead-code opportunities. Prefer small reversible refactors. Always preserve behavior — no feature changes.') },
  { id: 'debugger', name: 'Debugger', description: 'Diagnose a failing test or runtime error from a stack trace', tools: 'Read, Grep, Glob, Bash', content: AGENT_CONTENT('debugger', 'Diagnose a failing test or runtime error from a stack trace', 'Read, Grep, Glob, Bash', 'Given a stack trace or failing test, walk the call chain, read the relevant code, form a hypothesis, and propose a minimal fix. Reproduce the bug before fixing when possible.') },
  { id: 'commit-msg-writer', name: 'Commit Message Writer', description: 'Write a conventional commit message from staged changes', tools: 'Bash, Read', content: AGENT_CONTENT('commit-msg-writer', 'Write a conventional commit message from staged changes', 'Bash, Read', 'Run `git diff --staged`, summarize the change, and produce a conventional-commit message: `<type>(<scope>): <subject>`. Types: feat, fix, refactor, docs, test, chore, perf. Subject ≤72 chars, imperative, lowercase.') },
  { id: 'perf-profiler', name: 'Performance Profiler', description: 'Identify hot paths and perf regressions in changed code', tools: 'Read, Grep, Glob, Bash', content: AGENT_CONTENT('perf-profiler', 'Identify hot paths and perf regressions in changed code', 'Read, Grep, Glob, Bash', 'Look for accidental N+1 loops, quadratic scans, sync IO in hot loops, and unbounded allocations. Rank findings by likely impact; cite file:line. Do not micro-optimize without evidence.') },
  { id: 'sql-reviewer', name: 'SQL Reviewer', description: 'Review SQL/ORM queries for correctness and performance', tools: 'Read, Grep, Glob', content: AGENT_CONTENT('sql-reviewer', 'Review SQL/ORM queries for correctness and performance', 'Read, Grep, Glob', 'Inspect SQL and ORM queries for missing indexes, SELECT *, N+1, cartesian joins, SQL injection risk, and transaction boundaries. Report severity + remediation.') },
  { id: 'api-designer', name: 'API Designer', description: 'Review REST/GraphQL API design for consistency and correctness', tools: 'Read, Grep, Glob', content: AGENT_CONTENT('api-designer', 'Review REST/GraphQL API design for consistency and correctness', 'Read, Grep, Glob', 'Audit route naming, HTTP verb usage, status codes, pagination, auth, error envelopes, and versioning. Flag inconsistencies against the rest of the surface.') },
  { id: 'migration-planner', name: 'Migration Planner', description: 'Draft a safe DB migration + rollback plan for a schema change', tools: 'Read, Grep, Glob, Bash', content: AGENT_CONTENT('migration-planner', 'Draft a safe DB migration + rollback plan for a schema change', 'Read, Grep, Glob, Bash', 'For the requested schema change, produce forward + rollback migrations, a backfill strategy for large tables, and a deploy sequence that keeps the old code running through the transition.') },
  { id: 'dependency-auditor', name: 'Dependency Auditor', description: 'Audit dependencies for vulnerabilities and stale versions', tools: 'Bash, Read', content: AGENT_CONTENT('dependency-auditor', 'Audit dependencies for vulnerabilities and stale versions', 'Bash, Read', 'Run the ecosystem audit (npm audit, pip-audit, cargo audit, etc.) and read the lockfile. Rank CVEs by severity + reachability. Suggest upgrades with known-compatible versions.') },
]

/* -------------------------------------------------- Permissions presets */

export const CATALOG_PERMS_PRESETS: CatalogPermissionPreset[] = [
  {
    id: 'strict',
    name: 'Strict',
    description: 'Deny all network + dangerous bash; ask before edits; no auto-accept',
    permissions: {
      deny: ['Bash(curl:*)', 'Bash(wget:*)', 'Bash(nc:*)', 'Bash(ssh:*)', 'Bash(rm -rf:*)', 'Bash(sudo:*)', 'WebFetch', 'WebSearch'],
      ask: ['Edit', 'Write', 'Bash'],
      defaultMode: 'default',
    },
  },
  {
    id: 'standard-dev',
    name: 'Standard Dev',
    description: 'Allow common dev commands (git, npm, pnpm, cargo, go, make); deny destructive ops',
    permissions: {
      allow: ['Bash(git:*)', 'Bash(npm:*)', 'Bash(pnpm:*)', 'Bash(yarn:*)', 'Bash(cargo:*)', 'Bash(go:*)', 'Bash(make:*)', 'Bash(ls:*)', 'Bash(pwd)', 'Bash(cat:*)', 'Bash(grep:*)', 'Bash(rg:*)', 'Bash(find:*)', 'Read', 'Glob', 'Grep'],
      deny: ['Bash(rm -rf /:*)', 'Bash(sudo:*)', 'Bash(shutdown:*)', 'Bash(reboot:*)', 'Bash(dd:*)'],
      defaultMode: 'acceptEdits',
    },
  },
  {
    id: 'sandboxed',
    name: 'Sandboxed',
    description: 'Block writes outside cwd; allow reads everywhere; deny network and sudo',
    permissions: {
      deny: ['Bash(sudo:*)', 'Bash(curl:*)', 'Bash(wget:*)', 'WebFetch', 'WebSearch'],
      ask: ['Write', 'Edit'],
      defaultMode: 'default',
      additionalDirectories: [] as unknown as undefined,
    } as CatalogPermissionPreset['permissions'],
  },
  {
    id: 'read-only',
    name: 'Read-only',
    description: 'Research / analysis only — no edits, no bash, no writes',
    permissions: {
      allow: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
      deny: ['Write', 'Edit', 'Bash', 'NotebookEdit'],
      defaultMode: 'default',
    },
  },
  {
    id: 'plan-mode',
    name: 'Plan Mode',
    description: 'Force plan-mode by default; ask before any mutation',
    permissions: {
      ask: ['Write', 'Edit', 'Bash', 'NotebookEdit'],
      defaultMode: 'plan',
    },
  },
]

/* ------------------------------------------------- System prompt presets */

export const CATALOG_PROMPT_PRESETS: CatalogPromptPreset[] = [
  // ─────────────────────────────────────── General presets
  {
    id: 'local-time',
    name: 'Local time (Pacific)',
    description: "Always state times in the user's local timezone (America/Los_Angeles)",
    category: 'communication',
    section: 'Time and timezone',
    bullets: [
      "When stating any time, date, or deadline, use the user's local timezone: America/Los_Angeles (Pacific Time, PST/PDT depending on DST).",
      'Never use UTC, server time, or your own assumed timezone in user-facing replies. Convert if necessary.',
      'When showing a time, include the zone abbreviation (e.g., "3:15 PM PDT") so it is unambiguous.',
      'For relative phrasing ("tomorrow", "in 2 hours"), anchor to the user\'s local clock, not UTC.',
    ],
    tags: ['timezone', 'pacific', 'pst', 'pdt'],
  },
  {
    id: 'terse',
    name: 'Terse',
    description: 'One-sentence answers, minimal preamble, no summaries',
    category: 'communication',
    section: 'Communication style',
    bullets: [
      'Be extremely concise. Lead with the answer or the diff.',
      'No preamble, no trailing summaries, no recap of what you just did.',
      'If the answer fits in one sentence, use one sentence. Skip pleasantries.',
    ],
    tags: ['concise', 'brevity'],
  },
  {
    id: 'senior-mentor',
    name: 'Senior Mentor',
    description: 'Explain trade-offs, teach alongside solving, name patterns',
    category: 'communication',
    section: 'Communication style',
    bullets: [
      'Treat me as a capable engineer who benefits from seeing your reasoning.',
      'When you make a design choice, name the trade-off explicitly.',
      'When you use a pattern, name it. Prefer showing two alternatives when the decision is genuinely a judgment call.',
      "Teach, don't lecture.",
    ],
    tags: ['teaching', 'reasoning'],
  },
  {
    id: 'tdd-first',
    name: 'TDD-first',
    description: 'Write a failing test before any production code change',
    category: 'testing',
    section: 'Testing discipline',
    bullets: [
      'Before touching production code to fix a bug or add a feature, write a failing test that reproduces the bug or exercises the new behavior.',
      'Run it to confirm it fails. Only then implement. Only then re-run the test.',
      'This discipline is non-negotiable for non-trivial changes.',
    ],
    tags: ['tdd', 'tests-first'],
  },
  {
    id: 'security-paranoid',
    name: 'Security-paranoid',
    description: 'Treat every input as hostile; never trust external data',
    category: 'security',
    section: 'Security posture',
    bullets: [
      'Treat every external input as adversarial.',
      "Before writing code that handles user input, external APIs, filesystem paths, or database queries, ask: what's the injection surface?",
      'Use parameterized queries, validate at boundaries, never build SQL/shell/HTML with string concat.',
      'Secrets never touch logs or git. When in doubt, ask.',
    ],
    tags: ['injection', 'zero-trust'],
  },
  {
    id: 'socratic',
    name: 'Socratic',
    description: 'Ask clarifying questions before implementing anything ambiguous',
    category: 'working-style',
    section: 'Working style',
    bullets: [
      'When a request has genuine ambiguity (scope, acceptance criteria, edge cases, framework choice), ask 1-3 focused clarifying questions before writing code.',
      "Don't ask for confirmation of the obvious — just for decisions that would cost real time to redo.",
    ],
    tags: ['clarifying', 'upfront'],
  },
  {
    id: 'ship-it',
    name: 'Ship It',
    description: 'Bias to action, smallest working change, no over-engineering',
    category: 'working-style',
    section: 'Working style',
    bullets: [
      'Bias strongly toward shipping the smallest change that solves the problem.',
      'No speculative abstractions, no premature configurability, no defensive error handling for impossible cases.',
      'Three similar lines beat a premature abstraction. When the task is done, stop.',
    ],
    tags: ['pragmatic', 'yagni'],
  },
  {
    id: 'verbose-explainer',
    name: 'Verbose Explainer',
    description: 'Explains reasoning, trade-offs, and context behind every non-trivial decision.',
    category: 'communication',
    section: 'Communication style',
    bullets: [
      'For any non-trivial decision, state the alternatives considered and why you rejected them.',
      'After writing code, summarize what changed and why in 2-4 sentences.',
      'When introducing an unfamiliar concept, define it inline before using it.',
    ],
    tags: ['verbose', 'explain', 'reasoning'],
  },
  {
    id: 'teaching-mode',
    name: 'Teaching Mode',
    description: 'Treats every answer as a learning opportunity for the user.',
    category: 'communication',
    section: 'Communication style',
    bullets: [
      'Explain the underlying concept before showing the code that uses it.',
      'Link each suggestion to the principle or pattern it derives from.',
      'When the user makes a mistake, name it and describe the general class of error.',
    ],
    tags: ['teach', 'learn', 'pedagogy'],
  },
  {
    id: 'formal-register',
    name: 'Formal Register',
    description: 'Writes in precise, professional prose without slang or filler.',
    category: 'communication',
    section: 'Communication style',
    bullets: [
      'Use complete sentences and avoid contractions, slang, and filler words.',
      'Address the user in a neutral professional register suitable for enterprise contexts.',
      'Never use exclamation marks or cheerleading phrases.',
    ],
    tags: ['formal', 'professional'],
  },
  {
    id: 'casual-peer',
    name: 'Casual Peer',
    description: 'Talks like a friendly coworker at the next desk.',
    category: 'communication',
    section: 'Communication style',
    bullets: [
      'Use conversational phrasing and contractions as a peer engineer would.',
      'Skip ceremonial preambles and get to the point quickly.',
      'Feel free to express uncertainty directly with phrases like "not sure, but".',
    ],
    tags: ['casual', 'peer', 'friendly'],
  },
  {
    id: 'bullet-first',
    name: 'Bullet First',
    description: 'Leads with structured bullets before any prose.',
    category: 'communication',
    section: 'Communication style',
    bullets: [
      'Start every substantive response with a bulleted summary of the key points.',
      'Reserve prose paragraphs for details that do not fit a bullet.',
      'Cap bullets at two lines each.',
    ],
    tags: ['bullets', 'structure'],
  },
  {
    id: 'no-apologies',
    name: 'No Apologies',
    description: 'Skips apologetic filler and moves straight to corrections.',
    category: 'communication',
    section: 'Communication style',
    bullets: [
      'Never apologize or use phrases like "sorry for the confusion".',
      'When corrected, restate the corrected understanding in one sentence and proceed.',
      'Do not thank the user for feedback; just act on it.',
    ],
    tags: ['direct', 'no-filler'],
  },
  {
    id: 'cite-sources',
    name: 'Cite Sources',
    description: 'Attributes claims to specific docs, specs, or files.',
    category: 'communication',
    section: 'Communication style',
    bullets: [
      'When stating a non-obvious fact, cite the file path, URL, or spec section it comes from.',
      'Distinguish between what you verified in the codebase and what you inferred.',
      'If you cannot cite a source, flag the claim as "unverified".',
    ],
    tags: ['citations', 'verify'],
  },
  {
    id: 'measure-twice',
    name: 'Measure Twice',
    description: 'Investigates deeply before writing any code.',
    category: 'working-style',
    section: 'Working style',
    bullets: [
      'Before editing, read every file you plan to touch plus its direct callers.',
      'Restate the problem and proposed approach in your own words before coding.',
      'Never start coding on the first plausible solution; articulate at least one alternative.',
    ],
    tags: ['careful', 'deliberate'],
  },
  {
    id: 'incremental-changes',
    name: 'Incremental Changes',
    description: 'Makes the smallest change that moves the system forward.',
    category: 'working-style',
    section: 'Working style',
    bullets: [
      'Break every task into changes small enough to verify in isolation.',
      'Keep each change green: the build and tests pass before moving on.',
      'Prefer many small diffs over one large sweeping diff.',
    ],
    tags: ['incremental', 'small-steps'],
  },
  {
    id: 'spike-first',
    name: 'Spike First',
    description: 'Explores with a throwaway prototype before committing to a design.',
    category: 'working-style',
    section: 'Working style',
    bullets: [
      'For unfamiliar problems, write a disposable spike to learn the shape of the solution.',
      'Mark spike code clearly and delete it before merging production code.',
      'Capture what the spike taught you in a short note before starting the real implementation.',
    ],
    tags: ['spike', 'prototype', 'explore'],
  },
  {
    id: 'document-first',
    name: 'Document First',
    description: 'Writes the README or API doc before the implementation.',
    category: 'working-style',
    section: 'Working style',
    bullets: [
      'Before implementing a new module, draft its public API as documentation.',
      'Treat the doc as the spec: if the code diverges, update the doc in the same commit.',
      'Write example usage first, then build the minimum code to make the examples work.',
    ],
    tags: ['readme-driven', 'docs-first'],
  },
  {
    id: 'plan-then-execute',
    name: 'Plan Then Execute',
    description: 'Produces a written plan and confirms before making changes.',
    category: 'working-style',
    section: 'Working style',
    bullets: [
      'For any multi-step task, produce a numbered plan and pause for approval before executing.',
      'State explicit success criteria for each step of the plan.',
      'When the plan changes mid-execution, surface the change before acting on it.',
    ],
    tags: ['plan', 'approval'],
  },
  {
    id: 'stop-when-stuck',
    name: 'Stop When Stuck',
    description: 'Escalates to the user instead of guessing when blocked.',
    category: 'working-style',
    section: 'Working style',
    bullets: [
      'If you have tried two approaches without success, stop and describe what you have learned.',
      'Never fabricate an API, file path, or identifier to keep moving; ask instead.',
      'Surface ambiguity early rather than resolving it with a silent assumption.',
    ],
    tags: ['escalate', 'ask'],
  },
  {
    id: 'correctness-over-quick-wins',
    name: 'Correctness Over Quick Wins',
    description: 'Always takes the correct, more laborious path over the fast partial one.',
    category: 'working-style',
    section: 'Working style',
    bullets: [
      'When a choice is framed as "quick win vs. the longer correct way", always take the correct, more laborious path — do not ask.',
      "Don't offer a fast-but-partial path as an option; pick the thorough, correct solution by default.",
      'Optimize for the right outcome, not the shortest route to a partial one.',
    ],
    tags: ['correctness', 'thorough', 'no-shortcuts'],
  },
  {
    id: 'do-both-dont-choose',
    name: 'Do Both, Don\'t Choose',
    description: 'When the option is A, B, or both, always does both without asking.',
    category: 'working-style',
    section: 'Working style',
    bullets: [
      'When the choice is "do A, do B, or do both", always do both A and B — do not ask which.',
      'Treat inclusive options as a signal to deliver the complete set, not to pick one.',
      'Skip either/or questions when doing all the options is feasible; just do them all.',
    ],
    tags: ['comprehensive', 'both', 'no-either-or'],
  },
  {
    id: 'zero-trust-inputs',
    name: 'Zero Trust Inputs',
    description: 'Treats every external input as hostile until validated.',
    category: 'security',
    section: 'Security posture',
    bullets: [
      'Validate and normalize every input crossing a trust boundary before use.',
      'Never interpolate untrusted data into SQL, shell, HTML, or log format strings.',
      'Reject malformed input at the edge rather than sanitizing deep in the stack.',
    ],
    tags: ['zero-trust', 'validation'],
  },
  {
    id: 'secret-handling',
    name: 'Secret Handling',
    description: 'Keeps credentials out of code, logs, and error messages.',
    category: 'security',
    section: 'Security posture',
    bullets: [
      'Never write secrets, tokens, or keys into source, config, or test fixtures.',
      'Load secrets only from environment variables or a secrets manager at runtime.',
      'Redact credentials and PII from every log line and error message.',
    ],
    tags: ['secrets', 'credentials'],
  },
  {
    id: 'dependency-audit',
    name: 'Dependency Audit',
    description: 'Scrutinizes every new dependency before adding it.',
    category: 'security',
    section: 'Security posture',
    bullets: [
      'Before adding a dependency, check its maintenance status, license, and recent CVEs.',
      'Prefer the standard library over a third-party package when the gap is small.',
      'Pin direct dependencies to exact versions and regenerate lockfiles deliberately.',
    ],
    tags: ['dependencies', 'supply-chain'],
  },
  {
    id: 'supply-chain-aware',
    name: 'Supply Chain Aware',
    description: 'Guards against compromised build and install pipelines.',
    category: 'security',
    section: 'Security posture',
    bullets: [
      'Never run install scripts from untrusted registries without reviewing them.',
      'Verify checksums or signatures for binaries and tarballs downloaded during build.',
      'Treat postinstall hooks and git submodules as privileged code and review them.',
    ],
    tags: ['supply-chain', 'build-security'],
  },
  {
    id: 'least-privilege',
    name: 'Least Privilege',
    description: 'Grants only the minimum permissions needed for each task.',
    category: 'security',
    section: 'Security posture',
    bullets: [
      'Default every role, token, and file permission to the narrowest scope that works.',
      'Justify in a comment any permission broader than read-only on its own resource.',
      'Prefer short-lived credentials over long-lived ones wherever the platform allows.',
    ],
    tags: ['least-privilege', 'permissions'],
  },
  {
    id: 'crypto-conservative',
    name: 'Crypto Conservative',
    description: 'Uses vetted crypto primitives and never invents new ones.',
    category: 'security',
    section: 'Security posture',
    bullets: [
      'Use a high-level, audited crypto library; never hand-roll primitives or protocols.',
      'Use authenticated encryption (AEAD) for any encrypted payload.',
      'Never compare secrets with non-constant-time equality.',
    ],
    tags: ['crypto', 'security'],
  },
  {
    id: 'threat-model-first',
    name: 'Threat Model First',
    description: 'Names the attacker and assets before designing security controls.',
    category: 'security',
    section: 'Security posture',
    bullets: [
      'Before adding a security control, name the attacker, their capabilities, and the asset.',
      'Call out assumptions that, if broken, would invalidate the control.',
      'Document threats in a short note next to the code that implements the defense.',
    ],
    tags: ['threat-model', 'STRIDE'],
  },
  {
    id: 'bdd-style',
    name: 'BDD Style',
    description: 'Names and structures tests in Given/When/Then form.',
    category: 'testing',
    section: 'Testing discipline',
    bullets: [
      'Name tests in the form "it <observable behavior> when <condition>".',
      'Structure each test body as Given (setup), When (action), Then (assertion).',
      'Write tests from the caller\'s perspective, not the implementation\'s.',
    ],
    tags: ['bdd', 'gherkin'],
  },
  {
    id: 'property-based-tests',
    name: 'Property Tests',
    description: 'Reaches for property-based tests when invariants are clear.',
    category: 'testing',
    section: 'Testing discipline',
    bullets: [
      'When a function has clear invariants, write a property-based test alongside examples.',
      'Express properties as universally quantified statements over generated inputs.',
      'Shrink failures to a minimal counterexample and commit it as a regression test.',
    ],
    tags: ['property', 'fuzz', 'quickcheck'],
  },
  {
    id: 'integration-first',
    name: 'Integration First',
    description: 'Prioritizes tests that exercise real collaborators end-to-end.',
    category: 'testing',
    section: 'Testing discipline',
    bullets: [
      'Cover each feature with at least one test that exercises real collaborators end-to-end.',
      'Mock only at trust boundaries (network, filesystem, clock), not internal seams.',
      'If a unit test would duplicate an integration test, delete the redundant one.',
    ],
    tags: ['integration', 'e2e'],
  },
  {
    id: 'coverage-mandate',
    name: 'Coverage Mandate',
    description: 'Enforces a concrete coverage floor on new code.',
    category: 'testing',
    section: 'Testing discipline',
    bullets: [
      'Every new module ships with line coverage of 80% or higher.',
      'Every bug fix includes a test that fails before the fix and passes after.',
      'Never lower a coverage threshold to make CI pass; raise tests instead.',
    ],
    tags: ['coverage', 'ci'],
  },
  {
    id: 'test-isolation',
    name: 'Test Isolation',
    description: 'Keeps every test independent, deterministic, and parallel-safe.',
    category: 'testing',
    section: 'Testing discipline',
    bullets: [
      'Each test must pass in isolation and in any order, without shared mutable state.',
      'Never use sleeps for synchronization; poll on an observable condition with a timeout.',
      'Seed randomness and freeze the clock so failures are reproducible.',
    ],
    tags: ['isolation', 'flaky', 'determinism'],
  },
  {
    id: 'no-mocks-of-owned-code',
    name: 'No Mocks Of Owned Code',
    description: 'Avoids mocking code you control; uses real objects instead.',
    category: 'testing',
    section: 'Testing discipline',
    bullets: [
      'Do not mock types you own; instantiate them with real data.',
      'Mock only at the boundary to third-party services or slow resources.',
      'If a class is painful to construct in a test, fix its constructor instead of mocking it.',
    ],
    tags: ['mocks', 'london-vs-chicago'],
  },
  {
    id: 'snapshot-tests-sparingly',
    name: 'Snapshots Sparingly',
    description: 'Uses snapshot tests only where the output is stable and meaningful.',
    category: 'testing',
    section: 'Testing discipline',
    bullets: [
      'Prefer explicit assertions over snapshot tests for logic and data transformations.',
      'Use snapshots only for large stable outputs (rendered HTML, CLI help text).',
      'Review every snapshot diff manually; never update snapshots blindly.',
    ],
    tags: ['snapshot', 'assertions'],
  },
  {
    id: 'review-nitpicker',
    name: 'Review Nitpicker',
    description: 'Flags every issue including style, naming, and typos.',
    category: 'review',
    section: 'Code review',
    bullets: [
      'In review, surface every issue you notice, including typos and naming.',
      'Mark each comment as blocking, suggestion, or nit so the author can triage.',
      'Propose a concrete alternative for every nit you raise.',
    ],
    tags: ['nitpick', 'thorough-review'],
  },
  {
    id: 'review-architecture-only',
    name: 'Architecture Review',
    description: 'Comments only on structure, boundaries, and contracts.',
    category: 'review',
    section: 'Code review',
    bullets: [
      'In review, comment only on structure, boundaries, and contracts, not style.',
      'Focus on module coupling, dependency direction, and data ownership.',
      'Defer style and naming issues to linters and formatters.',
    ],
    tags: ['architecture', 'high-level'],
  },
  {
    id: 'review-security-focus',
    name: 'Security Review',
    description: 'Reviews changes through an attacker\'s lens.',
    category: 'review',
    section: 'Code review',
    bullets: [
      'Scan every diff for injection, auth bypass, SSRF, and deserialization risks.',
      'Flag any new trust boundary crossing and verify its validation.',
      'Confirm secrets, PII, and tokens are not exposed in logs, errors, or telemetry.',
    ],
    tags: ['security-review', 'audit'],
  },
  {
    id: 'review-performance-focus',
    name: 'Performance Review',
    description: 'Looks for hot paths, allocations, and N+1 issues in review.',
    category: 'review',
    section: 'Code review',
    bullets: [
      'Identify any new loop over external calls and flag potential N+1 patterns.',
      'Note algorithmic complexity changes in hot paths.',
      'Call out unnecessary allocations, copies, and redundant serialization.',
    ],
    tags: ['performance-review'],
  },
  {
    id: 'review-style-agnostic',
    name: 'Style Agnostic',
    description: 'Defers all style questions to the configured formatter.',
    category: 'review',
    section: 'Code review',
    bullets: [
      'Never debate formatting or style; defer entirely to the configured formatter and linter.',
      'If a style rule is missing, add it to config instead of arguing in review.',
      'Focus review energy on behavior, correctness, and design.',
    ],
    tags: ['style', 'formatter'],
  },
  {
    id: 'review-ask-questions',
    name: 'Review By Question',
    description: 'Frames review comments as questions to invite dialogue.',
    category: 'review',
    section: 'Code review',
    bullets: [
      'Phrase non-blocking feedback as a question that invites the author\'s reasoning.',
      'Reserve imperative language for actual blockers.',
      'Assume the author has context you lack until proven otherwise.',
    ],
    tags: ['questions', 'collaborative-review'],
  },
  {
    id: 'docs-minimal',
    name: 'Minimal Docs',
    description: 'Writes only the docs that explain non-obvious decisions.',
    category: 'documentation',
    section: 'Documentation',
    bullets: [
      'Document the why, never the what; the code shows the what.',
      'Skip docstrings on self-explanatory functions and trivial types.',
      'Write a short comment only where a reader would otherwise ask "why?".',
    ],
    tags: ['minimal-docs', 'why-not-what'],
  },
  {
    id: 'docs-thorough',
    name: 'Thorough Docs',
    description: 'Documents every public symbol with intent, params, and examples.',
    category: 'documentation',
    section: 'Documentation',
    bullets: [
      'Every exported function, type, and module has a docstring describing intent and contract.',
      'Document parameters, return values, errors, and side effects explicitly.',
      'Include a runnable example for any non-trivial public API.',
    ],
    tags: ['thorough-docs', 'docstrings'],
  },
  {
    id: 'examples-required',
    name: 'Examples Required',
    description: 'Pairs every public API with at least one runnable example.',
    category: 'documentation',
    section: 'Documentation',
    bullets: [
      'Ship every public API with at least one runnable usage example.',
      'Keep examples short, self-contained, and executable in isolation.',
      'Verify examples in CI so they never drift from the code.',
    ],
    tags: ['examples', 'usage'],
  },
  {
    id: 'adr-first',
    name: 'ADR First',
    description: 'Captures architecture decisions as numbered records.',
    category: 'documentation',
    section: 'Documentation',
    bullets: [
      'For any decision with long-term impact, write an ADR before implementing.',
      'State the context, alternatives, decision, and consequences in the ADR.',
      'Number ADRs sequentially and never delete them; supersede instead.',
    ],
    tags: ['adr', 'architecture-decisions'],
  },
  {
    id: 'changelog-discipline',
    name: 'Changelog Discipline',
    description: 'Updates the changelog with every user-visible change.',
    category: 'documentation',
    section: 'Documentation',
    bullets: [
      'Add a changelog entry for every user-visible change in the same commit.',
      'Group entries under Added, Changed, Deprecated, Removed, Fixed, Security.',
      'Write entries from the user\'s perspective, not the implementer\'s.',
    ],
    tags: ['changelog', 'keep-a-changelog'],
  },
  {
    id: 'inline-comments-only',
    name: 'Inline Comments Only',
    description: 'Keeps documentation next to the code it describes.',
    category: 'documentation',
    section: 'Documentation',
    bullets: [
      'Prefer inline comments and docstrings over separate markdown documentation.',
      'When external docs are needed, generate them from the inline sources.',
      'Never let external docs contradict the code; delete them if they drift.',
    ],
    tags: ['inline', 'single-source'],
  },
  {
    id: 'hypothesis-driven-debug',
    name: 'Hypothesis Driven',
    description: 'Debugs by stating and testing explicit hypotheses.',
    category: 'debugging',
    section: 'Debugging approach',
    bullets: [
      'State an explicit hypothesis before each debugging action.',
      'Describe what observation would confirm or refute the hypothesis.',
      'If three hypotheses fail, stop and re-examine your assumptions from scratch.',
    ],
    tags: ['hypothesis', 'scientific-debugging'],
  },
  {
    id: 'binary-search-debug',
    name: 'Binary Search Debug',
    description: 'Narrows down bugs by bisecting code, commits, or inputs.',
    category: 'debugging',
    section: 'Debugging approach',
    bullets: [
      'When a bug was recently introduced, bisect commits to find the offender.',
      'When a bug is in a long pipeline, halve the input or code path until it localizes.',
      'Record each bisection step so the path to the root cause is reproducible.',
    ],
    tags: ['bisect', 'binary-search'],
  },
  {
    id: 'log-first-debug',
    name: 'Log First Debug',
    description: 'Adds structured logs before reaching for a debugger.',
    category: 'debugging',
    section: 'Debugging approach',
    bullets: [
      'Add structured logs at decision points before stepping through with a debugger.',
      'Log the inputs, outputs, and branch taken at each suspect boundary.',
      'Remove or downgrade debug logs before merging.',
    ],
    tags: ['logging', 'tracing'],
  },
  {
    id: 'reproduce-first',
    name: 'Reproduce First',
    description: 'Gets a reliable reproduction before attempting any fix.',
    category: 'debugging',
    section: 'Debugging approach',
    bullets: [
      'Never attempt a fix until you can reproduce the bug on demand.',
      'Capture the reproduction as a failing test before changing production code.',
      'If the bug cannot be reproduced, instrument the system until it can.',
    ],
    tags: ['repro', 'regression-test'],
  },
  {
    id: 'five-whys',
    name: 'Five Whys',
    description: 'Drills past the first symptom to the root cause.',
    category: 'debugging',
    section: 'Debugging approach',
    bullets: [
      'For every bug, ask "why" at least five times to reach a root cause, not a symptom.',
      'Record the chain of causes in the commit or PR description.',
      'Fix the deepest cause that is economical to address, not the surface symptom.',
    ],
    tags: ['root-cause', 'five-whys'],
  },
  {
    id: 'yagni',
    name: 'YAGNI',
    description: 'Builds only what is needed right now.',
    category: 'architecture',
    section: 'Architecture',
    bullets: [
      'Implement only the behavior required by a current, concrete caller.',
      'Delete dead code, unused parameters, and speculative abstractions on sight.',
      'Never add configuration until a second caller needs a different value.',
    ],
    tags: ['yagni', 'simplicity'],
  },
  {
    id: 'dry-with-care',
    name: 'DRY With Care',
    description: 'Deduplicates only when duplication represents the same idea.',
    category: 'architecture',
    section: 'Architecture',
    bullets: [
      'Extract a helper only after seeing the same logic represent the same concept three times.',
      'Prefer duplication over the wrong abstraction.',
      'When deduplicating, name the concept the new helper represents.',
    ],
    tags: ['dry', 'rule-of-three'],
  },
  {
    id: 'solid-strict',
    name: 'SOLID Strict',
    description: 'Applies SOLID principles rigorously to OO designs.',
    category: 'architecture',
    section: 'Architecture',
    bullets: [
      'Each class has one reason to change; split classes that mix responsibilities.',
      'Depend on abstractions at module boundaries, not concrete implementations.',
      'Clients should never be forced to depend on methods they do not use.',
    ],
    tags: ['solid', 'oop'],
  },
  {
    id: 'functional-core',
    name: 'Functional Core',
    description: 'Keeps pure logic at the core and side effects at the edge.',
    category: 'architecture',
    section: 'Architecture',
    bullets: [
      'Keep business logic pure: no I/O, no clocks, no randomness in core functions.',
      'Push side effects to a thin imperative shell that calls the pure core.',
      'Pass data in and out explicitly; avoid hidden mutable state.',
    ],
    tags: ['functional-core', 'imperative-shell'],
  },
  {
    id: 'hexagonal-architecture',
    name: 'Hexagonal',
    description: 'Organizes code around ports and adapters.',
    category: 'architecture',
    section: 'Architecture',
    bullets: [
      'Define ports (interfaces) for every external dependency the domain needs.',
      'Place adapters at the boundary; domain code never imports infrastructure.',
      'Test the domain through ports, swapping in fakes for adapters.',
    ],
    tags: ['hexagonal', 'ports-adapters'],
  },
  {
    id: 'event-driven',
    name: 'Event Driven',
    description: 'Models state changes as immutable events.',
    category: 'architecture',
    section: 'Architecture',
    bullets: [
      'Represent state changes as named, immutable events rather than in-place mutations.',
      'Derive current state by folding over events; never lose history.',
      'Publish events at module boundaries so consumers can react without coupling.',
    ],
    tags: ['events', 'cqrs', 'event-sourcing'],
  },
  {
    id: 'composition-over-inheritance',
    name: 'Composition Over Inheritance',
    description: 'Reaches for composition before class hierarchies.',
    category: 'architecture',
    section: 'Architecture',
    bullets: [
      'Reach for composition and interfaces before subclassing.',
      'Use inheritance only for true is-a relationships with stable contracts.',
      'Never extend a class just to reuse a few of its methods.',
    ],
    tags: ['composition', 'inheritance'],
  },
  {
    id: 'boy-scout',
    name: 'Boy Scout Rule',
    description: 'Leaves every file a little cleaner than you found it.',
    category: 'refactoring',
    section: 'Refactoring',
    bullets: [
      'Leave every file you touch at least slightly cleaner than you found it.',
      'Fix bad names, dead code, and misleading comments when you pass through them.',
      'Keep cleanup scoped to what you touched; do not sprawl.',
    ],
    tags: ['boy-scout', 'continuous-cleanup'],
  },
  {
    id: 'preserve-behavior',
    name: 'Preserve Behavior',
    description: 'Refactors without changing observable behavior.',
    category: 'refactoring',
    section: 'Refactoring',
    bullets: [
      'When refactoring, do not change observable behavior or tests in the same commit.',
      'Run the full test suite before and after each refactoring step.',
      'If a test needs to change, that is a behavior change; split it into its own commit.',
    ],
    tags: ['refactor', 'safe-refactor'],
  },
  {
    id: 'separate-refactor-commits',
    name: 'Separate Refactor Commits',
    description: 'Splits refactors and behavior changes into distinct commits.',
    category: 'refactoring',
    section: 'Refactoring',
    bullets: [
      'Never mix a refactor with a behavior change in the same commit.',
      'Name refactor commits with a "refactor:" prefix so reviewers can skim them.',
      'When tempted to refactor mid-fix, stash, commit the refactor first, then resume.',
    ],
    tags: ['commit-hygiene', 'refactor'],
  },
  {
    id: 'extract-then-inline',
    name: 'Extract Then Inline',
    description: 'Uses extract and inline as the primary refactoring moves.',
    category: 'refactoring',
    section: 'Refactoring',
    bullets: [
      'To understand tangled code, extract pieces into named helpers until structure emerges.',
      'Once structure is clear, inline helpers that no longer earn their name.',
      'Let naming drive the structure, not the other way around.',
    ],
    tags: ['extract', 'inline', 'naming'],
  },
  {
    id: 'rename-aggressively',
    name: 'Rename Aggressively',
    description: 'Renames as soon as a better name appears.',
    category: 'refactoring',
    section: 'Refactoring',
    bullets: [
      'Rename a symbol the moment you think of a clearer name.',
      'Names should describe intent and units, not implementation.',
      'Commit renames separately so diffs stay reviewable.',
    ],
    tags: ['rename', 'naming'],
  },
  {
    id: 'measure-first',
    name: 'Measure First',
    description: 'Profiles before optimizing anything.',
    category: 'performance',
    section: 'Performance',
    bullets: [
      'Never optimize without a profile or benchmark identifying the hot path.',
      'Record a baseline measurement before any performance change.',
      'Reject performance claims that are not backed by numbers.',
    ],
    tags: ['profile', 'benchmark'],
  },
  {
    id: 'big-o-aware',
    name: 'Big-O Aware',
    description: 'States and checks algorithmic complexity for data-heavy code.',
    category: 'performance',
    section: 'Performance',
    bullets: [
      'State the time and space complexity of any non-trivial algorithm in a comment.',
      'Flag any nested loop over user-scaled data as a complexity hazard.',
      'Prefer O(n) solutions over O(n log n) only when n is provably small or constant.',
    ],
    tags: ['complexity', 'big-o'],
  },
  {
    id: 'avoid-premature-opt',
    name: 'Avoid Premature Optimization',
    description: 'Writes clear code first and optimizes only when required.',
    category: 'performance',
    section: 'Performance',
    bullets: [
      'Write the clearest correct solution first; optimize only against a measured target.',
      'Never trade readability for speed without a benchmark showing the trade is worth it.',
      'Document any non-obvious optimization with the benchmark that justified it.',
    ],
    tags: ['premature-optimization', 'clarity'],
  },
  {
    id: 'allocation-conscious',
    name: 'Allocation Conscious',
    description: 'Minimizes unnecessary allocations on hot paths.',
    category: 'performance',
    section: 'Performance',
    bullets: [
      'On hot paths, preallocate buffers and reuse them across iterations.',
      'Avoid constructing intermediate collections just to transform them.',
      'Prefer streaming and iterators over materializing entire datasets.',
    ],
    tags: ['allocations', 'gc'],
  },
  {
    id: 'cache-aware',
    name: 'Cache Aware',
    description: 'Considers locality and cache behavior in hot code.',
    category: 'performance',
    section: 'Performance',
    bullets: [
      'Lay out hot data contiguously and traverse it in memory order.',
      'Prefer arrays of structs or structs of arrays based on actual access patterns.',
      'Avoid pointer-chasing in inner loops on large datasets.',
    ],
    tags: ['cache', 'locality'],
  },
  {
    id: 'latency-budget',
    name: 'Latency Budget',
    description: 'Designs against explicit per-request latency budgets.',
    category: 'performance',
    section: 'Performance',
    bullets: [
      'State a latency budget for each request path and allocate it across stages.',
      'Measure p50, p95, and p99 latencies, not just averages.',
      'Reject any change that silently blows the budget at p95.',
    ],
    tags: ['latency', 'slo'],
  },
  {
    id: 'pair-mode',
    name: 'Pair Mode',
    description: 'Acts as an engaged pair-programming partner.',
    category: 'collaboration',
    section: 'Collaboration',
    bullets: [
      'Narrate your reasoning as you go, as a pair partner would.',
      'Before typing, state what you intend to do and why.',
      'Pause at natural checkpoints and invite the user to drive or object.',
    ],
    tags: ['pair', 'pairing'],
  },
  {
    id: 'async-friendly',
    name: 'Async Friendly',
    description: 'Produces self-contained written artifacts for async review.',
    category: 'collaboration',
    section: 'Collaboration',
    bullets: [
      'Summarize every session with a written handoff another engineer could resume from.',
      'Include open questions, known gotchas, and next steps in every summary.',
      'Never assume synchronous follow-up; write as if the reader is in another timezone.',
    ],
    tags: ['async', 'remote'],
  },
  {
    id: 'pr-discipline',
    name: 'PR Discipline',
    description: 'Keeps pull requests small, focused, and well-described.',
    category: 'collaboration',
    section: 'Collaboration',
    bullets: [
      'Keep each PR under ~400 lines of diff where possible; split larger work.',
      'Every PR has one purpose stated in its title and described in its body.',
      'PR descriptions explain motivation, approach, and testing performed.',
    ],
    tags: ['pr', 'pull-request'],
  },
  {
    id: 'commit-hygiene',
    name: 'Commit Hygiene',
    description: 'Crafts atomic commits with well-formed messages.',
    category: 'collaboration',
    section: 'Collaboration',
    bullets: [
      'Each commit is atomic: one logical change that leaves the tree green.',
      'Write commit messages with a 50-char imperative subject and a wrapped body explaining why.',
      'Use conventional prefixes (feat, fix, refactor, docs, test, chore) consistently.',
    ],
    tags: ['commits', 'conventional-commits'],
  },
  {
    id: 'handoff-notes',
    name: 'Handoff Notes',
    description: 'Ends every session with a structured handoff note.',
    category: 'collaboration',
    section: 'Collaboration',
    bullets: [
      'End each session with a handoff note listing what changed, what is pending, and what is blocked.',
      'List every file touched and why in the handoff.',
      'Capture commands needed to resume work in a runnable form.',
    ],
    tags: ['handoff', 'session-summary'],
  },
  {
    id: 'conflict-surface',
    name: 'Surface Conflicts',
    description: 'Raises disagreements early rather than working around them.',
    category: 'collaboration',
    section: 'Collaboration',
    bullets: [
      'When you disagree with a request, state the disagreement and your reasoning once.',
      'After stating your concern, proceed with the user\'s decision unless it risks harm.',
      'Never silently sandbag a task you disagree with.',
    ],
    tags: ['disagree-and-commit'],
  },
  {
    id: 'rust-idiomatic',
    name: 'Rust Idiomatic',
    description: 'Follows canonical Rust ownership and error conventions.',
    category: 'domain',
    section: 'Language idioms',
    bullets: [
      'Model errors with enums and the `?` operator; never use `unwrap` in library code.',
      'Accept borrowed slices (`&str`, `&[T]`) in function signatures where ownership is not needed.',
      'Use iterators and combinators over explicit index loops.',
      'Run `cargo clippy` and address every lint before declaring work done.',
    ],
    tags: ['rust', 'clippy'],
  },
  {
    id: 'ts-strict',
    name: 'TypeScript Strict',
    description: 'Relies on the strictest TypeScript settings and narrow types.',
    category: 'domain',
    section: 'Language idioms',
    bullets: [
      'Enable `strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`.',
      'Never use `any`; use `unknown` with narrowing or generics instead.',
      'Prefer discriminated unions over optional fields for state modeling.',
      'Type function boundaries explicitly; let inference handle locals.',
    ],
    tags: ['typescript', 'strict'],
  },
  {
    id: 'react-hooks-rules',
    name: 'React Hooks Rules',
    description: 'Follows the rules of hooks and modern React patterns.',
    category: 'domain',
    section: 'Framework conventions',
    bullets: [
      'Call hooks only at the top level of components and custom hooks, never conditionally.',
      'Include every reactive value in effect dependency arrays; never suppress the lint.',
      'Derive state during render where possible; reach for `useState` only for true state.',
      'Extract reusable stateful logic into custom hooks named `use*`.',
    ],
    tags: ['react', 'hooks'],
  },
  {
    id: 'python-typed',
    name: 'Python Typed',
    description: 'Writes fully type-annotated, mypy-clean Python.',
    category: 'domain',
    section: 'Language idioms',
    bullets: [
      'Annotate every function signature and public attribute with types.',
      'Run `mypy --strict` (or equivalent) and fix every error.',
      'Prefer `dataclass` or `pydantic` models over untyped dicts for structured data.',
      'Use `Protocol` for structural typing instead of inheritance-based interfaces.',
    ],
    tags: ['python', 'mypy', 'typing'],
  },
  {
    id: 'go-idioms',
    name: 'Go Idioms',
    description: 'Follows idiomatic Go for errors, concurrency, and style.',
    category: 'domain',
    section: 'Language idioms',
    bullets: [
      'Return errors explicitly and wrap with context via `fmt.Errorf("...: %w", err)`.',
      'Accept interfaces, return concrete types.',
      'Pass `context.Context` as the first argument to any function that blocks or does I/O.',
      'Run `go vet` and `staticcheck` and address every finding.',
    ],
    tags: ['go', 'golang'],
  },
  {
    id: 'sql-safe',
    name: 'SQL Safe',
    description: 'Writes parameterized, explicit, index-aware SQL.',
    category: 'domain',
    section: 'Database conventions',
    bullets: [
      'Always use parameterized queries; never interpolate values into SQL strings.',
      'List columns explicitly in `SELECT` and `INSERT`; never use `SELECT *` in production code.',
      'Check the query plan for any new query touching a large table.',
      'Wrap multi-statement writes in an explicit transaction.',
    ],
    tags: ['sql', 'database'],
  },
  {
    id: 'k8s-aware',
    name: 'Kubernetes Aware',
    description: 'Writes Kubernetes manifests that are safe and production-ready.',
    category: 'domain',
    section: 'Infrastructure conventions',
    bullets: [
      'Set resource `requests` and `limits` on every container.',
      'Define readiness and liveness probes for every workload.',
      'Run containers as non-root with a read-only root filesystem where feasible.',
      'Pin images by digest, not tag, for reproducible deploys.',
    ],
    tags: ['kubernetes', 'k8s', 'devops'],
  },
  {
    id: 'twelve-factor',
    name: 'Twelve Factor',
    description: 'Follows twelve-factor principles for services.',
    category: 'domain',
    section: 'Infrastructure conventions',
    bullets: [
      'Read all configuration from environment variables, never from files baked into the image.',
      'Treat logs as event streams written to stdout; never write log files from the app.',
      'Design processes to be stateless and disposable; persist state in backing services.',
    ],
    tags: ['twelve-factor', 'cloud-native'],
  },
  {
    id: 'accessibility-first',
    name: 'Accessibility First',
    description: 'Treats a11y as a baseline requirement for every UI change.',
    category: 'domain',
    section: 'Frontend conventions',
    bullets: [
      'Use semantic HTML elements before reaching for ARIA.',
      'Ensure every interactive element is reachable and operable by keyboard.',
      'Provide accessible names for icons, buttons, and form controls.',
      'Verify color contrast meets WCAG AA for all text.',
    ],
    tags: ['a11y', 'accessibility', 'wcag'],
  },
  {
    id: 'i18n-aware',
    name: 'Internationalization Aware',
    description: 'Keeps user-facing strings externalized and locale-safe.',
    category: 'domain',
    section: 'Frontend conventions',
    bullets: [
      'Never hardcode user-facing strings; route them through the i18n layer.',
      'Format dates, numbers, and currencies through locale-aware APIs.',
      'Avoid string concatenation for sentences; use interpolation with named placeholders.',
    ],
    tags: ['i18n', 'l10n'],
  },
  {
    id: 'observability-minded',
    name: 'Observability Minded',
    description: 'Instruments code with logs, metrics, and traces by default.',
    category: 'architecture',
    section: 'Observability',
    bullets: [
      'Emit a structured log with correlation id at every service boundary.',
      'Add a metric for every operation whose rate, latency, or error count matters.',
      'Propagate trace context across async boundaries and external calls.',
    ],
    tags: ['observability', 'telemetry'],
  },
  {
    id: 'feature-flag-rollouts',
    name: 'Feature Flag Rollouts',
    description: 'Ships risky changes behind flags with a rollback plan.',
    category: 'working-style',
    section: 'Working style',
    bullets: [
      'Put any risky or user-visible change behind a feature flag by default.',
      'Document the rollout and rollback plan in the PR description.',
      'Remove flags promptly once the change is fully rolled out.',
    ],
    tags: ['feature-flags', 'rollout'],
  },
  {
    id: 'backwards-compatible',
    name: 'Backwards Compatible',
    description: 'Treats public interfaces as contracts that cannot silently break.',
    category: 'architecture',
    section: 'Architecture',
    bullets: [
      'Never change the shape of a public API without a deprecation path.',
      'Add new optional fields rather than renaming or removing existing ones.',
      'Version any breaking change and keep the old version running until consumers migrate.',
    ],
    tags: ['compat', 'versioning'],
  },
  {
    id: 'error-handling-explicit',
    name: 'Explicit Errors',
    description: 'Treats error paths as first-class, not afterthoughts.',
    category: 'architecture',
    section: 'Error handling',
    bullets: [
      'Name every error condition; never swallow exceptions silently.',
      'Attach enough context to each error for a reader to diagnose without a debugger.',
      'Distinguish expected failures (return them) from bugs (raise/panic).',
    ],
    tags: ['errors', 'exceptions'],
  },
  {
    id: 'idempotency',
    name: 'Idempotent Operations',
    description: 'Designs write operations to be safely retryable.',
    category: 'architecture',
    section: 'Architecture',
    bullets: [
      'Make every external write operation idempotent or protected by an idempotency key.',
      'Never assume a network call succeeded just because the request was sent.',
      'Design retries with exponential backoff and a cap on attempts.',
    ],
    tags: ['idempotency', 'retries'],
  },
  {
    id: 'null-safety',
    name: 'Null Safety',
    description: 'Makes the absence of values explicit in the type system.',
    category: 'architecture',
    section: 'Architecture',
    bullets: [
      'Represent optional values with `Option`/`Maybe`/`| null` explicitly in types.',
      'Handle the absent case at the boundary, not deep in business logic.',
      'Never use null as a sentinel for error or default.',
    ],
    tags: ['null', 'optional'],
  },
  {
    id: 'migration-safety',
    name: 'Migration Safety',
    description: 'Writes database migrations that are reversible and online-safe.',
    category: 'domain',
    section: 'Database conventions',
    bullets: [
      'Make every migration safe to run while the old code is still live.',
      'Expand-then-contract: add new columns, backfill, switch reads, then drop old ones.',
      'Provide a tested down-migration for every up-migration.',
    ],
    tags: ['migrations', 'schema'],
  },
  {
    id: 'concurrency-careful',
    name: 'Concurrency Careful',
    description: 'Treats shared mutable state as a serious hazard.',
    category: 'architecture',
    section: 'Concurrency',
    bullets: [
      'Prefer message passing or immutable data over shared mutable state.',
      'Document the locking order for every mutex to prevent deadlocks.',
      'Never hold a lock across I/O or an await point.',
    ],
    tags: ['concurrency', 'threads', 'async'],
  },
  {
    id: 'contract-tests',
    name: 'Contract Tests',
    description: 'Verifies assumptions at every service boundary.',
    category: 'testing',
    section: 'Testing discipline',
    bullets: [
      'For every external service you depend on, write a contract test that pins its observed behavior.',
      'Run contract tests against a real or high-fidelity fake of the dependency.',
      'Fail loudly when a contract drifts; do not paper over it in the client.',
    ],
    tags: ['contract-tests', 'boundaries'],
  },
  {
    id: 'deprecation-discipline',
    name: 'Deprecation Discipline',
    description: 'Removes dead and deprecated code on a schedule.',
    category: 'refactoring',
    section: 'Refactoring',
    bullets: [
      'Mark deprecated APIs with a clear annotation and a removal date.',
      'When adding a replacement, update all internal callers in the same change.',
      'Delete deprecated code once the removal date passes; do not let it linger.',
    ],
    tags: ['deprecation', 'cleanup'],
  },
  {
    id: 'defensive-assertions',
    name: 'Defensive Assertions',
    description: 'Encodes invariants as runtime assertions at trust boundaries.',
    category: 'architecture',
    section: 'Architecture',
    bullets: [
      'Assert invariants at the entry of public functions to fail fast on violations.',
      'Prefer assertions that describe the violated invariant in plain language.',
      'Never use assertions for user-input validation; use real error returns there.',
    ],
    tags: ['assertions', 'invariants', 'fail-fast'],
  },
]
