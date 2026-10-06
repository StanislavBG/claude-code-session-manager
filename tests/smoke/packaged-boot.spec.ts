/**
 * Packaged-app boot smoke test.
 *
 * Why this exists: every other spec launches the source tree via
 * src/main/index.cjs. This one launches the electron-builder OUTPUT binary
 * (SM_PACKAGED_BIN) so a broken stage/asar/dependency layout fails CI before a
 * user installs it. CI runs it on macOS and Windows against the real packaged
 * apps; on Linux use `npm run dist:linux-dir` and
 * SM_PACKAGED_BIN=release/out/linux-unpacked/session-manager.
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PACKAGED_BIN = process.env.SM_PACKAGED_BIN

test.skip(!PACKAGED_BIN, 'SM_PACKAGED_BIN is not set')

test('packaged: app boots and renderer mounts', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-packaged-boot-'))
  // An inherited ELECTRON_RUN_AS_NODE would put the packaged exe into node mode.
  const env: Record<string, string | undefined> = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  // Overriding USERPROFILE on win32 leaves Chromium unable to resolve known folders
  // (boot diag: "Failed to get 'userData' path", exit 0x80000003), so isolate there
  // with --user-data-dir instead.
  const isWin = process.platform === 'win32'
  const app: ElectronApplication = await electron.launch({
    executablePath: path.resolve(PACKAGED_BIN as string),
    args: isWin ? [`--user-data-dir=${home}`] : [],
    env: {
      ...env,
      ...(isWin ? {} : { HOME: home, USERPROFILE: home }),
      SM_BOOT_DIAG: '1',
      SM_E2E: '1',
      SM_SUPERVISOR_DISABLE: '1',
      SM_MOCK_BILLING_KIND: 'ok',
    },
    timeout: 60_000,
  })

  try {
    const win: Page = await app.firstWindow({ timeout: 60_000 })
    // Same mount signal darwin-boot.spec.ts uses: the TabBar paints once the
    // root App component is on-screen.
    await win.waitForSelector('[data-testid="tour-tabbar"]', { timeout: 60_000 })
    const rootHtml = await win.locator('#root').innerHTML()
    expect(rootHtml.trim().length).toBeGreaterThan(0)
  } finally {
    await app.close().catch(() => {})
    fs.rmSync(home, { recursive: true, force: true })
  }
})
