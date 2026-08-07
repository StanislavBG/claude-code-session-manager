import { useEffect, useState } from 'react'
import { usePanelFocus } from './panelFocus'

export type SlotSnapshot = {
  total: number
  inUse: number
  holders: { owner: string; at: string }[]
  min: number
  max: number
  default: number
  envOverride: boolean
}

const POLL_INTERVAL_MS = 5000

/**
 * Module-level cached singleton, mirroring useKnownProjects.ts's shape: one
 * shared `window.api.schedule.sessionSlots()` poll regardless of how many
 * components consume it. Before this, Home.tsx's Hero + ActiveSessionsCard
 * and SessionManagerConfig.tsx each ran their own independent 5s interval —
 * three IPC calls a tick for the same machine-wide pool snapshot, all three
 * kept alive forever since dockview never unmounts a screen it has opened.
 */
let snapshot: SlotSnapshot | null = null
const subscribers = new Set<() => void>()
let activeConsumers = 0
let pollTimer: ReturnType<typeof setInterval> | null = null

function notify() {
  subscribers.forEach((fn) => fn())
}

async function pollOnce(): Promise<void> {
  try {
    snapshot = await window.api.schedule.sessionSlots()
    notify()
  } catch {
    // diagnostic surface only
  }
}

/**
 * Idempotent: a second/third consumer registering while the poller is
 * already running is a no-op, so N mounted-and-focused consumers still
 * issue exactly one IPC call per interval. Starting from a stopped state
 * fires an immediate poll rather than waiting a full interval — this is
 * also what makes a consumer regaining focus refresh right away.
 */
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

/**
 * Shared session-slots snapshot, polled at most once per interval across
 * every consumer. Polling runs only while at least one consumer is mounted
 * in a focused panel (per usePanelFocus); the last focused consumer going
 * away (unmount or losing focus) stops the poller entirely.
 */
export function useSessionSlots(panelId?: string): SlotSnapshot | null {
  const focused = usePanelFocus(panelId)
  const [, forceRender] = useState(0)

  useEffect(() => {
    const fn = () => forceRender((n) => n + 1)
    subscribers.add(fn)
    return () => { subscribers.delete(fn) }
  }, [])

  useEffect(() => {
    if (!focused) return
    activeConsumers += 1
    startPolling()
    return () => {
      activeConsumers -= 1
      if (activeConsumers <= 0) stopPolling()
    }
  }, [focused])

  return snapshot
}

/** Test-only reset — clears the singleton so tests don't leak timers/state across files. */
export function __resetSessionSlotsForTests(): void {
  stopPolling()
  snapshot = null
  activeConsumers = 0
  subscribers.clear()
}
