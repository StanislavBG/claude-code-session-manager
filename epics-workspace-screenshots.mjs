import { _electron as electron } from 'playwright'
import path from 'node:path'
import fs from 'node:fs'

const ROOT = '/home/bilko/Projects/session-manager'
const OUT = '/tmp/epics-workspace-screenshots'
fs.mkdirSync(OUT, { recursive: true })

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

  // Navigate to the Epics ('terminal' nav) destination via Cmd-K palette.
  await win.keyboard.press('Control+K')
  const palette = win.locator('[data-testid="command-palette"]')
  await palette.waitFor({ state: 'visible', timeout: 5000 })
  await win.locator('[data-testid="command-palette"] input[role="combobox"]').fill('go to terminal')
  await win.locator('button[data-cmd-id="nav:terminal"]').first().waitFor({ state: 'visible', timeout: 3000 })
  await win.keyboard.press('Enter')
  await palette.waitFor({ state: 'hidden', timeout: 3000 })
  await win.waitForTimeout(1500)

  const workspace = win.locator('[data-testid="epics-workspace"]')
  await workspace.waitFor({ state: 'visible', timeout: 5000 })

  // 1. Queue + detail (or empty state, if no Epics exist yet).
  await win.screenshot({ path: path.join(OUT, '1-queue-and-detail.png') })

  // 2. New Epic card — right pane swap.
  const newEpicButton = win.locator('button', { hasText: '+ New Epic' }).first()
  await newEpicButton.waitFor({ state: 'visible', timeout: 5000 })
  await newEpicButton.click()
  const newEpicCard = win.locator('[data-testid="new-epic-card"]')
  await newEpicCard.waitFor({ state: 'visible', timeout: 5000 })
  await win.waitForTimeout(300)
  await win.screenshot({ path: path.join(OUT, '2-new-epic-card.png') })
  await win.locator('[data-testid="new-epic-cancel"]').click()

  // 3. PRDs tab of the detail pane, if an Epic row exists to select.
  const firstRow = win.locator('[data-testid="epic-queue-row"]').first()
  if (await firstRow.count()) {
    await firstRow.click()
    const detail = win.locator('[data-testid="epic-detail"]')
    await detail.waitFor({ state: 'visible', timeout: 5000 })
    const prdsTab = detail.locator('button', { hasText: /^PRDs/ }).first()
    await prdsTab.click()
    await win.waitForTimeout(300)
    await win.screenshot({ path: path.join(OUT, '3-prds-tab.png') })
  }

  await app.close()
  console.log('Screenshots saved to', OUT)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
