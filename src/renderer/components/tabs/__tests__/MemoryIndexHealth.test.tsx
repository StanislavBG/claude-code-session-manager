// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { MemoryIndexHealth } from '../memory/MemoryIndexHealth'
import type { MemoryIndexHealth as IndexHealth } from '../../../../preload/api'

let container: HTMLDivElement | null = null
let root: Root | null = null

async function mount(props: { index: IndexHealth | undefined; autoMemoryEnabled: boolean }) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(createElement(MemoryIndexHealth, props))
  })
  return container
}

const base: IndexHealth = {
  lines: 42,
  bytes: 2048,
  maxLines: 200,
  maxBytes: 25600,
  overBudget: false,
  nearBudget: false,
  orphans: [],
  dangling: [],
}

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
})

describe('MemoryIndexHealth', () => {
  it('shows the auto-memory-off banner only when disabled', async () => {
    const el = await mount({ index: base, autoMemoryEnabled: false })
    expect(el.textContent).toContain('Auto memory is off — Claude Code will not read or write these memories')
    act(() => root?.unmount())
    el.remove()
    const el2 = await mount({ index: base, autoMemoryEnabled: true })
    expect(el2.textContent).not.toContain('Auto memory is off')
  })

  it('renders the lines/KB strip', async () => {
    const el = await mount({ index: base, autoMemoryEnabled: true })
    expect(el.textContent).toContain('MEMORY.md 42/200 lines · 2.0/25 KB')
  })

  it('uses amber when near budget and red when over budget', async () => {
    const el = await mount({ index: { ...base, nearBudget: true }, autoMemoryEnabled: true })
    const strip = el.querySelector('[data-testid="memory-index-strip"]')!
    expect(strip.className).toContain('text-amber-400')
    expect(strip.className).not.toContain('text-red-400')
    act(() => root?.unmount())
    el.remove()
    const el2 = await mount({ index: { ...base, nearBudget: true, overBudget: true }, autoMemoryEnabled: true })
    const strip2 = el2.querySelector('[data-testid="memory-index-strip"]')!
    expect(strip2.className).toContain('text-red-400')
  })

  it('shows orphan and dangling counts when non-zero', async () => {
    const el = await mount({
      index: { ...base, orphans: ['a.md', 'b.md'], dangling: ['x.md'] },
      autoMemoryEnabled: true,
    })
    expect(el.textContent).toContain('2 not in index')
    expect(el.textContent).toContain('1 dangling index lines')
    act(() => root?.unmount())
    el.remove()
    const el2 = await mount({ index: base, autoMemoryEnabled: true })
    expect(el2.textContent).not.toContain('not in index')
    expect(el2.textContent).not.toContain('dangling')
  })

  it('renders no strip for an undefined index', async () => {
    const el = await mount({ index: undefined, autoMemoryEnabled: true })
    expect(el.querySelector('[data-testid="memory-index-strip"]')).toBeNull()
    expect(el.textContent).toBe('')
  })
})
