import type { ScheduleLastTick } from '../../../preload/api'

/** Why the queue is running narrower than the pool; null when idle or unconstrained. */
export function queueConstraintLabel(
  lastTick: ScheduleLastTick | null | undefined,
  pending: number,
  total: number,
): string | null {
  if (!lastTick || lastTick.fired) return null
  if (pending === 0) return null
  switch (lastTick.reason) {
    case 'memory-deferred':
      return `memory gate: ${lastTick.availableMb} MB free, need ${lastTick.threshold} MB`
    case 'load-deferred':
      return lastTick.detail ?? 'CPU load gate holding'
    case 'slots-exhausted':
      return `all ${total} slots busy — ${lastTick.deferredCount ?? pending} pending`
    case 'usage-meter-degraded':
      return lastTick.detail ?? 'usage meter down: running capped'
    case 'held': {
      const n = lastTick.holds?.length ?? 0
      return n > 0
        ? `${n} pending held behind dependencies`
        : (lastTick.detail ?? 'held')
    }
    case 'paused':
      return 'scheduler paused'
    default:
      return null
  }
}
