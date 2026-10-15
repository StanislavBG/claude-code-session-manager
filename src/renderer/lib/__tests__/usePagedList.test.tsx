// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { usePagedList } from '../usePagedList'
import { Pager } from '../../components/ui/Pager'

type Result = ReturnType<typeof usePagedList<number>>

let container: HTMLDivElement | null = null
let root: Root | null = null

afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  container = null
  root = null
})

function mount(node: React.ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(node))
}

function harness(items: number[], size: number) {
  const out: { current: Result | null } = { current: null }
  function H({ list }: { list: number[] }) {
    out.current = usePagedList(list, size)
    return null
  }
  mount(<H list={items} />)
  return { out, rerender: (list: number[]) => act(() => root!.render(<H list={list} />)) }
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1)

describe('usePagedList', () => {
  it('returns the first page slice', () => {
    const { out } = harness(range(20), 8)
    expect(out.current!.page).toBe(1)
    expect(out.current!.pageItems).toEqual(range(8))
    expect(out.current!.total).toBe(20)
    expect(out.current!.pageSize).toBe(8)
  })

  it('returns the next page slice', () => {
    const { out } = harness(range(20), 8)
    act(() => out.current!.setPage(2))
    expect(out.current!.pageItems).toEqual([9, 10, 11, 12, 13, 14, 15, 16])
    act(() => out.current!.setPage(3))
    expect(out.current!.pageItems).toEqual([17, 18, 19, 20])
  })

  it('clamps to the last valid page when the list shrinks', () => {
    const { out, rerender } = harness(range(20), 8)
    act(() => out.current!.setPage(3))
    rerender(range(10))
    expect(out.current!.page).toBe(2)
    expect(out.current!.pageItems).toEqual([9, 10])
  })

  it('empty list → page 1 and []', () => {
    const { out, rerender } = harness(range(20), 8)
    act(() => out.current!.setPage(3))
    rerender([])
    expect(out.current!.page).toBe(1)
    expect(out.current!.pageItems).toEqual([])
  })

  it('keeps pageItems referentially stable across re-renders', () => {
    const items = range(20)
    const { out, rerender } = harness(items, 8)
    const first = out.current!.pageItems
    rerender(items)
    expect(out.current!.pageItems).toBe(first)
  })
})

describe('Pager testIdPrefix', () => {
  it('derives testids from the prefix', () => {
    mount(<Pager page={1} pageSize={8} totalItems={20} onPageChange={() => {}} testIdPrefix="home-projects-pager" compact />)
    expect(container!.querySelector('[data-testid="home-projects-pager-range"]')!.textContent).toBe('1–8 of 20')
    expect(container!.querySelector('[data-testid="home-projects-pager-prev"]')).not.toBeNull()
    expect(container!.querySelector('[data-testid="home-projects-pager-next"]')).not.toBeNull()
    expect(container!.querySelector('[data-testid="plan-pager"]')).toBeNull()
  })

  it('defaults to plan-pager', () => {
    mount(<Pager page={1} pageSize={8} totalItems={20} onPageChange={() => {}} />)
    expect(container!.querySelector('[data-testid="plan-pager-range"]')!.textContent).toBe('1–8 of 20')
  })
})
