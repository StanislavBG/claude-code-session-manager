/**
 * Cross-tab PRD deep link (PRD 750): TerminalChat's queue panel navigates to
 * Scheduler and selects a specific PRD slug there. A same-tick CustomEvent
 * alone isn't enough — SchedulerPrdsView unmounts when Scheduler isn't the
 * active nav (unlike TerminalStage, which stays mounted), so its listener
 * isn't registered yet the first time a user clicks a link before ever
 * visiting Scheduler this session; the event would be dropped silently.
 *
 * `setPendingPrdSlug` stores the slug AND fires the event: a listener that's
 * already mounted (Scheduler already open) gets it live; one that isn't yet
 * mounted picks it up via `takePendingPrdSlug()` in its mount effect instead.
 */

let pending: string | null = null

export function setPendingPrdSlug(slug: string): void {
  pending = slug
  window.dispatchEvent(new CustomEvent('sm:select-prd', { detail: slug }))
}

/** Reads and clears the pending slug — call once from the consumer's mount effect. */
export function takePendingPrdSlug(): string | null {
  const slug = pending
  pending = null
  return slug
}
