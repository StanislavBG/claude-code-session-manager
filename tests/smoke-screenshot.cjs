// One-shot Electron smoke + screenshot using Electron's own capturePage API
// (Playwright's screenshot path hangs on `waitForFonts` in xvfb).

const { _electron: electron } = require('@playwright/test')
const path = require('node:path')
const fs = require('node:fs')

const ROOT = path.resolve(__dirname, '..')

async function snap(app, win, file) {
  const buf = await app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    const img = await w.webContents.capturePage()
    return img.toPNG().toString('base64')
  })
  fs.writeFileSync(file, Buffer.from(buf, 'base64'))
}

async function main() {
  const app = await electron.launch({
    args: [path.join(ROOT, 'src', 'main', 'index.cjs')],
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      SM_E2E: '1',
      SM_SUPERVISOR_DISABLE: '1',
      SM_MOCK_BILLING_KIND: 'meter_rate_limited',
    },
  })
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  win.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`)
  })

  await win.waitForSelector('text=Claude Session Manager', { timeout: 15_000 })
  await win.waitForTimeout(1200)
  await snap(app, win, '/tmp/almanac-home.png')
  console.log('OK home')

  // Open command palette → navigate to Settings
  await win.keyboard.press('Control+K')
  await win.waitForTimeout(300)
  await win.keyboard.type('Settings')
  await win.waitForTimeout(300)
  await win.keyboard.press('Enter')
  await win.waitForTimeout(1200)
  await snap(app, win, '/tmp/almanac-settings.png')
  console.log('OK settings')

  // Open Skills via the sidebar instead of palette
  await win.keyboard.press('Control+K')
  await win.waitForTimeout(300)
  await win.keyboard.type('Skills')
  await win.waitForTimeout(300)
  await win.keyboard.press('Enter')
  await win.waitForTimeout(1200)
  await snap(app, win, '/tmp/almanac-skills.png')
  console.log('OK skills')

  await app.close()

  if (errors.length) {
    console.log('---renderer errors---')
    for (const e of errors.slice(0, 20)) console.log(e)
    if (errors.length > 20) console.log(`... and ${errors.length - 20} more`)
    process.exit(2)
  }
  console.log('OK no renderer errors')
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(1)
})
