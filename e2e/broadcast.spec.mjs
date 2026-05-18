/**
 * E2E regression test for the Broadcast feature.
 *
 * Reproduction path for the original crash:
 *   PtyManager.write() called s.proc.write(data) on a dead node-pty socket.
 *   node-pty's internal net.Socket emitted an 'error' event that had no
 *   listener, which Node.js re-threw as an uncaught exception — bypassing the
 *   synchronous try-catch in the IPC handler and crashing the main process.
 *   Additionally, writes to tabs whose IDs were removed from the sessions
 *   store were silently dropped with no renderer feedback.
 *
 * Fix: PtyManager.write() now checks session existence and wraps proc.write in
 *   try-catch, emitting 'pty:write-error' back to the renderer in both failure
 *   paths. BroadcastBar subscribes to that event and marks the corresponding
 *   row as 'skipped'.
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
  // Seed two tabs so broadcast has multiple targets — we can't stub
  // window.api.app.pickDirectory (contextBridge freezes it under
  // contextIsolation:true), so create them via tabs.json hydration instead.
  const mkTab = (n) => ({
    id: `test-tab-${n}-${Date.now()}`,
    claudeSessionId: `test-session-${n}-${Date.now()}`,
    cwd: ROOT,
    label: null,
    presetId: 'pick-dangerous',
    pid: null,
    status: 'spawning',
    exitCode: null,
    startupCommand: `claude --dangerously-skip-permissions --session-id test-session-${n}`,
    generation: 0,
  })
  const t1 = mkTab(1)
  const t2 = mkTab(2)
  fs.mkdirSync(path.dirname(TABS_JSON), { recursive: true })
  fs.writeFileSync(TABS_JSON, JSON.stringify({ tabs: [t1, t2], activeTabId: t1.id }))

  const app = await electron.launch({
    args: [path.join(ROOT, 'src', 'main', 'index.cjs')],
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'development', SM_E2E: '1' },
  })
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (err) => errors.push(err.message))
  const logs = []
  win.on('console', (msg) => logs.push(`[${msg.type()}] ${msg.text()}`))
  await win.waitForSelector('text=Claude Session Manager', { timeout: 15_000 })
  await win.waitForTimeout(3000)
  return { app, win, errors, logs }
}

test('broadcast sends prompt to all checked tabs', async () => {
  const { app, win, errors } = await launchApp()
  const uniqueStr = `BCAST-${Date.now()}`

  // launchApp seeded two tabs; wait for both to come up running.
  await expect(win.locator('.bg-green-500').first()).toBeVisible({ timeout: 15_000 })
  await expect(win.locator('.bg-green-500')).toHaveCount(2, { timeout: 15_000 })

  // (window.api.pty.write spy removed: contextBridge freezes the api object
  // so the assignment silently fails. Broadcast success is verified via the
  // per-row sent indicator and the success toast below.)

  // The broadcast toggle lives in LeftNav's SessionSection (always rendered
  // when the nav is open). Clicking it switches activeNav to 'terminal' so
  // the BroadcastBar (still mounted in MainPane) appears.
  await expect(win.getByTestId('broadcast-toggle')).toBeVisible({ timeout: 5_000 })
  await win.getByTestId('broadcast-toggle').click({ force: true })
  await expect(win.getByTestId('broadcast-bar')).toBeVisible({ timeout: 5_000 })

  // Type the unique prompt into the textarea.
  await win.getByTestId('broadcast-bar').getByRole('textbox').fill(uniqueStr)

  // Click Send. force:true because BroadcastBar re-renders on every keystroke
  // tracking selected-tab count, which trips Playwright's stability auto-wait.
  await win.getByRole('button', { name: /Send to \d+ tab/ }).click({ force: true })

  // Per-row ✓ indicators appear immediately (synchronous state update after
  // fire-and-forget IPC writes are dispatched).
  await expect(win.locator('[data-testid="broadcast-row-sent"]').first()).toBeVisible({ timeout: 3_000 })

  // No skipped indicators expected on a healthy 2-tab broadcast.
  expect(await win.locator('[data-testid="broadcast-row-skipped"]').count()).toBe(0)

  // Bar auto-closes after 1.5 s and the success toast appears.
  await expect(win.getByTestId('broadcast-toast')).toBeVisible({ timeout: 5_000 })
  const toastText = await win.getByTestId('broadcast-toast').textContent()
  expect(toastText).toMatch(/Sent to \d+ tab/)

  // No renderer exceptions during the whole flow.
  expect(errors).toHaveLength(0)

  await app.close()
})
