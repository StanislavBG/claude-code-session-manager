/**
 * Singleton scheduler-state subscription.
 *
 * Before: 5 components (SchedulePanel, Overview, SchedulerPrdsView, LeftNav,
 * AgentView) each opened their own `window.api.schedule.onState(...)`
 * subscription. Every snapshot fanned out 5 times, and a `schedule:state`
 * broadcast cost N IPC reads where N was the number of mounted consumers.
 *
 * This module owns a single subscription and exposes the latest snapshot via
 * zustand. Consumers `useScheduleState()`; the timer/subscription start once
 * at app mount via `startSchedulePolling()`.
 */
import { create } from 'zustand'
import type { ScheduleStateSnapshot } from '../../preload/api'
import { toast } from './toast'
import { withTimeout } from '../lib/withTimeout'

const SCHEDULE_IPC_TIMEOUT_MS = 5_000

interface ScheduleState {
  snapshot: ScheduleStateSnapshot | null
  loaded: boolean
}

export const useScheduleState = create<ScheduleState>(() => ({ snapshot: null, loaded: false }))

let started = false
let offSubscription: (() => void) | null = null
let toastedFailure = false

export async function startSchedulePolling(): Promise<void> {
  if (started) return
  started = true
  try {
    const snap = await withTimeout(
      window.api.schedule.state(),
      SCHEDULE_IPC_TIMEOUT_MS,
      'schedule.state',
    )
    useScheduleState.setState({ snapshot: snap, loaded: true })
  } catch (e) {
    if (!toastedFailure) {
      toastedFailure = true
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(`Scheduler state hydrate failed: ${msg}`)
    }
  }
  // Install the live subscription regardless of whether the initial hydrate
  // succeeded — if the first state() timed out, broadcasts will still drive
  // useScheduleState once main starts responding.
  offSubscription = window.api.schedule.onState((s) => {
    useScheduleState.setState({ snapshot: s, loaded: true })
  })
}

export function stopSchedulePolling(): void {
  if (offSubscription) {
    offSubscription()
    offSubscription = null
  }
  started = false
}
