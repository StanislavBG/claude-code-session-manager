import { _electron as electron } from 'playwright'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const ROOT = '/home/bilko/Projects/session-manager'
const OUT = '/tmp/tabbar-group-screenshots'
fs.mkdirSync(OUT, { recursive: true })

const TABS_PATH = path.join(os.homedir(), '.config', 'session-manager', 'tabs.json')

const sharedCwd = '/home/bilko/Projects/session-manager'
const soloCwd = '/home/bilko/Projects/Agents'

const tabA = { id: randomUUID(), sessionId: randomUUID(), cwd: sharedCwd, label: 'sm-alpha', presetId: null }
const tabB = { id: randomUUID(), sessionId: randomUUID(), cwd: sharedCwd, label: 'sm-beta', presetId: null }
const tabC = { id: randomUUID(), sessionId: randomUUID(), cwd: soloCwd, label: 'agents-solo', presetId: null }

fs.writeFileSync(
  TABS_PATH,
  JSON.stringify({ tabs: [tabA, tabB, tabC], activeTabId: tabC.id, savedAt: Date.now() }, null, 2),
)

async function main() {
  const app = await electron.launch({
    args: [path.join(ROOT, 'src/main/index.cjs')],
    cwd: ROOT,
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await win.waitForTimeout(2500)

  await win.locator('[data-testid="tour-tabbar"]').waitFor({ state: 'visible', timeout: 10000 })
  await win.waitForTimeout(1000)
  await win.setViewportSize({ width: 1440, height: 900 })
  await win.waitForTimeout(300)
  await win.screenshot({ path: path.join(OUT, '1-tabbar-grouped.png') })

  await app.close()
  console.log('Screenshot saved to', OUT)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
