// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { ClaudeConfigShell } from './ClaudeConfigShell'
import type { ConfigBandTab } from './ConfigBand'
import type { LearningContent } from '../learningContent'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const TABS: ConfigBandTab[] = [
  { key: 'claude-md', label: 'CLAUDE.md', icon: 'file', count: 'missing', warn: true },
  { key: 'settings', label: 'Settings', icon: 'settings', count: 13 },
  { key: 'mcp', label: 'MCP', icon: 'mcp', count: 3, attention: true },
  { key: 'agents', label: 'Agents', icon: 'book' },
]
const LEARN = { intro: 'Learn intro text', sections: [] } as unknown as LearningContent

let container: HTMLDivElement
let root: Root
let onSearch: ReturnType<typeof vi.fn>

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  onSearch = vi.fn()
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function render(onSelect = vi.fn(), activeKey = 'settings', query = '') {
  const search = {
    bandProps: {
      searchQuery: query,
      onSearch,
      onSearchFocus: vi.fn(),
      onSearchKeyDown: vi.fn(),
      searchInputRef: { current: null },
    },
    panelProps: { groups: [], loading: false, activeIndex: 0, onChoose: vi.fn(), onHover: vi.fn() },
  } as unknown as Parameters<typeof ClaudeConfigShell>[0]['search']
  act(() => {
    root.render(
      <ClaudeConfigShell
        testId="shell"
        eyebrow="CLAUDE CODE · GLOBAL"
        title="Claude config"
        scopePath="~/.claude"
        tabs={TABS}
        activeKey={activeKey}
        onSelect={onSelect}
        search={search}
        learn={LEARN}
      >
        <div>body</div>
      </ClaudeConfigShell>,
    )
  })
  return onSelect
}

const tabs = () => Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
const press = (el: Element, key: string) =>
  act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })) })

describe('ClaudeConfigShell', () => {
  it('renders tabs in order with counts, attention and warn, and no config-band', () => {
    render()
    expect(tabs().map((t) => t.getAttribute('data-testid'))).toEqual(
      TABS.map((t) => `config-rail-tab-${t.key}`),
    )
    expect(container.querySelector('[data-testid="config-band"]')).toBeNull()
    expect(container.querySelector('[data-testid="config-rail"]')).not.toBeNull()
    expect(container.querySelector('[role="tablist"]')?.getAttribute('aria-orientation')).toBe('vertical')
    expect(tabs()[1].textContent).toContain('13')
    expect(tabs()[3].querySelector('[data-testid="config-rail-count"]')).toBeNull()
    expect(tabs()[2].querySelector('[data-testid="config-rail-attention"]')).not.toBeNull()
    expect(tabs()[1].querySelector('[data-testid="config-rail-attention"]')).toBeNull()
    expect(tabs()[0].querySelector('[data-testid="config-rail-count"]')?.className).toContain('accent')
    expect(container.querySelector('[data-testid="config-rail-path"]')?.getAttribute('title')).toBe('~/.claude')
  })

  it('click selects; arrows, Home and End select with wrapping', () => {
    const onSelect = render()
    act(() => tabs()[2].click())
    expect(onSelect).toHaveBeenLastCalledWith('mcp')
    press(tabs()[3], 'ArrowDown')
    expect(onSelect).toHaveBeenLastCalledWith('claude-md')
    press(tabs()[0], 'ArrowUp')
    expect(onSelect).toHaveBeenLastCalledWith('agents')
    press(tabs()[1], 'Home')
    expect(onSelect).toHaveBeenLastCalledWith('claude-md')
    press(tabs()[1], 'End')
    expect(onSelect).toHaveBeenLastCalledWith('agents')
  })

  it("'/' focuses search unless typing in an input; Esc clears", () => {
    render()
    const input = container.querySelector<HTMLInputElement>('input[type="search"]')!
    press(document.body, '/')
    expect(document.activeElement).toBe(input)
    input.blur()
    const other = document.createElement('input')
    document.body.appendChild(other)
    other.focus()
    press(other, '/')
    expect(document.activeElement).toBe(other)
    other.remove()
    input.focus()
    press(input, 'Escape')
    expect(onSearch).toHaveBeenCalledWith('')
    expect(document.activeElement).not.toBe(input)
  })

  it('LEARN toggles the learn panel', () => {
    render()
    expect(container.querySelector('[data-testid="shell-learn"]')).toBeNull()
    const learn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'LEARN')!
    act(() => learn.click())
    expect(container.querySelector('[data-testid="shell-learn"]')).not.toBeNull()
    act(() => learn.click())
    expect(container.querySelector('[data-testid="shell-learn"]')).toBeNull()
  })

  it('content area testid follows activeKey', () => {
    render(vi.fn(), 'mcp')
    expect(container.querySelector('[data-testid="shell-panel-mcp"]')?.textContent).toBe('body')
    expect(container.querySelector('[data-testid="shell-panel-settings"]')).toBeNull()
  })
})
