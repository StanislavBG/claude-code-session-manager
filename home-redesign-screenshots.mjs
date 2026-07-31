// Manual-only capture script for the redesigned Home surfaces (PRD 840-series).
// Run it yourself: `xvfb-run node home-redesign-screenshots.mjs` (Linux) or
// `node home-redesign-screenshots.mjs` (macOS). Not part of CI — the scheduler
// must never invoke this; headless `claude -p` cannot drive the GUI.

import { _electron as electron } from 'playwright'
import path from 'node:path'
import fs from 'node:fs'

const ROOT = '/home/bilko/Projects/session-manager'
const OUT = '/tmp/home-redesign-screenshots'
fs.mkdirSync(OUT, { recursive: true })

// Fixture brief, matching the schema in
// session-manager-operations/design-mocks/home/DESIGN_SPEC.md.
const FIXTURE_BRIEF = {
  version: 1,
  synthesizedAt: new Date().toISOString(),
  model: 'claude-sonnet-5',
  purpose: 'Local cockpit for driving and observing Claude Code sessions.',
  what: [
    'Session Manager is an **Electron** desktop cockpit for Claude Code — Terminal plus 25+ config, observability, and scheduling tabs.',
    'The scheduler runs queued PRDs as headless `claude -p` jobs, capped at 3 concurrent sessions machine-wide.',
  ],
  areas: [
    { name: 'src/main', files: 42, note: 'Electron main process — IPC, scheduler, transcripts.', epic: 'Home redesign', heat: 0.8 },
    { name: 'src/renderer', files: 118, note: 'React + zustand UI.', epic: null, heat: 0.5 },
  ],
  scope: [
    { when: '2 days ago', kind: 'added', text: 'Per-project Home ("The Brief") scaffold shipped.', src: 'CLAUDE.md' },
    { when: '1 week ago', kind: 'decided', text: 'Scheduler consolidated into one nav destination.', src: 'commit 4ab267b' },
  ],
  conventions: [
    'No CommonJS in renderer, no ES modules in main.',
    'All fs paths go through config.cjs validatePath.',
  ],
  pins: { what: false, conventions: true },
  pinned: { what: null, conventions: null },
}

function writeFixtureBrief(cwd) {
  const dir = path.join(cwd, 'session-manager-operations', 'project-brief')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'brief.json'), JSON.stringify(FIXTURE_BRIEF, null, 2))
}

function removeFixtureBrief(cwd) {
  const file = path.join(cwd, 'session-manager-operations', 'project-brief', 'brief.json')
  fs.rmSync(file, { force: true })
}

async function gotoNav(win, query, cmdId) {
  await win.keyboard.press('Control+K')
  const palette = win.locator('[data-testid="command-palette"]')
  await palette.waitFor({ state: 'visible', timeout: 5000 })
  await win.locator('[data-testid="command-palette"] input[role="combobox"]').fill(query)
  await win.locator(`button[data-cmd-id="${cmdId}"]`).first().waitFor({ state: 'visible', timeout: 3000 })
  await win.keyboard.press('Enter')
  await palette.waitFor({ state: 'hidden', timeout: 3000 })
  await win.waitForTimeout(1500)
}

async function main() {
  const app = await electron.launch({
    args: [path.join(ROOT, 'src/main/index.cjs')],
    cwd: ROOT,
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await win.waitForTimeout(2000)

  await win.setViewportSize({ width: 1600, height: 1000 })
  await win.waitForTimeout(500)

  // No brief fixture yet for this capture run — remove any stale one from a
  // prior manual run before the "no brief" screenshots.
  removeFixtureBrief(ROOT)

  // 1. Machine Home via the fixed TabBar Home chip — hero + usage/projects grid.
  await win.locator('[data-testid="tabbar-machine-home"]').click()
  await win.waitForTimeout(1000)
  const heroKicker = win.locator('text=This machine').first()
  await heroKicker.waitFor({ state: 'visible', timeout: 5000 })
  await win.screenshot({ path: path.join(OUT, 'home-redesign-1-machine-hero.png') })

  // 2. Machine Home scrolled to Active + Recent sessions.
  const activeHeading = win.locator('h2', { hasText: 'Active sessions' }).first()
  if (await activeHeading.count()) {
    await activeHeading.scrollIntoViewIfNeeded()
    await win.waitForTimeout(300)
  }
  await win.screenshot({ path: path.join(OUT, 'home-redesign-2-active-and-recent.png') })

  // 3. Project Home with no brief — "Generate the brief" empty state + live blocks.
  await gotoNav(win, 'go to home', 'nav:project-home')
  const generateButton = win.locator('button', { hasText: 'Generate the brief' }).first()
  await generateButton.waitFor({ state: 'visible', timeout: 5000 })
  await win.screenshot({ path: path.join(OUT, 'home-redesign-3-project-home-no-brief.png') })

  // 4. Project Home with a brief present — seed the fixture, then reload the tab.
  writeFixtureBrief(ROOT)
  await win.locator('[data-testid="tabbar-machine-home"]').click()
  await win.waitForTimeout(500)
  await gotoNav(win, 'go to home', 'nav:project-home')
  const briefHeading = win.locator('text=What this is').first()
  await briefHeading.waitFor({ state: 'visible', timeout: 5000 })
  await win.waitForTimeout(300)
  await win.screenshot({ path: path.join(OUT, 'home-redesign-4-project-home-with-brief.png') })

  removeFixtureBrief(ROOT)

  await app.close()
  console.log('Screenshots saved to', OUT)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
