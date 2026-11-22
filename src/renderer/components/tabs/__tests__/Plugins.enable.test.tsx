// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushAsync } from '../../../testUtils/domFlush'

const HOME = '/home/test'
const KEY = 'demo@market'

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
      readText: vi.fn(async (path: string) => {
        const p = plugins.find((x) => path.startsWith(`${installPathOf(x)}/commands/`))
        if (!p) return { exists: false, text: '' }
        const base = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, '')
        return { exists: true, text: `---\ndescription: Runs ${base}.\n---\n` }
      }),
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

describe('Plugins list + detail: enable switch, file card, filter, + Add, inline uninstall', () => {
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
  const rows = () => Array.from(container.querySelectorAll<HTMLElement>('[data-testid="config-list-row"]'))
  const rowNames = () => rows().map((r) => r.querySelector('.font-mono')?.textContent)
  const rowFor = (name: string) => rows().find((r) => r.querySelector('.font-mono')?.textContent === name) as HTMLElement
  const menuButton = (label: string) =>
    Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menu"] button')).find((b) => b.textContent === label) as HTMLButtonElement

  function typeFilter(value: string) {
    const input = q('input[type="search"]') as HTMLInputElement
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    act(() => {
      setValue.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  it('toggling a row switch calls plugins.setEnabled (the enabledPlugins write) without selecting the row, then re-lists', async () => {
    const api = installApi({ plugins: [{ name: 'alpha' }, { name: 'demo' }] })
    const root = await mount()
    const demo = rowFor('demo')
    expect(demo.getAttribute('aria-selected')).toBe('false')
    const sw = demo.querySelector('[data-testid="plugin-enabled-switch"]') as HTMLButtonElement
    expect(sw.getAttribute('role')).toBe('switch')
    expect(sw.getAttribute('aria-checked')).toBe('false')
    expect(demo.className).toContain('opacity-60')
    const before = api.plugins.list.mock.calls.length
    act(() => sw.click())
    await flushAsync(10)
    expect(api.plugins.setEnabled).toHaveBeenCalledWith({ key: KEY, enabled: true })
    expect(api.plugins.list.mock.calls.length).toBeGreaterThan(before)
    const after = rowFor('demo')
    expect(after.getAttribute('aria-selected')).toBe('false')
    expect((after.querySelector('[data-testid="plugin-enabled-switch"]') as HTMLElement).getAttribute('aria-checked')).toBe('true')
    expect(after.className).not.toContain('opacity-60')
    act(() => root.unmount())
  })

  it('the detail Enabled switch makes the same enabledPlugins write', async () => {
    const api = installApi({ plugins: [{ name: 'demo', enabled: true }] })
    const root = await mount()
    const sw = q('[data-testid="plugin-detail-switch"]') as HTMLButtonElement
    expect(sw.getAttribute('aria-checked')).toBe('true')
    act(() => sw.click())
    await flushAsync(10)
    expect(api.plugins.setEnabled).toHaveBeenCalledWith({ key: KEY, enabled: false })
    expect((q('[data-testid="plugin-detail-switch"]') as HTMLElement).getAttribute('aria-checked')).toBe('false')
    act(() => root.unmount())
  })

  it('renders the PLUGINS file card with the on count, manifest path and enabledPlugins note', async () => {
    installApi({ plugins: [{ name: 'demo', enabled: true }, { name: 'other' }, { name: 'third', enabled: true }] })
    const root = await mount()
    const card = q('[data-testid="config-file-card"]') as HTMLElement
    expect(card.textContent).toContain('PLUGINS')
    expect(card.textContent).toContain('2 on')
    expect(card.textContent).toContain('~/.claude/plugins/installed_plugins.json')
    expect(card.textContent).toContain('On/off is saved in settings.json › enabledPlugins')
    act(() => root.unmount())
  })

  it('rows show the mono name and "<marketplace> · <contents>"; the filter matches name or description', async () => {
    installApi({
      plugins: [
        { name: 'demo', description: 'Does the demo thing', enabled: true, commands: ['go.md', 'stop.md'] },
        { name: 'other', description: 'Formats tables' },
      ],
    })
    const root = await mount()
    expect(rowNames()).toEqual(['demo', 'other'])
    expect(rowFor('demo').textContent).toContain('market · 2 commands')
    expect(rowFor('other').textContent).toContain('market · empty')

    typeFilter('TABLES')
    expect(rowNames()).toEqual(['other'])
    typeFilter('dem')
    expect(rowNames()).toEqual(['demo'])
    typeFilter('nothing-matches')
    expect(rowNames()).toEqual([])
    expect(container.textContent).toContain('No plugins match')
    typeFilter('')
    expect(rowNames()).toEqual(['demo', 'other'])
    act(() => root.unmount())
  })

  it('"+ Add" calls onAdd (the catalog drawer)', async () => {
    installApi()
    const onAdd = vi.fn()
    const root = await mount({ onAdd })
    const add = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '+ Add') as HTMLButtonElement
    act(() => add.click())
    expect(onAdd).toHaveBeenCalledTimes(1)
    act(() => root.unmount())
  })

  it('the detail shows eyebrow, name, description, what it adds, install path and the saved line; no update control', async () => {
    installApi({ plugins: [{ name: 'demo', description: 'Does the demo thing', commands: ['go.md', 'stop.md'] }] })
    const onJump = vi.fn()
    const root = await mount({ onJump })
    const header = q('[data-testid="config-detail-header"]') as HTMLElement
    expect(header.textContent).toContain('PLUGIN · MARKET · V1.0.0 · USER SCOPE')
    expect(header.textContent).toContain('demo')
    expect(header.textContent).toContain('Enabled')
    expect(header.textContent).not.toMatch(/up to date/i)
    const cards = Array.from(container.querySelectorAll('[data-testid="config-card"]')).map((c) => c.textContent ?? '')
    expect(cards[0]).toContain("DESCRIPTION · FROM THE PLUGIN'S MANIFEST")
    expect(cards[0]).toContain('Does the demo thing')
    expect(cards[1]).toContain('WHAT IT ADDS · 2 COMMANDS')
    expect(Array.from(container.querySelectorAll('[data-testid="plugin-adds-command"]')).map((r) => r.textContent)).toEqual([
      '/goRuns go.',
      '/stopRuns stop.',
    ])
    expect(cards[2]).toContain('INSTALLED AT')
    expect(q('[data-testid="plugin-install-path"]')?.textContent).toBe('/p/demo')
    expect(q('[data-testid="config-saved-line"]')?.textContent).toBe('Saved — matches settings.json › enabledPlugins')

    act(() => (q('[data-testid="plugin-open-in-skills"]') as HTMLButtonElement).click())
    expect(onJump).toHaveBeenCalledWith('skills')
    act(() => root.unmount())
  })

  it('selecting a row shows its detail', async () => {
    installApi({ plugins: [{ name: 'alpha' }, { name: 'demo' }] })
    const root = await mount()
    expect(rowFor('alpha').getAttribute('aria-selected')).toBe('true')
    act(() => rowFor('demo').click())
    await flushAsync(10)
    expect(rowFor('demo').getAttribute('aria-selected')).toBe('true')
    expect(q('[data-testid="config-detail-header"]')?.textContent).toContain('demo')
    act(() => root.unmount())
  })

  it('a config-search focus for a plugin key selects it, clearing a filter that hides it, then clears the request', async () => {
    installApi({ plugins: [{ name: 'alpha' }, { name: 'demo' }] })
    const root = await mount()
    const { useConfigSearchFocus } = await import('../../../state/configSearchFocus')
    typeFilter('alpha')
    expect(rowNames()).toEqual(['alpha'])
    act(() => useConfigSearchFocus.getState().set('plugins', `plugins:${KEY}`))
    await flushAsync(10)
    expect(rowNames()).toEqual(['alpha', 'demo'])
    expect(rowFor('demo').getAttribute('aria-selected')).toBe('true')
    expect(q('[data-testid="config-detail-header"]')?.textContent).toContain('demo')
    expect(useConfigSearchFocus.getState()).toMatchObject({ tab: null, id: null })
    act(() => root.unmount())
  })

  it('a config-search focus that matches no plugin keeps the selection and still clears the request', async () => {
    installApi({ plugins: [{ name: 'alpha' }, { name: 'demo' }] })
    const root = await mount()
    const { useConfigSearchFocus } = await import('../../../state/configSearchFocus')
    act(() => rowFor('demo').click())
    act(() => useConfigSearchFocus.getState().set('plugins', 'plugins:nope@market'))
    await flushAsync(10)
    expect(rowFor('demo').getAttribute('aria-selected')).toBe('true')
    expect(useConfigSearchFocus.getState()).toMatchObject({ tab: null, id: null })
    act(() => root.unmount())
  })

  it('uninstall confirms inline in the ⋯ menu (no window.confirm), calls uninstall and re-lists', async () => {
    const api = installApi()
    const confirm = vi.fn().mockReturnValue(true)
    vi.stubGlobal('confirm', confirm)
    const root = await mount()

    act(() => (q('[data-testid="plugin-menu"]') as HTMLButtonElement).click())
    expect(Array.from(container.querySelectorAll('[role="menu"] button')).map((b) => b.textContent)).toEqual([
      'Reveal in File Explorer',
      'Copy path',
      'Uninstall demo',
    ])
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
    act(() => (q('[data-testid="plugin-menu"]') as HTMLButtonElement).click())
    act(() => menuButton('Uninstall demo').click())
    act(() => (q('[data-testid="plugin-uninstall"]') as HTMLButtonElement).click())
    await flushAsync(10)
    expect(useToast.getState().toasts.some((t) => t.kind === 'error' && t.message.includes('boom'))).toBe(true)
    act(() => root.unmount())
  })

  it('shows an empty card when nothing is installed', async () => {
    installApi({ plugins: [] })
    const root = await mount()
    expect(q('[data-testid="plugins-empty"]')?.textContent).toContain('No plugins installed')
    expect(q('[data-testid="config-file-card"]')?.textContent).toContain('0 on')
    act(() => root.unmount())
  })
})
