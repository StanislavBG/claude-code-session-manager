/**
 * macOS boot smoke test.
 *
 * Why this exists: the e2e suite runs under xvfb-run on Linux only, so
 * Mac-specific startup paths (Homebrew claude bin location at
 * /opt/homebrew/bin, the /Users -> /System/Volumes/Data/Users symlink that
 * trips chokidar realpath, dock-vs-window activation) had zero pre-release
 * coverage. v0.10.0 shipped a Mac startup hang because of this gap.
 *
 * This spec asserts the bare minimum: the renderer mounts, the three boot
 * pollers (billing / teams / schedule, wrapped in withTimeout) do not emit
 * their "timed out after Nms" error, and the app closes cleanly. If any of
 * those IPCs hang on a Mac runner, CI fails before users see it.
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../..')

// Matches the message format in src/renderer/lib/withTimeout.ts.
const TIMEOUT_RE = /timed out after \d+ms/

test('darwin: app boots, renderer mounts, no boot-poller timeouts', async () => {
  const consoleErrors: string[] = []
  const pageErrors: string[] = []

  const app: ElectronApplication = await electron.launch({
    args: [path.join(ROOT, 'src', 'main', 'index.cjs')],
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      SM_E2E: '1',
      SM_SUPERVISOR_DISABLE: '1',
      // Keep billing poll deterministic on a runner with no Claude credentials.
      SM_MOCK_BILLING_KIND: 'ok',
    },
  })

  try {
    const win: Page = await app.firstWindow()
    win.on('pageerror', (e) => pageErrors.push(e.message))
    win.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text())
    })

    // Renderer mounted within the boot-poller deadline.
    await win.waitForSelector('[data-testid="app-status-bar"]', { timeout: 10_000 })

    // Give the three withTimeout-wrapped boot IPCs a moment to settle so
    // their rejections (if any) hit the console before we assert.
    await win.waitForTimeout(2_000)

    const timeoutHits = [...consoleErrors, ...pageErrors].filter((m) => TIMEOUT_RE.test(m))
    expect(timeoutHits, `boot poller timeouts: ${timeoutHits.join(' | ')}`).toEqual([])
  } finally {
    await app.close()
  }
})
