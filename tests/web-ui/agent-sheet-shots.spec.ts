import { test, expect, chromium, type Browser, type Page } from '@playwright/test'
import { build } from 'esbuild'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { outDirFor, type ShotsSpec } from './shotsOutDir.ts'

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
const openSheet = (name: string) => async (page: Page) => {
  await page.locator(`[data-testid="agent-card"][data-agent-row="${name}"]`).click()
  await page.getByTestId('agent-sheet').waitFor()
  // GearPanel renders from the armory: wait for its floor chips + companions slot (frame 1b's gear area).
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
  // 1e: sheet + the Armory drawer open (Open Armory in the Gear header). The mid-drag ghost is a native HTML5 drag image and is not shot.
  { name: 'armory-drag', testid: 'agent-roster', reference: '1e-armory-mid-drag.png', setUp: async (page) => { await openSheet('architect')(page); await page.getByTestId('agent-open-armory').click(); await page.getByTestId('agent-armory').waitFor() } },
  // 1f: blender-artist's sheet with the blender server's Powers panel open.
  { name: 'mcp-powers', testid: 'agent-roster', reference: '1f-mcp-powers.png', setUp: async (page) => { await openSheet('blender-artist')(page); await page.locator('[data-testid="agent-mcp-item"][data-server="blender"] [data-testid="agent-mcp-powers-open"]').click(); await page.getByTestId('agent-mcp-powers').waitFor() } },
  // 1g: an Undecided agent's sheet shows the first-run choice in the gear area.
  { name: 'undecided', testid: 'agent-roster', reference: '1g-undecided-first-run.png', setUp: async (page) => { await openSheet('page-history')(page); await page.getByTestId('agent-undecided-choice').waitFor() } },
  // 1h: builder's sheet in project mode — Global | In project ▾ picks Self, whose overlay overrides the model.
  { name: 'project-override', testid: 'agent-roster', reference: '1h-project-override.png', setUp: async (page) => {
    await openSheet('builder')(page)
    await page.getByRole('button', { name: 'In project' }).click()
    await page.getByTestId('agent-project-select').selectOption({ label: 'Self' })
    await page.getByTestId('agent-project-override').waitFor()
  } },
]

let browser: Browser
let css = ''
let bundle = ''

test.beforeAll(async () => {
  if (!fs.existsSync(path.join(root, 'dist-web/app.css'))) {
    execSync('npx vite build --config vite.web.config.ts', { cwd: root, stdio: 'inherit' })
  }
  css = fs.readFileSync(path.join(root, 'dist-web/app.css'), 'utf8')
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
