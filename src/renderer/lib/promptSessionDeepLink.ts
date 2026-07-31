/**
 * Cross-tab PromptSession deep link: a Scheduler job row that traces back to
 * the PromptSession which authored its PRD (via ScheduleJob.sourceTabId —
 * set when the PRD was created from PromptSessionConversation, whose chat key
 * IS the PromptSession's own id) navigates to the "Projects" nav ('terminal'
 * NavKey) and opens that specific PromptSession there.
 *
 * Mirrors prdDeepLink.ts's pending + live-event pattern: ProjectsLanding is
 * only mounted while no SessionTab is active, so a listener registered after
 * the click would miss a same-tick CustomEvent — `takePendingPromptSessionId`
 * covers that case from the consumer's mount effect.
 */

let pending: string | null = null

export function setPendingPromptSessionId(id: string): void {
  pending = id
  window.dispatchEvent(new CustomEvent('sm:select-prompt-session', { detail: id }))
}

/** Reads and clears the pending id — call once from the consumer's mount effect. */
export function takePendingPromptSessionId(): string | null {
  const id = pending
  pending = null
  return id
}
