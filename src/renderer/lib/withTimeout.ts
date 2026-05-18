/**
 * Wrap an IPC promise with a hard deadline. If `p` does not settle within
 * `ms`, the returned promise rejects with `<label> timed out after <ms>ms`.
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
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
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
