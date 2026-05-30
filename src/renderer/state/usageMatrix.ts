/**
 * Singleton AgOps usage-matrix store.
 *
 * Mirrors `state/billing.ts`'s shape but driven by a main-process push (the
 * `usage:matrix:tick` event), with a single snapshot() fetch on first
 * subscription to bootstrap. The main aggregator only broadcasts when
 * something changed, so there's no idle traffic on a quiet machine.
 */
import { create } from 'zustand'
import { useEffect } from 'react'
import type { UsageMatrixSnapshot } from '../../preload/api'

interface UsageMatrixState {
  snapshot: UsageMatrixSnapshot | null
}

export const useUsageMatrix = create<UsageMatrixState>(() => ({ snapshot: null }))

let started = false
let off: (() => void) | null = null

/** Idempotent. Subscribes to ticks + pulls an initial snapshot. */
export function startUsageMatrix(): void {
  if (started) return
  started = true
  off = window.api.usageMatrix.onTick((snap) => {
    useUsageMatrix.setState({ snapshot: snap })
  })
  window.api.usageMatrix
    .snapshot()
    .then((snap) => useUsageMatrix.setState({ snapshot: snap }))
    .catch(() => {
      // Non-fatal — ticks will populate on the next event.
    })
}

export function stopUsageMatrix(): void {
  off?.()
  off = null
  started = false
}

/** Convenience hook — starts on first mount, never tears down (singleton). */
export function useStartUsageMatrix(): void {
  useEffect(() => {
    startUsageMatrix()
  }, [])
}
