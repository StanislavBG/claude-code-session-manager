import { useEffect, useState } from 'react'

export type UpdateStatus = { current: string; latest: string | null; behind: boolean }

const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000

/**
 * Module-level cached singleton (same shape as useSessionSlots.ts): one shared
 * `window.api.app.updateStatus()` poll — once on first mount, then every 6h —
 * regardless of consumer count. The snapshot is replaced only on a successful
 * poll, so the returned reference is stable between polls.
 */
let snapshot: UpdateStatus | null = null
const subscribers = new Set<() => void>()
let activeConsumers = 0
let pollTimer: ReturnType<typeof setInterval> | null = null

async function pollOnce(): Promise<void> {
  try {
    snapshot = await window.api.app.updateStatus()
    subscribers.forEach((fn) => fn())
  } catch {
    // passive surface: no toast, no error state
  }
}

function startPolling() {
  if (pollTimer != null) return
  void pollOnce()
  pollTimer = setInterval(() => { void pollOnce() }, POLL_INTERVAL_MS)
}

function stopPolling() {
  if (pollTimer != null) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

export function useUpdateStatus(): UpdateStatus | null {
  const [, forceRender] = useState(0)

  useEffect(() => {
    const fn = () => forceRender((n) => n + 1)
    subscribers.add(fn)
    activeConsumers += 1
    startPolling()
    return () => {
      subscribers.delete(fn)
      activeConsumers -= 1
      if (activeConsumers <= 0) stopPolling()
    }
  }, [])

  return snapshot
}

/** Test-only reset — clears the singleton so tests don't leak timers/state. */
export function __resetUpdateStatusForTests(): void {
  stopPolling()
  snapshot = null
  activeConsumers = 0
  subscribers.clear()
}
