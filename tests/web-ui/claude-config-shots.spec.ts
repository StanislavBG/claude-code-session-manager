import { test, expect, chromium, type Page } from '@playwright/test'
import { build } from 'esbuild'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Real Chromium (never Electron). Mounts the real HomeClaudeConfig and ProjectClaudeConfig pages
// (claude-config-entry.tsx) with CSS from the built web renderer (dist-web/app.css) over a stub
// window.api shaped like the design's sample data, asserts each tab's structure, and writes one
// PNG per tab at the design's main-area size (1592x1040), named like the design renders in
// session-manager-operations/design-mocks/claude-config/renders/ (05-project-memory … 15-home-agents).
// Output goes to test-results/claude-config/ (gitignored) — never a tracked path.
const root = path.resolve(__dirname, '../..')
const OUT = path.join(root, 'test-results/claude-config')
const VIEWPORT = { width: 1592, height: 1040 }

type Face = 'home' | 'project'
interface TabSpec {
  tab: string
  /** Band tab label. */
  label: string
  /** Optional: select a row first so the shot matches the design render's selection. */
  select?: string
  /** The left-column file card and its eyebrow. */
  card: string
  eyebrow: string
  /** The detail header and the texts it must carry (eyebrow, title). */
  header: string
  headerText: string[]
  /** Extra structure checks for the tab. */
  extra?: (page: Page) => Promise<void>
}

const rows = (page: Page) => page.getByTestId('config-list-row')

const TABS: Record<Face, { eyebrow: string; scope: string; counts: Record<string, string>; tabs: TabSpec[] }> = {
  home: {
    eyebrow: 'CLAUDE CODE · GLOBAL',
    scope: '~/.claude',
    counts: { mcp: '3', plugins: '4', agents: '9' },
    tabs: [
      {
        tab: 'claude-md', label: 'CLAUDE.md', card: 'claude-md-file-card', eyebrow: 'FILE + ITS IMPORTS',
        header: 'config-detail-header', headerText: ['~/.claude/CLAUDE.md · YOUR INSTRUCTIONS FOR EVERY PROJECT', 'CLAUDE.md'],
        extra: async (page) => {
          const imports = page.getByTestId('referenced-file-row')
          await expect(imports).toHaveCount(2)
          await expect(imports.nth(0)).toContainText('git.md')
          await expect(imports.nth(0)).toContainText('42 lines')
          await expect(imports.nth(1)).toContainText('writing.md')
          await expect(imports.nth(1)).toContainText('18 lines')
          await expect(page.getByTestId('tiptap-editor')).toContainText('House rules')
        },
      },
      {
        tab: 'settings', label: 'Settings', card: 'settings-file-card', eyebrow: 'SETTINGS FILE',
        header: 'settings-detail-header', headerText: ['USER SETTINGS · 2 OF 3 SET', 'Essentials'],
        extra: async (page) => {
          await expect(page.getByTestId('settings-group-row').first()).toContainText('Essentials2/3')
        },
      },
      {
        tab: 'mcp', label: 'MCP', select: 'mcp-row-playwright', card: 'config-file-card', eyebrow: 'SERVER FILE',
        header: 'mcp-detail', headerText: ['User scope', '~/.claude.json › mcpServers › playwright'],
        extra: async (page) => {
          await expect(page.locator('[data-testid^="mcp-row-"]')).toHaveCount(3)
          await expect(page.getByTestId('mcp-detail-name')).toHaveText('playwright')
        },
      },
      {
        tab: 'skills', label: 'Skills', select: 'pdf', card: 'config-file-card', eyebrow: 'SKILLS FOLDER',
        header: 'config-detail-header', headerText: ['SKILL · USER · ~/.claude/skills/pdf/SKILL.md', 'pdf'],
        extra: async (page) => {
          await expect(page.getByTestId('skills-item')).toHaveCount(6)
          await expect(page.getByTestId('skills-folder-on')).toHaveText('6 on')
        },
      },
      {
        tab: 'plugins', label: 'Plugins', card: 'config-file-card', eyebrow: 'PLUGINS',
        header: 'config-detail-header', headerText: ['PLUGIN · CLAUDE-PLUGINS-OFFICIAL', 'commit-commands'],
        extra: async (page) => {
          await expect(rows(page)).toHaveCount(4)
          await expect(rows(page).filter({ hasText: 'pr-review-toolkit' })).toContainText('1 command · 6 agents')
          await expect(page.getByTestId('config-saved-line')).toContainText('Saved — matches settings.json › enabledPlugins')
        },
      },
      {
        tab: 'agents', label: 'Agents', card: 'config-file-card', eyebrow: 'AGENTS FOLDER',
        header: 'config-detail-header', headerText: ['AGENT · USER · ~/.claude/agents/architect.md', 'architect'],
        extra: async (page) => {
          await expect(rows(page)).toHaveCount(9)
          await expect(page.getByTestId('agent-detail-description')).toContainText('Designs the shape of a change')
        },
      },
    ],
  },
  project: {
    eyebrow: 'CLAUDE CODE · PROJECT',
    scope: '~/Projects/Self',
    counts: { memory: '9', 'claude-md': 'missing', mcp: '5', skills: '13' },
    tabs: [
      {
        tab: 'memory', label: 'Memory', card: 'config-file-card', eyebrow: 'MEMORY FOLDER',
        header: 'mx-reader-header', headerText: ['MODIFIED JUST NOW', 'portfolio-action-project-field'],
        extra: async (page) => {
          await expect(page.locator('[data-testid^="mx-list-row-"]')).toHaveCount(9)
          await expect(page.getByTestId('mx-list-folder-count')).toHaveText('9 files')
        },
      },
      {
        tab: 'claude-md', label: 'CLAUDE.md', card: 'claude-md-file-card', eyebrow: 'FILE + ITS IMPORTS',
        header: 'config-detail-header', headerText: ['~/Projects/Self/CLAUDE.md · PROJECT INSTRUCTIONS', 'CLAUDE.md', 'Not created'],
        extra: async (page) => {
          await expect(page.getByTestId('claude-md-empty')).toContainText('Nothing tells Claude how this repo works yet.')
        },
      },
      {
        tab: 'settings', label: 'Settings', card: 'settings-file-card', eyebrow: 'SETTINGS FILE',
        header: 'settings-detail-header', headerText: ['PROJECT SETTINGS', 'Essentials'],
        extra: async (page) => {
          await expect(page.getByTestId('settings-file-project')).toBeVisible()
          await expect(page.getByTestId('settings-file-local')).toBeVisible()
          await expect(page.getByTestId('project-claude-config-epic-isolation')).toBeVisible()
        },
      },
      {
        tab: 'mcp', label: 'MCP', card: 'config-file-card', eyebrow: 'SERVER FILE',
        header: 'mcp-detail', headerText: ['Project scope', '.mcp.json › mcpServers › burrow'],
        extra: async (page) => {
          await expect(page.locator('[data-testid^="mcp-row-"]')).toHaveCount(5)
          await expect(page.getByTestId('mcp-detail-name')).toHaveText('burrow')
        },
      },
      {
        tab: 'skills', label: 'Skills', card: 'config-file-card', eyebrow: 'SKILLS FOLDER',
        header: 'config-detail-header',
        headerText: ['SKILL · PROJECT · ~/Projects/Self/.claude/skills/bank-of-america-statements/SKILL.md', 'bank-of-america-statements'],
        extra: async (page) => {
          await expect(page.getByTestId('skills-item')).toHaveCount(13)
        },
      },
    ],
  },
}

test('Claude config screenshots: every Home and Project tab at 1592x1040', async () => {
  if (!fs.existsSync(path.join(root, 'dist-web/app.css'))) {
    execSync('npx vite build --config vite.web.config.ts', { cwd: root, stdio: 'inherit' })
  }
  const css = fs.readFileSync(path.join(root, 'dist-web/app.css'), 'utf8')
  const bundle = (await build({
    entryPoints: [path.join(__dirname, 'claude-config-entry.tsx')],
    bundle: true, write: false, format: 'iife', jsx: 'automatic', loader: { '.css': 'empty' }, logLevel: 'error',
    define: { 'process.env.NODE_ENV': '"production"', __APP_VERSION__: '"0.0.0"' },
  })).outputFiles[0].text

  fs.mkdirSync(OUT, { recursive: true })
  const browser = await chromium.launch() // never Electron
  const pageErrors: string[] = []
  const unmodelled: string[] = []
  const written: string[] = []
  try {
    for (const face of ['home', 'project'] as const) {
      const spec = TABS[face]
      const ctx = await browser.newContext({ viewport: VIEWPORT })
      const page = await ctx.newPage()
      page.on('pageerror', (e) => pageErrors.push(`${face}: ${e.message}`))
      page.on('console', (m) => { if (m.text().startsWith('[stub-api]')) unmodelled.push(m.text()) })
      await page.route('http://fx.test/**', (r) =>
        r.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><style>${css}</style></head><body class="bg-bg"><div id="root"></div></body></html>` }),
      )
      await page.goto(`http://fx.test/#${face}`)
      await page.addScriptTag({ content: bundle })

      const band = page.getByTestId('config-band')
      await expect(band).toContainText(spec.eyebrow)
      await expect(band).toContainText(spec.scope)
      for (const [tab, count] of Object.entries(spec.counts)) {
        await expect(page.getByTestId(`config-band-tab-${tab}`).getByTestId('config-band-count')).toHaveText(count)
      }

      for (const t of spec.tabs) {
        await page.getByTestId(`config-band-tab-${t.tab}`).click()
        if (t.select) {
          const row = page.getByTestId(t.select)
          await (await row.count() ? row : page.getByTestId('skills-item').filter({ hasText: `/${t.select}` })).first().click()
        }
        // Band: title, and exactly this tab active.
        await expect(band.getByText('Claude config', { exact: true })).toBeVisible()
        const selected = band.locator('[role="tab"][aria-selected="true"]')
        await expect(selected).toHaveCount(1)
        await expect(selected).toHaveAttribute('data-testid', `config-band-tab-${t.tab}`)
        await expect(selected).toContainText(t.label)

        const panel = page.getByTestId(`${face}-claude-config-panel-${t.tab}`)
        await expect(panel).toBeVisible()
        // Left file card eyebrow.
        const card = panel.getByTestId(t.card).first()
        await expect(card).toBeVisible()
        await expect(card.getByText(t.eyebrow, { exact: true })).toBeVisible()
        // Detail header.
        const header = panel.getByTestId(t.header).first()
        await expect(header).toBeVisible()
        for (const text of t.headerText) await expect(header).toContainText(text)
        await t.extra?.(page)

        await page.waitForTimeout(400) // fonts + editor settle
        const file = path.join(OUT, `${face}-${t.tab}.png`)
        await page.screenshot({ path: file })
        written.push(file)
      }
      await ctx.close()
    }
  } finally {
    await browser.close()
  }
  expect(pageErrors).toEqual([])
  expect(unmodelled).toEqual([])
  expect(written.map((f) => path.basename(f, '.png')).sort()).toEqual([
    'home-agents', 'home-claude-md', 'home-mcp', 'home-plugins', 'home-settings', 'home-skills',
    'project-claude-md', 'project-mcp', 'project-memory', 'project-settings', 'project-skills',
  ])
  for (const f of written) {
    expect(fs.statSync(f).size).toBeGreaterThan(10_000)
    const png = fs.readFileSync(f)
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([VIEWPORT.width, VIEWPORT.height])
  }
})
