/**
 * Playwright Electron test: verifies new session + restart flows.
 */
import { test, expect, _electron as electron } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const TABS_JSON = path.join(process.env.HOME, '.config', 'session-manager', 'tabs.json')

test.beforeEach(() => {
  if (fs.existsSync(TABS_JSON)) {
    fs.copyFileSync(TABS_JSON, TABS_JSON + '.bak')
    fs.unlinkSync(TABS_JSON)
  }
})

test.afterEach(() => {
  if (fs.existsSync(TABS_JSON + '.bak')) {
    fs.copyFileSync(TABS_JSON + '.bak', TABS_JSON)
    fs.unlinkSync(TABS_JSON + '.bak')
  }
})

async function launchApp() {
  const app = await electron.launch({
    args: [path.join(ROOT, 'src', 'main', 'index.cjs')],
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'development', SM_E2E: '1' },
  })
  const win = await app.firstWindow()
  const logs = []
  win.on('console', (msg) => logs.push(`[${msg.type()}] ${msg.text()}`))
  await win.waitForSelector('text=Claude Session Manager', { timeout: 15000 })
  await win.waitForTimeout(3000)
  return { app, win, logs }
}

test('TabBar dropdown creates a new session', async () => {
  const { app, win } = await launchApp()

  const tabsBefore = await win.locator('.group.px-3').count()
  expect(tabsBefore).toBe(1)

  // Open dropdown, pick first preset (Session Manager skip perms).
  // Title is "New session — pick a project directory" — match by prefix.
  await win.locator('button[title^="New session"]').click()
  await win.waitForTimeout(300)
  await win.locator('.absolute.top-full button').first().click()
  await win.waitForTimeout(3000)

  const tabsAfter = await win.locator('.group.px-3').count()
  expect(tabsAfter).toBe(2)

  // Both should be running (green dots)
  const greenDots = await win.locator('.bg-green-500').count()
  expect(greenDots).toBe(2)

  await app.close()
})

test('restart button respawns the active session', async () => {
  const { app, win, logs } = await launchApp()

  // Verify initial session is running
  const greenBefore = await win.locator('.bg-green-500').count()
  expect(greenBefore).toBe(1)

  // Get the initial tab's claudeSessionId from tabs.json
  await win.waitForTimeout(500)
  const before = JSON.parse(fs.readFileSync(TABS_JSON, 'utf8'))
  const sessionIdBefore = before.tabs[0].claudeSessionId

  // Click "Restart Session" in the MainPane header
  const restartBtn = win.locator('button', { hasText: 'Restart Session' })
  await expect(restartBtn).toBeVisible()
  await restartBtn.click()

  // Wait for PTY kill + remount + respawn + claude boot
  await win.waitForTimeout(8000)

  // Should still have 1 tab, and it should be running
  const tabsAfter = await win.locator('.group.px-3').count()
  expect(tabsAfter).toBe(1)

  const greenAfter = await win.locator('.bg-green-500').count()
  expect(greenAfter).toBe(1)

  // claudeSessionId should have changed (new session)
  const after = JSON.parse(fs.readFileSync(TABS_JSON, 'utf8'))
  const sessionIdAfter = after.tabs[0].claudeSessionId
  console.log('Session ID before:', sessionIdBefore)
  console.log('Session ID after:', sessionIdAfter)
  expect(sessionIdAfter).not.toBe(sessionIdBefore)

  await app.close()
})

test('StatusBar restart link works', async () => {
  const { app, win } = await launchApp()

  // StatusBar restart should be visible for running session
  const statusRestart = win.locator('button', { hasText: 'restart' }).last()
  await expect(statusRestart).toBeVisible()

  const before = JSON.parse(fs.readFileSync(TABS_JSON, 'utf8'))
  await statusRestart.click()
  await win.waitForTimeout(5000)

  const after = JSON.parse(fs.readFileSync(TABS_JSON, 'utf8'))
  expect(after.tabs[0].claudeSessionId).not.toBe(before.tabs[0].claudeSessionId)

  await app.close()
})
