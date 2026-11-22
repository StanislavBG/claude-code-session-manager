// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import type { NeedsYouItem } from '../../../preload/api'
import { useOutsideNeedsYou } from '../useOutsideNeedsYou'

let container: HTMLDivElement | null = null
let root: Root | null = null
let emit: () => void = () => {}
let latest: ReturnType<typeof useOutsideNeedsYou> | null = null
const list = vi.fn()
const answer = vi.fn()
const unsubscribe = vi.fn()

function mk(id: string): NeedsYouItem {
  return {
    app: 'portfolio', id, title: `t-${id}`, why: 'w', link: null, options: ['a', 'b'],
    externalRef: null, status: 'open', answer: null,
    createdAt: '2026-11-20T00:00:00.000Z', updatedAt: '2026-11-20T00:00:00.000Z', answeredAt: null,
  }
}

function Probe() {
  latest = useOutsideNeedsYou()
  return null
}

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  ;(window as unknown as { api: unknown }).api = {
    needsYou: {
      list,
      answer,
      onChanged: (h: () => void) => { emit = h; return unsubscribe },
    },
  }
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container = null
  latest = null
  list.mockReset()
  answer.mockReset()
  unsubscribe.mockReset()
})

function mount() {
  container = document.createElement('div')
  root = createRoot(container)
  act(() => root!.render(<Probe />))
}

describe('useOutsideNeedsYou', () => {
  it('lists on mount', async () => {
    list.mockResolvedValue({ ok: true, items: [mk('1')] })
    mount()
    await flush()
    expect(list).toHaveBeenCalledTimes(1)
    expect(latest!.items.map((i) => i.id)).toEqual(['1'])
  })

  it('lists again on every change and unsubscribes on unmount', async () => {
    list.mockResolvedValueOnce({ ok: true, items: [mk('1')] })
    list.mockResolvedValueOnce({ ok: true, items: [mk('1'), mk('2')] })
    mount()
    await flush()
    act(() => emit())
    await flush()
    expect(list).toHaveBeenCalledTimes(2)
    expect(latest!.items.map((i) => i.id)).toEqual(['1', '2'])
    act(() => root!.unmount())
    root = null
    expect(unsubscribe).toHaveBeenCalled()
  })

  it('answer calls window.api.needsYou.answer and returns its result', async () => {
    list.mockResolvedValue({ ok: true, items: [] })
    const result = { ok: false, error: 'no such option' }
    answer.mockResolvedValue(result)
    mount()
    await flush()
    let got: unknown
    await act(async () => { got = await latest!.answer('portfolio', '1', 'a') })
    expect(answer).toHaveBeenCalledWith({ app: 'portfolio', id: '1', answer: 'a' })
    expect(got).toBe(result)
  })

  it('reload lists again, updates items, and keeps its identity across renders', async () => {
    list.mockResolvedValueOnce({ ok: true, items: [mk('1')] })
    list.mockResolvedValueOnce({ ok: true, items: [mk('1'), mk('3')] })
    mount()
    await flush()
    const firstReload = latest!.reload
    act(() => latest!.reload())
    await flush()
    expect(list).toHaveBeenCalledTimes(2)
    expect(latest!.items.map((i) => i.id)).toEqual(['1', '3'])
    act(() => root!.render(<Probe />))
    expect(latest!.reload).toBe(firstReload)
  })

  it('a failing reload toasts once across repeated failures', async () => {
    const { useToast } = await import('../../state/toast')
    useToast.getState().clearHistory()
    list.mockResolvedValueOnce({ ok: true, items: [] })
    list.mockRejectedValue(new Error('down'))
    mount()
    await flush()
    act(() => latest!.reload())
    await flush()
    act(() => latest!.reload())
    await flush()
    expect(list).toHaveBeenCalledTimes(3)
    const errs = useToast.getState().history.filter((h) => h.message.includes('outside items'))
    expect(errs).toHaveLength(1)
  })

  it('reload after unmount is a no-op', async () => {
    list.mockResolvedValue({ ok: true, items: [] })
    mount()
    await flush()
    const reload = latest!.reload
    act(() => root!.unmount())
    root = null
    reload()
    expect(list).toHaveBeenCalledTimes(1)
  })
})
