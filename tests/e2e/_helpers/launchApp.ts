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
    // Force the X11 ozone backend: under `xvfb-run` DISPLAY points at a virtual
    // X server, but a COSMIC/Wayland login also exports WAYLAND_DISPLAY, which
    // Electron will otherwise probe — creating a live terminal (xterm opens a
    // new surface) then crashes the renderer with "zxdg_exporter_v2 … invalid
    // role". Pinning x11 + clearing WAYLAND_DISPLAY keeps headless runs stable.
    args: ['--ozone-platform=x11', path.join(ROOT, 'src', 'main', 'index.cjs')],
    cwd: ROOT,
    env: {
      ...process.env,
      WAYLAND_DISPLAY: '',
      ELECTRON_OZONE_PLATFORM_HINT: 'x11',
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
  // Query with the full "go to <key>" label, not just the bare key. Bare
  // 'scheduler' also matches action commands ("Scheduler — Run now") that
  // outrank "Go to Scheduler", so Enter would fire the wrong command. Prefixing
  // "go to " filters those out (they have no 'g' to subsequence-match), leaving
  // the nav entry as the sole top result. We dispatch with Enter rather than a
  // click because the palette list re-renders on the scheduler's 2s poller and
  // is never "stable" enough for Playwright's click actionability checks.
  const input = win.locator('[data-testid="command-palette"] input[role="combobox"]')
  await input.fill(`go to ${navKey.replace(/-/g, ' ')}`)
  await win.locator(`button[data-cmd-id="nav:${navKey}"]`).first().waitFor({ state: 'visible', timeout: 3_000 })
  await win.keyboard.press('Enter')
  await palette.waitFor({ state: 'hidden', timeout: 3_000 })
}
