// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

const mocks = vi.hoisted(() => ({
  refreshKnownProjects: vi.fn<(opts: { force?: boolean }) => Promise<void>>(),
  refreshScheduleState: vi.fn<() => Promise<void>>(),
  refreshBilling: vi.fn<() => void>(),
  billingData: { value: null as unknown },
  hydrate: vi.fn<(cwd: string) => Promise<void>>(),
  hydrateArchived: vi.fn<(cwd: string) => Promise<void>>(),
  toastError: vi.fn<(msg: string) => void>(),
}))

vi.mock('../useKnownProjects', () => ({ refreshKnownProjects: mocks.refreshKnownProjects }))
vi.mock('../../state/scheduleState', () => ({ refreshScheduleState: mocks.refreshScheduleState }))
vi.mock('../../state/billing', () => ({
  refreshBilling: mocks.refreshBilling,
  useBilling: { getState: () => ({ data: mocks.billingData.value }) },
}))
vi.mock('../../state/promptSessions', () => ({
  usePromptSessions: { getState: () => ({ hydrate: mocks.hydrate, hydrateArchived: mocks.hydrateArchived }) },
}))
vi.mock('../../state/toast', () => ({ toast: { error: mocks.toastError } }))

import { useDashboardRefresh, DASHBOARD_VISIT_MIN_GAP_MS, type DashboardRefreshResult } from '../useDashboardRefresh'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let now = 1_000_000
let renders = 0
let container: HTMLDivElement | null = null
let root: Root | null = null
let latest: DashboardRefreshResult | null = null

interface Props { focused: boolean; cwds: readonly string[]; extra?: () => unknown }

function Harness(props: Props) {
  latest = useDashboardRefresh(props)
  renders++
  return null
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  })
}

async function render(props: Props) {
  if (!root) {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  }
  act(() => root!.render(<Harness {...props} />))
  await flush()
}

function setVisibility(v: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v })
}

beforeEach(() => {
  now = 1_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  mocks.refreshKnownProjects.mockReset().mockResolvedValue(undefined)
  mocks.refreshScheduleState.mockReset().mockResolvedValue(undefined)
  mocks.refreshBilling.mockReset()
  mocks.hydrate.mockReset().mockResolvedValue(undefined)
  mocks.hydrateArchived.mockReset().mockResolvedValue(undefined)
  mocks.toastError.mockReset()
  mocks.billingData.value = null
  setVisibility('visible')
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  latest = null
  vi.restoreAllMocks()
})

describe('visits', () => {
  it('mounting focused runs one visit refresh with force:false', async () => {
    await render({ focused: true, cwds: ['/a'] })
    expect(mocks.refreshKnownProjects).toHaveBeenCalledTimes(1)
    expect(mocks.refreshKnownProjects).toHaveBeenCalledWith({ force: false })
    expect(mocks.refreshScheduleState).toHaveBeenCalledTimes(1)
    expect(latest!.lastRefreshedAt).toBe(now)
    expect(latest!.refreshing).toBe(false)
  })

  it('nothing runs while unfocused; focus true runs; gap skips re-visits', async () => {
    await render({ focused: false, cwds: [] })
    act(() => { window.dispatchEvent(new Event('focus')) })
    await flush()
    expect(mocks.refreshKnownProjects).not.toHaveBeenCalled()

    await render({ focused: true, cwds: [] })
    expect(mocks.refreshKnownProjects).toHaveBeenCalledTimes(1)

    await render({ focused: false, cwds: [] })
    now += DASHBOARD_VISIT_MIN_GAP_MS - 1
    await render({ focused: true, cwds: [] })
    expect(mocks.refreshKnownProjects).toHaveBeenCalledTimes(1)

    now += 1
    act(() => { window.dispatchEvent(new Event('focus')) })
    await flush()
    expect(mocks.refreshKnownProjects).toHaveBeenCalledTimes(2)
  })

  it('visibilitychange to visible while focused visits; hidden does not', async () => {
    await render({ focused: true, cwds: [] })
    now += DASHBOARD_VISIT_MIN_GAP_MS
    setVisibility('hidden')
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    await flush()
    expect(mocks.refreshKnownProjects).toHaveBeenCalledTimes(1)
    setVisibility('visible')
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    await flush()
    expect(mocks.refreshKnownProjects).toHaveBeenCalledTimes(2)
  })

  it('a visit is skipped while one is in flight', async () => {
    let resolve: () => void = () => {}
    mocks.refreshScheduleState.mockImplementation(() => new Promise<void>((r) => { resolve = r }))
    await render({ focused: true, cwds: [] })
    expect(latest!.refreshing).toBe(true)
    now += DASHBOARD_VISIT_MIN_GAP_MS * 2
    act(() => { window.dispatchEvent(new Event('focus')) })
    act(() => { latest!.refresh() })
    await flush()
    expect(mocks.refreshKnownProjects).toHaveBeenCalledTimes(1)
    resolve()
    await flush()
    expect(latest!.refreshing).toBe(false)
  })

  it('removes both listeners on unmount', async () => {
    const winRemove = vi.spyOn(window, 'removeEventListener')
    const docRemove = vi.spyOn(document, 'removeEventListener')
    await render({ focused: true, cwds: [] })
    act(() => root!.unmount())
    root = null
    expect(winRemove.mock.calls.some((c) => c[0] === 'focus')).toBe(true)
    expect(docRemove.mock.calls.some((c) => c[0] === 'visibilitychange')).toBe(true)
    now += DASHBOARD_VISIT_MIN_GAP_MS * 2
    window.dispatchEvent(new Event('focus'))
    await flush()
    expect(mocks.refreshKnownProjects).toHaveBeenCalledTimes(1)
  })
})

describe('refresh()', () => {
  it('runs inside the gap with force:true', async () => {
    await render({ focused: true, cwds: [] })
    act(() => { latest!.refresh() })
    await flush()
    expect(mocks.refreshKnownProjects).toHaveBeenCalledTimes(2)
    expect(mocks.refreshKnownProjects).toHaveBeenLastCalledWith({ force: true })
  })
})

describe('sources', () => {
  it('calls every source, billing only with data, extra when given', async () => {
    const extra = vi.fn()
    await render({ focused: false, cwds: ['/a', '/b'], extra })
    mocks.hydrate.mockClear()
    mocks.hydrateArchived.mockClear()
    act(() => { latest!.refresh() })
    await flush()
    expect(mocks.hydrate.mock.calls.map((c) => c[0])).toEqual(['/a', '/b'])
    expect(mocks.hydrateArchived.mock.calls.map((c) => c[0])).toEqual(['/a', '/b'])
    expect(mocks.refreshScheduleState).toHaveBeenCalledTimes(1)
    expect(mocks.refreshBilling).not.toHaveBeenCalled()
    expect(extra).toHaveBeenCalledTimes(1)

    mocks.billingData.value = { some: 'data' }
    act(() => { latest!.refresh() })
    await flush()
    expect(mocks.refreshBilling).toHaveBeenCalledTimes(1)
  })

  it('one failure (reject or sync throw) does not stop the others', async () => {
    mocks.billingData.value = {}
    mocks.refreshKnownProjects.mockRejectedValue(new Error('scan broke'))
    mocks.refreshBilling.mockImplementation(() => { throw new Error('sync boom') })
    const extra = vi.fn()
    await render({ focused: true, cwds: ['/a'], extra })
    expect(mocks.refreshScheduleState).toHaveBeenCalledTimes(1)
    expect(mocks.hydrate).toHaveBeenCalledWith('/a')
    expect(extra).toHaveBeenCalledTimes(1)
    expect(latest!.failedSources).toEqual(['projects', 'usage'])
  })
})

describe('new cwd hydration', () => {
  it('hydrates new cwds once without a visit, even unfocused', async () => {
    await render({ focused: false, cwds: ['/a'] })
    expect(mocks.hydrate.mock.calls).toEqual([['/a']])
    expect(mocks.hydrateArchived.mock.calls).toEqual([['/a']])
    expect(mocks.refreshKnownProjects).not.toHaveBeenCalled()
    await render({ focused: false, cwds: ['/a', '/b'] })
    expect(mocks.hydrate.mock.calls).toEqual([['/a'], ['/b']])
    expect(mocks.hydrateArchived.mock.calls).toEqual([['/a'], ['/b']])
    await render({ focused: false, cwds: ['/b', '/a'] })
    expect(mocks.hydrate).toHaveBeenCalledTimes(2)
  })

  it('logs (not toasts, not swallows) a throwing hydrate for one cwd', async () => {
    const write = vi.fn()
    const w = window as unknown as { api?: unknown }
    const prevApi = w.api
    w.api = { logs: { write } }
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      mocks.hydrate.mockImplementation((cwd: string) => {
        if (cwd === '/bad') throw new Error('disk gone')
        return Promise.resolve()
      })
      await render({ focused: false, cwds: ['/ok', '/bad'] })
      expect(write).toHaveBeenCalledTimes(1)
      const [scope, level, message, meta, ctx] = write.mock.calls[0]
      expect(scope).toBe('dashboard')
      expect(level).toBe('warn')
      expect(message).toContain('/bad')
      expect(message).toContain('disk gone')
      expect(meta).toBeUndefined()
      expect(ctx).toEqual({ cwd: '/bad' })
      expect(mocks.toastError).not.toHaveBeenCalled()
      await new Promise((r) => setTimeout(r, 0))
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
      w.api = prevApi
    }
  })

  it('a failing hydrate with no window.api.logs does not throw', async () => {
    const w = window as unknown as { api?: unknown }
    const prevApi = w.api
    w.api = undefined
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      mocks.hydrateArchived.mockRejectedValue(new Error('nope'))
      await render({ focused: false, cwds: ['/x'] })
      await new Promise((r) => setTimeout(r, 0))
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
      w.api = prevApi
    }
  })
})

describe('state + toasts', () => {
  it('failure keeps lastRefreshedAt, lists names, toasts once with first message', async () => {
    await render({ focused: true, cwds: [] })
    const first = latest!.lastRefreshedAt
    expect(first).toBe(now)

    mocks.refreshScheduleState.mockRejectedValue(new Error('queue down'))
    now += DASHBOARD_VISIT_MIN_GAP_MS
    act(() => { window.dispatchEvent(new Event('focus')) })
    await flush()
    expect(latest!.failedSources).toEqual(['queue'])
    expect(latest!.lastRefreshedAt).toBe(first)
    expect(mocks.toastError).toHaveBeenCalledTimes(1)
    expect(mocks.toastError).toHaveBeenCalledWith('Dashboard refresh failed (queue): queue down')

    // A second failing visit after a failure: no toast.
    now += DASHBOARD_VISIT_MIN_GAP_MS
    act(() => { window.dispatchEvent(new Event('focus')) })
    await flush()
    expect(mocks.refreshScheduleState).toHaveBeenCalledTimes(3)
    expect(mocks.toastError).toHaveBeenCalledTimes(1)

    // refresh() always toasts on failure.
    act(() => { latest!.refresh() })
    await flush()
    expect(mocks.toastError).toHaveBeenCalledTimes(2)

    // Success clears failures and stamps lastRefreshedAt.
    mocks.refreshScheduleState.mockResolvedValue(undefined)
    now += 5
    act(() => { latest!.refresh() })
    await flush()
    expect(latest!.failedSources).toEqual([])
    expect(latest!.lastRefreshedAt).toBe(now)
  })

  it('the gap counts from a failed finish too', async () => {
    mocks.refreshScheduleState.mockRejectedValue(new Error('x'))
    await render({ focused: true, cwds: [] })
    now += DASHBOARD_VISIT_MIN_GAP_MS - 1
    act(() => { window.dispatchEvent(new Event('focus')) })
    await flush()
    expect(mocks.refreshScheduleState).toHaveBeenCalledTimes(1)
  })

  it('sets no state after unmount', async () => {
    let resolve: () => void = () => {}
    mocks.refreshScheduleState.mockImplementation(() => new Promise<void>((r) => { resolve = r }))
    const errSpy = vi.spyOn(console, 'error')
    await render({ focused: true, cwds: [] })
    const seen = latest
    act(() => root!.unmount())
    root = null
    const rendersAtUnmount = renders
    resolve()
    await flush()
    expect(latest).toBe(seen)
    expect(renders).toBe(rendersAtUnmount)
    expect(mocks.toastError).not.toHaveBeenCalled()
    expect(errSpy).not.toHaveBeenCalled()
  })
})
