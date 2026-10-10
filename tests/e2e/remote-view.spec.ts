/**
 * Remote machines view — screenshot scene (empty / offline / online + terminal,
 * light and dark). Run by a human, never by a scheduler job:
 *   npm run test:e2e -- tests/e2e/remote-view.spec.ts
 * PNGs land in test-results/remote-view/ and are not committed.
 *
 * The relay is never touched: the three remoteClient handlers the view uses
 * (list / connect / send) are swapped in the main process for in-memory fakes.
 * The app has no in-app theme switch, so light/dark is the renderer's
 * prefers-color-scheme via Playwright's emulateMedia.
 */
import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { launchApp, navigateToTab, ROOT } from './_helpers/launchApp'

const OUT_DIR = path.join(ROOT, 'test-results', 'remote-view')
const MACHINE = 'Fake Workstation'
const PEER_ID = 'fake-peer-1'

test.beforeAll(() => {
  fs.mkdirSync(OUT_DIR, { recursive: true })
})

async function shoot(win: Page, name: string) {
  for (const scheme of ['light', 'dark'] as const) {
    await win.emulateMedia({ colorScheme: scheme })
    await win.waitForTimeout(250)
    await win.screenshot({ path: path.join(OUT_DIR, `${name}-${scheme}.png`) })
  }
}

test('remote view: empty, offline, online terminal screenshots', async () => {
  test.setTimeout(120_000)
  const { app, win } = await launchApp()
  try {
    // Install in-memory fakes in the main process (no relay, no network).
    await app.evaluate(({ ipcMain, BrowserWindow }, fake) => {
      const g = globalThis as unknown as { __fakeRemote: { peers: unknown[] } }
      g.__fakeRemote = { peers: [] }
      const base = {
        peerId: fake.peerId,
        deviceId: fake.peerId,
        machineName: fake.machine,
        pairedAt: new Date().toISOString(),
        clientPublicKey: 'fake-client-key',
        verifiedDevicePubKey: null,
        os: 'linux',
        status: 'idle',
        reason: 'device_offline',
        sas: null,
      }
      const push = (channel: string, payload: unknown) => {
        for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload)
      }
      for (const ch of ['remoteClient:list', 'remoteClient:connect', 'remoteClient:send']) {
        ipcMain.removeHandler(ch)
      }
      ipcMain.handle('remoteClient:list', () => g.__fakeRemote.peers)
      ipcMain.handle('remoteClient:connect', () => {
        const status = { status: 'authenticated', reason: null, sas: null }
        g.__fakeRemote.peers = [{ ...base, ...status }]
        push('remoteClient:status', { peerId: fake.peerId, ...status })
        return status
      })
      ipcMain.handle('remoteClient:send', (_e, args: { peerId: string; type: string; payload: { tabId?: string } }) => {
        if (args?.type === 'cmd:pty:spawn') {
          const tabId = args.payload?.tabId
          setTimeout(() => {
            push('remoteClient:event', {
              peerId: args.peerId,
              type: 'event:pty:data',
              payload: { tabId, data: `${fake.machine}:~$ echo hello from the remote pty\r\nhello from the remote pty\r\n` },
            })
          }, 300)
        }
        return { ok: true }
      })
      ;(g.__fakeRemote as { base?: unknown }).base = base
    }, { peerId: PEER_ID, machine: MACHINE })

    const open = async () => {
      await win.reload()
      await win.waitForSelector('[data-testid="tour-tabbar"]', { timeout: 15_000 })
      await navigateToTab(win, 'remote')
    }

    // 1. Empty.
    await open()
    await expect(win.locator('[data-testid="remote-view-empty"]')).toBeVisible({ timeout: 5000 })
    await shoot(win, 'remote-empty')

    // 2. One offline machine.
    await app.evaluate(() => {
      const g = globalThis as unknown as { __fakeRemote: { peers: unknown[]; base: object } }
      g.__fakeRemote.peers = [g.__fakeRemote.base]
    })
    await open()
    await expect(win.locator('[data-testid="remote-view-offline"]')).toBeVisible({ timeout: 5000 })
    await expect(win.locator('[data-testid="remote-view-header-badge"]')).toBeVisible()
    await shoot(win, 'remote-offline')

    // 3. Online machine with an open remote terminal.
    await win.locator('[data-testid="remote-view-connect"]').click()
    await win.locator('[data-testid="remote-view-tab-terminal"]').click()
    await expect(win.locator('[data-testid="remote-terminal-panel"]')).toBeVisible({ timeout: 5000 })
    await expect(win.locator('[data-testid="remote-terminal-badge"]')).toBeVisible()
    await expect(win.locator('[data-testid="remote-view-header-badge"]')).toContainText(MACHINE)
    await expect(win.locator('[data-testid="remote-terminal-host"]')).toContainText('hello from the remote pty', { timeout: 5000 })
    await shoot(win, 'remote-online-terminal')
  } finally {
    await app.close()
  }
})
