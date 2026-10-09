import { toast } from '../state/toast'

/**
 * Shared "Run now" action for the scheduler. Every caller (Home, Scheduler
 * PRDs view, command palette) goes through this so the IPC is invoked once
 * and a failure is always surfaced as a toast instead of an unhandled
 * rejection. Never rejects; resolves `true` on success, `false` on failure.
 */
export async function runSchedulerNow(): Promise<boolean> {
  try {
    await window.api.schedule.runNow()
    return true
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    toast.error('Run now failed: ' + message)
    return false
  }
}
