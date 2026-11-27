import { test, expect, chromium, type Browser, type Page } from '@playwright/test'
import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { outDirFor, type ShotsSpec } from './shotsOutDir.ts'
import { ensureWebCss } from './webCss.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Real Chromium (never Electron). Mounts the real Agents tab (AgentLibrary, via agent-sheet-entry.tsx)
// over a stub window.api shaped like the character-sheet design's sample data (12 personas: 3 undecided,
// 7 equipped, 1 bare, 1 unbound; an armory with built-ins, 3 MCP servers, 2 packs, risk marks) and writes
// one PNG per frame x scheme at the design's page-area size (1592x1040):
//   roster, sheet, sheet-list-expanded, armory-drag, mcp-powers, undecided, project-override  -> <frame>-light.png / -dark.png
//
// REFERENCE: session-manager-operations/design-mocks/agent-character-sheet/renders/ (light, 1592x1040):
//   roster=1a-roster  sheet=1b-sheet-workbench  armory-drag=1e-armory-mid-drag  mcp-powers=1f-mcp-powers
//   undecided=1g-undecided-first-run  project-override=1h-project-override
// HOW TO COMPARE: run this spec, open each light PNG beside its reference render (same size) and check
// layout, labels, counts and states against DESIGN_SPEC.md (deliberate deviations listed there); dark is
// checked for legibility only. Output folder: ./shotsOutDir.ts (default test-results/agent-sheet/,
// gitignored; SM_SHOTS_OUT=<path> overrides).
//
// The roster frame (1a) is built (AgentRoster, testid 'agent-roster'). A frame whose UI does not exist yet is skipped (test.skip with the missing testid named); the PRD that
// builds that UI un-skips it by adding the testid.
const root = path.resolve(__dirname, '../..')
const SHOTS: ShotsSpec = { specName: 'agent-sheet' }
const OUT = outDirFor(root, SHOTS)
const VIEWPORT = { width: 1592, height: 1040 }

interface Frame {
  name: string
  /** The testid the finished UI carries for this frame; absent = frame not built yet. */
  testid: string
  /** The render this frame is compared against. */
  reference: string
  /** Put the page in the frame's state before the shot. */
  setUp?: (page: Page) => Promise<void>
}

// Roster card -> the sheet; the list column starts as the collapsed 64 px avatar rail (frame 1c's rail).
const openSheet = (name: string, opts: { gear?: boolean } = {}) => async (page: Page) => {
  await page.locator(`[data-testid="agent-card"][data-agent-row="${name}"]`).click()
  await page.getByTestId('agent-sheet').waitFor()
  // GearPanel renders from the armory: wait for its floor chips + companions slot (frame 1b's gear area).
  if (opts.gear === false) return // Undecided: the first-run choice replaces the Gear panel
  await page.getByTestId('agent-floor-row').waitFor()
  await page.getByTestId('agent-companions-slot').waitFor()
  // 1b layout: Gear sits in the centre column (before Personality); Constraints + Applies-to in the right column.
  const top = async (id: string) => (await page.getByTestId(id).boundingBox())!
  const gear = await top('agent-floor-row'); const pers = await top('agent-personality')
  if (!(gear.y < pers.y)) throw new Error('gear must sit above personality (centre column)')
}

const FRAMES: Frame[] = [
  { name: 'roster', testid: 'agent-roster', reference: '1a-roster.png', setUp: async (page) => { await page.getByTestId('agent-card').first().waitFor() } },
  // 1b workbench (collapsed rail by default); gear = GearPanel (built); constraints is a sibling PRD. Rail = 1c's left edge.
  { name: 'sheet', testid: 'agent-roster', reference: '1b-sheet-workbench.png', setUp: openSheet('architect') },
  // The same sheet with the list column expanded to 1b's 316 px list.
  { name: 'sheet-list-expanded', testid: 'agent-roster', reference: '1b-sheet-workbench.png', setUp: async (page) => { await openSheet('architect')(page); await page.getByTestId('agent-list-toggle').click(); await page.locator('[data-agent-row="builder"]').waitFor() } },
  // 1e: sheet + the Armory drawer open (Open Armory in the Gear header). Mid-drag: dragstart on an MCP item + dragenter on the MCP row (synthetic events — a native drag image cannot be shot), so the 'Moving…' ghost and the 'Release to equip' target show.
  { name: 'armory-drag', testid: 'agent-roster', reference: '1e-armory-mid-drag.png', setUp: async (page) => { await openSheet('architect')(page); await page.getByTestId('agent-open-armory').click(); await page.getByTestId('agent-armory').waitFor()
    const drawer = await page.getByTestId('agent-armory').boundingBox(); const row = await page.getByTestId('agent-mcp-row').boundingBox()
    if (!drawer || !row || row.x + row.width > drawer.x) throw new Error('the armory drawer must not cover the Gear drop rows')
    await page.locator('[data-testid="armory-item"][data-item="session-manager-scheduler"]').dispatchEvent('dragstart')
    await page.getByTestId('agent-mcp-row').dispatchEvent('dragenter')
    await page.getByTestId('agent-release-hint').waitFor()
    // 1e's floating ghost card under the pointer (a native drag image cannot be shot): a clone of the dragged item, tilted, over the MCP row.
    await page.evaluate(() => {
      const src = document.querySelector('[data-testid="armory-item"][data-item="session-manager-scheduler"]') as HTMLElement
      const tgt = document.querySelector('[data-testid="agent-mcp-row"]')!.getBoundingClientRect()
      const g = src.cloneNode(true) as HTMLElement
      g.setAttribute('data-testid', 'armory-drag-ghost'); g.removeAttribute('data-item'); g.removeAttribute('draggable')
      Object.assign(g.style, { position: 'fixed', left: `${tgt.x + 140}px`, top: `${tgt.y + 40}px`, width: '260px', zIndex: '99999', pointerEvents: 'none', transform: 'rotate(-2deg)', boxShadow: '0 12px 28px rgba(0,0,0,.28)', background: 'var(--bg-hi, #fff)', opacity: '0.96' })
      document.body.appendChild(g)
    })
    await page.getByTestId('armory-drag-ghost').waitFor() } },
  // 1f: blender-artist's sheet with the blender server's Powers panel open.
  { name: 'mcp-powers', testid: 'agent-roster', reference: '1f-mcp-powers.png', setUp: async (page) => { await openSheet('blender-artist')(page); await page.locator('[data-testid="agent-mcp-item"][data-server="blender"] [data-testid="agent-mcp-powers-open"]').click(); await page.getByTestId('agent-mcp-powers').waitFor()
    // 1f layout: full server name (not clipped), short tool labels, header children do not overlap.
    const name = page.getByTestId('agent-mcp-powers-name')
    if ((await name.textContent())?.trim() !== 'blender') throw new Error('powers header must show the full server name')
    if (await name.evaluate((el) => el.scrollWidth > el.clientWidth)) throw new Error('server name is clipped')
    const first = await page.locator('[data-power]').first().textContent()
    if (first?.includes('mcp__')) throw new Error('tool labels must be the short name, not the mcp__ id')
    const count = (await page.getByTestId('agent-mcp-powers-count').boundingBox())!; const nb = (await name.boundingBox())!
    if (nb.x + nb.width > count.x + 1) throw new Error('powers header text overlaps the count')
  } },
  // 1g: an Undecided agent's sheet shows the first-run choice in the gear area.
  { name: 'undecided', testid: 'agent-roster', reference: '1g-undecided-first-run.png', setUp: async (page) => { await openSheet('page-history', { gear: false })(page); await page.getByTestId('agent-undecided-choice').waitFor()
    if (await page.getByTestId('agent-gear-slot').count()) throw new Error('the Gear panel must not render under the first-run choice')
    const cards = page.locator('[data-testid="agent-undecided-choice"] [data-choice]')
    if (await cards.count() !== 3) throw new Error('first-run choice needs three cards')
    const box = await cards.first().boundingBox(); const sec = await page.getByTestId('agent-undecided-choice').boundingBox()
    if (!box || !sec || box.width < sec.width * 0.8) throw new Error('first-run cards must be full width')
    await page.getByTestId('agent-runs-today').waitFor() } },
  // 1h: builder's sheet in project mode — Global | In project ▾ picks Self, whose overlay overrides the model.
  { name: 'project-override', testid: 'agent-roster', reference: '1h-project-override.png', setUp: async (page) => {
    await openSheet('builder')(page)
    await page.getByRole('button', { name: 'In project' }).click()
    await page.getByTestId('agent-project-pill').click()
    await page.getByTestId('agent-project-option').filter({ hasText: 'Self' }).click()
    await page.getByTestId('agent-project-override').waitFor()
    // 1h layout: 'In <project> ▾' pill, project badge on the avatar, overlay header path, no empty DETAILS card, Other-projects card.
    if (!/In Self/.test((await page.getByTestId('agent-project-pill').textContent()) ?? '')) throw new Error("scope control must be the 'In Self ▾' pill")
    await page.getByTestId('agent-project-badge').waitFor()
    if (!/PROJECT OVERLAY.*\/Self\/\.claude\/agents\/builder\.md/.test((await page.getByTestId('agent-header-path').textContent()) ?? '')) throw new Error('header path must be the overlay path')
    if (await page.getByTestId('agent-details').count()) throw new Error('no empty DETAILS card in project mode')
    await page.getByTestId('agent-other-projects').waitFor()
  } },
  // Persona upgrade: the roster card's marker, then the sheet's notice + the list row badge with the diff open.
  { name: 'persona-upgrade-roster', testid: 'agent-roster', reference: '(none: no design mock)', setUp: async (page) => { await expect(page.getByTestId('agent-roster-upgrade-architect')).toBeVisible() } },
  { name: 'persona-upgrade-sheet', testid: 'agent-roster', reference: '(none: no design mock)', setUp: async (page) => {
    await openSheet('architect')(page)
    await expect(page.getByTestId('persona-upgrade-notice')).toBeVisible()
    await page.getByTestId('agent-list-toggle').click() // the row badge lives in the expanded list column
    await expect(page.getByTestId('agent-row-upgrade-architect')).toBeVisible()
    await page.getByTestId('persona-upgrade-notice').locator('summary').click()
    await expect(page.locator('[data-testid="persona-upgrade-notice"] [data-diff="add"]').first()).toBeVisible() } },
]

let browser: Browser
let css = ''
let bundle = ''

test.beforeAll(async () => {
  css = ensureWebCss(root)
  bundle = (await build({
    entryPoints: [path.join(__dirname, 'agent-sheet-entry.tsx')],
    bundle: true, write: false, format: 'iife', jsx: 'automatic', loader: { '.css': 'empty' }, logLevel: 'error',
    define: { 'process.env.NODE_ENV': '"production"', __APP_VERSION__: '"0.0.0"' },
  })).outputFiles[0].text
  fs.mkdirSync(OUT, { recursive: true })
  browser = await chromium.launch() // never Electron
})

test.afterAll(async () => {
  await browser?.close()
})

for (const frame of FRAMES) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`agent sheet: ${frame.name} (${scheme}) at 1592x1040`, async () => {
      const ctx = await browser.newContext({ viewport: VIEWPORT, colorScheme: scheme })
      const page = await ctx.newPage()
      const errors: string[] = []
      page.on('pageerror', (e) => errors.push(String(e)))
      page.on('console', (m) => { if (m.text().startsWith('[stub-api]')) errors.push(m.text()) })
      try {
        await page.route('http://fx.test/**', (r) =>
          r.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><style>${css}</style></head><body class="bg-bg"><div id="root"></div></body></html>` }),
        )
        await page.goto('http://fx.test/')
        await page.addScriptTag({ content: bundle })
        // The app ships one light palette: dark = colour-scheme emulation plus an inverted render.
        if (scheme === 'dark') await page.addStyleTag({ content: 'html{filter:invert(1) hue-rotate(180deg)}' })
        await expect(page.getByTestId('agent-row-model').first()).toBeVisible()

        test.skip(
          (await page.getByTestId(frame.testid).count()) === 0,
          `frame '${frame.name}' (${frame.reference}): UI not built yet — no [data-testid="${frame.testid}"]; the PRD that builds it un-skips this frame`,
        )
        await frame.setUp?.(page)
        await page.waitForTimeout(300) // fonts settle
        const file = path.join(OUT, `${frame.name}-${scheme}.png`)
        await page.screenshot({ path: file })
        expect(errors, 'page errors or unmodelled api calls').toEqual([])
        const png = fs.readFileSync(file)
        expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([VIEWPORT.width, VIEWPORT.height])
        expect(png.length).toBeGreaterThan(10_000)
      } finally {
        await ctx.close()
      }
    })
  }
}
