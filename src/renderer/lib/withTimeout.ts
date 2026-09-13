/**
 * Rejection shape produced by `withTimeout` specifically — as opposed to a
 * rejection from `p` itself. Tagged (rather than string-matched) so callers
 * can distinguish "IPC call timed out" from a real error without parsing
 * `.message`.
 */
export class TimeoutError extends Error {
  readonly label: string
  readonly ms: number

  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`)
    this.name = 'TimeoutError'
    this.label = label
    this.ms = ms
  }
}

export function isTimeoutError(e: unknown): e is TimeoutError {
  return e instanceof TimeoutError
}

/**
 * Wrap an IPC promise with a hard deadline. If `p` does not settle within
 * `ms`, the returned promise rejects with a `TimeoutError`.
 *
 * Existed because the boot-time pollers (billing/teams/schedule) each await
 * an IPC call with no timeout — if the main process hangs (slow Mac volume,
 * stuck chokidar handshake, blocked claude-bin resolve), the renderer sits
 * forever with no diagnostic. With this, a hang surfaces as a labeled toast
 * via the existing catch block, so users see WHAT hung instead of a frozen
 * window.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new TimeoutError(label, ms)), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}
