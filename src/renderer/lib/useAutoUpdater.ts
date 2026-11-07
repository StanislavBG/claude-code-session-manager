import { useEffect, useState } from 'react'
import type { AutoUpdaterStatus } from '../../preload/api'

/**
 * Module-level cached singleton (same shape as useSessionSlots.ts): one
 * `window.api.updater.status()` fetch on first mount plus one `onStatus`
 * subscription shared by all consumers, torn down when the last unmounts.
 * The snapshot is replaced only when a new status arrives.
 */
let snapshot: AutoUpdaterStatus | null = null
const subscribers = new Set<() => void>()
let activeConsumers = 0
let unsubscribeStatus: (() => void) | null = null
let started = false

const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000
let pollTimer: ReturnType<typeof setInterval> | null = null

function publish(next: AutoUpdaterStatus) {
  // Pushed statuses omit the latest-version probe (`check`); keep the last one.
  snapshot = next.check || !snapshot?.check ? next : { ...next, check: snapshot.check }
  subscribers.forEach((fn) => fn())
}

function start() {
  if (started) return
  started = true
  unsubscribeStatus = window.api.updater.onStatus(publish)
  const poll = () => {
    window.api.updater.status().then(publish).catch(() => {
      // passive surface: no toast, no error state
    })
  }
  poll()
  pollTimer = setInterval(poll, POLL_INTERVAL_MS)
}

function stop() {
  started = false
  if (pollTimer != null) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  if (unsubscribeStatus) {
    unsubscribeStatus()
    unsubscribeStatus = null
  }
}

export function useAutoUpdater(): AutoUpdaterStatus | null {
  const [, forceRender] = useState(0)

  useEffect(() => {
    const fn = () => forceRender((n) => n + 1)
    subscribers.add(fn)
    activeConsumers += 1
    start()
    return () => {
      subscribers.delete(fn)
      activeConsumers -= 1
      if (activeConsumers <= 0) stop()
    }
  }, [])

  return snapshot
}

/** Test-only reset — clears the singleton so tests don't leak subscriptions/state. */
export function __resetAutoUpdaterForTests(): void {
  stop()
  snapshot = null
  activeConsumers = 0
  subscribers.clear()
}
