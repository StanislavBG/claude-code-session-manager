/**
 * Singleton billing-usage poller.
 *
 * Before: AppStatusBar and Overview each ran their own 60s timer hitting
 * `billing:fetch`, with divergent backoff and divergent toast policies.
 * Worst case the user saw the toast twice. Now a single tick lives here and
 * both consumers read from the same zustand snapshot.
 *
 * Backoff comes from Overview's smarter policy: on a `transient` (network
 * blip / cache miss) result, retry in 5s then 30s; on `auth` failure (token
 * expired or absent), back off to 30s; otherwise the normal 60s.
 *
 * Toast policy: surface the FIRST failure so the user learns why the 5h pill
 * is missing; subsequent failures stay silent to avoid spam (matches the
 * existing AppStatusBar pattern, applied once globally).
 */
import { create } from 'zustand'
import type { BillingData, BillingFetchResult } from '../../preload/api'
import { toast } from './toast'
import { withTimeout } from '../lib/withTimeout'

const BILLING_REFRESH_MS = 60_000
const BILLING_IPC_TIMEOUT_MS = 5_000

interface BillingState {
  data: BillingFetchResult | null
  refreshing: boolean
}

export const useBilling = create<BillingState>(() => ({ data: null, refreshing: false }))

let started = false
let timer: ReturnType<typeof setTimeout> | null = null
let lastKind: BillingFetchResult['kind'] | null = null
let toastedFailure = false

async function tick(): Promise<void> {
  useBilling.setState({ refreshing: true })
  let next = BILLING_REFRESH_MS
  try {
    const r = await withTimeout(window.api.billing.fetch(), BILLING_IPC_TIMEOUT_MS, 'billing.fetch')
    useBilling.setState({ data: r, refreshing: false })
    if (r.kind === 'transient') {
      next = lastKind === 'transient' ? 30_000 : 5_000
    } else if (r.kind === 'auth' || r.kind === 'meter_rate_limited') {
      next = 30_000
    }
    lastKind = r.kind
  } catch (e) {
    useBilling.setState({ refreshing: false })
    if (!toastedFailure) {
      toastedFailure = true
      const msg = e instanceof Error ? e.message : String(e)
      toast.warn(`Billing usage fetch failed: ${msg}`)
    }
  }
  timer = setTimeout(tick, next)
}

/** Call once at app mount. Idempotent. */
export function startBillingPolling(): void {
  if (started) return
  started = true
  tick()
}

/** Unwrap a BillingFetchResult to its data payload, or null if unavailable. */
export function getBillingData(r: BillingFetchResult | null): BillingData | null {
  if (!r) return null
  if (r.kind === 'ok' || r.kind === 'ok-stale') return r.data
  if ((r.kind === 'auth' || r.kind === 'meter_rate_limited') && r.cached) return r.cached
  return null
}

/** Five-hour utilization as a 0–100 percentage, 0 if unavailable. */
export function getFiveHourUtil(r: BillingFetchResult | null): number {
  return getBillingData(r)?.usage.five_hour?.utilization ?? 0
}

/** Force an immediate refresh, resetting the timer. */
export function refreshBilling(): void {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
  tick()
}
