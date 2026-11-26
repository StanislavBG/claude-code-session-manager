import { test, expect, chromium, type Locator, type Page } from '@playwright/test'
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
  extra?: (page: Page, panel: Locator) => Promise<void>
}

const rows = (page: Page) => page.getByTestId('config-list-row')

// Wave-3 design details (validate-claude-config-wave3.md findings 1-30): each is asserted so a
// regression fails this gate instead of only showing up in a PNG nobody diffs.

/** One editor footer (finding 6) and the Outline closed by default (finding 5). */
async function editorChrome(panel: Locator) {
  await expect(panel.getByTestId('document-editor-pane')).toHaveCount(1)
  await expect(panel.getByTestId('editor-status-bar')).toHaveCount(1)
  await expect(panel.getByTestId('document-outline-toggle')).toHaveAttribute('aria-pressed', 'false')
  await expect(panel.getByTestId('doc-outline')).toHaveCount(0)
}

/** Settings rows carry one control each — no inline 'Set to:' input (finding 9). */
async function settingsRows(panel: Locator, stages: string[]) {
  await expect(panel.getByTestId('setting-card').first()).toBeVisible()
  await expect(panel.getByText('Set to:')).toHaveCount(0)
  // The source ladder names only this face's scopes (finding 10).
  const ladder = panel.getByTestId('source-ladder').first()
  await expect(ladder.locator('[data-stage]')).toHaveCount(stages.length)
  expect(await ladder.locator('[data-stage]').evaluateAll((els) => els.map((e) => e.getAttribute('data-stage')))).toEqual(stages)
}

const TABS: Record<Face, { search: string; eyebrow: string; scope: string; counts: Record<string, string>; tabs: TabSpec[] }> = {
  home: {
    search: 'pdf',
    eyebrow: 'CLAUDE CODE · GLOBAL',
    scope: '~/.claude',
    // CLAUDE.md chip = the file + its two imports; Settings = top-level keys set in settings.json (finding 1).
    counts: { 'claude-md': '3 files', settings: '3', mcp: '3', skills: '6', plugins: '4', agents: '9' },
    tabs: [
      {
        tab: 'claude-md', label: 'CLAUDE.md', card: 'claude-md-file-card', eyebrow: 'FILE + ITS IMPORTS',
        header: 'config-detail-header', headerText: ['~/.claude/CLAUDE.md · YOUR INSTRUCTIONS FOR EVERY PROJECT', 'CLAUDE.md'],
        extra: async (page, panel) => {
          const imports = page.getByTestId('referenced-file-row')
          await expect(imports).toHaveCount(2)
          await expect(imports.nth(0)).toContainText('git.md')
          await expect(imports.nth(0)).toContainText('42 lines')
          await expect(imports.nth(1)).toContainText('writing.md')
          await expect(imports.nth(1)).toContainText('18 lines')
          await expect(page.getByTestId('tiptap-editor')).toContainText('House rules')
          // Each `@` import line is its own block with its own marker (finding 3).
          const importBlocks = page.getByTestId('tiptap-editor').locator('[data-sm-import]')
          await expect(importBlocks).toHaveCount(2)
          await expect(importBlocks.nth(0)).toHaveAttribute('data-sm-import', '~/.claude/rules/git.md')
          await expect(importBlocks.nth(1)).toHaveAttribute('data-sm-import', '~/.claude/rules/writing.md')
          for (let i = 0; i < 2; i++) await expect(importBlocks.nth(i).locator('[data-sm-import-marker]')).toHaveText('@')
          const [a, b] = [await importBlocks.nth(0).boundingBox(), await importBlocks.nth(1).boundingBox()]
          expect(b!.y).toBeGreaterThanOrEqual(a!.y + a!.height - 1)
          await editorChrome(panel)
        },
      },
      {
        tab: 'settings', label: 'Settings', card: 'settings-file-card', eyebrow: 'SETTINGS FILE',
        header: 'settings-detail-header', headerText: ['USER SETTINGS · 2 OF 3 SET', 'Essentials'],
        extra: async (page, panel) => {
          await expect(page.getByTestId('settings-group-row').first()).toContainText('Essentials2/3')
          await settingsRows(panel, ['default', 'user'])
        },
      },
      {
        tab: 'mcp', label: 'MCP', select: 'mcp-row-playwright', card: 'config-file-card', eyebrow: 'SERVER FILE',
        header: 'mcp-detail', headerText: ['User scope', '~/.claude.json › mcpServers › playwright'],
        extra: async (page, panel) => {
          await expect(page.locator('[data-testid^="mcp-row-"]')).toHaveCount(3)
          await expect(page.getByTestId('mcp-detail-name')).toHaveText('playwright')
        },
      },
      {
        tab: 'skills', label: 'Skills', select: 'pdf', card: 'config-file-card', eyebrow: 'SKILLS FOLDER',
        header: 'config-detail-header', headerText: ['SKILL · USER · ~/.claude/skills/pdf/SKILL.md', 'pdf'],
        extra: async (page, panel) => {
          await expect(page.getByTestId('skills-item')).toHaveCount(6)
          await expect(page.getByTestId('skills-folder-on')).toHaveText('6 on')
          await editorChrome(panel)
        },
      },
      {
        tab: 'plugins', label: 'Plugins', card: 'config-file-card', eyebrow: 'PLUGINS',
        header: 'config-detail-header', headerText: ['PLUGIN · CLAUDE-PLUGINS-OFFICIAL', 'commit-commands'],
        extra: async (page, panel) => {
          await expect(rows(page)).toHaveCount(4)
          await expect(rows(page).filter({ hasText: 'pr-review-toolkit' })).toContainText('1 command · 6 agents')
          await expect(page.getByTestId('config-saved-line')).toContainText('Saved — matches settings.json › enabledPlugins')
        },
      },
      {
        tab: 'agents', label: 'Agents', card: 'config-file-card', eyebrow: 'AGENTS FOLDER',
        header: 'config-detail-header', headerText: ['AGENT · USER · ~/.claude/agents/architect.md', 'architect'],
        extra: async (page, panel) => {
          await expect(rows(page)).toHaveCount(9)
          await expect(page.getByTestId('agent-detail-description')).toContainText('Designs the shape of a change')
          // Three compact selects under MODEL / EFFORT / RUNS ON (finding 23).
          const runtime = panel.getByTestId('agent-runtime-row')
          await expect(runtime.locator('select')).toHaveCount(3)
          expect(await runtime.locator('select').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')?.toUpperCase()))).toEqual(['MODEL', 'EFFORT', 'RUNS ON'])
          // Rendered label text (the labels are CSS-uppercased), each sitting above its select.
          expect(await runtime.locator('label').evaluateAll((els) => els.map((e) => (e.firstElementChild as HTMLElement).innerText.trim()))).toEqual(['MODEL', 'EFFORT', 'RUNS ON'])
          // The prompt editor follows the config card, inside the 1040px frame (finding 25).
          const card = await panel.getByTestId('agent-runtime-card').boundingBox()
          const editor = await panel.getByTestId('agent-detail-editor').boundingBox()
          expect(editor!.y).toBeGreaterThanOrEqual(card!.y + card!.height)
          expect(editor!.y - (card!.y + card!.height)).toBeLessThan(40)
          expect(editor!.y).toBeLessThan(VIEWPORT.height - 100)
          expect(await panel.getByTestId('agent-runtime-card').evaluate((el) => el.nextElementSibling?.getAttribute('data-testid'))).toBe('agent-detail-editor')
          // The editor fills the rest of the pane: its status bar sits in the first view, no scroll (wave-5 Minor 1).
          expect(await page.getByTestId('config-workbench-detail').evaluate((el) => el.scrollTop)).toBe(0)
          const status = await panel.getByTestId('editor-status-bar').boundingBox()
          expect(status!.y + status!.height).toBeLessThanOrEqual(VIEWPORT.height)
          // …and reaches the bottom of the pane: an editor shrunk back to its floor fails (wave-6 Minor 1).
          const detail = await page.getByTestId('config-workbench-detail').boundingBox()
          expect(detail!.y + detail!.height - (status!.y + status!.height)).toBeLessThanOrEqual(48)
          await editorChrome(panel)
        },
      },
    ],
  },
  project: {
    search: 'burrow',
    eyebrow: 'CLAUDE CODE · PROJECT',
    scope: '~/Projects/Self',
    counts: { memory: '9', 'claude-md': 'missing', settings: '3', mcp: '5', skills: '13' },
    tabs: [
      {
        tab: 'memory', label: 'Memory', card: 'config-file-card', eyebrow: 'MEMORY FOLDER',
        header: 'mx-reader-header', headerText: ['MODIFIED JUST NOW', 'portfolio-action-project-field'],
        extra: async (page, panel) => {
          await expect(page.locator('[data-testid^="mx-list-row-"]')).toHaveCount(9)
          await expect(page.getByTestId('mx-list-folder-count')).toHaveText('9 files')
          // No inner page header, nav rail or path footer (finding 27).
          for (const id of ['mx-search-trigger', 'mx-learn', 'mx-nav', 'mx-index-footer']) await expect(panel.getByTestId(id)).toHaveCount(0)
          await expect(panel.getByText('CONFIGURE', { exact: true })).toHaveCount(0)
          await expect(panel.getByText('Search all memories', { exact: false })).toHaveCount(0)
          // The full title, not truncated (finding 28).
          const title = panel.getByTestId('mx-reader-title')
          await expect(title).toHaveText('portfolio-action-project-field')
          expect(await title.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
        },
      },
      {
        tab: 'claude-md', label: 'CLAUDE.md', card: 'claude-md-file-card', eyebrow: 'INSTRUCTIONS FILE',
        header: 'config-detail-header', headerText: ['~/Projects/Self/CLAUDE.md · PROJECT INSTRUCTIONS', 'CLAUDE.md', 'Not created'],
        extra: async (page, panel) => {
          await expect(page.getByTestId('claude-md-empty')).toContainText('Nothing tells Claude how this repo works yet.')
          // A missing file keeps the editor chrome; its save button reads 'Create file' (finding 30).
          await expect(panel.getByTestId('document-empty')).toBeVisible()
          await expect(panel.getByTestId('editor-save')).toContainText('Create file')
          await editorChrome(panel)
        },
      },
      {
        tab: 'settings', label: 'Settings', card: 'settings-file-card', eyebrow: 'SETTINGS FILE',
        header: 'settings-detail-header', headerText: ['PROJECT SETTINGS', 'Essentials'],
        extra: async (page, panel) => {
          await expect(page.getByTestId('settings-file-project')).toBeVisible()
          await expect(page.getByTestId('settings-file-local')).toBeVisible()
          // Epic isolation is a row in the Settings rail, not a strip above the page (finding 12).
          await expect(panel.getByTestId('settings-row-epic-isolation')).toBeVisible()
          await expect(page.getByTestId('project-claude-config-epic-isolation')).toHaveCount(0)
          await settingsRows(panel, ['default', 'user', 'project', 'local'])
        },
      },
      {
        tab: 'mcp', label: 'MCP', card: 'config-file-card', eyebrow: 'SERVER FILE',
        header: 'mcp-detail', headerText: ['Project scope', '.mcp.json › mcpServers › burrow'],
        extra: async (page, panel) => {
          await expect(page.locator('[data-testid^="mcp-row-"]')).toHaveCount(5)
          await expect(page.getByTestId('mcp-detail-name')).toHaveText('burrow')
          // One 'Auto-approve all servers' toggle row in the SERVER FILE card (finding 16).
          const card = panel.getByTestId('config-file-card').first()
          await expect(card.getByText('Auto-approve all servers', { exact: true })).toBeVisible()
          await expect(card.locator('input[type="checkbox"]')).toHaveCount(0)
          await expect(panel.getByTestId('mcp-detail-approved')).toBeVisible()
        },
      },
      {
        tab: 'skills', label: 'Skills', card: 'config-file-card', eyebrow: 'SKILLS FOLDER',
        header: 'config-detail-header',
        headerText: ['SKILL · PROJECT · ~/Projects/Self/.claude/skills/bank-of-america-statements/SKILL.md', 'bank-of-america-statements'],
        extra: async (page, panel) => {
          await expect(page.getByTestId('skills-item')).toHaveCount(13)
          await editorChrome(panel)
        },
      },
    ],
  },
}

/**
 * Short body fills (wave-7 Minor 1): the screenshot agent's prompt is about as tall as the free
 * space, so it can't tell flex-1 from content height. Click a stub agent whose prompt is one line
 * ('builder') at 1592x1040: only flex-1 can stretch its editor to the detail column's visible
 * bottom. Runs after every PNG is written and writes none itself.
 */
async function shortBodyFills(page: Page) {
  await rows(page).filter({ hasText: 'builder' }).filter({ hasNotText: 'demo-video-builder' }).first().click()
  const header = page.getByTestId('config-detail-header').first()
  await expect(header).toContainText('~/.claude/agents/builder.md')
  await expect(page.getByTestId('tiptap-editor')).toContainText('You are builder.')
  const detail = page.getByTestId('config-workbench-detail')
  const bottom = await detail.evaluate((el) => {
    const r = el.getBoundingClientRect()
    return r.top + el.clientTop + el.clientHeight
  })
  const editor = await page.getByTestId('agent-detail-editor').boundingBox()
  expect(bottom - (editor!.y + editor!.height)).toBeGreaterThanOrEqual(0)
  expect(bottom - (editor!.y + editor!.height)).toBeLessThanOrEqual(48)
}

/**
 * Short pane (wave-6 Minor 2): with the Agents tab still open, shrink the viewport to 1592x700 so
 * the detail column is the single scroller. The editor keeps its 320px floor, and scrolling the
 * column to its end (scrollTop, never scrollIntoView) brings the status bar inside the column's
 * visible box. Runs after every PNG is written and writes none itself.
 */
async function shortPane(page: Page) {
  await page.setViewportSize({ width: VIEWPORT.width, height: 700 })
  const detail = page.getByTestId('config-workbench-detail')
  await expect.poll(() => detail.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
  const editor = await page.getByTestId('agent-detail-editor').boundingBox()
  expect(editor!.height).toBeGreaterThanOrEqual(320)
  await detail.evaluate((el) => { el.scrollTop = el.scrollHeight })
  await expect.poll(() => detail.evaluate((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 1)).toBe(true)
  const box = await detail.evaluate((el) => {
    const r = el.getBoundingClientRect()
    return { top: r.top + el.clientTop, bottom: r.top + el.clientTop + el.clientHeight }
  })
  const status = await page.getByTestId('editor-status-bar').boundingBox()
  expect(status!.y).toBeGreaterThanOrEqual(box.top)
  expect(status!.y + status!.height).toBeLessThanOrEqual(box.bottom)
}

/**
 * Short viewport: at 1592x560 the rail's content can overflow and scrolls vertically. End selects
 * the last tab; its box plus 2px (focus ring / shadow) must sit inside the `config-rail-scroll` box (the
 * scrolling tab list), not the rail's client box.
 * Runs after every PNG of the face is written and writes none itself.
 */
async function shortViewportTabs(page: Page) {
  await page.setViewportSize({ width: VIEWPORT.width, height: 560 })
  const rail = page.getByTestId('config-rail')
  await rail.locator('[role="tab"][aria-selected="true"]').focus()
  await page.keyboard.press('End') // keyboard focus -> :focus-visible ring
  const last = rail.locator('[role="tab"]').last()
  await expect(last).toHaveAttribute('aria-selected', 'true')
  await expect(last).toBeFocused()
  await last.scrollIntoViewIfNeeded()
  const box = await rail.getByTestId('config-rail-scroll').evaluate((el) => {
    const r = el.getBoundingClientRect()
    return { top: r.top + el.clientTop, bottom: r.top + el.clientTop + el.clientHeight }
  })
  const tab = await last.boundingBox()
  expect(tab!.y - 2).toBeGreaterThanOrEqual(box.top)
  expect(tab!.y + tab!.height + 2).toBeLessThanOrEqual(box.bottom)
}

/**
 * An @-import is editable from the page: select the first import of ~/.claude/CLAUDE.md (the
 * stub's canWrite says ok) and check the document pane carries no read-only badge and no
 * read-only note, then shoot it. Leaves the Agents tab open again for the checks that follow.
 */
async function homeImportShot(page: Page, written: string[]) {
  await page.getByTestId('config-rail-tab-claude-md').click()
  const panel = page.getByTestId('home-claude-config-panel-claude-md')
  const first = panel.getByTestId('referenced-file-row').first()
  await expect(first).toContainText('git.md')
  await expect(first).toContainText('Imported · editable here')
  await first.click()
  await expect(first).toHaveAttribute('aria-checked', 'true')
  await expect(panel.getByTestId('config-detail-header').first()).toContainText('IMPORTED BY CLAUDE.md')
  const doc = panel.getByTestId('document-editor-pane')
  await expect(doc).toHaveCount(1)
  await expect(doc.getByText('read-only', { exact: true })).toHaveCount(0)
  await expect(panel.locator('[data-testid$="-readonly-note"]')).toHaveCount(0)
  await expect(panel.getByTestId('editor-save')).toHaveCount(1)
  await page.waitForTimeout(400) // fonts + editor settle
  const file = path.join(OUT, 'home-claude-md-import.png')
  await page.screenshot({ path: file })
  written.push(file)
  await page.getByTestId('config-rail-tab-agents').click()
  await expect(page.getByTestId('home-claude-config-panel-agents')).toBeVisible()
}

/** Search panel opens beside the rail, unclipped, over the content; rail has no horizontal range; no tab label truncates. */
async function searchPanelShot(page: Page, face: Face, query: string, written: string[]) {
  const rail = page.getByTestId('config-rail')
  const input = page.getByLabel('Search all config')
  await input.click()
  await input.fill(query)
  const panel = page.getByTestId('config-search-panel')
  await expect(panel).toBeVisible()
  const [rb, pb] = [(await rail.boundingBox())!, (await panel.boundingBox())!]
  expect(pb.x).toBeGreaterThanOrEqual(rb.x + rb.width - 1)
  expect(await panel.evaluate((el) => {
    const r = el.getBoundingClientRect()
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return !!hit && el.contains(hit)
  })).toBe(true)
  expect(await rail.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  const firstTitle = panel.locator('[role="option"]').first().locator('span').first()
  expect(await firstTitle.evaluate((el) => el.scrollWidth <= el.clientWidth), 'first result title clipped').toBe(true)
  const labels = await rail.getByTestId('config-rail-tab-label').evaluateAll((els) => els.map((e) => [e.textContent, e.scrollWidth, e.clientWidth]))
  for (const [text, sw, cw] of labels) expect(sw as number, `label ${text}`).toBeLessThanOrEqual(cw as number)
  await page.waitForTimeout(200)
  const file = path.join(OUT, `${face}-search-open.png`)
  await page.screenshot({ path: file })
  written.push(file)
  await input.fill('')
  await input.press('Escape')
  await expect(panel).toHaveCount(0)
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

      const band = page.getByTestId('config-rail')
      const root = page.getByTestId(`${face}-claude-config`)
      await expect(band).toContainText(spec.eyebrow)
      await expect(band).toContainText(spec.scope)
      // Scope path shows whole (the last folder names the scope) — not clipped by CSS.
      const scopePath = band.getByTestId('config-rail-path')
      await expect(scopePath).toHaveText(spec.scope)
      await expect(scopePath).toHaveAttribute('title', spec.scope)
      const clip = await scopePath.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }))
      expect(clip.scroll).toBeLessThanOrEqual(clip.client)
      for (const [tab, count] of Object.entries(spec.counts)) {
        await expect(page.getByTestId(`config-rail-tab-${tab}`).getByTestId('config-rail-count')).toHaveText(count)
      }

      // Rail geometry: left of the panel, nothing above it, tabs stacked vertically.
      const railBox = (await band.boundingBox())!
      const rootBox = (await root.boundingBox())!
      expect(Math.abs(railBox.y - rootBox.y)).toBeLessThanOrEqual(1)
      let prev: { y: number; height: number } | null = null
      for (const el of await band.locator('[role="tab"]').all()) {
        const tb = (await el.boundingBox())!
        if (prev) expect(tb.y).toBeGreaterThanOrEqual(prev.y + prev.height - 1)
        prev = tb
      }

      await searchPanelShot(page, face, spec.search, written)

      for (const t of spec.tabs) {
        await page.getByTestId(`config-rail-tab-${t.tab}`).click()
        if (t.select) {
          const row = page.getByTestId(t.select)
          await (await row.count() ? row : page.getByTestId('skills-item').filter({ hasText: `/${t.select}` })).first().click()
        }
        // Band: title, and exactly this tab active.
        await expect(band.getByText('Claude config', { exact: true })).toBeVisible()
        const selected = band.locator('[role="tab"][aria-selected="true"]')
        await expect(selected).toHaveCount(1)
        await expect(selected).toHaveAttribute('data-testid', `config-rail-tab-${t.tab}`)
        await expect(selected).toContainText(t.label)

        const panel = page.getByTestId(`${face}-claude-config-panel-${t.tab}`)
        await expect(panel).toBeVisible()
        const panelBox = (await panel.boundingBox())!
        expect(railBox.x + railBox.width).toBeLessThanOrEqual(panelBox.x + 1)
        // Left file card eyebrow.
        const card = panel.getByTestId(t.card).first()
        await expect(card).toBeVisible()
        await expect(card.getByText(t.eyebrow, { exact: true })).toBeVisible()
        // Detail header.
        const header = panel.getByTestId(t.header).first()
        await expect(header).toBeVisible()
        for (const text of t.headerText) await expect(header).toContainText(text)
        await t.extra?.(page, panel)

        await page.waitForTimeout(400) // fonts + editor settle
        const file = path.join(OUT, `${face}-${t.tab}.png`)
        await page.screenshot({ path: file })
        written.push(file)
      }
      if (face === 'home') {
        await homeImportShot(page, written)
        await shortBodyFills(page)
        await shortPane(page)
      }
      await shortViewportTabs(page)
      await ctx.close()
    }
  } finally {
    await browser.close()
  }
  expect(pageErrors).toEqual([])
  expect(unmodelled).toEqual([])
  expect(written.map((f) => path.basename(f, '.png')).sort()).toEqual([
    'home-agents', 'home-claude-md', 'home-claude-md-import', 'home-mcp', 'home-plugins', 'home-search-open', 'home-settings', 'home-skills',
    'project-claude-md', 'project-mcp', 'project-memory', 'project-search-open', 'project-settings', 'project-skills',
  ])
  for (const f of written) {
    expect(fs.statSync(f).size).toBeGreaterThan(10_000)
    const png = fs.readFileSync(f)
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([VIEWPORT.width, VIEWPORT.height])
  }
})
