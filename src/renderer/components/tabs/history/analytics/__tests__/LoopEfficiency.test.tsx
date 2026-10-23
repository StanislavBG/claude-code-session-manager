// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { LoopEfficiency } from '../panels/LoopEfficiency'

let container: HTMLDivElement
let root: Root

function result(over: Record<string, unknown> = {}, totals: Record<string, unknown> = {}) {
  return {
    fromMs: 0,
    toMs: 1,
    rows: [
      { cwd: '/a', project: 'alpha', runs: 10, wastedRuns: 0, verified: 4, refuted: 1, executorUsd: 8, usdPerVerified: 2 },
      { cwd: '/b', project: 'beta', runs: 5, wastedRuns: 1, verified: 0, refuted: 0, executorUsd: 3, usdPerVerified: null },
    ],
    totals: { runs: 15, wastedRuns: 1, verified: 4, refuted: 1, executorUsd: 11, wastedRunRate: 0.02, ...totals },
    weeklyUtilizationPct: 40,
    verifiedPerUsagePct: 0.1,
    ...over,
  }
}

async function mount(res: unknown) {
  const loopEfficiency = vi.fn(async () => res)
  ;(globalThis as any).window.api = { history: { loopEfficiency, onUpdated: vi.fn(() => () => {}) } }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(createElement(LoopEfficiency))
    await Promise.resolve()
    await Promise.resolve()
  })
}

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  delete (globalThis as any).window?.api
})

const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null

describe('LoopEfficiency', () => {
  it('renders one row per project and an em dash for null $ / verified', async () => {
    await mount(result())
    expect(container.querySelectorAll('[data-testid="loop-eff-row"]').length).toBe(2)
    const cells = container.querySelectorAll('[data-testid="loop-eff-per-verified"]')
    expect(cells[0].textContent).toBe('$2.00')
    expect(cells[1].textContent).toBe('—')
  })

  it('shows the usage footer when available', async () => {
    await mount(result())
    expect(q('loop-eff-usage')!.textContent).toBe('0.1 verified PRDs per 1% of weekly usage')
  })

  it('shows unavailable when verifiedPerUsagePct is null', async () => {
    await mount(result({ verifiedPerUsagePct: null }))
    expect(q('loop-eff-usage')!.textContent).toBe('weekly usage unavailable')
  })

  it('warns only when wasted rate exceeds 5%', async () => {
    await mount(result())
    expect(q('loop-eff-totals')!.dataset.warning).toBe('false')
    act(() => root.unmount())
    container.remove()
    await mount(result({}, { wastedRunRate: 0.12 }))
    expect(q('loop-eff-totals')!.dataset.warning).toBe('true')
  })

  it('shows empty state', async () => {
    await mount(result({ rows: [] }))
    expect(q('loop-eff-empty')).not.toBeNull()
  })
})
