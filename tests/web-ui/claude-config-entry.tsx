// Bundle entry for the real-Chromium Claude config screenshot spec. Mounts the real
// HomeClaudeConfig (location.hash `#home`) or ProjectClaudeConfig (`#project`) over a stub
// window.api backed by an in-memory file tree that mirrors the design's sample data
// (session-manager-operations/design-mocks/claude-config/config-data.js, commit 5931a062):
//   Home    ~/.claude — CLAUDE.md with two @imports, 3 MCP servers, 6 skills, 4 plugins, 9 agents.
//   Project "Self"    — 9 memory files, no CLAUDE.md yet, 5 MCP servers, 13 skills.
// Nothing here touches a real disk: every write resolves in memory.
import { createRoot } from 'react-dom/client'
import { HomeClaudeConfig } from '../../src/renderer/components/tabs/HomeClaudeConfig'
import { ProjectClaudeConfig } from '../../src/renderer/components/tabs/ProjectClaudeConfig'
import { useSessions, type SessionTab } from '../../src/renderer/state/sessions'
import { useLayout } from '../../src/renderer/state/layout'

const HOME = '/home/user'
const CWD = `${HOME}/Projects/Self`
const MEM_DIR = `${HOME}/.claude/projects/${CWD.replace(/\//g, '-')}/memory`
const now = Date.now()

// ---- the in-memory file tree ------------------------------------------------------------
const files = new Map<string, { text: string; mtimeMs: number }>()
const dirs = new Set<string>()
const put = (p: string, body: unknown, agoMin = 30) =>
  files.set(p, { text: typeof body === 'string' ? body : JSON.stringify(body, null, 2), mtimeMs: now - agoMin * 60_000 })
const fm = (fields: Record<string, string>, body: string) =>
  `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n${body}\n`

// Home: ~/.claude/CLAUDE.md (G.claudeMd) and its two imports (G.imports: 42 + 18 lines).
put(`${HOME}/.claude/CLAUDE.md`, [
  '# House rules', '', 'Plain language everywhere: records, commits, PR descriptions.', '',
  '## Before you say it works', '', "- Run the project's own test command and read the output.",
  '- Name each file you changed, and why, in one line.', '', '## Never', '',
  '- Re-add something the owner deleted. Ask first.', '- Push to `main` without a green check.', '',
  '@~/.claude/rules/git.md', '@~/.claude/rules/writing.md',
].join('\n'), 20)
const lines = (title: string, n: number) => [`# ${title}`, ...Array.from({ length: n - 1 }, (_, i) => `- rule ${i + 1}`)].join('\n')
put(`${HOME}/.claude/rules/git.md`, lines('Git', 42), 600)
put(`${HOME}/.claude/rules/writing.md`, lines('Writing', 18), 600)
const IMPORTS = [`${HOME}/.claude/rules/git.md`, `${HOME}/.claude/rules/writing.md`]

// Home settings + enabled plugins.
const PLUGINS = [
  { name: 'commit-commands', on: true, adds: { commands: ['commit', 'commit-push-pr', 'clean_gone'] } },
  { name: 'frontend-design', on: true, adds: { skills: ['frontend-design'] } },
  { name: 'pr-review-toolkit', on: false, adds: { commands: ['review-pr'], agents: ['code-reviewer', 'test-analyzer', 'comment-analyzer', 'type-design-analyzer', 'silent-failure-hunter', 'code-simplifier'] } },
  { name: 'security-guidance', on: true, adds: { hooks: true } },
] as const
const MKT = 'claude-plugins-official'
put(`${HOME}/.claude/settings.json`, {
  model: 'opus',
  language: 'English',
  enabledPlugins: Object.fromEntries(PLUGINS.map((p) => [`${p.name}@${MKT}`, p.on])),
}, 240)

// Home MCP: ~/.claude.json with the design's 3 servers.
const homeServers = {
  playwright: { command: 'npx', args: ['@playwright/mcp@latest'] },
  context7: { type: 'http', url: 'https://mcp.context7.com/mcp' },
  github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/' },
}
const claudeJson = { numStartups: 42, mcpServers: homeServers }
put(`${HOME}/.claude.json`, claudeJson, 15)

// Home skills (G.skills); the first one carries G.skillSrc.
const HOME_LONG_SKILL = 'pdf-long-title-overflow-check-skill-name-that-keeps-going-well-past-the-panel-width'
const HOME_SKILLS: Array<[string, string]> = [
  ['pdf', 'Read, fill, split and merge PDF files. Use when a task involves a .pdf.'],
  ['docx', 'Create and edit Word documents, keeping tracked changes and comments.'],
  ['xlsx', 'Read and write spreadsheets, formulas included.'],
  ['pptx', 'Build and edit slide decks from an outline.'],
  ['skill-creator', 'Write a new skill: folder, SKILL.md and a first test run.'],
  ['webapp-testing', 'Drive a local web app in a real browser to check a change.'],
  [HOME_LONG_SKILL, 'Stub skill for the search panel overflow check: pdf'],
]
const PDF_BODY = ['', '# pdf', '', 'Work on PDF files with tools already on this machine.', '', '## Read', '', '- Text: `pdftotext -layout in.pdf -`', '- Scanned pages: run `ocrmypdf in.pdf out.pdf` first.', '', '## Fill a form', '', '1. List the fields: `python3 scripts/fields.py form.pdf`', '2. Put the values in `fields.json`.', '3. Fill: `python3 scripts/fill.py form.pdf fields.json out.pdf`', '', '## Split or merge', '', '```', 'qpdf in.pdf --pages . 1-3 -- part.pdf', 'qpdf --empty --pages a.pdf b.pdf -- merged.pdf', '```'].join('\n')
for (const [name, description] of HOME_SKILLS) {
  put(`${HOME}/.claude/skills/${name}/SKILL.md`, fm({ name, description }, name === 'pdf' ? PDF_BODY : `\n# ${name}\n\n${description}`), 90)
}

// Installed plugins (G.plugins).
const CACHE = `${HOME}/.claude/plugins/cache/${MKT}`
const installPath = (n: string) => `${CACHE}/${n}/1.0.0`
put(`${HOME}/.claude/plugins/installed_plugins.json`, {
  version: 2,
  plugins: Object.fromEntries(PLUGINS.map((p) => [`${p.name}@${MKT}`, [{ scope: 'user', installPath: installPath(p.name), version: '1.0.0' }]])),
}, 240)
const CMD_DESC: Record<string, string> = {
  commit: 'Write a git commit for the staged changes',
  'commit-push-pr': 'Commit, push and open a pull request',
  clean_gone: 'Delete local branches whose remote is gone',
  'review-pr': 'Review the open pull request',
}
for (const p of PLUGINS) {
  const dir = installPath(p.name)
  put(`${dir}/.claude-plugin/plugin.json`, { name: p.name, version: '1.0.0', description: `${p.name.replace(/-/g, ' ')} for Claude Code.` })
  const adds = p.adds as { commands?: readonly string[]; skills?: readonly string[]; agents?: readonly string[]; hooks?: boolean }
  for (const c of adds.commands ?? []) put(`${dir}/commands/${c}.md`, fm({ description: CMD_DESC[c] ?? c }, `Run ${c}.`))
  for (const s of adds.skills ?? []) put(`${dir}/skills/${s}/SKILL.md`, fm({ name: s, description: 'Build distinctive front-end interfaces.' }, `# ${s}`))
  for (const a of adds.agents ?? []) put(`${dir}/agents/${a}.md`, fm({ name: a, description: `The ${a} agent.` }, 'Review.'))
  if (adds.hooks) put(`${dir}/hooks/hooks.json`, { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'security-guidance pre-tool' }] }] } })
}

// Agents (G.agents) — ~/.claude/agents/*.md; the first one carries G.agentPrompt.
const AGENTS: Array<[string, string, string]> = [
  ['architect', 'opus', 'Designs the shape of a change before anyone builds it.'],
  ['bilko-ceo', 'opus', "Sets the week's priorities for Bilko."],
  ['bilko-host-publisher', 'sonnet', 'Publishes finished pages and checks they load.'],
  ['blender-artist', 'sonnet', 'Builds and renders 3D scenes from a brief.'],
  ['builder', 'sonnet', 'Implements a design end to end, with tests.'],
  ['competitive-analyst', 'sonnet', 'Compares a product with named rivals.'],
  ['competitive-researcher', 'haiku', 'Finds who else solves the problem.'],
  ['demo-video-builder', 'sonnet', 'Turns a working feature into a short demo.'],
  ['dev-lead', 'opus', 'Reviews plans and diffs, splits work into Epics.'],
]
const ARCHITECT_PROMPT = ['You are the architect for this workspace.', '', 'Before any code is written, write a short design:', '', '1. The problem, in one sentence.', '2. What changes, and what must not.', '3. The data flow, step by step.', '4. Each risk, and how it will be checked.', '', 'Keep it under a page. Name files, not concepts.', 'Hand the builder a checklist, not an essay.'].join('\n')
const personas = AGENTS.map(([name, model, description], i) => {
  const body = i === 0 ? ARCHITECT_PROMPT : `You are ${name}. ${description}`
  const path = `${HOME}/.claude/agents/${name}.md`
  put(path, fm({ name, description, model }, `\n${body}`), 60 * (i + 1))
  return {
    name, description, model, tools: [], effort: null, agentCli: null, agentCliModel: null, color: null,
    tags: [], projects: [], action: null, actionLabel: null, title: null, seedVersion: null, executorOnly: false,
    path, body, overridingProjects: [], overrideDetails: [],
  }
})

// Project "Self": memory files (memories), no CLAUDE.md, settings, 5 MCP servers, 13 skills.
const MEMORIES: Array<[string, string, number, number]> = [
  ['portfolio-action-project-field', 'Portfolio ledger - never set action.project to burrow, Bilko or Self (the owner deleted those project entries 2026-11-12); name the repo in ref. Also: a Burrow action auto-marked done is not proof the pipeline runs', 4.8, 1],
  ['bilko-run-clicks-are-not-people', 'Before a Portfolio decision cites bilko.run clicks, check they are people — bot and preview traffic inflate them', 3.9, 1],
  ['portfolio-readings-trend', '2026-11-20 Epic 94b1a05a — goal readings → trend lines, never single points', 1.5, 1],
  ['portfolio-list-alignment', '2026-11-19 bug Epic 5f093431 - Portfolio list columns must line up across rows', 3.0, 1440],
  ['portfolio-decisions-are-steps', 'Owner 2026-11-15 - a Portfolio decision is an action step, not a note', 8.7, 1440],
  ['portfolio-habits-grow-independently', 'Owner 2026-11-12 values the Habit vs Number split — habits grow on their own track', 2.6, 1440],
  ['portfolio-plain-language', 'Owner 2026-11-19 - Portfolio records must be written in plain language', 1.2, 1440],
  ['human-for-hire-card-self-owned', '2026-11-19 owner - Human For Hire is pitched by Self and owned by Self', 3.0, 1440],
  ['burrow-long-title-overflow-check-memory-name-that-keeps-going-well-past-the-panel-width', 'Stub entry for the search panel overflow check: burrow', 1.0, 1440],
  ['kiln-idea-tool', '2026-11-15 Epic 07f2a491: Kiln business-idea tool scope and first readings', 13.6, 5760],
]
const MEM_BODY = [
  'Two lessons from the Portfolio pulse of 2026-11-20 (my own findings, not owner words).', '',
  '**1. Omit `project` on action rows for internal tools.** The owner deleted the `burrow`, `Bilko`, `Self` and `social-signals-trader` entries from `portfolio.yaml` `projects` on 2026-11-12.', '',
  '**Why:** a record the owner deleted is gone on purpose; agents never re-add it.', '',
  '**How to apply:** on an action row, leave `project` out unless it is a key in `portfolio.yaml` `projects`; name the carrying repo in `ref`.',
].join('\n')
const memoryText = new Map<string, string>()
for (const [slug, description] of MEMORIES) {
  const text = fm({ name: slug, description, type: 'feedback' }, `\n${MEM_BODY}`)
  memoryText.set(`${slug}.md`, text)
}
const memoryEntries = MEMORIES.map(([slug, , kb, agoMin]) => ({
  name: `${slug}.md`, path: `${MEM_DIR}/${slug}.md`, mtimeMs: now - agoMin * 60_000, bytes: Math.round(kb * 1024),
}))
for (const e of memoryEntries) files.set(e.path, { text: memoryText.get(e.name)!, mtimeMs: e.mtimeMs })
put(`${MEM_DIR}/MEMORY.md`, MEMORIES.map(([slug, d]) => `- [${slug}](${slug}.md) — ${d}`).join('\n'), 1)

put(`${CWD}/.claude/settings.json`, { model: 'opus', permissions: { allow: ['Bash(npm test:*)'] }, env: { TZ: 'America/Los_Angeles' } }, 600)
put(`${CWD}/.mcp.json`, {
  mcpServers: {
    burrow: { type: 'http', url: 'http://127.0.0.1:8767/mcp' },
    'gmail-bilko': { command: 'npx', args: ['-y', '@gongrzhe/server-gmail-autoauth-mcp'] },
    'gmail-sg': { command: 'npx', args: ['-y', '@gongrzhe/server-gmail-autoauth-mcp'] },
    kiln: { command: 'python3', args: ['kiln/mcp_server.py'] },
    satchel: { command: 'python3', args: ['satchel/mcp_server.py'] },
  },
}, 600)
const PROJECT_SKILLS: Array<[string, string]> = [
  ['bank-of-america-statements', 'Parse local Bank of America PDF eStatements (checking + mortgage) for the WA household into append-only structured data and refresh the served Bank-of-America page.'],
  ['invoice-cross-valley-water', 'Download, understand, process, and summarize the latest Cross Valley Water invoice into the household ledger.'],
  ['invoice-property-tax', 'Download, understand, process, and summarize the latest property-tax statement into the household ledger.'],
  ['invoice-pse', 'Download, understand, process, and summarize the latest PSE energy invoice into the household ledger.'],
  ['invoice-snohomish-pud', 'Download, understand, process, and summarize the latest Snohomish PUD invoice into the household ledger.'],
  ['invoice-united-parcel', 'Download, understand, process, and summarize the latest United invoice into the household ledger.'],
  ['invoice-waste-management', 'Download, understand, process, and summarize the latest Waste Management invoice into the household ledger.'],
  ['invoice-ziply-fiber', 'Download, understand, process, and summarize the latest Ziply Fiber invoice into the household ledger.'],
  ['portfolio', "One Portfolio run for Bilko's tools. Records the pulse, readings and actions in the ledger."],
  ['process-invoices', 'Wrapper that pools the per-service invoice skills into one run and reports what changed.'],
  ['process-mailbox', 'Sort the household mailbox into statements, invoices and everything else.'],
  ['refresh-household-pages', 'Rebuild the served household pages after any finance skill writes new data.'],
  ['tax-documents', "Collect the year's tax forms from the inbox into one checked folder."],
]
for (const [name, description] of PROJECT_SKILLS) {
  put(`${CWD}/.claude/skills/${name}/SKILL.md`, fm({ name, description }, `\n# ${name}\n\n${description}`), 300)
}
// Both scopes have an (empty) slash-commands folder, as in the design: no commands listed.
dirs.add(CWD).add(`${HOME}/.claude/commands`).add(`${CWD}/.claude/commands`)

// Every ancestor of a file is a directory.
for (const p of files.keys()) {
  for (let i = p.lastIndexOf('/'); i > 0; i = p.lastIndexOf('/', i - 1)) dirs.add(p.slice(0, i))
}

const base = (p: string) => p.slice(p.lastIndexOf('/') + 1)
const norm = (p: string) => p.replace(/^~(?=\/|$)/, HOME).replace(/\/+$/, '')
function listDir(path: string, opts: { filesOnly?: boolean; dirsOnly?: boolean; includeHidden?: boolean } = {}) {
  const dir = norm(path)
  if (!dirs.has(dir)) return { ok: false, entries: [], error: `ENOENT: no such file or directory, scandir '${dir}'` }
  const kids = new Map<string, boolean>() // name -> isDirectory
  for (const d of dirs) if (d.startsWith(`${dir}/`) && !d.slice(dir.length + 1).includes('/')) kids.set(base(d), true)
  for (const f of files.keys()) if (f.startsWith(`${dir}/`) && !f.slice(dir.length + 1).includes('/')) kids.set(base(f), false)
  const entries = [...kids]
    .filter(([n, isDir]) => (opts.includeHidden || !n.startsWith('.')) && (!opts.filesOnly || !isDir) && (!opts.dirsOnly || isDir))
    .map(([name, isDir]) => {
      const p = `${dir}/${name}`
      return { name, path: p, isDirectory: isDir, isFile: !isDir, mtimeMs: files.get(p)?.mtimeMs ?? now - 3_600_000, size: files.get(p)?.text.length ?? 0 }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
  return { ok: true, entries, error: null }
}
function readText(p: string) {
  const f = files.get(norm(p))
  return f
    ? { exists: true, text: f.text, mtimeMs: f.mtimeMs, error: null, truncated: false }
    : { exists: false, text: '', mtimeMs: 0, error: null, truncated: false }
}
function readJson(p: string) {
  const f = files.get(norm(p))
  if (!f) return { exists: false, raw: '', data: null, parseError: null, mtimeMs: 0, error: null }
  return { exists: true, raw: f.text, data: JSON.parse(f.text), parseError: null, mtimeMs: f.mtimeMs, error: null }
}
function parseImports(p: string) {
  if (norm(p) !== `${HOME}/.claude/CLAUDE.md`) return { ok: true, imports: [] }
  return {
    ok: true,
    imports: IMPORTS.map((path) => {
      const size = files.get(path)!.text.length
      return { path, exists: true, sizeBytes: size, tokenEstimate: Math.round(size / 4), ok: true }
    }),
  }
}

// ---- window.api -------------------------------------------------------------------------
const ok = async () => ({ ok: true, error: null, mtimeMs: now })
const writeText = async (p: string, text: string) => {
  put(norm(p), text, 0)
  return { ok: true, error: null, mtimeMs: files.get(norm(p))!.mtimeMs }
}
const api = {
  app: { homeDir: async () => HOME, cwd: async () => CWD, version: async () => '0.0.0', seedStatus: async () => null },
  config: {
    listDir: async (p: string, o?: { filesOnly?: boolean; dirsOnly?: boolean; includeHidden?: boolean }) => listDir(p, o),
    readText: async (p: string) => readText(p),
    readJson: async (p: string) => readJson(p),
    exists: async (p: string) => files.has(norm(p)) || dirs.has(norm(p)),
    writeText,
    writeJson: async (p: string, data: unknown) => writeText(p, JSON.stringify(data, null, 2)),
    canWrite: async () => ({ ok: true }),
    parseImports: async (p: string) => parseImports(p),
    watch: () => {},
    unwatch: () => {},
    onChanged: () => () => {},
  },
  claudeConfig: {
    read: async ({ fileId }: { fileId: string }) =>
      fileId === 'claudeJson'
        ? { path: `${HOME}/.claude.json`, data: claudeJson }
        : { path: `${HOME}/.claude/settings.json`, data: readJson(`${HOME}/.claude/settings.json`).data },
    patch: async () => ({ ok: true, path: `${HOME}/.claude.json`, data: claudeJson }),
  },
  plugins: {
    list: async () => PLUGINS.map((p) => ({
      key: `${p.name}@${MKT}`, name: p.name, marketplace: MKT, version: '1.0.0', scope: 'user', installPath: installPath(p.name), enabled: p.on,
    })),
    setEnabled: async () => ({ ok: true }),
    uninstall: async () => ({ ok: true, exitCode: 0 }),
    install: async () => ({ ok: true, exitCode: 0 }),
    onInstallProgress: () => () => {},
  },
  agents: {
    listPersonas: async () => personas,
    savePersona: async () => ({ ok: true, path: personas[0].path }),
    deletePersona: async () => ({ ok: true }),
    removeOverride: async () => ({ ok: true }),
    onChanged: () => () => {},
  },
  memory: {
    list: async () => ({ entries: memoryEntries, workspace: 'self', dir: MEM_DIR, autoMemoryEnabled: true, error: null }),
    read: async (name: string) => {
      const text = memoryText.get(name)
      return text ? { content: text, exists: true, mtimeMs: now, bytes: text.length, error: null } : { content: '', exists: false, mtimeMs: 0, bytes: 0, error: null }
    },
    write: ok,
    delete: ok,
    create: ok,
    stale: async () => ({ entries: [], workspace: 'self', error: null }),
    aggregate: async () => ({ workspace: 'self', generatedAt: null, clusters: [], orphans: [], cached: true }),
    agents: async () => ({ agents: [] }),
    listArchived: async () => ({ names: [], error: null }),
    verify: ok,
    archive: ok,
    restore: ok,
  },
  promptSessions: {
    getWorktreeDisabled: async () => ({ disabled: false }),
    setWorktreeDisabled: async ({ disabled }: { disabled: boolean }) => ({ disabled }),
  },
  mcp: {
    status: async () => ({ ok: true, error: null, servers: [] }),
    checkServer: async () => ({ ok: false, status: 'failed', error: 'not answered by the fixture', checkedAt: Date.now() }),
  },
  models: {
    catalog: async () => ({
      aliases: ['haiku', 'sonnet', 'opus'], models: ['claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-opus-4-5'],
      effortLevels: ['low', 'medium', 'high'], settingsEffortLevels: ['low', 'medium', 'high'], availableModels: null,
      claudeVersion: '2.0.0', probedAt: new Date(now).toISOString(),
      sources: { aliases: 'floor', models: 'floor', effortLevels: 'floor' }, degraded: false,
    }),
  },
  agentCli: { detect: async () => [] },
  voice: { getTtsEnabled: async () => false },
  files: { delete: ok },
  clipboard: { writeText: ok },
  shell: { open: ok },
}

// Anything the pages reach for that the fixture doesn't model resolves harmlessly — and is
// logged, so a new dependency shows up in the spec's console capture instead of crashing the mount.
function fallback(target: any, path: string): any {
  return new Proxy(target, {
    get(t, k) {
      if (typeof k === 'symbol' || k in t) {
        const v = t[k as any]
        return v && typeof v === 'object' ? fallback(v, `${path}.${String(k)}`) : v
      }
      console.warn(`[stub-api] unmodelled window.api${path}.${String(k)}`)
      return fallback(async () => undefined, `${path}.${String(k)}`)
    },
  })
}
;(window as any).api = fallback(api, '')

// ---- mount ------------------------------------------------------------------------------
const face = location.hash === '#project' ? 'project' : 'home'
const SELF_TAB: SessionTab = {
  id: 'tab-self', sessionId: 'tab-self', label: 'Self', cwd: CWD, pid: null, status: 'dormant',
  exitCode: null, startupCommand: null, presetId: null, generation: 0,
}
useLayout.setState({ navFace: face })
if (face === 'project') useSessions.setState({ tabs: [SELF_TAB], activeTabId: SELF_TAB.id })

createRoot(document.getElementById('root')!).render(
  <div style={{ height: '100vh' }}>
    {face === 'project' ? <ProjectClaudeConfig /> : <HomeClaudeConfig />}
  </div>,
)
