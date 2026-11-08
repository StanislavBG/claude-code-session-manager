// Bundle entry for the real-Chromium Extensions 3a screenshot spec. Mounts the real
// SectionFrame (hideTitle, as screenComponents.tsx mounts it) around the real Extensions
// page, over a stub window.api backed by an in-memory file tree shaped like the 3a renders
// (session-manager-operations/design-mocks/extensions-3a/renders/): 0 user skills + 1 command,
// 7 MCP servers in ~/.claude.json, and 2 installed plugins (session-manager-dev, stripe).
import { createRoot } from 'react-dom/client'
import { SectionFrame } from '../../src/renderer/components/layout/SectionFrame'
import { Extensions } from '../../src/renderer/components/tabs/Extensions'
import { NAV_GROUP_BY_KEY } from '../../src/renderer/lib/navGroups'

const HOME = '/home/user'
const now = Date.now()

// ---- the in-memory file tree ------------------------------------------------------------
const files = new Map<string, { text: string; mtimeMs: number }>()
const put = (p: string, body: unknown, agoMin = 30) =>
  files.set(p, { text: typeof body === 'string' ? body : JSON.stringify(body, null, 2), mtimeMs: now - agoMin * 60_000 })
const md = (name: string, description: string, body: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`

// User scope: no skills (the dir exists but is empty), one slash command.
const dirs = new Set<string>([`${HOME}/.claude/skills`])
put(`${HOME}/.claude/commands/review-pr.md`, md('review-pr', 'Review the open pull request against the repo conventions.', '# Review PR\n\nRead the diff, run the tests, and leave inline comments.'), 120)

// ~/.claude.json — 7 user MCP servers.
const mcpServers = {
  fetch: { command: 'uvx', args: ['mcp-server-fetch'] },
  github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: 'ghp_fixture' } },
  filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', `${HOME}/Projects`] },
  sqlite: { command: 'uvx', args: ['mcp-server-sqlite', '--db-path', `${HOME}/data.db`] },
  playwright: { command: 'npx', args: ['@playwright/mcp@latest'] },
  linear: { type: 'http', url: 'https://mcp.linear.app/mcp' },
  sentry: { type: 'http', url: 'https://mcp.sentry.dev/mcp' },
}
const claudeJson = { numStartups: 42, mcpServers }
put(`${HOME}/.claude.json`, claudeJson, 15)

// Installed plugins.
const CACHE = `${HOME}/.claude/plugins/cache`
const smDev = `${CACHE}/session-manager/session-manager-dev/0.3.6`
const stripe = `${CACHE}/claude-plugins-official/stripe/1.2.0`
put(`${HOME}/.claude/plugins/installed_plugins.json`, {
  version: 2,
  plugins: {
    'session-manager-dev@session-manager': [{ scope: 'user', installPath: smDev, version: '0.3.6' }],
    'stripe@claude-plugins-official': [{ scope: 'user', installPath: stripe, version: '1.2.0' }],
  },
}, 240)
put(`${HOME}/.claude/settings.json`, { enabledPlugins: { 'session-manager-dev@session-manager': true, 'stripe@claude-plugins-official': true } }, 240)

put(`${smDev}/.claude-plugin/plugin.json`, { name: 'session-manager-dev', version: '0.3.6', description: 'Develop, publish and maintain projects with the session-manager scheduler.' })
for (const [n, d] of [
  ['develop', 'Lead a software-development task and queue it as scheduled PRDs.'],
  ['builder', 'Drive the next npm publish from git history.'],
  ['send-feedback', 'Hand a finding to a different project on this machine.'],
  ['maintaining-md-network', 'Review or drift-check a project\'s markdown network.'],
]) put(`${smDev}/skills/${n}/SKILL.md`, md(n, d, `# ${n}\n\nSee /develop for the full workflow.`))

put(`${stripe}/.claude-plugin/plugin.json`, { name: 'stripe', version: '1.2.0', description: 'Stripe integration guidance, docs and test helpers for Claude Code.' })
for (const n of ['stripe-best-practices', 'stripe-docs', 'stripe-apps', 'stripe-pay', 'stripe-projects', 'stripe-directory', 'connect-recommend', 'metronome', 'upgrade-stripe', 'explain-error']) {
  put(`${stripe}/skills/${n}/SKILL.md`, md(n, `Stripe guidance: ${n.replace(/-/g, ' ')}.`, `# ${n}\n\nUse when working on ${n}.`))
}
put(`${stripe}/commands/test-cards.md`, md('test-cards', 'Display Stripe test card numbers.', 'List the test cards.'))
put(`${stripe}/commands/explain-error.md`, md('explain-error', 'Explain a Stripe error code.', 'Explain the error.'))
put(`${stripe}/agents/company-researcher.md`, md('Company Researcher', 'Research a company to infer its Connect shape.', 'Research.'))
put(`${stripe}/.mcp.json`, { mcpServers: { stripe: { type: 'http', url: 'https://mcp.stripe.com' } } })
const hook = (command: string) => ({ hooks: [{ type: 'command', command }] })
put(`${stripe}/hooks/hooks.json`, {
  hooks: {
    SessionStart: [hook('stripe-hint session-start'), hook('stripe-hint cli-version')],
    PreToolUse: [hook('stripe-guard pre-tool'), hook('stripe-guard secrets')],
    PostToolUse: [hook('stripe-guard post-tool')],
    UserPromptSubmit: [hook('stripe-hint prompt')],
    Stop: [hook('stripe-hint stop')],
  },
})

// Every ancestor of a file is a directory.
for (const p of files.keys()) {
  for (let i = p.lastIndexOf('/'); i > 0; i = p.lastIndexOf('/', i - 1)) dirs.add(p.slice(0, i))
}

const base = (p: string) => p.slice(p.lastIndexOf('/') + 1)
function listDir(path: string, opts: { filesOnly?: boolean; dirsOnly?: boolean; includeHidden?: boolean } = {}) {
  const dir = path.replace(/\/+$/, '')
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
  const f = files.get(p)
  return f
    ? { exists: true, text: f.text, mtimeMs: f.mtimeMs, error: null, truncated: false }
    : { exists: false, text: '', mtimeMs: 0, error: null, truncated: false }
}
function readJson(p: string) {
  const f = files.get(p)
  if (!f) return { exists: false, raw: '', data: null, parseError: null, mtimeMs: 0, error: null }
  return { exists: true, raw: f.text, data: JSON.parse(f.text), parseError: null, mtimeMs: f.mtimeMs, error: null }
}

// ---- window.api -------------------------------------------------------------------------
const ok = async () => ({ ok: true, error: null, mtimeMs: now })
const api = {
  app: { homeDir: async () => HOME, cwd: async () => HOME, version: async () => '0.0.0', seedStatus: async () => null },
  config: {
    listDir: async (p: string, o?: { filesOnly?: boolean; dirsOnly?: boolean; includeHidden?: boolean }) => listDir(p, o),
    readText: async (p: string) => readText(p),
    readJson: async (p: string) => readJson(p),
    exists: async (p: string) => files.has(p) || dirs.has(p.replace(/\/+$/, '')),
    writeText: ok,
    writeJson: ok,
    canWrite: async () => true,
    watch: () => {},
    unwatch: () => {},
    onChanged: () => () => {},
  },
  claudeConfig: {
    read: async ({ fileId }: { fileId: string }) =>
      fileId === 'claudeJson' ? { path: `${HOME}/.claude.json`, data: claudeJson } : { path: `${HOME}/.claude/settings.json`, data: {} },
    patch: async () => ({ ok: true, path: `${HOME}/.claude.json`, data: claudeJson }),
  },
  plugins: {
    list: async () => [
      { key: 'session-manager-dev@session-manager', name: 'session-manager-dev', marketplace: 'session-manager', version: '0.3.6', scope: 'user', installPath: smDev, enabled: true },
      { key: 'stripe@claude-plugins-official', name: 'stripe', marketplace: 'claude-plugins-official', version: '1.2.0', scope: 'user', installPath: stripe, enabled: true },
    ],
    setEnabled: async () => ({ ok: true }),
    uninstall: async () => ({ ok: true, exitCode: 0 }),
    install: async () => ({ ok: true, exitCode: 0 }),
    onInstallProgress: () => () => {},
  },
  mcp: {
    checkServer: async (req: { name: string }) => {
      await new Promise((r) => setTimeout(r, 150))
      return req.name === 'fetch'
        ? { ok: true, status: 'connected', tools: [{ name: 'fetch', description: 'Fetches a URL from the internet and extracts its contents as markdown.' }], checkedAt: Date.now() }
        : { ok: false, status: 'failed', error: 'not answered by the fixture', checkedAt: Date.now() }
    },
  },
  files: { delete: ok },
  shell: { open: ok },
}

// Anything the page reaches for that the fixture doesn't model resolves harmlessly — and is logged,
// so a new dependency shows up in the spec's console capture instead of crashing the mount.
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

createRoot(document.getElementById('root')!).render(
  <div style={{ height: '100vh' }}>
    <SectionFrame
      eyebrow={NAV_GROUP_BY_KEY.extensions}
      title="Extensions"
      intro="Skills, MCP servers and plugins — each tab edits the real file Claude Code reads."
      hideTitle
    >
      <Extensions />
    </SectionFrame>
  </div>,
)
