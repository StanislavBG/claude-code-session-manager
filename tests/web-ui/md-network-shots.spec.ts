import { test, expect, chromium } from '@playwright/test'
import { build } from 'esbuild'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Real Chromium (never Electron). Renders the real Project Home document (key buttons +
// ProjectPagesSection) on its Tools tab with Review MD network selected, through
// project-home-entry.tsx (`?tab=tools`), whose stub window.api.projectPages.mdNetwork returns a
// scan with 2 duplicate pairs, 1 localOnly broken link and 1 orphan group. Writes the pane in
// light + dark and the explorer in Graph view to the Playwright output folder (gitignored).
// The app ships a single light palette, so "dark" = Chromium dark colour-scheme emulation plus
// an inverted render of the same page (as project-home-library-shots.spec.ts does).
const root = path.resolve(__dirname, '../..')

test('Review MD network screenshots: pane light + dark, explorer Graph view', async ({}, testInfo) => {
  if (!fs.existsSync(path.join(root, 'dist-web/app.css'))) {
    execSync('npx vite build --config vite.web.config.ts', { cwd: root, stdio: 'inherit' })
  }
  const css = fs.readFileSync(path.join(root, 'dist-web/app.css'), 'utf8')
  const bundle = (await build({
    entryPoints: [path.join(__dirname, 'project-home-entry.tsx')],
    bundle: true, write: false, format: 'iife', jsx: 'automatic', loader: { '.css': 'empty' },
    define: { 'process.env.NODE_ENV': '"production"', __APP_VERSION__: '"0.0.0"' },
  })).outputFiles[0].text

  const shots: string[] = []
  const browser = await chromium.launch() // never Electron
  try {
    for (const scheme of ['light', 'dark'] as const) {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 }, colorScheme: scheme })
      const page = await ctx.newPage()
      await page.route('http://fx.test/**', (r) =>
        r.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><style>${css}</style></head><body class="bg-bg"><div id="root"></div></body></html>` }),
      )
      await page.goto('http://fx.test/?tab=tools')
      await page.addScriptTag({ content: bundle })
      if (scheme === 'dark') await page.addStyleTag({ content: 'html{filter:invert(1) hue-rotate(180deg)}' })

      await expect(page.getByTestId('project-home-tool-content')).toHaveAttribute('data-macro-id', 'builtin-review-md-network')
      await expect(page.locator('[data-testid="project-home-tool"][aria-current="true"]')).toHaveAttribute('data-macro-id', 'builtin-review-md-network')
      // Fix list: 2 duplicates first, then the local-only broken link, then the orphan group.
      const rows = page.getByTestId('md-fix-row')
      await expect(rows).toHaveCount(4)
      await expect(rows.first()).toHaveAttribute('data-type', 'duplicate')
      await expect(rows.nth(0).getByTestId('md-fix-type')).toHaveText('duplicate')
      expect(await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-type')))).toEqual([
        'duplicate', 'duplicate', 'broken-link', 'orphan',
      ])
      await expect(rows.nth(2).getByTestId('md-fix-detail')).toContainText('Works only on this machine')
      await expect(page.getByTestId('md-link-map-svg')).toBeVisible()
      await expect(page.getByTestId('project-home-review-info-text')).toContainText('4 findings')
      await page.waitForTimeout(300)
      const pane = testInfo.outputPath(`review-md-network-${scheme}.png`)
      await page.screenshot({ path: pane, fullPage: true })
      shots.push(pane)

      if (scheme === 'light') {
        await page.getByTestId('md-link-map-expand').click()
        await expect(page.getByTestId('md-explorer')).toBeVisible()
        await expect(page.getByTestId('md-explorer-view-map')).toHaveAttribute('aria-pressed', 'true')
        await expect(page.getByTestId('md-explorer-canvas')).toBeVisible()
        await expect(page.getByTestId('md-link-map-node').first()).toBeAttached()
        await page.waitForTimeout(300)
        const graph = testInfo.outputPath('review-md-network-explorer-graph.png')
        await page.screenshot({ path: graph })
        shots.push(graph)
      }
      await ctx.close()
    }
  } finally {
    await browser.close()
  }
  for (const p of shots) expect(fs.statSync(p).size).toBeGreaterThan(10_000)
  expect(shots.map((p) => path.basename(p)).sort()).toEqual([
    'review-md-network-dark.png', 'review-md-network-explorer-graph.png', 'review-md-network-light.png',
  ])
})
