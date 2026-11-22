// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

import { ConfigBand, type ConfigBandTab } from './ConfigBand'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const TABS: ConfigBandTab[] = [
  { key: 'claude-md', label: 'CLAUDE.md', icon: 'file', count: '3 files' },
  { key: 'settings', label: 'Settings', icon: 'settings', count: 13 },
  { key: 'mcp', label: 'MCP', icon: 'mcp', count: 3, attention: true },
  { key: 'agents', label: 'Agents', icon: 'book' },
]

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function render(onSelect = vi.fn(), activeKey = 'settings') {
  act(() => {
    root.render(
      <ConfigBand
        eyebrow="CLAUDE CODE · GLOBAL"
        title="Claude config"
        scopePath="~/.claude"
        tabs={TABS}
        activeKey={activeKey}
        onSelect={onSelect}
      />,
    )
  })
  return onSelect
}

const tabs = () => Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'))

describe('ConfigBand', () => {
  it('renders eyebrow, title, scope path, a tablist and every tab label + count', () => {
    render()
    expect(container.textContent).toContain('CLAUDE CODE · GLOBAL')
    expect(container.textContent).toContain('Claude config')
    expect(container.textContent).toContain('~/.claude')
    expect(container.querySelectorAll('[role="tablist"]')).toHaveLength(1)
    expect(tabs()).toHaveLength(TABS.length)
    const text = tabs().map((t) => t.textContent)
    expect(text[0]).toContain('CLAUDE.md')
    expect(text[0]).toContain('3 files')
    expect(text[1]).toContain('Settings')
    expect(text[1]).toContain('13')
    expect(text[2]).toContain('MCP')
    expect(text[2]).toContain('3')
    expect(text[3]).toContain('Agents')
    // No count → no chip.
    expect(tabs()[3].querySelector('[data-testid="config-band-count"]')).toBeNull()
    expect(container.querySelector('input[aria-label="Search all config"]')).not.toBeNull()
    expect(container.textContent).toContain('LEARN')
  })

  it('renders the attention dot only on flagged tabs', () => {
    render()
    expect(tabs()[2].querySelector('[data-testid="config-band-attention"]')).not.toBeNull()
    expect(tabs()[1].querySelector('[data-testid="config-band-attention"]')).toBeNull()
  })

  it('clicking a tab calls onSelect with its key', () => {
    const onSelect = render()
    act(() => tabs()[2].click())
    expect(onSelect).toHaveBeenCalledWith('mcp')
    act(() => tabs()[0].click())
    expect(onSelect).toHaveBeenLastCalledWith('claude-md')
  })

  it('aria-selected marks only the active tab', () => {
    render(vi.fn(), 'mcp')
    expect(tabs().map((t) => t.getAttribute('aria-selected'))).toEqual(['false', 'false', 'true', 'false'])
  })

  it('calls the optional onSearch with the typed query', () => {
    const onSearch = vi.fn()
    act(() => {
      root.render(
        <ConfigBand eyebrow="E" title="T" scopePath="~/p" tabs={TABS} activeKey="mcp" onSelect={vi.fn()} onSearch={onSearch} />,
      )
    })
    const input = container.querySelector<HTMLInputElement>('input[type="search"]')!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    act(() => {
      setter.call(input, 'model')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(onSearch).toHaveBeenLastCalledWith('model')
  })
})
