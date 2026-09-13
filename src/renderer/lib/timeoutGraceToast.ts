/**
 * Shared policy for a `withTimeout` TIMEOUT rejection on a boot-time poller
 * (schedule/billing/teams state hydrate): a slow-boot main process usually
 * recovers within seconds on its own (a push subscription or the poller's
 * own next tick), so toasting the instant the 5s IPC deadline fires is a
 * false alarm for a condition that's about to self-heal. A NON-timeout
 * rejection is not this module's concern — callers must keep toasting that
 * immediately, unconditionally.
 *
 * `scheduleTimeoutGraceToast` only fires for a `TimeoutError` (checked via
 * `isTimeoutError`, not string-matching). It waits `graceMs` (>= 30s) for
 * something else to supersede it — the caller cancels the returned handle as
 * soon as a live snapshot arrives some other way. If nothing does, it
 * re-attempts the IPC call once; only if THAT also fails does it toast, with
 * a message naming the IPC label and that the main process was busy.
 */
import { isTimeoutError, type TimeoutError } from './withTimeout'

export const TIMEOUT_GRACE_MS = 30_000

export interface GraceWindowHandle {
  /** Cancel the pending grace timer/retry — call when a live update supersedes it. */
  cancel: () => void
}

export interface TimeoutGraceToastOptions<T> {
  /** The value caught from the initial `withTimeout(...)` rejection. */
  error: unknown
  /** Re-issues the same timed-out IPC call. Only invoked once, after the grace window elapses. */
  retry: () => Promise<T>
  /** Called with the retry's result if it succeeds — wire this to the store's normal success path. */
  onRetrySuccess: (value: T) => void
  /** Called if the grace window elapses AND the retry also fails, with the actionable message. */
  onStillFailing: (message: string) => void
  /** Minimum 30_000ms per the policy; defaults to TIMEOUT_GRACE_MS. */
  graceMs?: number
}

function actionableMessage(err: TimeoutError): string {
  return `${err.label} timed out — the main process was busy, and a retry also failed.`
}

/**
 * Returns `null` for a non-timeout error (nothing scheduled — caller keeps
 * its existing immediate-toast path). Returns a handle for a timeout error;
 * `.cancel()` it as soon as a live update arrives, or on teardown.
 */
export function scheduleTimeoutGraceToast<T>(
  opts: TimeoutGraceToastOptions<T>,
): GraceWindowHandle | null {
  if (!isTimeoutError(opts.error)) return null
  const err = opts.error
  let settled = false

  const timer = setTimeout(
    () => {
      if (settled) return
      opts.retry().then(
        (value) => {
          if (settled) return
          settled = true
          opts.onRetrySuccess(value)
        },
        () => {
          if (settled) return
          settled = true
          opts.onStillFailing(actionableMessage(err))
        },
      )
    },
    Math.max(opts.graceMs ?? TIMEOUT_GRACE_MS, TIMEOUT_GRACE_MS),
  )

  return {
    cancel: () => {
      settled = true
      clearTimeout(timer)
    },
  }
}
