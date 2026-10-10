// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { SettingsUpdates } from '../SettingsUpdates'
import { __resetAutoUpdaterForTests } from '../../../lib/useAutoUpdater'

function mkStatus(overrides: Record<string, unknown> = {}) {
  return {
    state: 'idle',
    current: '1.0.0',
    latest: null,
    progress: null,
    error: null,
    busyReason: null,
    lastCheckedAt: null,
    enabled: true,
    ...overrides,
  }
}

let host: HTMLDivElement
let root: Root
let updater: Record<string, ReturnType<typeof vi.fn>>

async function mount(status: Record<string, unknown>) {
  updater = {
    status: vi.fn().mockResolvedValue(status),
    check: vi.fn().mockResolvedValue(status),
    install: vi.fn().mockResolvedValue({ ok: true }),
    cancelDeferred: vi.fn().mockResolvedValue(status),
    setEnabled: vi.fn().mockResolvedValue(status),
    onStatus: vi.fn().mockReturnValue(() => {}),
  }
  ;(window as unknown as { api: unknown }).api = { updater }
  await act(async () => {
    root.render(createElement(SettingsUpdates))
  })
  await act(async () => {})
}

beforeEach(() => {
  __resetAutoUpdaterForTests()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  __resetAutoUpdaterForTests()
})

describe('SettingsUpdates', () => {
  it('hides the toggle and check button when unsupported', async () => {
    await mount(mkStatus({ state: 'unsupported' }))
    expect(host.querySelector('[role="switch"]')).toBeNull()
    expect(host.querySelector('[data-testid="updates-check"]')).toBeNull()
    expect(host.textContent).toContain('npx')
  })

  it('calls check() from the Check for updates button', async () => {
    await mount(mkStatus())
    const btn = host.querySelector('[data-testid="updates-check"]') as HTMLButtonElement
    expect(host.textContent).toContain('Current v1.0.0')
    expect(host.textContent).toContain('Latest —')
    await act(async () => btn.click())
    expect(updater.check).toHaveBeenCalledTimes(1)
  })

  it('renders the install button when ready and calls install(false)', async () => {
    await mount(mkStatus({ state: 'ready', latest: '1.1.0' }))
    const btn = host.querySelector('[data-testid="updates-install"]') as HTMLButtonElement
    expect(btn.textContent).toContain('Restart to install v1.1.0')
    await act(async () => btn.click())
    expect(updater.install).toHaveBeenCalledWith(false)
  })

  it('renders busyReason when deferred and Cancel calls cancelDeferred()', async () => {
    await mount(mkStatus({ state: 'deferred', latest: '1.1.0', busyReason: '2 running jobs' }))
    expect(host.textContent).toContain('Waiting for 2 running jobs to finish')
    const cancel = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Cancel')!
    await act(async () => cancel.click())
    expect(updater.cancelDeferred).toHaveBeenCalledTimes(1)
  })
})
