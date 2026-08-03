/**
 * Cross-tab Agent Library deep link, mirroring prdDeepLink.ts: EpicDetail's
 * read-only Agent+model chip navigates to Agent Library and selects a
 * specific persona there. A same-tick CustomEvent alone isn't enough — like
 * SchedulerPrdsView, AgentLibrary unmounts when it isn't the active nav
 * screen, so its listener isn't registered yet the first time a user clicks
 * the chip before ever visiting Agent Library this session; the event would
 * be dropped silently.
 *
 * `setPendingPersonaName` stores the name AND fires the event: a listener
 * that's already mounted (Agent Library already open) gets it live; one that
 * isn't yet mounted picks it up via `takePendingPersonaName()` in its mount
 * effect instead.
 */

let pending: string | null = null

export function setPendingPersonaName(name: string): void {
  pending = name
  window.dispatchEvent(new CustomEvent('sm:select-persona', { detail: name }))
}

/** Reads and clears the pending persona name — call once from the consumer's mount effect. */
export function takePendingPersonaName(): string | null {
  const name = pending
  pending = null
  return name
}
