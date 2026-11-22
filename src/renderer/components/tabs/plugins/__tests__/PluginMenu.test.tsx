// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { PluginMenu, type PluginMenuProps } from '../PluginMenu'
import type { PluginRow } from '../../../../lib/pluginContents'
import { useLayout } from '../../../../state/layout'
import { REVEAL_HINT_PREFIX } from '../../../../lib/revealInFileExplorer'
import { Z } from '../../../../lib/zLayers'
import { flushAsync } from '../../../../testUtils/domFlush'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * The ⋯ menu on a plugin's detail header: Reveal in File Explorer, Copy path, and an Uninstall that
 * confirms inline.
 */

const HOME = '/home/test'
const PATH = `${HOME}/.claude/plugins/cache/claude-plugins-official/stripe/0.11.17`

function makeRow(over: Partial<PluginRow> = {}): PluginRow {
  return {
    name: 'stripe',
    path: PATH,
    mtimeMs: 0,
    hasManifest: true,
    manifest: { name: 'stripe', version: '0.11.17', description: 'Stripe development plugin for Claude' },
    hasLsp: false,
    monitors: 0,
    hooks: 7,
    agents: 1,
    commands: 2,
    skills: 10,
    binCount: 0,
    hasMcp: true,
    mcpServers: 1,
    marketplace: 'claude-plugins-official',
    scope: 'user',
    key: 'stripe@claude-plugins-official',
    enabled: true,
    ...over,
  }
}

let container: HTMLDivElement
let root: Root
let openPanel: Mock<(id: string, tab?: string) => void>
let realOpenPanel: (id: string, tab?: string) => void
let writeText: Mock<(text: string) => Promise<{ ok: boolean }>>

beforeEach(() => {
  writeText = vi.fn<(text: string) => Promise<{ ok: boolean }>>().mockResolvedValue({ ok: true })
  ;(window as unknown as { api: unknown }).api = {
    app: { homeDir: vi.fn().mockResolvedValue(HOME) },
    config: {
      readJson: vi.fn().mockResolvedValue({ exists: false, parseError: false, data: null, mtimeMs: 0, error: null }),
      writeJson: vi.fn().mockResolvedValue({ ok: true, mtimeMs: 0 }),
    },
    clipboard: { writeText },
  }
  realOpenPanel = useLayout.getState().openPanel
  openPanel = vi.fn<(id: string, tab?: string) => void>()
  useLayout.setState({ openPanel })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useLayout.setState({ openPanel: realOpenPanel })
  vi.unstubAllGlobals()
})

function render(over: Partial<PluginMenuProps> = {}) {
  const props: PluginMenuProps = {
    row: makeRow(),
    busy: false,
    onUninstall: vi.fn(),
    ...over,
  }
  act(() => root.render(<PluginMenu {...props} />))
  return props
}

const q = (sel: string) => container.querySelector(sel) as HTMLElement | null
const menuItems = () => Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menu"] button'))
const menuItem = (label: string) => menuItems().find((b) => b.textContent?.trim() === label) as HTMLButtonElement
const openMenu = () => act(() => (q('[data-testid="plugin-menu"]') as HTMLButtonElement).click())

describe('PluginMenu', () => {
  it('the ⋯ menu sits on the dialog z rung and lists Reveal, Copy path, a divider and Uninstall <name>', () => {
    render()
    expect(q('[role="menu"]')).toBeNull()
    openMenu()
    const menu = q('[role="menu"]') as HTMLElement
    expect(menu.className.split(/\s+/)).toContain(Z.dialog)
    expect(menuItems().map((b) => b.textContent)).toEqual(['Reveal in File Explorer', 'Copy path', 'Uninstall stripe'])
    expect(menu.querySelector('[role="separator"]')).not.toBeNull()
  })

  it('Reveal in File Explorer reveals the install path and closes the menu', () => {
    render()
    openMenu()
    act(() => menuItem('Reveal in File Explorer').click())
    expect(openPanel).toHaveBeenCalledWith('projects', REVEAL_HINT_PREFIX + PATH)
    expect(q('[role="menu"]')).toBeNull()
  })

  it('Copy path writes the install path to the clipboard', async () => {
    render()
    openMenu()
    act(() => menuItem('Copy path').click())
    await flushAsync(4)
    expect(writeText).toHaveBeenCalledWith(PATH)
    expect(q('[role="menu"]')).toBeNull()
  })

  it('Copy path surfaces a failed write as an error toast', async () => {
    writeText.mockResolvedValue({ ok: false })
    render()
    const { useToast } = await import('../../../../state/toast')
    openMenu()
    act(() => menuItem('Copy path').click())
    await flushAsync(4)
    expect(useToast.getState().toasts.some((t) => t.kind === 'error' && t.message.includes(PATH))).toBe(true)
  })

  it('Uninstall asks inline (Confirm / Cancel) before calling onUninstall, never window.confirm', () => {
    const confirm = vi.fn().mockReturnValue(true)
    vi.stubGlobal('confirm', confirm)
    const props = render()
    openMenu()
    act(() => menuItem('Uninstall stripe').click())
    expect(props.onUninstall).not.toHaveBeenCalled()
    expect(q('[role="menu"]')?.textContent).toContain('Uninstall stripe?')
    expect(q('[data-testid="plugin-uninstall"]')?.textContent).toBe('Confirm')

    // Cancel backs out to the menu without uninstalling.
    act(() => menuItem('Cancel').click())
    expect(props.onUninstall).not.toHaveBeenCalled()
    expect(q('[data-testid="plugin-uninstall"]')).toBeNull()
    expect(menuItems().map((b) => b.textContent)).toContain('Uninstall stripe')

    act(() => menuItem('Uninstall stripe').click())
    act(() => (q('[data-testid="plugin-uninstall"]') as HTMLButtonElement).click())
    expect(props.onUninstall).toHaveBeenCalledTimes(1)
    expect(props.onUninstall).toHaveBeenCalledWith(props.row)
    expect(q('[role="menu"]')).toBeNull()
    expect(confirm).not.toHaveBeenCalled()
  })

  it('Escape closes the menu and drops a pending confirm', () => {
    render()
    openMenu()
    act(() => menuItem('Uninstall stripe').click())
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(q('[role="menu"]')).toBeNull()
    openMenu()
    expect(q('[data-testid="plugin-uninstall"]')).toBeNull()
  })

  it('Uninstall is disabled for a plugin with no marketplace', () => {
    render({ row: makeRow({ marketplace: undefined, key: 'stripe' }) })
    openMenu()
    expect(menuItem('Uninstall stripe').disabled).toBe(true)
  })
})
