// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

import { useState } from 'react'
import { ConfigBand, ConfigSearchResults, compactScopePath, type ConfigBandTab } from './ConfigBand'
import type { ConfigSearchGroup } from '../../lib/configSearch'

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

describe('compactScopePath', () => {
  it('returns a path that fits unchanged', () => {
    expect(compactScopePath('~/Projects/Self')).toBe('~/Projects/Self')
    expect(compactScopePath('~/.claude')).toBe('~/.claude')
  })

  it('elides a long nested path from the start, keeping the last folder', () => {
    const long = '~/Projects/clients/acme-corp/monorepo/packages/web-frontend'
    const out = compactScopePath(long)
    expect(out.startsWith('…/')).toBe(true)
    expect(out.endsWith('/web-frontend')).toBe(true)
    expect(out.length).toBeLessThanOrEqual(32)
    expect(out).toBe('…/monorepo/packages/web-frontend')
    expect(compactScopePath(long, 20)).toBe('…/web-frontend')
  })

  it('keeps a single overlong last segment whole', () => {
    const seg = 'an-extremely-long-project-folder-name-that-cannot-fit'
    expect(compactScopePath(`~/Projects/${seg}`)).toBe(`…/${seg}`)
  })
})

describe('ConfigBand scope path', () => {
  it('renders the compacted path with the full path as its title, no CSS truncate', () => {
    const full = '~/Projects/clients/acme-corp/monorepo/packages/web-frontend'
    act(() => {
      root.render(<ConfigBand eyebrow="E" title="T" scopePath={full} tabs={TABS} activeKey="mcp" onSelect={vi.fn()} />)
    })
    const path = container.querySelector<HTMLElement>('[data-testid="config-band-path"]')!
    expect(path.textContent).toBe(compactScopePath(full))
    expect(path.getAttribute('title')).toBe(full)
    expect(path.className).not.toContain('truncate')
  })
})

describe('ConfigBand search panel', () => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  const input = () => container.querySelector<HTMLInputElement>('input[type="search"]')!
  const panel = () => container.querySelector('[data-testid="config-search-panel"]')

  function Harness({ onKey }: { onKey?: (k: string) => void }) {
    const [query, setQuery] = useState('')
    return (
      <ConfigBand
        eyebrow="E"
        title="T"
        scopePath="~/p"
        tabs={TABS}
        activeKey="mcp"
        onSelect={vi.fn()}
        searchQuery={query}
        onSearch={setQuery}
        onSearchKeyDown={(e) => onKey?.(e.key)}
        searchPanel={<div data-testid="results">results for {query}</div>}
      />
    )
  }

  function type(value: string) {
    act(() => {
      setter.call(input(), value)
      input().dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  it('shows the panel only while focused with a non-empty query', () => {
    act(() => root.render(<Harness />))
    expect(panel()).toBeNull()
    act(() => input().focus())
    expect(panel()).toBeNull()
    type('mod')
    expect(panel()?.textContent).toContain('results for mod')
    act(() => input().blur())
    expect(panel()).toBeNull()
  })

  it("'/' focuses the field unless focus is in an input, textarea or contenteditable", () => {
    act(() => root.render(<Harness />))
    act(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true })) })
    expect(document.activeElement).toBe(input())
    act(() => input().blur())
    const other = document.createElement('textarea')
    document.body.appendChild(other)
    other.focus()
    act(() => { other.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true })) })
    expect(document.activeElement).toBe(other)
    other.remove()
  })

  it('Esc clears the query and blurs the field; other keys reach onSearchKeyDown', () => {
    const keys: string[] = []
    act(() => root.render(<Harness onKey={(k) => keys.push(k)} />))
    act(() => input().focus())
    type('mod')
    act(() => { input().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) })
    expect(keys).toEqual(['ArrowDown'])
    act(() => { input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(input().value).toBe('')
    expect(document.activeElement).not.toBe(input())
    expect(panel()).toBeNull()
  })
})

describe('ConfigSearchResults', () => {
  const groups: ConfigSearchGroup[] = [
    { tab: 'settings', total: 7, items: [{ tab: 'settings', id: 'settings:model', title: 'model', detail: 'Model' }] },
    { tab: 'mcp', total: 1, items: [{ tab: 'mcp', id: 'mcp:one', title: 'one', detail: 'MCP server' }] },
  ]

  it('groups rows under each tab label with its total and marks the active row', () => {
    act(() => {
      root.render(<ConfigSearchResults groups={groups} loading={false} activeIndex={1} tabs={TABS} onChoose={vi.fn()} onHover={vi.fn()} />)
    })
    const heads = Array.from(container.querySelectorAll('[data-testid="config-search-group"]')).map((g) => g.textContent)
    expect(heads[0]).toContain('Settings')
    expect(heads[0]).toContain('7')
    expect(heads[1]).toContain('MCP')
    const rows = Array.from(container.querySelectorAll('[role="option"]'))
    expect(rows.map((r) => r.getAttribute('aria-selected'))).toEqual(['false', 'true'])
  })

  it("says 'No matches' when there are no groups", () => {
    act(() => {
      root.render(<ConfigSearchResults groups={[]} loading={false} activeIndex={0} tabs={TABS} onChoose={vi.fn()} onHover={vi.fn()} />)
    })
    expect(container.textContent).toContain('No matches')
  })

  it('clicking a row chooses its item', () => {
    const onChoose = vi.fn()
    act(() => {
      root.render(<ConfigSearchResults groups={groups} loading={false} activeIndex={0} tabs={TABS} onChoose={onChoose} onHover={vi.fn()} />)
    })
    act(() => (container.querySelectorAll('[role="option"]')[1] as HTMLElement).click())
    expect(onChoose).toHaveBeenCalledWith(groups[1].items[0])
  })
})
