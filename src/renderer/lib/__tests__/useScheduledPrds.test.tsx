// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { useScheduledPrds, requestScheduledPrds, __resetScheduledPrdsForTests, LIST_PRDS_COALESCE_MS } from '../useScheduledPrds'
import { useScheduleState } from '../../state/scheduleState'
import type { PrdListItem, ScheduleStateSnapshot } from '../../../preload/api'

/**
 * Every mounted useScheduledPrds() used to fire its own machine-wide
 * listPrds() on each schedule snapshot change — 4 hook sites x every
 * snapshot fed the main-process heap OOM loop. These assert N instances
 * for one cwd share one coalesced IPC call, bursts coalesce, and cwd is
 * passed through (absent = machine-wide).
 */

const seen: PrdListItem[][] = []

function Consumer({ cwd, idx }: { cwd?: string; idx: number }) {
  const prds = useScheduledPrds(cwd)
  seen[idx] = prds
  return null
}

const LIST = [{ slug: 'a', cwd: '/p' }] as unknown as PrdListItem[]

function installMock() {
  const listPrds = vi.fn().mockResolvedValue(LIST)
  ;(window as unknown as { api: { schedule: { listPrds: typeof listPrds } } }).api = {
    schedule: { listPrds },
  }
  return listPrds
}

function setJobs(n: number) {
  useScheduleState.setState({ snapshot: { jobs: Array.from({ length: n }, () => ({})) } as unknown as ScheduleStateSnapshot })
}

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  vi.useFakeTimers()
  __resetScheduledPrdsForTests()
  seen.length = 0
  setJobs(0)
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  delete (window as unknown as { api?: unknown }).api
  __resetScheduledPrdsForTests()
  vi.useRealTimers()
})

function mount(children: ReturnType<typeof createElement>[]) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(createElement('div', null, ...children)))
}

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(LIST_PRDS_COALESCE_MS + 1)
  })
}

describe('useScheduledPrds — shared fetch', () => {
  it('two hook instances for the same cwd share one listPrds call', async () => {
    const listPrds = installMock()
    mount([
      createElement(Consumer, { key: 0, cwd: '/p', idx: 0 }),
      createElement(Consumer, { key: 1, cwd: '/p', idx: 1 }),
    ])
    await flush()
    expect(listPrds).toHaveBeenCalledTimes(1)
    expect(listPrds).toHaveBeenCalledWith('/p')
    expect(seen[0]).toBe(LIST)
    expect(seen[1]).toBe(LIST)
  })

  it('a burst of snapshot changes coalesces into one call', async () => {
    const listPrds = installMock()
    mount([
      createElement(Consumer, { key: 0, cwd: '/p', idx: 0 }),
      createElement(Consumer, { key: 1, cwd: '/p', idx: 1 }),
    ])
    await flush()
    listPrds.mockClear()
    act(() => setJobs(1))
    act(() => setJobs(2))
    act(() => setJobs(3))
    await flush()
    expect(listPrds).toHaveBeenCalledTimes(1)
  })

  it('no cwd → machine-wide list; distinct cwds fetch separately', async () => {
    const listPrds = installMock()
    mount([
      createElement(Consumer, { key: 0, idx: 0 }),
      createElement(Consumer, { key: 1, cwd: '/q', idx: 1 }),
    ])
    await flush()
    expect(listPrds).toHaveBeenCalledTimes(2)
    expect(listPrds).toHaveBeenCalledWith(undefined)
    expect(listPrds).toHaveBeenCalledWith('/q')
  })

  it('two direct requestScheduledPrds calls for one cwd inside the window make one listPrds call', async () => {
    const listPrds = installMock()
    const a = requestScheduledPrds('/p')
    await vi.advanceTimersByTimeAsync(LIST_PRDS_COALESCE_MS - 50)
    const b = requestScheduledPrds('/p')
    await flush()
    await expect(a).resolves.toBe(LIST)
    await expect(b).resolves.toBe(LIST)
    expect(listPrds).toHaveBeenCalledTimes(1)
    expect(listPrds).toHaveBeenCalledWith('/p')
  })
})
