/**
 * ProjectFeedback — Project Home ▸ Feedback: one project's website feedback, beside the
 * project it belongs to. Two sections: Website widget (this cwd's relay boxes, managed by ProjectFeedbackWidgetCard) and Inbox
 * (the items those boxes delivered, read in full in ProjectFeedbackInbox).
 *
 * Data comes only from the `siteFeedback` store (`state/siteFeedback.ts`): widgets and items
 * load on mount and whenever `cwd` changes. A failed load surfaces through the toast channel;
 * the store also keeps it as the cwd's `error`.
 */

import { useEffect } from 'react'
import { selectSiteFeedback, useSiteFeedback } from '../../../state/siteFeedback'
import { toast } from '../../../state/toast'
import { ProjectFeedbackWidgetCard } from './ProjectFeedbackWidgetCard'
import { ProjectFeedbackInbox } from './ProjectFeedbackInbox'
import type { SiteFeedbackResult } from '../../../../preload/api'

function toastFailure<T>(r: SiteFeedbackResult<T>): void {
  if (!r.ok) toast.error(`Feedback: ${r.message || r.error}`)
}

export function ProjectFeedback({ cwd }: { cwd: string }) {
  const state = useSiteFeedback(selectSiteFeedback(cwd))
  const loadWidgets = useSiteFeedback((s) => s.loadWidgets)
  const loadItems = useSiteFeedback((s) => s.loadItems)

  useEffect(() => {
    void loadWidgets(cwd).then(toastFailure)
    void loadItems(cwd).then(toastFailure)
  }, [cwd, loadWidgets, loadItems])

  const openCount = state.items.filter((it) => it.status === 'open').length

  return (
    <div data-testid="project-home-section" data-tab="feedback" className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto">
      <section data-testid="project-feedback-widgets" className="flex flex-col gap-2">
        <h2 className="text-[15px] font-semibold tracking-[-0.01em]">Website widget</h2>
        <p data-testid="project-feedback-widgets-meta" className="text-[12.5px] text-fg-faint">
          {state.widgetsLoading
            ? 'Loading widgets…'
            : state.widgets.length === 0
              ? 'No widget for this project yet'
              : `${state.widgets.length} widget${state.widgets.length === 1 ? '' : 's'}`}
          {state.relayError && state.relayError.error !== 'not_linked'
            ? ` · relay unreachable: ${state.relayError.message || state.relayError.error}`
            : ''}
        </p>
        <ProjectFeedbackWidgetCard cwd={cwd} />
      </section>
      <section data-testid="project-feedback-inbox" className="flex flex-col gap-2">
        <h2 className="text-[15px] font-semibold tracking-[-0.01em]">Inbox</h2>
        <p data-testid="project-feedback-inbox-meta" className="text-[12.5px] text-fg-faint">
          {state.itemsLoading
            ? 'Loading inbox…'
            : state.items.length === 0
              ? 'No feedback yet'
              : `${state.items.length} item${state.items.length === 1 ? '' : 's'} · ${openCount} open`}
        </p>
        <ProjectFeedbackInbox cwd={cwd} />
      </section>
    </div>
  )
}
