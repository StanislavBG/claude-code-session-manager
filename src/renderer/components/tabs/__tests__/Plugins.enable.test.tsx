// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushAsync } from '../../../testUtils/domFlush'

const HOME = '/home/test'
const KEY = 'demo@market'

function installApi(opts: { uninstall?: { ok: boolean; exitCode: number; error?: string } } = {}) {
  let enabled = false
  const api = {
    app: { homeDir: vi.fn().mockResolvedValue(HOME), seedStatus: vi.fn().mockResolvedValue(null) },
    config: {
      exists: vi.fn().mockResolvedValue(false),
      readJson: vi.fn().mockResolvedValue({
        exists: true,
        parseError: false,
        mtimeMs: 0,
        error: null,
        data: {
          version: 2,
          plugins: { [KEY]: [{ scope: 'user', installPath: '/p/demo', version: '1.0.0', installedAt: '', lastUpdated: '' }] },
        },
      }),
      listDir: vi.fn().mockResolvedValue({ ok: true, error: null, entries: [] }),
      readText: vi.fn().mockResolvedValue({ exists: false, text: '' }),
      watch: vi.fn(),
      unwatch: vi.fn(),
      onChanged: vi.fn(() => () => {}),
    },
    plugins: {
      list: vi.fn(async () => [
        { key: KEY, name: 'demo', marketplace: 'market', version: '1.0.0', scope: 'user', installPath: '/p/demo', enabled },
      ]),
      setEnabled: vi.fn(async (p: { key: string; enabled: boolean }) => {
        enabled = p.enabled
        return { ok: true }
      }),
      uninstall: vi.fn().mockResolvedValue(opts.uninstall ?? { ok: true, exitCode: 0 }),
    },
  }
  ;(window as unknown as { api: typeof api }).api = api
  return api
}

describe('Plugins installed row: enable switch + uninstall', () => {
  let container: HTMLDivElement
  beforeEach(() => {
    vi.resetModules()
    container = document.createElement('div')
    document.body.appendChild(container)
  })
  afterEach(() => {
    container.remove()
    vi.unstubAllGlobals()
  })

  async function mount() {
    const { Plugins } = await import('../Plugins')
    const root = createRoot(container)
    act(() => root.render(createElement(Plugins)))
    await flushAsync(10)
    return root
  }

  it('shows the switch bound to list().enabled and toggling calls setEnabled then re-lists', async () => {
    const api = installApi()
    const root = await mount()
    const sw = container.querySelector('[role="switch"]') as HTMLButtonElement
    expect(sw.getAttribute('aria-checked')).toBe('false')
    const before = api.plugins.list.mock.calls.length
    act(() => sw.click())
    await flushAsync(10)
    expect(api.plugins.setEnabled).toHaveBeenCalledWith({ key: KEY, enabled: true })
    expect(api.plugins.list.mock.calls.length).toBeGreaterThan(before)
    expect((container.querySelector('[role="switch"]') as HTMLElement).getAttribute('aria-checked')).toBe('true')
    act(() => root.unmount())
  })

  it('uninstall asks to confirm, calls uninstall and re-lists', async () => {
    const api = installApi()
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValue(true)
    vi.stubGlobal('confirm', confirm)
    const root = await mount()
    const btn = () => container.querySelector('[data-testid="plugin-uninstall"]') as HTMLButtonElement
    act(() => btn().click())
    await flushAsync(10)
    expect(api.plugins.uninstall).not.toHaveBeenCalled()
    const before = api.plugins.list.mock.calls.length
    act(() => btn().click())
    await flushAsync(10)
    expect(api.plugins.uninstall).toHaveBeenCalledWith({ slug: 'demo', marketplaceName: 'market' })
    expect(api.plugins.list.mock.calls.length).toBeGreaterThan(before)
    act(() => root.unmount())
  })

  it('surfaces uninstall failure via useToast error', async () => {
    installApi({ uninstall: { ok: false, exitCode: 1, error: 'boom' } })
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true))
    const root = await mount()
    const { useToast } = await import('../../../state/toast')
    act(() => (container.querySelector('[data-testid="plugin-uninstall"]') as HTMLButtonElement).click())
    await flushAsync(10)
    expect(useToast.getState().toasts.some((t) => t.kind === 'error' && t.message.includes('boom'))).toBe(true)
    act(() => root.unmount())
  })
})
