/**
 * Renderer-side wrapper for classifying a queued PromptTicket (chat.ts's
 * per-tab queue, PRD 748) as 'inline' (run through chatRunner) or 'develop'
 * (dispatch to /develop for PRD decomposition).
 *
 * The actual judgment is a single bounded `claude -p` call made in the main
 * process (src/main/lib/classifyPromptTicket.cjs) — deliberately NOT routed
 * through the scheduler, since classification decides IF a PRD is needed at
 * all; scheduling that decision itself would be circular. This module is
 * just the IPC round-trip plus a fail-safe default so a missing/unavailable
 * API surface (e.g. non-Electron test environments) never wedges the queue.
 */

export type ClassificationVerdict = 'inline' | 'develop'

export async function classifyPromptTicket(text: string): Promise<ClassificationVerdict> {
  if (typeof window === 'undefined' || typeof window.api?.chat?.classifyTicket !== 'function') {
    return 'inline'
  }
  try {
    const verdict = await window.api.chat.classifyTicket({ text })
    return verdict === 'develop' ? 'develop' : 'inline'
  } catch {
    return 'inline'
  }
}
