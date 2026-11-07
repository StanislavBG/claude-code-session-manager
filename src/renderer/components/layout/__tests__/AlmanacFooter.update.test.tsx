// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { AlmanacFooter } from '../AlmanacFooter'
import { useBilling } from '../../../state/billing'
import { __resetSessionSlotsForTests } from '../../../lib/useSessionSlots'
import { __resetAutoUpdaterForTests } from '../../../lib/useAutoUpdater'

/** The footer reads the available-update chip from the combined `updater.status()` `check` field. */

let container: HTMLDivElement
let root: Root

function setApi(check: unknown) {
  ;(window as unknown as { api: unknown }).api = {
    app: { gitBranch: vi.fn().mockResolvedValue(null) },
    schedule: undefined,
    shell: { open: vi.fn().mockResolvedValue(undefined) },
    updater: {
      status: vi.fn().mockResolvedValue({
        state: 'idle', current: '1.0.0', latest: null, progress: null, error: null,
        busyReason: null, lastCheckedAt: null, enabled: true, check,
      }),
      onStatus: vi.fn().mockReturnValue(() => {}),
      install: vi.fn(),
    },
  }
}

beforeEach(() => {
  ;(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = '0.0.0-test'
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useBilling.setState({ data: null, refreshing: false })
  __resetSessionSlotsForTests()
  __resetAutoUpdaterForTests()
})

async function render() {
  await act(async () => { root.render(createElement(AlmanacFooter, {})) })
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

const chip = () => container.querySelector<HTMLElement>('[data-testid="footer-version"]')

describe('AlmanacFooter available update', () => {
  it('shows the npm update chip from updater.status().check', async () => {
    setApi({ current: '1.0.0', latest: '1.2.0', behind: true, channel: 'npm' })
    await render()
    expect(chip()?.textContent).toContain('v1.0.0 → v1.2.0')
  })

  it('shows the plain version when not behind', async () => {
    setApi({ current: '1.0.0', latest: '1.0.0', behind: false, channel: 'npm' })
    await render()
    expect(chip()?.textContent).toBe('v1.0.0')
  })
})
