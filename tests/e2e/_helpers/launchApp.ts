/**
 * Shared electron-launch helper for tests/e2e/*.spec.ts.
 *
 * Mirrors the inline launch pattern used in cycle2-coverage.spec.ts and
 * scheduler-resilience.spec.ts. Centralizing means cycle-3+ specs get the
 * same SM_E2E + SM_SUPERVISOR_DISABLE defaults for free.
 *
 * Existing inline helpers (cycle2-coverage.spec.ts:20, scheduler-resilience
 * .spec.ts:74) are left as-is — refactor lazily.
 */
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(__dirname, '../../..')

export type LaunchOptions = {
  env?: Record<string, string>
  /** Wait for the main shell heading before returning. Default true. */
  waitForReady?: boolean
}

export async function launchApp(opts: LaunchOptions = {}): Promise<{
  app: ElectronApplication
  win: Page
  errors: string[]
}> {
  const errors: string[] = []
  const app = await electron.launch({
    args: [path.join(ROOT, 'src', 'main', 'index.cjs')],
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      SM_E2E: '1',
      SM_SUPERVISOR_DISABLE: '1',
      SM_MOCK_BILLING_KIND: 'meter_rate_limited',
      ...(opts.env ?? {}),
    },
  })
  const win = await app.firstWindow()
  // Capture renderer-side errors so callers can assert clean mounts.
  win.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  win.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`)
  })
  if (opts.waitForReady !== false) {
    await win.waitForSelector('text=Claude Session Manager', { timeout: 15_000 })
    await win.waitForTimeout(300)
  }
  return { app, win, errors }
}

/**
 * Open the command palette and dispatch a `nav:<key>` command. Deterministic
 * across the 17 tabs — does not depend on LeftNav scroll/collapse state.
 */
export async function navigateToTab(win: Page, navKey: string): Promise<void> {
  await win.keyboard.press('Control+K')
  const palette = win.locator('[data-testid="command-palette"]')
  await palette.waitFor({ state: 'visible', timeout: 5_000 })
  // Type the nav key (with dashes turned into spaces so kebab keys like
  // 'system-prompt' fuzzy-match "Go to System Prompt"). The matching command
  // becomes the first entry; Enter dispatches it.
  const input = win.locator('[data-testid="command-palette"] input[role="combobox"]')
  await input.fill(navKey.replace(/-/g, ' '))
  await win.locator(`button[data-cmd-id="nav:${navKey}"]`).first().waitFor({ state: 'visible', timeout: 3_000 })
  await win.keyboard.press('Enter')
  await palette.waitFor({ state: 'hidden', timeout: 3_000 })
}
