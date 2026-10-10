// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { AlmanacFooter } from '../AlmanacFooter'
import { useBilling } from '../../../state/billing'
import { useToast } from '../../../state/toast'
import { __resetSessionSlotsForTests } from '../../../lib/useSessionSlots'
import { __resetAutoUpdaterForTests } from '../../../lib/useAutoUpdater'

/**
 * The footer version chip is the always-visible restart prompt once the
 * in-app auto-updater has a downloaded update; otherwise it falls back to
 * the npm/installer chip from useUpdateStatus.
 */

let container: HTMLDivElement
let root: Root

type Status = {
  state: string
  current: string
  latest: string | null
  progress: number | null
  error: string | null
  busyReason: string | null
  lastCheckedAt: number | null
  enabled: boolean
}

const mkStatus = (over: Partial<Status>): Status => ({
  state: 'idle',
  current: '1.0.0',
  latest: '1.1.0',
  progress: null,
  error: null,
  busyReason: null,
  lastCheckedAt: null,
  enabled: true,
  ...over,
})

function setApi(opts: {
  status: Status
  install?: ReturnType<typeof vi.fn>
  updateCheck?: unknown
}) {
  ;(window as unknown as { api: unknown }).api = {
    app: {
      gitBranch: vi.fn().mockResolvedValue(null),
      updateStatus: vi.fn().mockResolvedValue(
        opts.updateCheck ?? { current: '1.0.0', latest: '1.1.0', behind: true, channel: 'installer', downloadUrl: 'https://x/y' },
      ),
    },
    schedule: undefined,
    shell: { open: vi.fn().mockResolvedValue(undefined) },
    updater: {
      status: vi.fn().mockResolvedValue(opts.status),
      onStatus: vi.fn().mockReturnValue(() => {}),
      install: opts.install ?? vi.fn().mockResolvedValue({ ok: true }),
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
  await act(async () => {
    root.render(createElement(AlmanacFooter, {}))
  })
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

const chip = () => container.querySelector<HTMLElement>('[data-testid="footer-version"]')

describe('AlmanacFooter auto-updater chip', () => {
  it('ready renders the restart button and click calls install(false)', async () => {
    const install = vi.fn().mockResolvedValue({ ok: true })
    setApi({ status: mkStatus({ state: 'ready' }), install })
    await render()
    const el = chip()
    expect(el?.tagName).toBe('BUTTON')
    expect(el?.textContent).toBe('Update ready — restart to install v1.1.0')
    await act(async () => {
      el!.click()
    })
    expect(install).toHaveBeenCalledWith(false)
  })

  it('shows an info toast when install is deferred', async () => {
    const show = vi.fn()
    useToast.setState({ show } as never)
    const install = vi.fn().mockResolvedValue({
      ok: true,
      status: mkStatus({ state: 'deferred', busyReason: '2 running jobs' }),
    })
    setApi({ status: mkStatus({ state: 'ready' }), install })
    await render()
    await act(async () => {
      chip()!.click()
    })
    expect(show).toHaveBeenCalledWith('info', 'Update v1.1.0 will install when 2 running jobs finish')
  })

  it('falls back to the installer chip when the updater is unsupported', async () => {
    setApi({ status: mkStatus({ state: 'unsupported', enabled: false }) })
    await render()
    expect(chip()?.tagName).toBe('BUTTON')
    expect(chip()?.textContent).toBe('Download v1.1.0')
  })
})
