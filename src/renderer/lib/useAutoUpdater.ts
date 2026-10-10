import { useEffect, useState } from 'react'
import type { AutoUpdaterStatus } from '../../preload/api'

/**
 * Module-level cached singleton (same shape as useUpdateStatus.ts): one
 * `window.api.updater.status()` fetch on first mount plus one `onStatus`
 * subscription shared by all consumers, torn down when the last unmounts.
 * The snapshot is replaced only when a new status arrives.
 */
let snapshot: AutoUpdaterStatus | null = null
const subscribers = new Set<() => void>()
let activeConsumers = 0
let unsubscribeStatus: (() => void) | null = null
let started = false

function publish(next: AutoUpdaterStatus) {
  snapshot = next
  subscribers.forEach((fn) => fn())
}

function start() {
  if (started) return
  started = true
  unsubscribeStatus = window.api.updater.onStatus(publish)
  window.api.updater.status().then(publish).catch(() => {
    // passive surface: no toast, no error state
  })
}

function stop() {
  started = false
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
