import { _electron as electron } from 'playwright'
import path from 'node:path'
import fs from 'node:fs'

const ROOT = '/home/bilko/Projects/session-manager'
const OUT = '/tmp/scheduler-structure'
fs.mkdirSync(OUT, { recursive: true })

async function main() {
  const app = await electron.launch({
    args: [path.join(ROOT, 'src/main/index.cjs')],
    cwd: ROOT,
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await win.setViewportSize({ width: 1600, height: 1000 })
  await win.waitForTimeout(2500)

  const schedulerNav = win.locator('text=Scheduler').first()
  await schedulerNav.waitFor({ state: 'visible', timeout: 5000 })
  await schedulerNav.click()
  await win.waitForTimeout(2000)

  await win.screenshot({ path: path.join(OUT, '1-scheduler-queue.png') })

  const prdsTab = win.locator('button, [role="tab"]').filter({ hasText: /^PRDs$/ }).first()
  if (await prdsTab.count()) {
    await prdsTab.click()
    await win.waitForTimeout(1500)
    await win.screenshot({ path: path.join(OUT, '2-scheduler-prds.png') })
  } else {
    console.log('PRDs tab not found')
  }

  await app.close()
  console.log('Screenshots saved to', OUT)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
