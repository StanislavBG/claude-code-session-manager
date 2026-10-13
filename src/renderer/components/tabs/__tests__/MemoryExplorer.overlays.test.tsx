// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { SearchPalette } from '../memory/explorer/SearchPalette'
import { DeleteMemoryDialog } from '../memory/explorer/DeleteMemoryDialog'
import { UndoBar } from '../memory/explorer/UndoBar'
import type { MemoryRow } from '../memory/explorer/model'

let container: HTMLDivElement | null = null
let root: Root | null = null

function row(over: Partial<MemoryRow> = {}): MemoryRow {
  return {
    name: 'a.md', slug: 'a', path: '/m/a.md', description: 'desc a', bytes: 2048, mtimeMs: 0,
    ageDays: 3, stale: false, staleReasons: [], ageOnlyStale: false, deadRefs: [], broken: false,
    danglingLinks: [], outLinks: [], inLinks: [], notIndexed: false, clusterId: null, type: null,
    originSessionId: null, ...over,
  }
}

function render(el: ReturnType<typeof createElement>) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => { root!.render(el) })
}

const q = (id: string) => container!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
const key = (el: Element | Document, k: string) =>
  act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })) })

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  container = null
  root = null
  vi.useRealTimers()
})

describe('SearchPalette', () => {
  const rows = [
    row({ name: 'alpha.md', slug: 'alpha', description: 'first', mtimeMs: 1 }),
    row({ name: 'beta.md', slug: 'beta', description: 'second', mtimeMs: 3 }),
    row({ name: 'gamma.md', slug: 'gamma', description: 'third', mtimeMs: 2 }),
  ]
  function mount() {
    const fns = { onPick: vi.fn(), onAsk: vi.fn(), onClose: vi.fn() }
    render(createElement(SearchPalette, { open: true, rows, clusterDot: () => 'bg-accent', ...fns }))
    return fns
  }
  const type = (v: string) => {
    const input = q('mx-palette-input') as HTMLInputElement
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, v)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    return input
  }
  const slugs = () => [...container!.querySelectorAll('[data-testid="mx-palette-row"]')].map((e) => e.textContent)

  it('lists recent first when empty and filters by query', () => {
    mount()
    expect(slugs()[0]).toContain('beta')
    type('alp')
    expect(slugs()).toHaveLength(1)
    expect(slugs()[0]).toContain('alpha')
  })

  it('arrow keys move highlight and Enter picks', () => {
    const fns = mount()
    const input = q('mx-palette-input')!
    key(input, 'ArrowDown')
    key(input, 'Enter')
    expect(fns.onPick).toHaveBeenCalledWith('gamma.md')
  })

  it('Enter on the Ask row asks with the query', () => {
    const fns = mount()
    const input = type('zzz')
    expect(q('mx-palette-ask')!.textContent).toContain('Ask “zzz”')
    key(input, 'Enter')
    expect(fns.onAsk).toHaveBeenCalledWith('zzz')
    expect(fns.onPick).not.toHaveBeenCalled()
  })

  it('Esc closes', () => {
    const fns = mount()
    key(q('mx-palette-input')!, 'Escape')
    expect(fns.onClose).toHaveBeenCalled()
  })
})

describe('DeleteMemoryDialog', () => {
  function mount(inbound: number) {
    const fns = { onArchive: vi.fn(), onCancel: vi.fn(), onConfirm: vi.fn() }
    render(createElement(DeleteMemoryDialog, { open: true, name: 'x.md', inbound, ...fns }))
    return fns
  }

  it('shows the inbound warning only when inbound > 0', () => {
    mount(2)
    expect(q('mx-delete-dialog')!.textContent).toContain('2 memories link here.')
    act(() => { root!.unmount() })
    container!.remove()
    mount(0)
    expect(q('mx-delete-dialog')!.textContent).not.toContain('link here')
  })

  it('wires the three buttons and Esc', () => {
    const fns = mount(0)
    const btn = (t: string) =>
      [...container!.querySelectorAll('button')].find((b) => b.textContent === t) as HTMLElement
    act(() => { btn('Archive instead').click() })
    act(() => { btn('Cancel').click() })
    act(() => { q('mx-delete-confirm')!.click() })
    expect(fns.onArchive).toHaveBeenCalledTimes(1)
    expect(fns.onCancel).toHaveBeenCalledTimes(1)
    expect(fns.onConfirm).toHaveBeenCalledTimes(1)
    key(document, 'Escape')
    expect(fns.onCancel).toHaveBeenCalledTimes(2)
  })
})

describe('UndoBar', () => {
  it('Undo click calls onUndo; hidden without onUndo', () => {
    const onUndo = vi.fn()
    render(createElement(UndoBar, { message: 'Deleted', onUndo, onClose: vi.fn() }))
    act(() => { q('mx-undo')!.click() })
    expect(onUndo).toHaveBeenCalled()
    act(() => { root!.render(createElement(UndoBar, { message: 'Deleted', onClose: vi.fn() })) })
    expect(q('mx-undo')).toBeNull()
  })

  it('auto-closes after 6s and resets on a new message', () => {
    const onClose = vi.fn()
    render(createElement(UndoBar, { message: 'one', onClose }))
    act(() => { vi.advanceTimersByTime(5000) })
    act(() => { root!.render(createElement(UndoBar, { message: 'two', onClose })) })
    act(() => { vi.advanceTimersByTime(5000) })
    expect(onClose).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(1000) })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
