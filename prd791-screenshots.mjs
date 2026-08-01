import { _electron as electron } from 'playwright'
import path from 'node:path'
import fs from 'node:fs'

const ROOT = '/home/bilko/Projects/session-manager'
const OUT = '/tmp/prd791-screenshots'
fs.mkdirSync(OUT, { recursive: true })

async function main() {
  const app = await electron.launch({
    args: [path.join(ROOT, 'src/main/index.cjs')],
    cwd: ROOT,
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await win.waitForTimeout(2000)

  // Sidebar screenshot — mic button removed from the "New session" row.
  await win.setViewportSize({ width: 1440, height: 900 })
  await win.waitForTimeout(500)
  const sidebar = win.locator('[data-testid="tour-leftnav"]')
  await sidebar.waitFor({ state: 'visible', timeout: 5000 })
  await sidebar.screenshot({ path: path.join(OUT, '1-sidebar-no-mic.png') })

  // Navigate to Terminal (Chat) tab via Cmd-K palette.
  await win.keyboard.press('Control+K')
  const palette = win.locator('[data-testid="command-palette"]')
  await palette.waitFor({ state: 'visible', timeout: 5000 })
  await win.locator('[data-testid="command-palette"] input[role="combobox"]').fill('go to terminal')
  await win.locator('button[data-cmd-id="nav:terminal"]').first().waitFor({ state: 'visible', timeout: 3000 })
  await win.keyboard.press('Enter')
  await palette.waitFor({ state: 'hidden', timeout: 3000 })
  await win.waitForTimeout(1500)

  const composerRow = win.locator('textarea').locator('xpath=..')
  await composerRow.waitFor({ state: 'visible', timeout: 5000 })
  await composerRow.screenshot({ path: path.join(OUT, '2-composer-mic-left.png') })
  await win.screenshot({ path: path.join(OUT, '3-composer-full-window.png') })

  await app.close()
  console.log('Screenshots saved to', OUT)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
