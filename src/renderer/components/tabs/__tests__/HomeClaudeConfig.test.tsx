// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

// Stubs render at test time, after the hoisted mocks — so createElement is initialised by then.
const { stub } = vi.hoisted(() => ({
  stub: (name: string) => (p: Record<string, unknown>) =>
    createElement('div', { 'data-testid': `page-${name}`, 'data-scope': p.scope as string | undefined }),
}))
vi.mock('../SystemPrompt', () => ({ SystemPrompt: stub('SystemPrompt') }))
vi.mock('../Settings', () => ({ Settings: stub('Settings') }))
vi.mock('../McpServers', () => ({ McpServers: stub('McpServers') }))
vi.mock('../Skills', () => ({ Skills: stub('Skills') }))
vi.mock('../Plugins', () => ({ Plugins: stub('Plugins') }))
vi.mock('../AgentLibrary', () => ({ AgentLibrary: stub('AgentLibrary') }))
vi.mock('../Library', () => ({ SkillsLibrary: () => null, McpLibrary: () => null, PluginsLibrary: () => null }))
vi.mock('../home/HomeSessionDrawer', () => ({ HomeSessionDrawer: () => null }))
vi.mock('../../../lib/useExtensionCounts', () => ({ useExtensionCounts: () => ({ skills: 7, mcp: 3, plugins: 2 }) }))
vi.mock('../../../lib/useAgentPersonas', () => ({ useAgentPersonasState: () => ({ personas: [{}, {}, {}, {}], refresh: vi.fn() }) }))

const { loadItems } = vi.hoisted(() => ({ loadItems: vi.fn() }))
vi.mock('../../../lib/configSearch', async (orig) => ({
  ...(await orig<typeof import('../../../lib/configSearch')>()),
  loadConfigSearchItems: loadItems,
}))

import { HomeClaudeConfig } from '../HomeClaudeConfig'
import { useLayout } from '../../../state/layout'
import { useConfigSearchFocus } from '../../../state/configSearchFocus'
import type { ConfigSearchItem } from '../../../lib/configSearch'

const SEARCH_ITEMS: ConfigSearchItem[] = [
  { tab: 'settings', id: 'settings:model', title: 'model', detail: 'Model' },
  { tab: 'mcp', id: 'mcp:modelsrv', title: 'modelsrv', detail: 'MCP server' },
  { tab: 'agents', id: 'agents:dev-lead', title: 'dev-lead' },
]

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  useLayout.setState({ panelTabHint: null })
  useConfigSearchFocus.getState().clear()
  loadItems.mockReset()
  loadItems.mockResolvedValue(SEARCH_ITEMS)
  ;(window as unknown as { api: unknown }).api = {}
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const q = (id: string) => host.querySelector(`[data-testid="${id}"]`)

describe('HomeClaudeConfig', () => {
  it('renders the band with the global eyebrow, title and ~/.claude path', () => {
    act(() => root.render(createElement(HomeClaudeConfig)))
    const band = q('config-band')!
    expect(band.textContent).toContain('CLAUDE CODE · GLOBAL')
    expect(band.textContent).toContain('Claude config')
    expect(band.textContent).toContain('~/.claude')
  })

  it.each([
    ['claude-md', 'SystemPrompt'],
    ['settings', 'Settings'],
    ['mcp', 'McpServers'],
    ['skills', 'Skills'],
    ['plugins', 'Plugins'],
    ['agents', 'AgentLibrary'],
  ])('tab %s mounts %s', (tab, page) => {
    act(() => root.render(createElement(HomeClaudeConfig)))
    act(() => (q(`config-band-tab-${tab}`) as HTMLButtonElement).click())
    expect(q(`page-${page}`)).not.toBeNull()
    expect(host.querySelectorAll('[data-testid^="page-"]').length).toBe(1)
  })

  it('mounts Settings, MCP and Skills at user scope', () => {
    act(() => root.render(createElement(HomeClaudeConfig, { initialTab: 'settings' })))
    expect(q('page-Settings')?.getAttribute('data-scope')).toBe('user')
    act(() => (q('config-band-tab-mcp') as HTMLButtonElement).click())
    expect(q('page-McpServers')?.getAttribute('data-scope')).toBe('user')
    act(() => (q('config-band-tab-skills') as HTMLButtonElement).click())
    expect(q('page-Skills')?.getAttribute('data-scope')).toBe('user')
  })

  it('tab counts come from the data hooks', () => {
    act(() => root.render(createElement(HomeClaudeConfig)))
    const count = (tab: string) => q(`config-band-tab-${tab}`)?.querySelector('[data-testid="config-band-count"]')?.textContent
    expect([count('mcp'), count('skills'), count('plugins'), count('agents')]).toEqual(['3', '7', '2', '4'])
  })

  it('a deep link to a retired key opens Claude config on the matching tab', () => {
    act(() => root.render(createElement(HomeClaudeConfig)))
    act(() => useLayout.getState().openPanel('extensions', 'mcp'))
    expect(useLayout.getState().focusedPanelId).toBe('claude-config')
    expect(q('page-McpServers')).not.toBeNull()
    act(() => useLayout.getState().openPanel('agent-library'))
    expect(q('page-AgentLibrary')).not.toBeNull()
  })

  it('a Settings sub-view deep link selects the tab and forwards the view hint', () => {
    act(() => root.render(createElement(HomeClaudeConfig)))
    act(() => useLayout.getState().openPanel('settings', 'hooks'))
    expect(q('page-Settings')).not.toBeNull()
    expect(useLayout.getState().panelTabHint).toEqual({ id: 'settings', tab: 'hooks' })
  })

  describe('Search all config', () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    const input = () => host.querySelector<HTMLInputElement>('input[aria-label="Search all config"]')!
    const key = (k: string) => act(() => { input().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })) })
    async function focusAndType(value: string) {
      await act(async () => { input().focus() })
      await act(async () => { await Promise.resolve() })
      act(() => {
        setter.call(input(), value)
        input().dispatchEvent(new Event('input', { bubbles: true }))
      })
    }

    it('loads items once on first focus and shows results grouped by tab', async () => {
      act(() => root.render(createElement(HomeClaudeConfig)))
      expect(loadItems).not.toHaveBeenCalled()
      await focusAndType('model')
      expect(loadItems).toHaveBeenCalledTimes(1)
      expect(loadItems).toHaveBeenCalledWith(expect.objectContaining({ scope: 'home', cwd: null }))
      const groups = Array.from(host.querySelectorAll('[data-testid="config-search-group"]')).map((g) => g.textContent)
      expect(groups).toHaveLength(2)
      expect(groups[0]).toContain('Settings')
      expect(groups[0]).toContain('1')
      expect(groups[1]).toContain('MCP')
      act(() => input().blur())
      await act(async () => { input().focus() })
      expect(loadItems).toHaveBeenCalledTimes(1)
    })

    it("shows 'No matches' for a query nothing matches", async () => {
      act(() => root.render(createElement(HomeClaudeConfig)))
      await focusAndType('zzzz')
      expect(q('config-search-panel')?.textContent).toContain('No matches')
    })

    it('Down + Enter switches to the chosen tab and records the item in configSearchFocus', async () => {
      act(() => root.render(createElement(HomeClaudeConfig)))
      await focusAndType('model')
      key('ArrowDown')
      key('Enter')
      expect(q('page-McpServers')).not.toBeNull()
      expect(useConfigSearchFocus.getState()).toMatchObject({ tab: 'mcp', id: 'mcp:modelsrv' })
      expect(input().value).toBe('')
      expect(q('config-search-panel')).toBeNull()
    })

    it("'/' focuses the field and Esc clears it", async () => {
      act(() => root.render(createElement(HomeClaudeConfig)))
      await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true })) })
      expect(document.activeElement).toBe(input())
      await focusAndType('model')
      expect(q('config-search-panel')).not.toBeNull()
      key('Escape')
      expect(input().value).toBe('')
      expect(q('config-search-panel')).toBeNull()
    })
  })
})
