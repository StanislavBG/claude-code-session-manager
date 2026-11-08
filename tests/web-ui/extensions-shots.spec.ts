import { test, expect, chromium, type Page } from '@playwright/test'
import { build } from 'esbuild'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Real Chromium (never Electron). Renders the real SectionFrame (hideTitle) + Extensions page with
// CSS from the built web renderer (dist-web/app.css) and the stub window.api in extensions-entry.tsx,
// asserts the 3a structure on each tab, and writes light + inverted-dark PNGs per tab for the
// validator to set beside session-manager-operations/design-mocks/extensions-3a/renders/.
// The app ships one light palette, so "dark" = Chromium dark colour-scheme emulation plus an
// inverted render. Output goes to test-results/ (gitignored) — never a tracked path.
const root = path.resolve(__dirname, '../..')
const OUT = path.join(root, 'test-results/extensions-3a')

async function expectFrame(page: Page) {
  // Folder tabs carry the user-scope counts: 0 skills + 1 command / 7 servers / 2 plugins.
  await expect(page.getByTestId('folder-tab-count-skills')).toHaveText('1')
  await expect(page.getByTestId('folder-tab-count-mcp')).toHaveText('7')
  await expect(page.getByTestId('folder-tab-count-plugins')).toHaveText('2')
  // 3a header: no h1 — the sidebar names the page; an 8px spacer stands in its place.
  await expect(page.locator('h1')).toHaveCount(0)
  await expect(page.getByTestId('section-frame-title-spacer')).toBeAttached()
}

test('Extensions 3a screenshots: skills, mcp, plugins — light + inverted dark', async () => {
  if (!fs.existsSync(path.join(root, 'dist-web/app.css'))) {
    execSync('npx vite build --config vite.web.config.ts', { cwd: root, stdio: 'inherit' })
  }
  const css = fs.readFileSync(path.join(root, 'dist-web/app.css'), 'utf8')
  const bundle = (await build({
    entryPoints: [path.join(__dirname, 'extensions-entry.tsx')],
    bundle: true, write: false, format: 'iife', jsx: 'automatic', loader: { '.css': 'empty' },
    define: { 'process.env.NODE_ENV': '"production"', __APP_VERSION__: '"0.0.0"' },
  })).outputFiles[0].text

  fs.mkdirSync(OUT, { recursive: true })
  const browser = await chromium.launch() // never Electron
  const pageErrors: string[] = []
  try {
    for (const scheme of ['light', 'dark'] as const) {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme })
      const page = await ctx.newPage()
      page.on('pageerror', (e) => pageErrors.push(e.message))
      await page.route('http://fx.test/**', (r) =>
        r.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><style>${css}</style></head><body class="bg-bg"><div id="root"></div></body></html>` }),
      )
      await page.goto('http://fx.test/')
      await page.addScriptTag({ content: bundle })
      if (scheme === 'dark') await page.addStyleTag({ content: 'html{filter:invert(1) hue-rotate(180deg)}' })

      // ---- Skills: + New, the one command, the FROM PLUGINS group, a clean save bar.
      await expectFrame(page)
      await expect(page.getByTestId('skills-new')).toBeVisible()
      await expect(page.getByTestId('skills-section-skills-count')).toHaveText('0')
      await expect(page.getByTestId('skills-section-commands-count')).toHaveText('1')
      await page.getByTestId('skills-item').filter({ hasText: 'review-pr' }).first().click()
      await expect(page.getByTestId('savebar-clean')).toContainText('Saved — matches the file on disk')
      await page.waitForTimeout(300)
      await page.screenshot({ path: path.join(OUT, `skills-${scheme}.png`) })

      // ---- MCP Servers: + Add server, 7 rows, the stripe plugin server; Check again on fetch lists its tool.
      await page.getByTestId('folder-tab-mcp').click()
      await expectFrame(page)
      await expect(page.getByTestId('mcp-add-server')).toBeVisible()
      await expect(page.locator('[data-testid^="mcp-row-"]')).toHaveCount(7)
      await expect(page.getByTestId('mcp-plugins-count')).toHaveText('1')
      await page.getByTestId('mcp-row-fetch').click()
      await expect(page.getByTestId('mcp-detail-name')).toHaveText('fetch')
      await expect(page.getByTestId('savebar-clean')).toContainText('Saved — matches')
      await page.getByTestId('mcp-check-again').click()
      await expect(page.getByTestId('mcp-detail-status')).toContainText(/connected/i)
      await expect(page.getByTestId('mcp-tools-count')).toHaveText('1')
      await expect(page.getByTestId('mcp-tool-row-fetch')).toBeVisible()
      await page.waitForTimeout(300)
      await page.screenshot({ path: path.join(OUT, `mcp-${scheme}.png`) })

      // ---- Plugins: + Add plugin, two cards with their content chips.
      await page.getByTestId('folder-tab-plugins').click()
      await expectFrame(page)
      await expect(page.getByTestId('plugins-add')).toBeVisible()
      const cards = page.getByTestId('plugin-card')
      await expect(cards).toHaveCount(2)
      const smDev = cards.filter({ hasText: 'session-manager-dev' })
      await expect(smDev.getByTestId('plugin-chip-skills')).toContainText('4 skills')
      const stripe = cards.filter({ has: page.getByTestId('plugin-card-name').getByText('stripe', { exact: true }) })
      await expect(stripe.getByTestId('plugin-chip-skills')).toContainText('10 skills')
      await expect(stripe.getByTestId('plugin-chip-commands')).toContainText('2 commands')
      await expect(stripe.getByTestId('plugin-chip-mcp')).toContainText('MCP server')
      await expect(stripe.getByTestId('plugin-chip-agents')).toContainText('1 agent')
      await expect(stripe.getByTestId('plugin-chip-hooks')).toContainText('7 hooks')
      await page.waitForTimeout(300)
      await page.screenshot({ path: path.join(OUT, `plugins-${scheme}.png`) })
      await ctx.close()
    }
  } finally {
    await browser.close()
  }
  expect(pageErrors).toEqual([])
  for (const tab of ['skills', 'mcp', 'plugins']) {
    for (const scheme of ['light', 'dark']) {
      expect(fs.statSync(path.join(OUT, `${tab}-${scheme}.png`)).size).toBeGreaterThan(10_000)
    }
  }
})
