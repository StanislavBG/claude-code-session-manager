/**
 * Lightweight TTL cache around `window.api.schedule.lintQueue()`.
 *
 * Before: SchedulePanel's auto-run lint + SchedulerPrdsView's on-open lint
 * both hit the same IPC within seconds of each other, doubling the disk
 * walk. This wraps the call with a 5s memo so back-to-back consumers share
 * a result. Force-refresh by passing { fresh: true }.
 */
import type { LintQueueResult } from '../../preload/api'

const TTL_MS = 5_000

let cached: { result: LintQueueResult; at: number } | null = null
let inFlight: Promise<LintQueueResult> | null = null

export async function getLintQueueCached(opts?: { fresh?: boolean }): Promise<LintQueueResult> {
  const now = Date.now()
  if (!opts?.fresh && cached && now - cached.at < TTL_MS) {
    return cached.result
  }
  if (inFlight) return inFlight
  inFlight = (async () => {
    try {
      const result = await window.api.schedule.lintQueue()
      cached = { result, at: Date.now() }
      return result
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}
