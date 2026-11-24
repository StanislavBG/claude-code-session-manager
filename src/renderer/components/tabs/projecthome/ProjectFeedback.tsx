/**
 * ProjectFeedback — Project Home ▸ Feedback: one project's website feedback, beside the
 * project it belongs to. Two sections: Website widget (this cwd's relay boxes, managed by ProjectFeedbackWidgetCard) and Inbox
 * (the items those boxes delivered, read in full in ProjectFeedbackInbox).
 *
 * Site data comes from the `siteFeedback` store (`state/siteFeedback.ts`): widgets and items
 * load on mount and whenever `cwd` changes. A failed load surfaces through the toast channel;
 * the store also keeps it as the cwd's `error`.
 *
 * When owner mode is on and `cwd` is the owner's project (`customerFeedback` store `ownerInfo`),
 * a third section, App feedback, renders CustomerFeedbackInbox — the app-feedback items customers
 * sent from Session Manager — so the owner has one inbox screen. The two stores are composed
 * here, per component; neither subscribes to the other.
 */

import { useEffect } from 'react'
import { selectSiteFeedback, useSiteFeedback } from '../../../state/siteFeedback'
import { useCustomerFeedback } from '../../../state/customerFeedback'
import { CustomerFeedbackInbox } from '../../customerFeedback/CustomerFeedbackInbox'
import { toast } from '../../../state/toast'
import { ProjectFeedbackWidgetCard } from './ProjectFeedbackWidgetCard'
import { ProjectFeedbackInbox } from './ProjectFeedbackInbox'
import type { SiteFeedbackResult } from '../../../../preload/api'

function toastFailure<T>(r: SiteFeedbackResult<T>): void {
  if (!r.ok) toast.error(`Feedback: ${r.message || r.error}`)
}

const trimSlash = (p: string): string => p.replace(/\/+$/, '') || '/'

/** True when `cwd` is the owner's project, so its Feedback tab also shows the app inbox. */
export function isOwnerProject(cwd: string, projectCwd: string | null | undefined): boolean {
  return !!projectCwd && trimSlash(cwd) === trimSlash(projectCwd)
}

// One-shot request for Project Home to open on its Feedback tab (CustomerFeedbackPanel's link).
// The flag covers a Project Home that is not mounted yet; the event covers one that already is.
export const PROJECT_HOME_FEEDBACK_EVENT = 'sm:project-home-feedback'
let pendingFeedbackTab = false

export function requestProjectHomeFeedback(): void {
  pendingFeedbackTab = true
  window.dispatchEvent(new CustomEvent(PROJECT_HOME_FEEDBACK_EVENT))
}

export function consumeProjectHomeFeedbackRequest(): boolean {
  const was = pendingFeedbackTab
  pendingFeedbackTab = false
  return was
}

export function ProjectFeedback({ cwd }: { cwd: string }) {
  const state = useSiteFeedback(selectSiteFeedback(cwd))
  const loadWidgets = useSiteFeedback((s) => s.loadWidgets)
  const loadItems = useSiteFeedback((s) => s.loadItems)
  const ownerInfoLoaded = useCustomerFeedback((s) => s.ownerInfo !== null)
  const loadOwnerInfo = useCustomerFeedback((s) => s.loadOwnerInfo)
  const showAppInbox = useCustomerFeedback(
    (s) => s.ownerInfo?.ownerMode === true && isOwnerProject(cwd, s.ownerInfo.projectCwd),
  )
  const appCount = useCustomerFeedback((s) => s.inbox.length)

  useEffect(() => {
    void loadWidgets(cwd).then(toastFailure)
    void loadItems(cwd).then(toastFailure)
  }, [cwd, loadWidgets, loadItems])

  useEffect(() => {
    if (!ownerInfoLoaded) void loadOwnerInfo()
  }, [ownerInfoLoaded, loadOwnerInfo])

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
      {showAppInbox && (
        <section data-testid="project-feedback-app-inbox" className="flex flex-col gap-2">
          <h2 className="flex items-center gap-2 text-[15px] font-semibold tracking-[-0.01em]">
            App feedback
            <span
              data-testid="project-feedback-source-chip"
              className="rounded border border-line px-1.5 py-0.5 font-mono text-[10.5px] font-semibold uppercase tracking-[0.05em] text-fg-dim"
            >
              App
            </span>
          </h2>
          <p data-testid="project-feedback-app-inbox-meta" className="text-[12.5px] text-fg-faint">
            Sent from Session Manager&apos;s Feedback panel · {appCount} item{appCount === 1 ? '' : 's'}
          </p>
          <CustomerFeedbackInbox embedded />
        </section>
      )}
    </div>
  )
}
