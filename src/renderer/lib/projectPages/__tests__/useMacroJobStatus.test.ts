// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { createElement } from 'react'
import { useMacroJobStatus } from '../useMacroJobStatus'
import type { MacroJobStatus } from '../../../../preload/api'

const row = (over: Partial<MacroJobStatus> = {}): MacroJobStatus => ({
  macroId: 'm1', epicId: 'e1', slug: 's', state: 'running', status: 'running',
  reason: null, startedAt: null, finishedAt: null, ...over,
})

let root: Root | null = null
let container: HTMLDivElement | null = null
let latest: Record<string, MacroJobStatus> = {}
let scheduleHandler: (() => void) | null = null
let pagesHandler: ((p: { cwd: string }) => void) | null = null
const offSchedule = vi.fn()
const offPages = vi.fn()
const jobStatus = vi.fn()

function Probe({ cwd }: { cwd: string | null }) {
  latest = useMacroJobStatus(cwd)
  return null
}
const flush = () => act(async () => { await Promise.resolve() })

beforeEach(() => {
  vi.useFakeTimers()
  jobStatus.mockReset().mockResolvedValue([row()])
  ;(window as unknown as { api: unknown }).api = {
    macros: { jobStatus },
    schedule: { onState: (h: () => void) => { scheduleHandler = h; return offSchedule } },
    projectPages: { onChanged: (h: (p: { cwd: string }) => void) => { pagesHandler = h; return offPages } },
  }
  container = document.createElement('div')
  root = createRoot(container)
})
afterEach(() => {
  act(() => root?.unmount())
  vi.useRealTimers()
  offSchedule.mockClear()
  offPages.mockClear()
})

describe('useMacroJobStatus', () => {
  it('fetches on mount keyed by macroId, refetches on both events, unsubscribes', async () => {
    act(() => root!.render(createElement(Probe, { cwd: '/p' })))
    await flush()
    expect(jobStatus).toHaveBeenCalledWith({ cwd: '/p' })
    expect(latest.m1.state).toBe('running')

    act(() => pagesHandler!({ cwd: '/other' }))
    expect(jobStatus).toHaveBeenCalledTimes(1)
    act(() => pagesHandler!({ cwd: '/p' }))
    expect(jobStatus).toHaveBeenCalledTimes(2)

    // schedule pushes are throttled to one per 2000 ms
    act(() => { vi.advanceTimersByTime(2500); scheduleHandler!(); scheduleHandler!() })
    expect(jobStatus).toHaveBeenCalledTimes(3)
    act(() => scheduleHandler!())
    expect(jobStatus).toHaveBeenCalledTimes(3)
    act(() => { vi.advanceTimersByTime(2100) })
    expect(jobStatus).toHaveBeenCalledTimes(4)

    act(() => root!.unmount())
    expect(offSchedule).toHaveBeenCalled()
    expect(offPages).toHaveBeenCalled()
    root = createRoot(container!)
  })
})
