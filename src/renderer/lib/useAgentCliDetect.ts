/**
 * useAgentCliDetect(enabled) — shared renderer view of `window.api.agentCli.detect`.
 * Module-scope state (rows + in-flight call + listeners, same shape as useModelCatalog)
 * so every mounted consumer — New Session's AgentCliPicker, the Agent Library's
 * per-persona picker — sees the same installed-CLI rows, and one Re-check refreshes
 * them all. Each enabled mount issues one detect({}) unless a call is already in
 * flight (concurrent consumers share it); recheck() issues detect({ refresh: true }).
 * A failure (rejection or a missing preload method) sets rows to [] and toasts once
 * per failed call.
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react'
import type { AgentCliDetectRow } from '../../preload/api'
import { useToast } from '../state/toast'

interface Snapshot {
  rows: AgentCliDetectRow[] | null
  checking: boolean
}

let snapshot: Snapshot = { rows: null, checking: false }
let inFlight: Promise<void> | null = null
const listeners = new Set<() => void>()

function publish(next: Partial<Snapshot>): void {
  snapshot = { ...snapshot, ...next }
  listeners.forEach((l) => l())
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => { listeners.delete(l) }
}

function getSnapshot(): Snapshot {
  return snapshot
}

/** One detect call at a time; a caller arriving mid-flight shares the promise. */
function load(refresh: boolean): Promise<void> {
  if (inFlight) return inFlight
  const p: Promise<void> = Promise.resolve()
    .then(() => {
      const detect = window.api?.agentCli?.detect
      if (typeof detect !== 'function') throw new Error('agentCli.detect is unavailable — restart Session Manager')
      return detect(refresh ? { refresh: true } : {})
    })
    .then(
      (next) => {
        inFlight = null
        publish({ rows: Array.isArray(next) ? next : [], checking: false })
      },
      (e: unknown) => {
        inFlight = null
        publish({ rows: [], checking: false })
        useToast.getState().show('error', `Could not detect agent CLIs: ${e instanceof Error ? e.message : String(e)}`)
      }
    )
  inFlight = p
  publish({ checking: true })
  return p
}

export function useAgentCliDetect(enabled = true): {
  rows: AgentCliDetectRow[] | null
  checking: boolean
  recheck: () => Promise<void>
} {
  const { rows, checking } = useSyncExternalStore(subscribe, getSnapshot)

  useEffect(() => {
    if (enabled) void load(false)
  }, [enabled])

  const recheck = useCallback(() => load(true), [])

  return { rows, checking, recheck }
}
