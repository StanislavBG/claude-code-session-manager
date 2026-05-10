/**
 * Playwright Electron tests: History tab dashboard view.
 */
import { test, expect, _electron as electron } from '@playwright/test'
import { execSync } from 'node:child_process'
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
    timeout: 30_000,
  })
  const win = await app.firstWindow()
  win.on('console', (m) => {
    if (m.type() === 'error') console.log(`[renderer:error] ${m.text()}`)
  })
  await win.waitForSelector('text=Claude Session Manager', { timeout: 20_000 })
  await win.waitForTimeout(2000)
  return { app, win }
}

async function openHistoryTab(win) {
  await win.locator('nav button:has-text("History")').first().click()
  await win.waitForTimeout(1000)
}

test('typecheck passes', () => {
  const result = execSync('npm run typecheck', { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' })
  expect(result).not.toContain('error TS')
})

test('History tab shows dashboard by default', async () => {
  const { app, win } = await launchApp()
  await openHistoryTab(win)

  // The dashboard container or empty state should appear (no sessions = empty state)
  const dashboardOrEmpty = win.locator('[data-testid="history-dashboard"], .h-full.flex.items-center')
  await expect(dashboardOrEmpty.first()).toBeVisible({ timeout: 10_000 })

  // Log view should NOT be visible
  await expect(win.locator('[data-testid="history-log"]')).not.toBeVisible()

  await app.close()
})

test('Dashboard / Log toggle switches views', async () => {
  const { app, win } = await launchApp()
  await openHistoryTab(win)

  // Click "Log" button
  await win.locator('button:has-text("Log")').click()
  await win.waitForTimeout(500)
  await expect(win.locator('[data-testid="history-log"]')).toBeVisible({ timeout: 5_000 })
  await expect(win.locator('[data-testid="history-dashboard"]')).not.toBeVisible()

  // Click "Dashboard" button
  await win.locator('button:has-text("Dashboard")').click()
  await win.waitForTimeout(500)
  const dashboardOrEmpty = win.locator('[data-testid="history-dashboard"], .h-full.flex.items-center')
  await expect(dashboardOrEmpty.first()).toBeVisible({ timeout: 5_000 })

  await app.close()
})

test('View preference persists across tab switches', async () => {
  const { app, win } = await launchApp()
  await openHistoryTab(win)

  // Switch to Log view
  await win.locator('button:has-text("Log")').click()
  await win.waitForTimeout(500)
  await expect(win.locator('[data-testid="history-log"]')).toBeVisible({ timeout: 5_000 })

  // Navigate away to a different tab
  await win.locator('nav button').first().click()
  await win.waitForTimeout(500)

  // Navigate back to History
  await openHistoryTab(win)

  // Should still be in Log view
  await expect(win.locator('[data-testid="history-log"]')).toBeVisible({ timeout: 5_000 })

  // Verify localStorage value
  const stored = await win.evaluate(() => localStorage.getItem('sm.historyTab.view'))
  expect(stored).toBe('log')

  await app.close()
})

test('Future fromDate shows empty state', async () => {
  const { app, win } = await launchApp()
  await openHistoryTab(win)

  // Set fromDate to a future date using the date input
  const futureDate = '2099-01-01'
  await win.locator('input[type="date"]').first().fill(futureDate)
  await win.waitForTimeout(3000)

  // Should show empty state (no sessions in that range)
  await expect(win.locator('text=no completed sessions found')).toBeVisible({ timeout: 10_000 })

  await app.close()
})

test('history:aggregate IPC excludes today', async () => {
  const { app, win } = await launchApp()

  const today = new Date().toISOString().slice(0, 10)
  // Call with toDate = future — aggregator should clamp to today (exclusive)
  const result = await win.evaluate(async () => {
    return window.api.history.aggregate({ fromDate: '2020-01-01', toDate: '2099-12-31' })
  })

  expect(result).toBeDefined()
  expect(typeof result.scannedMs).toBe('number')
  expect(Array.isArray(result.rows)).toBe(true)

  // No row should have date >= today
  for (const row of result.rows) {
    expect(row.date < today).toBe(true)
  }

  await app.close()
})
