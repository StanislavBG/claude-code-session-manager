// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

import { ConfigSearchResults, compactScopePath, type ConfigTabSpec } from './configShared'
import type { ConfigSearchGroup } from '../../lib/configSearch'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const TABS: ConfigTabSpec[] = [
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

describe('compactScopePath', () => {
  it('returns a path that fits unchanged', () => {
    expect(compactScopePath('~/Projects/Self', 32)).toBe('~/Projects/Self')
    expect(compactScopePath('~/.claude', 32)).toBe('~/.claude')
  })

  it('elides a long nested path from the start, keeping the last folder', () => {
    const long = '~/Projects/clients/acme-corp/monorepo/packages/web-frontend'
    const out = compactScopePath(long, 32)
    expect(out.startsWith('…/')).toBe(true)
    expect(out.endsWith('/web-frontend')).toBe(true)
    expect(out.length).toBeLessThanOrEqual(32)
    expect(out).toBe('…/monorepo/packages/web-frontend')
    expect(compactScopePath(long, 20)).toBe('…/web-frontend')
  })

  it('keeps a single overlong last segment whole', () => {
    const seg = 'an-extremely-long-project-folder-name-that-cannot-fit'
    expect(compactScopePath(`~/Projects/${seg}`, 32)).toBe(`…/${seg}`)
  })

  it('shortens a Windows path on backslashes and keeps the backslash separator', () => {
    const win = 'C:\\Users\\dev\\Projects\\clients\\acme-corp\\monorepo\\web-frontend'
    const out = compactScopePath(win, 32)
    expect(out).toBe('…\\monorepo\\web-frontend')
    expect(out).not.toContain('/')
    expect(out.length).toBeLessThanOrEqual(32)
    expect(compactScopePath(win, 20)).toBe('…\\web-frontend')
    expect(compactScopePath('C:\\Users\\dev', 32)).toBe('C:\\Users\\dev')
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

  it('keeps the title whole and truncates only the detail', () => {
    act(() => {
      root.render(<ConfigSearchResults groups={groups} loading={false} activeIndex={0} tabs={TABS} onChoose={vi.fn()} onHover={vi.fn()} />)
    })
    const [title, detail] = Array.from(container.querySelectorAll('[role="option"]')[0].querySelectorAll('span'))
    expect(title.className).toContain('shrink-0')
    expect(title.className).not.toContain('truncate')
    expect(detail.className).toContain('truncate')
    expect(detail.className).toContain('min-w-0')
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
