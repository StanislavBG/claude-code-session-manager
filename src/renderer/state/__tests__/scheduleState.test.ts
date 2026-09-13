import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { ScheduleStateSnapshot } from '../../../preload/api'

/**
 * scheduleState.ts's startSchedulePolling toasts the instant its 5s
 * withTimeout(...) rejects — even for a TIMEOUT, which the onState
 * subscription (installed right after, regardless of hydrate outcome) tends
 * to self-heal within seconds. These tests cover the grace-window policy:
 * a TIMEOUT rejection gets a 30s grace window (cancelled by a live snapshot,
 * or resolved by one retry) before it may toast; a non-timeout rejection
 * still toasts immediately. window.api is mocked since vitest runs this
 * suite in a node environment; fake timers make the 30s window assertable
 * without a real wait.
 */

function fakeSnapshot(): ScheduleStateSnapshot {
  return { paused: null } as unknown as ScheduleStateSnapshot
}

function installWindowApiMock(stateImpl: () => Promise<ScheduleStateSnapshot>) {
  let stateHandler: ((s: ScheduleStateSnapshot) => void) | null = null
  const state = vi.fn(stateImpl)
  const onState = vi.fn((handler: (s: ScheduleStateSnapshot) => void) => {
    stateHandler = handler
    return () => {
      stateHandler = null
    }
  })
  const onStall = vi.fn(() => () => {})
  const api = { schedule: { state, onState, onStall } }
  vi.stubGlobal('window', { api })
  return { state, emitState: (s: ScheduleStateSnapshot) => stateHandler?.(s) }
}

/** A promise that never settles — forces withTimeout's own 5s deadline to fire. */
function pendingForever<T>(): Promise<T> {
  return new Promise<T>(() => {})
}

describe('scheduleState.ts — timeout grace window', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('a TIMEOUT rejection followed by a late live snapshot does not toast', async () => {
    const { emitState } = installWindowApiMock(() => pendingForever())
    const { startSchedulePolling, stopSchedulePolling } = await import('../scheduleState')
    const { useToast } = await import('../toast')

    const startPromise = startSchedulePolling()
    await vi.advanceTimersByTimeAsync(5_000) // withTimeout's own deadline fires -> TIMEOUT rejection
    await startPromise

    emitState(fakeSnapshot()) // live snapshot arrives during the grace window -> cancels it
    await vi.advanceTimersByTimeAsync(40_000) // past the 30s grace window + retry's own deadline

    expect(useToast.getState().history).toHaveLength(0)
    stopSchedulePolling()
  })

  it('a TIMEOUT with no snapshot and a failed retry toasts exactly once, naming the IPC and a busy main process', async () => {
    installWindowApiMock(() => pendingForever())
    const { startSchedulePolling, stopSchedulePolling } = await import('../scheduleState')
    const { useToast } = await import('../toast')

    const startPromise = startSchedulePolling()
    await vi.advanceTimersByTimeAsync(5_000) // initial timeout
    await startPromise

    await vi.advanceTimersByTimeAsync(30_000) // grace window elapses -> fires the retry
    await vi.advanceTimersByTimeAsync(5_000) // the retry's own withTimeout deadline fires too

    const history = useToast.getState().history
    expect(history).toHaveLength(1)
    expect(history[0].kind).toBe('error')
    expect(history[0].message).toContain('schedule.state')
    expect(history[0].message).toContain('main process was busy')
    stopSchedulePolling()
  })

  it('a non-timeout rejection toasts immediately, without waiting for the grace window', async () => {
    installWindowApiMock(() => Promise.reject(new Error('reconcile skipped: queue.json unreadable (EACCES)')))
    const { startSchedulePolling, stopSchedulePolling } = await import('../scheduleState')
    const { useToast } = await import('../toast')

    await startSchedulePolling()

    const history = useToast.getState().history
    expect(history).toHaveLength(1)
    expect(history[0].kind).toBe('error')
    expect(history[0].message).toContain('queue.json unreadable')
    stopSchedulePolling()
  })

  it('teardown during the grace window cancels the pending toast', async () => {
    installWindowApiMock(() => pendingForever())
    const { startSchedulePolling, stopSchedulePolling } = await import('../scheduleState')
    const { useToast } = await import('../toast')

    const startPromise = startSchedulePolling()
    await vi.advanceTimersByTimeAsync(5_000) // initial timeout
    await startPromise

    stopSchedulePolling() // torn down before the 30s grace window elapses

    await vi.advanceTimersByTimeAsync(40_000) // would have fired the retry + toast, if not cancelled

    expect(useToast.getState().history).toHaveLength(0)
  })
})
