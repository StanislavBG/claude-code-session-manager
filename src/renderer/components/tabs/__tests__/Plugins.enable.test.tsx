// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushAsync } from '../../../testUtils/domFlush'

const HOME = '/home/test'
const KEY = 'demo@market'
const FOOTNOTE = 'Plugin contents also appear, read-only, in Skills and MCP Servers — tagged with the plugin that added them.'

interface FakePlugin {
  name: string
  description?: string
  enabled?: boolean
  /** File names listed under `<installPath>/commands`. */
  commands?: string[]
}

const installPathOf = (p: FakePlugin) => `/p/${p.name}`
const manifestPathOf = (p: FakePlugin) => `${installPathOf(p)}/.claude-plugin/plugin.json`
const absent = { exists: false, parseError: false, mtimeMs: 0, error: null, data: null }

function installApi(
  opts: { uninstall?: { ok: boolean; exitCode: number; error?: string }; plugins?: FakePlugin[] } = {},
) {
  const plugins = opts.plugins ?? [{ name: 'demo' }]
  const enabled = new Map(plugins.map((p) => [`${p.name}@market`, p.enabled === true]))
  const installed = {
    version: 2,
    plugins: Object.fromEntries(
      plugins.map((p) => [
        `${p.name}@market`,
        [{ scope: 'user', installPath: installPathOf(p), version: '1.0.0', installedAt: '', lastUpdated: '' }],
      ]),
    ),
  }
  const api = {
    app: { homeDir: vi.fn().mockResolvedValue(HOME), seedStatus: vi.fn().mockResolvedValue(null) },
    config: {
      exists: vi.fn(async (path: string) => plugins.some((p) => p.description !== undefined && path === manifestPathOf(p))),
      readJson: vi.fn(async (path: string) => {
        if (path === `${HOME}/.claude/plugins/installed_plugins.json`) return { ...absent, exists: true, data: installed }
        const p = plugins.find((x) => path === manifestPathOf(x))
        if (p) return { ...absent, exists: true, data: { name: p.name, version: '1.0.0', description: p.description } }
        return absent
      }),
      writeJson: vi.fn().mockResolvedValue({ ok: true, mtimeMs: 0 }),
      listDir: vi.fn(async (path: string) => {
        const p = plugins.find((x) => path === `${installPathOf(x)}/commands`)
        const entries = (p?.commands ?? []).map((name) => ({
          name, path: `${path}/${name}`, isDirectory: false, isFile: true, mtimeMs: 0, size: 0,
        }))
        return { ok: true, error: null, entries }
      }),
      readText: vi.fn().mockResolvedValue({ exists: false, text: '' }),
      watch: vi.fn(),
      unwatch: vi.fn(),
      onChanged: vi.fn(() => () => {}),
    },
    plugins: {
      list: vi.fn(async () =>
        plugins.map((p) => ({
          key: `${p.name}@market`, name: p.name, marketplace: 'market', version: '1.0.0', scope: 'user',
          installPath: installPathOf(p), enabled: enabled.get(`${p.name}@market`) === true,
        })),
      ),
      setEnabled: vi.fn(async (p: { key: string; enabled: boolean }) => {
        enabled.set(p.key, p.enabled)
        return { ok: true }
      }),
      uninstall: vi.fn().mockResolvedValue(opts.uninstall ?? { ok: true, exitCode: 0 }),
    },
  }
  ;(window as unknown as { api: typeof api }).api = api
  return api
}

describe('Plugins cards: enable switch, inline uninstall, toolbar, chips', () => {
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

  async function mount(props: { onAdd?: () => void; onJump?: (tab: 'skills' | 'mcp') => void } = {}) {
    const { Plugins } = await import('../Plugins')
    const root = createRoot(container)
    act(() => root.render(createElement(Plugins, props)))
    await flushAsync(10)
    return root
  }

  const q = (sel: string) => container.querySelector(sel) as HTMLElement | null
  const cardNames = () =>
    Array.from(container.querySelectorAll('[data-testid="plugin-card"] [data-testid="plugin-card-name"]')).map((n) => n.textContent)
  const menuButton = (label: string) =>
    Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menu"] button')).find((b) => b.textContent === label) as HTMLButtonElement

  function typeFilter(value: string) {
    const input = q('[data-testid="extensions-toolbar-filter"]') as HTMLInputElement
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    act(() => {
      setValue.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  async function confirmUninstall(name: string) {
    act(() => (q('[data-testid="plugin-menu"]') as HTMLButtonElement).click())
    act(() => menuButton(`Uninstall ${name}`).click())
    act(() => (q('[data-testid="plugin-uninstall"]') as HTMLButtonElement).click())
    await flushAsync(10)
  }

  it('shows the switch bound to list().enabled and toggling calls setEnabled then re-lists', async () => {
    const api = installApi()
    const root = await mount()
    const sw = container.querySelector('[data-testid="plugin-enabled-switch"]') as HTMLButtonElement
    expect(sw.getAttribute('role')).toBe('switch')
    expect(sw.getAttribute('aria-checked')).toBe('false')
    const before = api.plugins.list.mock.calls.length
    act(() => sw.click())
    await flushAsync(10)
    expect(api.plugins.setEnabled).toHaveBeenCalledWith({ key: KEY, enabled: true })
    expect(api.plugins.list.mock.calls.length).toBeGreaterThan(before)
    expect((container.querySelector('[data-testid="plugin-enabled-switch"]') as HTMLElement).getAttribute('aria-checked')).toBe('true')
    act(() => root.unmount())
  })

  it('uninstall confirms inline in the ⋯ menu (no window.confirm), calls uninstall and re-lists', async () => {
    const api = installApi()
    const confirm = vi.fn().mockReturnValue(true)
    vi.stubGlobal('confirm', confirm)
    const root = await mount()

    act(() => (q('[data-testid="plugin-menu"]') as HTMLButtonElement).click())
    act(() => menuButton('Uninstall demo').click())
    expect(q('[role="menu"]')?.textContent).toContain('Uninstall demo?')
    act(() => menuButton('Cancel').click())
    await flushAsync(10)
    expect(api.plugins.uninstall).not.toHaveBeenCalled()

    const before = api.plugins.list.mock.calls.length
    act(() => menuButton('Uninstall demo').click())
    act(() => (q('[data-testid="plugin-uninstall"]') as HTMLButtonElement).click())
    await flushAsync(10)
    expect(api.plugins.uninstall).toHaveBeenCalledWith({ slug: 'demo', marketplaceName: 'market' })
    expect(api.plugins.list.mock.calls.length).toBeGreaterThan(before)
    expect(confirm).not.toHaveBeenCalled()
    act(() => root.unmount())
  })

  it('surfaces uninstall failure via useToast error', async () => {
    installApi({ uninstall: { ok: false, exitCode: 1, error: 'boom' } })
    const root = await mount()
    const { useToast } = await import('../../../state/toast')
    await confirmUninstall('demo')
    expect(useToast.getState().toasts.some((t) => t.kind === 'error' && t.message.includes('boom'))).toBe(true)
    act(() => root.unmount())
  })

  it('renders the toolbar summary, one card per plugin and the footnote; the filter matches name or description', async () => {
    installApi({
      plugins: [
        { name: 'demo', description: 'Does the demo thing', enabled: true },
        { name: 'other', description: 'Formats tables' },
      ],
    })
    const root = await mount()
    expect(q('[data-testid="extensions-toolbar-summary"]')?.textContent).toBe('2 installed · 1 enabled')
    expect((q('[data-testid="extensions-toolbar-filter"]') as HTMLInputElement).placeholder).toBe('Filter plugins')
    expect(cardNames()).toEqual(['demo', 'other'])
    expect(container.textContent).toContain(FOOTNOTE)

    typeFilter('TABLES')
    expect(cardNames()).toEqual(['other'])
    typeFilter('dem')
    expect(cardNames()).toEqual(['demo'])
    typeFilter('nothing-matches')
    expect(cardNames()).toEqual([])
    expect(container.textContent).toContain('No plugins match')
    // The summary always counts every installed plugin, not just the filtered ones.
    expect(q('[data-testid="extensions-toolbar-summary"]')?.textContent).toBe('2 installed · 1 enabled')
    typeFilter('')
    expect(cardNames()).toEqual(['demo', 'other'])
    act(() => root.unmount())
  })

  it('one accent "+ Add plugin" whose "Browse catalog…" item calls onAdd', async () => {
    installApi()
    const onAdd = vi.fn()
    const root = await mount({ onAdd })
    const add = q('[data-testid="plugins-add"]') as HTMLButtonElement
    expect(add.textContent).toBe('+ Add plugin')
    act(() => add.click())
    const browse = q('[data-testid="plugins-add-catalog"]') as HTMLButtonElement
    expect(browse.textContent).toBe('Browse catalog…')
    act(() => browse.click())
    expect(onAdd).toHaveBeenCalledTimes(1)
    act(() => root.unmount())
  })

  it('a contents chip hands its tab to onJump', async () => {
    installApi({ plugins: [{ name: 'demo', commands: ['go.md', 'stop.md'] }] })
    const onJump = vi.fn()
    const root = await mount({ onJump })
    const chip = q('[data-testid="plugin-chip-commands"]') as HTMLButtonElement
    expect(chip.textContent).toBe('2 commands ›')
    act(() => chip.click())
    expect(onJump).toHaveBeenCalledWith('skills')
    act(() => root.unmount())
  })

  it('shows an empty card, not a table, when nothing is installed', async () => {
    installApi({ plugins: [] })
    const root = await mount()
    expect(container.querySelector('table')).toBeNull()
    expect(q('[data-testid="plugins-empty"]')?.textContent).toContain('No plugins installed')
    expect(q('[data-testid="extensions-toolbar-summary"]')?.textContent).toBe('0 installed · 0 enabled')
    act(() => root.unmount())
  })
})
