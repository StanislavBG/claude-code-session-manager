import { test, expect, chromium } from '@playwright/test'
import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureWebCss } from './webCss.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Real Chromium (never Electron). Renders the real Project Home document (key buttons +
// ProjectPagesSection) on its Tools tab with Review MD network selected, through
// project-home-entry.tsx (`?tab=tools`), whose stub window.api.projectPages.mdNetwork returns a
// scan with 2 duplicate pairs, 1 localOnly broken link and 1 orphan group. Writes the pane in
// light + dark, the LINK MAP card alone in light + dark (at a 1280px window, with a label-size
// check), and the explorer in Graph view to the Playwright output folder (gitignored).
// The app ships a single light palette, so "dark" = Chromium dark colour-scheme emulation plus
// an inverted render of the same page (as project-home-library-shots.spec.ts does). The Graph shot
// has one doc node selected so the inspector shows that doc's path, links and a realistic body,
// with the pointer moved off the canvas so no hover dims the graph.
const root = path.resolve(__dirname, '../..')

test('Review MD network screenshots: pane light + dark, explorer Graph view', async ({}, testInfo) => {
  const css = ensureWebCss(root)
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
      // FIX LIST card sits above the LINK MAP card in the pane.
      const fixBox = await page.getByTestId('md-fix-list').boundingBox()
      const mapBox = await page.getByTestId('md-link-map').boundingBox()
      expect(fixBox && mapBox).toBeTruthy()
      expect(fixBox!.y + fixBox!.height).toBeLessThanOrEqual(mapBox!.y)
      await page.waitForTimeout(300)
      const pane = testInfo.outputPath(`review-md-network-${scheme}.png`)
      await page.screenshot({ path: pane, fullPage: true })
      shots.push(pane)

      // LINK MAP card on its own: the app's inner scroller (not the page) scrolls, so a page shot
      // crops the map mid-graph. At the 1280px-wide window, bring the card into the scroller's view
      // and assert the 10.5-unit labels render at >= 10px (rendered width / viewBox width * 10.5).
      await page.setViewportSize({ width: 1280, height: 1100 })
      const mapCard = page.locator('[data-testid="md-link-map"]')
      await mapCard.scrollIntoViewIfNeeded()
      await expect(mapCard).toBeInViewport()
      const svg = page.getByTestId('md-link-map-svg')
      const { renderedWidth, viewBoxWidth } = await svg.evaluate((el) => ({
        renderedWidth: el.getBoundingClientRect().width,
        viewBoxWidth: (el as SVGSVGElement).viewBox.baseVal.width,
      }))
      expect(viewBoxWidth).toBe(760)
      expect((renderedWidth / viewBoxWidth) * 10.5).toBeGreaterThanOrEqual(10)
      await page.waitForTimeout(300)
      const mapShot = testInfo.outputPath(`review-md-network-map-${scheme}.png`)
      await mapCard.screenshot({ path: mapShot })
      shots.push(mapShot)
      await page.setViewportSize({ width: 1440, height: 1100 })

      if (scheme === 'light') {
        await page.getByTestId('md-link-map-expand').click()
        await expect(page.getByTestId('md-explorer')).toBeVisible()
        await expect(page.getByTestId('md-explorer-view-map')).toHaveAttribute('aria-pressed', 'true')
        await expect(page.getByTestId('md-explorer-canvas')).toBeVisible()
        await expect(page.getByTestId('md-link-map-node').first()).toBeAttached()
        await expect(page.getByTestId('md-explorer-legend')).toBeVisible()
        // Header 'N findings' must equal the pane's FIX LIST count.
        const fixCount = (await page.getByTestId('md-fix-count').textContent())?.trim()
        expect(fixCount).toMatch(/^\d+$/)
        await expect(page.getByTestId('md-explorer-counts')).toContainText(`${fixCount} finding${fixCount === '1' ? '' : 's'}`)
        // Select one doc node so the Graph shot shows a doc in the inspector, not the empty hint.
        const docNode = page
          .getByTestId('md-explorer-canvas')
          .locator('[data-testid="md-link-map-node"]:not([data-kind="folder"]):not([data-kind="missing"]):not([data-kind="orphan"])')
          .first()
        const docPath = await docNode.getAttribute('aria-label')
        expect(docPath).toBeTruthy()
        await docNode.click()
        await expect(docNode).toHaveAttribute('data-selected', 'true')
        const inspector = page.getByTestId('md-explorer-inspector')
        await expect(inspector.getByTestId('project-home-review-inspector-hint')).toHaveCount(0)
        await expect(inspector.getByTestId('md-doc-preview')).toBeVisible()
        await expect(inspector.getByTestId('md-doc-preview-path')).toHaveText(docPath!)
        // The preview renders the fixture's realistic body: heading, paragraphs, list, link.
        const body = inspector.getByTestId('md-doc-preview-body')
        await expect(body.locator('h1')).toHaveCount(1)
        await expect(body.locator('p').first()).toBeVisible()
        await expect(body.locator('li')).toHaveCount(3)
        await expect(body.locator('a[href$=".md"]')).toHaveCount(1)
        // Move the pointer off the canvas so the hover focus does not dim the selected node's neighbours.
        await page.mouse.move(1, 1)
        await expect(page.getByTestId('md-explorer-legend')).toBeVisible()
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
    'review-md-network-map-dark.png', 'review-md-network-map-light.png',
  ])
})
