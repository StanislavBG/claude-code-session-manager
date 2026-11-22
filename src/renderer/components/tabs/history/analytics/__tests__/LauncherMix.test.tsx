// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { LauncherMix } from '../panels/LauncherMix'
import type { LauncherBucket } from '../../../../../lib/historyProjectFold'
import type { HistoryLauncher } from '../../../../../lib/historyLauncher'

let container: HTMLDivElement | null = null
let root: Root | null = null

function bucket(costUsd: number): LauncherBucket {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd, sessionCount: 1 }
}

function mount(byLauncherTotals: Partial<Record<HistoryLauncher, LauncherBucket>>) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => { root!.render(createElement(LauncherMix, { byLauncherTotals })) })
  return container
}

function lines(el: HTMLElement) {
  return Array.from(el.querySelectorAll('[data-testid^="history-launcher-"]')).map((n) => n.textContent ?? '')
}

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  container = null
  root = null
})

describe('LauncherMix', () => {
  it('labels itself with the composition section kicker', () => {
    const el = mount({ epic: bucket(1) })
    expect(el.textContent).toContain('05 · composition')
    expect(el.textContent).not.toContain('07 · composition')
  })

  it('renders three lines in fixed order with cost and share', () => {
    const el = mount({ other: bucket(1), epic: bucket(2), job: bucket(1) })
    const ls = lines(el)
    expect(ls).toHaveLength(3)
    expect(ls[0]).toContain('Epic sessions')
    expect(ls[0]).toContain('$2.00')
    expect(ls[0]).toContain('50%')
    expect(ls[1]).toContain('Scheduler jobs')
    expect(ls[1]).toContain('$1.00')
    expect(ls[1]).toContain('25%')
    expect(ls[2]).toContain('Other sessions')
    expect(ls[2]).toContain('25%')
    expect(el.textContent).toContain('$4.00 total')
  })

  it('shows zero for a launcher with no data', () => {
    const el = mount({ epic: bucket(3) })
    const ls = lines(el)
    expect(ls).toHaveLength(3)
    expect(ls[0]).toContain('100%')
    expect(ls[1]).toContain('Scheduler jobs')
    expect(ls[1]).toContain('$0.00')
    expect(ls[1]).toContain('0%')
    expect(ls[2]).toContain('0%')
  })

  it('shows one empty-state line with no cost at all', () => {
    const el = mount({})
    expect(lines(el)).toHaveLength(0)
    expect(el.textContent).toContain('no usage in range')
    const zero = mount({ epic: bucket(0) })
    expect(lines(zero)).toHaveLength(0)
    expect(zero.textContent).toContain('no usage in range')
  })
})
