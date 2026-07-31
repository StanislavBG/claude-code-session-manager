import { _electron as electron } from 'playwright'
import path from 'node:path'
import fs from 'node:fs'

const ROOT = '/home/bilko/Projects/session-manager'
const OUT = '/tmp/sm-layout-screenshots'
fs.mkdirSync(OUT, { recursive: true })

async function main() {
  const app = await electron.launch({
    args: [path.join(ROOT, 'src/main/index.cjs')],
    cwd: ROOT,
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await win.waitForTimeout(2000)

  // Navigate to Terminal (Chat) tab via Cmd-K palette.
  await win.keyboard.press('Control+K')
  const palette = win.locator('[data-testid="command-palette"]')
  await palette.waitFor({ state: 'visible', timeout: 5000 })
  await win.locator('[data-testid="command-palette"] input[role="combobox"]').fill('go to terminal')
  await win.locator('button[data-cmd-id="nav:terminal"]').first().waitFor({ state: 'visible', timeout: 3000 })
  await win.keyboard.press('Enter')
  await palette.waitFor({ state: 'hidden', timeout: 3000 })
  await win.waitForTimeout(1500)

  // Wide viewport (>1180px): Prompt Queue primary/center, transcript in rail.
  await win.setViewportSize({ width: 1440, height: 900 })
  await win.waitForTimeout(500)
  await win.locator('[data-testid="chat-queue-panel"]').waitFor({ state: 'visible', timeout: 5000 })
  await win.screenshot({ path: path.join(OUT, '1-wide-paper-theme.png') })

  // Narrow viewport (<=1180px): Prompt Queue shown by default, toggle visible.
  await win.setViewportSize({ width: 900, height: 900 })
  await win.waitForTimeout(500)
  await win.locator('[data-testid="chat-queue-panel"]').waitFor({ state: 'visible', timeout: 5000 })
  await win.screenshot({ path: path.join(OUT, '2-narrow-queue-default.png') })

  // Click "View transcript" toggle.
  const showTranscriptBtn = win.locator('[data-testid="show-transcript-btn"]')
  await showTranscriptBtn.waitFor({ state: 'visible', timeout: 5000 })
  await showTranscriptBtn.click()
  await win.waitForTimeout(500)
  await win.screenshot({ path: path.join(OUT, '3-narrow-transcript-toggled.png') })

  await app.close()
  console.log('Screenshots saved to', OUT)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
