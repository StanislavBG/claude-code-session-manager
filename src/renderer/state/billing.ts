/**
 * Singleton billing-usage poller.
 *
 * Before: AppStatusBar and Overview each ran their own 60s timer hitting
 * `billing:fetch`, with divergent backoff and divergent toast policies.
 * Worst case the user saw the toast twice. Now a single tick lives here and
 * both consumers read from the same zustand snapshot.
 *
 * Backoff: every non-`ok` result (rate-limited, auth, transient, config) doubles
 * the poll delay from a 60s baseline up to a 300s cap, with +/-25% jitter so
 * concurrent app instances don't all retry in lockstep against an endpoint
 * that's already refusing. A `retryAfterMs` hint on the result floors the
 * delay. The next `ok` resets to the 60s baseline.
 *
 * Toast policy: surface the FIRST failure so the user learns why the 5h pill
 * is missing; subsequent failures stay silent to avoid spam (matches the
 * existing AppStatusBar pattern, applied once globally).
 */
import { create } from 'zustand'
import type { BillingData, BillingFetchResult } from '../../preload/api'
import { toast } from './toast'
import { withTimeout } from '../lib/withTimeout'
import { scheduleTimeoutGraceToast, type GraceWindowHandle } from '../lib/timeoutGraceToast'

const BILLING_BASE_DELAY_MS = 60_000
const BILLING_MAX_DELAY_MS = 300_000
const BILLING_BACKOFF_JITTER_FRACTION = 0.25
const BILLING_IPC_TIMEOUT_MS = 5_000

interface BillingState {
  data: BillingFetchResult | null
  refreshing: boolean
}

export const useBilling = create<BillingState>(() => ({ data: null, refreshing: false }))

let started = false
let timer: ReturnType<typeof setTimeout> | null = null
let backoffMs = BILLING_BASE_DELAY_MS
let toastedFailure = false
let pendingGraceHandle: GraceWindowHandle | null = null

/**
 * Computes the next poll delay from a fetch result and the previous
 * un-jittered backoff level. Exported for unit testing without driving the
 * store's own setTimeout chain.
 */
export function computeNextPollDelayMs(
  result: BillingFetchResult,
  previousBackoffMs: number,
): { delayMs: number; nextBackoffMs: number } {
  if (result.kind === 'ok') {
    return { delayMs: BILLING_BASE_DELAY_MS, nextBackoffMs: BILLING_BASE_DELAY_MS }
  }
  const nextBackoffMs = Math.min(previousBackoffMs * 2, BILLING_MAX_DELAY_MS)
  const jitter = nextBackoffMs * BILLING_BACKOFF_JITTER_FRACTION
  let delayMs = nextBackoffMs + (Math.random() * 2 - 1) * jitter
  const retryAfterMs = result.kind === 'meter_rate_limited' ? result.retryAfterMs : undefined
  if (typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > delayMs) {
    delayMs = retryAfterMs
  }
  return { delayMs, nextBackoffMs }
}

function fetchBilling(): Promise<BillingFetchResult> {
  return withTimeout(window.api.billing.fetch(), BILLING_IPC_TIMEOUT_MS, 'billing.fetch')
}

function applyResult(r: BillingFetchResult): void {
  useBilling.setState({ data: r, refreshing: false })
}

async function tick(): Promise<void> {
  useBilling.setState({ refreshing: true })
  let next = BILLING_BASE_DELAY_MS
  try {
    const r = await fetchBilling()
    if (pendingGraceHandle) {
      pendingGraceHandle.cancel()
      pendingGraceHandle = null
    }
    applyResult(r)
    const { delayMs, nextBackoffMs } = computeNextPollDelayMs(r, backoffMs)
    backoffMs = nextBackoffMs
    next = delayMs
  } catch (e) {
    backoffMs = BILLING_BASE_DELAY_MS
    useBilling.setState({ refreshing: false })
    const handle = scheduleTimeoutGraceToast({
      error: e,
      retry: fetchBilling,
      onRetrySuccess: (r) => {
        pendingGraceHandle = null
        applyResult(r)
      },
      onStillFailing: (message) => {
        pendingGraceHandle = null
        if (!toastedFailure) {
          toastedFailure = true
          toast.warn(`Billing usage fetch: ${message}`)
        }
      },
    })
    if (handle) {
      pendingGraceHandle = handle
    } else if (!toastedFailure) {
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
  if (pendingGraceHandle) {
    pendingGraceHandle.cancel()
    pendingGraceHandle = null
  }
  tick()
}
