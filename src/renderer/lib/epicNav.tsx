import { setPendingPrdSlug } from './prdDeepLink'
import { setPendingPromptSessionId } from './promptSessionDeepLink'
import type { TicketTag } from './ticketDisplay'

/**
 * Cross-tab navigation helpers + the composer tag selector, formerly defined
 * in the retired TerminalChat.tsx (PRD 750/813). Extracted so EpicDetail and
 * other Epic surfaces keep exactly one way to jump into Scheduler/a
 * PromptSession's own conversation, and exactly one Feature/Bug/Discussion
 * picker, rather than each reimplementing them.
 */

// Navigates to Scheduler and selects a PRD there, reusing AlmanacFooter's
// pill-click plumbing (dispatch a CustomEvent, App.tsx's window listener
// routes it) rather than inventing a new cross-tab routing mechanism. The
// slug itself goes through prdDeepLink.ts (not a second bare CustomEvent)
// since SchedulerPrdsView may not be mounted yet to receive it.
export function openPrdSlug(slug: string): void {
  setPendingPrdSlug(slug)
  window.dispatchEvent(new CustomEvent('sm:navigate', { detail: 'scheduler' }))
}

// Navigates to Projects ('terminal' nav) and opens the PromptSession a
// dev-work ticket dispatched to (PRD 813's ticket.promptSessionId) — the
// SAME open mechanism SchedulePanel's job-row chip and ProjectsLanding's own
// deep-link listener use, so there is only ever one way to jump into a
// PromptSessionConversation from elsewhere in the app.
export function openPromptSession(promptSessionId: string): void {
  setPendingPromptSessionId(promptSessionId)
  window.dispatchEvent(new CustomEvent('sm:navigate', { detail: 'terminal' }))
}

// Feature/Bug/Discussion composer tag selector.
export function TagSelector({
  value,
  onChange,
  disabled,
}: {
  value: TicketTag
  onChange: (tag: TicketTag) => void
  disabled?: boolean
}) {
  return (
    <div className="flex items-center gap-0.5 rounded-md border border-line p-0.5" role="group" aria-label="Epic tag">
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange('feature')}
        aria-pressed={value === 'feature'}
        className={`rounded px-2 py-1.5 text-xs font-medium disabled:opacity-40 ${
          value === 'feature' ? 'bg-sage/25 text-sage' : 'text-fg-faint hover:text-fg-dim'
        }`}
      >
        Feature
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange('bug')}
        aria-pressed={value === 'bug'}
        className={`rounded px-2 py-1.5 text-xs font-medium disabled:opacity-40 ${
          value === 'bug' ? 'bg-accent/15 text-accent' : 'text-fg-faint hover:text-fg-dim'
        }`}
      >
        Bug
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange('discussion')}
        aria-pressed={value === 'discussion'}
        title="Research conversation — stays interactive, never dispatched to /develop"
        className={`rounded px-2 py-1.5 text-xs font-medium disabled:opacity-40 ${
          value === 'discussion' ? 'bg-butter/25 text-fg-dim' : 'text-fg-faint hover:text-fg-dim'
        }`}
      >
        Discussion
      </button>
    </div>
  )
}
