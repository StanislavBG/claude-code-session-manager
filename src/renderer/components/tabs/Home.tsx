/**
 * Home — the "control room" Almanac landing page (design: Home Screen A).
 * Replaces Overview as the `overview` route.
 *
 * Sections (top to bottom):
 *   1. Hero — "This machine · N projects" kicker + live session-slot greeting,
 *      with the open "needs you" count as a jump-link, plus Refresh (with its
 *      last-refresh stamp) and All history.
 *   2. Grid — 5h billing window card + Projects card + Queued (pending
 *      scheduler jobs) card.
 *   3. Needs you — real signals only (see lib/homeNeedsYou.ts): a `proposed`
 *      Epic awaiting approval, a chat stopped on `needs-input`, or a
 *      scheduler job the queue itself flagged `failed`/`needs_review`. Each
 *      row expands inline: answers to a question (tool confirmations, outside
 *      apps' questions) or a link to the page that owns the action.
 *   4. Active sessions — the machine session-slot pool's ≤3 holders, joined
 *      against running scheduler jobs / chat runs for context.
 *   5. Recent sessions — pulls `.claude/projects/*.jsonl` (same source as the
 *      History tab) and shows the 5 most-recent.
 *
 * View-only (owner 2026-11-22, decided 2026-11-23 in Epic 9f2682ff): the page
 * reports the situation and carries no controls that belong on other pages —
 * New Epic lives in the Sessions view, the MCP tool catalog and Epic tag
 * reference are not shown here. The slot cap is edited solely by the
 * Scheduler's concurrency stepper; terminal appearance lives on App settings;
 * Data Model has its own nav row.
 *
 * Data sources are all existing zustand stores; nothing new on the backend.
 *
 * Refresh model: this panel stays mounted for the app's life, so mount-time
 * loads alone would show launch-time data. `useDashboardRefresh`
 * (src/renderer/lib/useDashboardRefresh.ts) re-reads every card's source —
 * known projects, Epics per project, the scheduler queue, usage, and the
 * outside needs-you items — each time the page is opened (at most every 30 s),
 * and immediately on the Hero's Refresh button. It is the page's only
 * Epic-hydrate path; the Hero stamps the last refresh time or the failed sources.
 */

import { memo, useMemo, useEffect, useState, type ReactNode } from 'react'
import type { NavKey } from '../../lib/navKey'
import { useBilling, getBillingData, refreshBilling } from '../../state/billing'
import { useScheduleState } from '../../state/scheduleState'
import { useSessions } from '../../state/sessions'
import { useLayout } from '../../state/layout'
import { usePromptSessions } from '../../state/promptSessions'
import { useChatSignals } from '../../lib/useChatSignals'
import { shellQuote } from '../../lib/presets'
import { candidatePath, useKnownProjects, type RecentRow } from '../../lib/useKnownProjects'
import { buildHomeProjectRows, type HomeProjectRow } from '../../lib/homeProjectRows'
import { projectNameFromCwd } from '../../lib/knownProjectAggregate'
import { activeSessionRows, recentSessionEpicTitle, type ActiveSessionRow } from '../../lib/homeSessionRows'
import { buildNeedsYouRows, type NeedsYouRow } from '../../lib/homeNeedsYou'
import { useOutsideNeedsYou } from '../../lib/useOutsideNeedsYou'
import { usePanelFocus } from '../../lib/panelFocus'
import { useDashboardRefresh } from '../../lib/useDashboardRefresh'
import { setPendingPromptSessionId } from '../../lib/promptSessionDeepLink'
import { projectColorFor } from '../../lib/projectColor'
import { openProjectTab } from '../../lib/homeOpenProject'
import { useSessionSlots } from '../../lib/useSessionSlots'
import { usePagedList } from '../../lib/usePagedList'
import { Pager } from '../ui/Pager'
import { scrollWithin } from '../../lib/scrollWithin'
import { UsageMeters } from './home/UsageMeters'
import { UsageCapControl } from './home/UsageCapControl'
import { HomeSessionDrawer, type DrawerKeyVal, type DrawerTailLine } from './home/HomeSessionDrawer'
import { QueuedJobPopover, type QueuedJobPopoverJob } from './home/QueuedJobPopover'
import { BillingStatusOverlay } from '../ui/BillingStatusBanner'
import { toast } from '../../state/toast'
import { formatAgo } from '../../lib/formatTime'
import type { ScheduleJob } from '../../../preload/api'
import { queueConstraintLabel } from './queueConstraintLabel'

const EMPTY_JOBS: ScheduleJob[] = []


interface HomeProps {
  onNavigate?: (k: NavKey) => void
}

function greetingForHour(h: number): string {
  if (h < 5)  return 'Up late'
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  return 'Good evening'
}

function HomeComponent({ onNavigate }: HomeProps) {
  const { rows: needsRows, answer: answerOutside, reloadOutside } = useNeedsYouRows()
  const focused = usePanelFocus()
  const { projects } = useKnownProjects()
  // Unique real cwds, identity-stable on their joined key, so the hook's
  // per-cwd hydrate only re-runs when the set of projects actually changes.
  const cwdsKey = useMemo(() => [...new Set(projects.map((p) => p.cwd))].join('\n'), [projects])
  const cwds = useMemo(() => (cwdsKey ? cwdsKey.split('\n') : []), [cwdsKey])
  const { refresh, refreshing, lastRefreshedAt, failedSources } = useDashboardRefresh({ focused, cwds, extra: reloadOutside })

  // Recomputed from the current hour on every refresh, not frozen at mount.
  const greeting = useMemo(() => {
    void lastRefreshedAt
    return greetingForHour(new Date().getHours())
  }, [lastRefreshedAt])

  const projectRows = useHomeProjectRows()

  return (
    <div className="h-full overflow-auto" data-home-scroller>
      <div className="mx-auto max-w-[1400px] px-[34px] py-[26px] text-fg">
        <HomeHero
          greeting={greeting}
          projectCount={projectRows.length}
          needsCount={needsRows.length}
          onNavigate={onNavigate}
          onRefresh={refresh}
          refreshing={refreshing}
          lastRefreshedAt={lastRefreshedAt}
          failedSources={failedSources}
          focused={focused}
        />
        <div
          data-testid="home-panel-grid"
          className="grid gap-[18px] mb-7"
          style={{ gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gridTemplateRows: 'repeat(2, minmax(0, 300px))' }}
        >
          <div className="bg-bg-hi border border-line rounded-[14px] px-4 py-[14px] min-h-0 overflow-auto">
            <BillingCard />
          </div>
          <ProjectsCard projectRows={projectRows} />
          <QueuedCard onNavigate={onNavigate} />
          <NeedsYouSection rows={needsRows} onNavigate={onNavigate} onAnswer={answerOutside} />
          <ActiveSessionsCard onNavigate={onNavigate} />
          <RecentSessionsCard onNavigate={onNavigate} />
        </div>
      </div>
    </div>
  )
}

/**
 * Memoized: Home only reads ScreenRenderCtx callbacks as props (stable
 * identities since perf-workbench-ctx-identity landed) — its own data comes
 * from store hooks inside the component, so a parent re-render that changes
 * nothing for Home should cost nothing.
 */
export const Home = memo(HomeComponent)

// ────────────────────────────────────────────────────────────────────
// Home project rows — ProjectsCard's rows and the hero's project count, so
// "known projects" is computed once (useKnownProjects' unique-per-cwd
// aggregates + running chats + Epic sessions, via buildHomeProjectRows).
// One row per real working directory — see lib/knownProjectAggregate.ts.
// ────────────────────────────────────────────────────────────────────
function useHomeProjectRows(): HomeProjectRow[] {
  const { projects } = useKnownProjects()
  const chats = useChatSignals()
  const sessions = usePromptSessions((s) => s.sessions)
  return useMemo(
    () => buildHomeProjectRows(projects, chats, sessions),
    [projects, chats, sessions],
  )
}

// ────────────────────────────────────────────────────────────────────
// Needs you — real signals only: a `proposed` Epic (the human gate that
// replaced the feedback folder), a chat mid-run and asking a question
// (`needs-input`), or a scheduler job the queue itself flagged `failed` /
// `needs_review`. See lib/homeNeedsYou.ts for the join.
// ────────────────────────────────────────────────────────────────────
type OutsideAnswer = ReturnType<typeof useOutsideNeedsYou>['answer']

function useNeedsYouRows(): { rows: NeedsYouRow[]; answer: OutsideAnswer; reloadOutside: () => void } {
  const sessions = usePromptSessions((s) => s.sessions)
  const chats = useChatSignals()
  const jobs = useScheduleState((s) => s.snapshot?.jobs) ?? EMPTY_JOBS
  const { items: outside, answer, reload: reloadOutside } = useOutsideNeedsYou()
  const rows = useMemo(() => {
    const proposed: Record<string, { id: string; cwd: string; goalText: string; tag?: string }> = {}
    for (const id of Object.keys(sessions)) {
      const s = sessions[id]
      if (s.status === 'proposed') proposed[id] = { id, cwd: s.cwd, goalText: s.goalText, tag: s.tag }
    }
    return buildNeedsYouRows(proposed, chats, jobs, Date.now(), outside)
  }, [sessions, chats, jobs, outside])
  return { rows, answer, reloadOutside }
}

/** Optional — with no `onRefresh`, Hero renders neither the button nor the stamp. */
interface HeroRefreshProps {
  /** useDashboardRefresh().refresh */
  onRefresh?: () => void
  refreshing?: boolean
  lastRefreshedAt?: number | null
  failedSources?: string[]
  /** Panel focus — the stamp only ticks while the page is visible. */
  focused?: boolean
}

const REFRESH_STAMP_TICK_MS = 15_000

// ────────────────────────────────────────────────────────────────────
// Hero — "This machine" kicker + greeting with live session-slot count,
// Refresh + stamp, and All history. Exported for Home.refresh.test.tsx.
// ────────────────────────────────────────────────────────────────────
export function HomeHero({
  greeting,
  projectCount,
  needsCount,
  onNavigate,
  onRefresh,
  refreshing = false,
  lastRefreshedAt = null,
  failedSources,
  focused = true,
}: {
  greeting: string
  projectCount: number
  needsCount: number
  onNavigate?: (k: NavKey) => void
} & HeroRefreshProps) {
  const slots = useSessionSlots()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!focused) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), REFRESH_STAMP_TICK_MS)
    return () => clearInterval(id)
  }, [focused, lastRefreshedAt])

  const failed = failedSources ?? []
  const stamp = failed.length > 0
    ? `Refresh failed: ${failed.join(', ')}`
    : lastRefreshedAt != null ? `Updated ${formatAgo(lastRefreshedAt, now)}` : null

  const total = slots?.total ?? 5
  const inUse = slots?.inUse ?? 0

  const scrollToNeeds = () => {
    // Scroll only Home's own scroller — the native into-view call would drag the
    // app's overflow:hidden page frames above it.
    const target = document.getElementById('home-needs-you')
    const scroller = target?.closest<HTMLElement>('[data-home-scroller]')
    if (target && scroller) scrollWithin(scroller, target, { behavior: 'smooth', block: 'start', offset: 16 })
  }

  return (
    <header className="mb-[18px] flex items-end gap-4">
      <div>
        <div className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.08em] text-fg-faint mb-1.5">
          This machine · {projectCount} project{projectCount === 1 ? '' : 's'}
        </div>
        <h1 className="m-0 font-serif text-[30px] font-semibold leading-[1.1] text-fg tracking-[-0.01em]">
          {greeting}. <span className="text-accent">{inUse} of {total}</span> slots busy,{' '}
          {needsCount > 0 ? (
            <button
              onClick={scrollToNeeds}
              className="underline decoration-dotted underline-offset-4 text-honey-dark hover:text-honey"
            >
              {needsCount} thing{needsCount > 1 ? 's' : ''}
            </button>
          ) : (
            <span className="text-sage">nothing</span>
          )}{' '}
          need{needsCount === 1 ? 's' : ''} you.
        </h1>
      </div>
      <div className="ml-auto flex gap-2 shrink-0">
        {onRefresh && stamp && (
          <span
            data-testid="home-updated-at"
            className={`font-mono text-[11px] self-center ${failed.length > 0 ? 'text-honey-dark' : 'text-fg-faint'}`}
          >
            {stamp}
          </span>
        )}
        {onRefresh && (
          <HeroButton testId="home-refresh" disabled={refreshing} onClick={onRefresh}>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </HeroButton>
        )}
        <HeroButton onClick={() => onNavigate?.('history')}>All history</HeroButton>
      </div>
    </header>
  )
}

function HeroButton({ children, onClick, disabled, testId }: {
  children: ReactNode
  onClick: () => void
  disabled?: boolean
  testId?: string
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      className="rounded-lg border border-line bg-bg-hi px-4 py-2 text-[12.5px] font-semibold text-fg-dim hover:bg-bg-elev disabled:opacity-50"
    >
      {children}
    </button>
  )
}

// ────────────────────────────────────────────────────────────────────
// Needs you section — expandable rows, one card per real signal.
// ────────────────────────────────────────────────────────────────────
export function NeedsYouSection({
  rows,
  onNavigate,
  onAnswer,
}: {
  rows: NeedsYouRow[]
  onNavigate?: (k: NavKey) => void
  /** useOutsideNeedsYou().answer — sends an 'outside-item' row's chosen option. */
  onAnswer?: OutsideAnswer
}) {
  const [openId, setOpenId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const paged = usePagedList(rows, 4)
  const changePage = (p: number) => { setOpenId(null); paged.setPage(p) }

  const openChat = (row: NeedsYouRow) => {
    if (!row.epicId) return
    setPendingPromptSessionId(row.epicId)
    onNavigate?.('terminal')
  }

  const answerOutside = (row: NeedsYouRow, value: string) => {
    if (!row.app || !row.itemId || !onAnswer || busyId) return
    setBusyId(row.id)
    onAnswer(row.app, row.itemId, value)
      .then((r) => { if (!r.ok) toast.error(r.error || 'Could not send the answer.'); else toast.info(`Answered "${value}" for ${row.app}.`) })
      .catch((err) => toast.error(err instanceof Error ? err.message : String(err)))
      .finally(() => { setBusyId(null); setOpenId(null) })
  }

  // Tool-risk 'confirm' items answer through the clearance IPC (scheduler:confirm-tool),
  // keyed by the refused call's tool + args digest — never the generic option path.
  const answerConfirm = (row: NeedsYouRow, approved: boolean) => {
    const c = row.confirm
    if (!c || busyId) return
    setBusyId(row.id)
    window.api.needsYou
      .confirmTool({ tool: c.tool, argsDigest: c.argsDigest, approved })
      .then((r) => {
        if (!r.ok) toast.error(r.error || 'Could not send the answer.')
        else toast.info(approved
          ? `Approved ${c.tool} — the job resumes its same session and may run this exact call once.`
          : `Denied ${c.tool} — the job stays parked.`)
      })
      .catch((err) => toast.error(err instanceof Error ? err.message : String(err)))
      .finally(() => { setBusyId(null); setOpenId(null) })
  }

  const openOutsideLink = (row: NeedsYouRow) => {
    if (!row.link) return
    window.api.shell
      .open({ as: 'external', url: row.link })
      .catch((err) => toast.error(err instanceof Error ? err.message : String(err)))
  }

  return (
    <section id="home-needs-you" className="bg-bg-hi border border-line rounded-[14px] px-4 py-[14px] min-h-0 overflow-auto scroll-mt-4">
      <div className="flex items-baseline justify-between gap-2 mb-2.5">
        <h2 className="m-0 font-mono text-[11px] uppercase tracking-[0.08em] text-fg-faint font-normal">Needs you</h2>
        <span className="font-mono text-[12px] text-fg-faint">{rows.length ? `${rows.length} open` : 'all clear'}</span>
      </div>
      {rows.length === 0 && (
        <div className="bg-bg-hi border border-line rounded-[11px] px-4 py-[18px] text-center text-[13px] text-fg-faint">
          Nothing waiting on you. Proposed Epics, mid-run questions, and failed jobs will surface here.
        </div>
      )}
      <div className="grid gap-[7px]">
        {paged.pageItems.map((row) => {
          const open = openId === row.id
          const tone =
            row.kind === 'job-failed' ? 'bg-accent'
            : row.kind === 'job-quarantined' ? (row.escalated ? 'bg-accent' : 'bg-honey')
            : row.kind === 'needs-input' || row.kind === 'outside-item' ? 'bg-honey'
            : 'bg-sage'
          return (
            <div key={row.id} className={`border rounded-[11px] overflow-hidden ${open ? 'bg-bg-hi border-line' : 'bg-bg border-line/60'}`}>
              <button
                onClick={() => setOpenId(open ? null : row.id)}
                className="w-full grid items-center gap-2.5 px-[13px] py-[10px] text-left"
                style={{ gridTemplateColumns: '6px minmax(0,1fr) auto' }}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${tone}`} />
                <span className="min-w-0">
                  <span className="block text-[12.5px] font-semibold text-fg">{row.label}</span>
                  <span className="block text-[11.5px] text-fg-faint truncate">
                    {row.project ? `${row.project} · ` : ''}{row.detail}
                  </span>
                </span>
                <span className="font-mono text-[11px] text-fg-faint">{open ? '▴' : '▾'}</span>
              </button>
              {open && (
                <div className="border-t border-line px-[13px] pt-[11px] pb-3 grid gap-2.5">
                  <div className="text-[12.5px] text-fg-dim leading-relaxed">{row.meta}</div>
                  {row.confirm && (
                    <div className="grid gap-1 text-[12px]" data-testid="confirm-details">
                      <div><span className="text-fg-faint">Tool </span><code className="font-mono text-fg" data-testid="confirm-tool">{row.confirm.tool}</code></div>
                      <div className="min-w-0"><span className="text-fg-faint">Args </span><span className="font-mono text-fg-dim break-all" data-testid="confirm-args">{row.confirm.summary || '(no summary recorded)'}</span></div>
                    </div>
                  )}
                  <div className="flex gap-2">
                    {/* Proposed Epics are approved in their own session's action bar;
                        failed / quarantined jobs are acted on in the Scheduler. */}
                    {(row.kind === 'proposed-epic' || row.kind === 'needs-input') && (
                      <NeedsButton onClick={() => openChat(row)}>Open session</NeedsButton>
                    )}
                    {(row.kind === 'job-failed' || row.kind === 'job-quarantined') && (
                      <NeedsButton quiet onClick={() => onNavigate?.('scheduler')}>View in Scheduler</NeedsButton>
                    )}
                    {row.kind === 'outside-item' && row.confirm && (
                      <>
                        <NeedsButton testId="confirm-approve" onClick={() => answerConfirm(row, true)} disabled={busyId === row.id}>Approve</NeedsButton>
                        <NeedsButton testId="confirm-deny" quiet onClick={() => answerConfirm(row, false)} disabled={busyId === row.id}>Deny</NeedsButton>
                      </>
                    )}
                    {row.kind === 'outside-item' && !row.confirm && (
                      <>
                        {(row.options ?? []).map((opt) => (
                          <NeedsButton key={opt} onClick={() => answerOutside(row, opt)} disabled={busyId === row.id}>{opt}</NeedsButton>
                        ))}
                        {row.link && (
                          <NeedsButton quiet onClick={() => openOutsideLink(row)}>Open</NeedsButton>
                        )}
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
      <Pager
        compact
        testIdPrefix="home-needs-pager"
        page={paged.page}
        pageSize={paged.pageSize}
        totalItems={paged.total}
        onPageChange={changePage}
      />
    </section>
  )
}

function NeedsButton({
  children,
  onClick,
  disabled,
  quiet,
  testId,
}: {
  children: ReactNode
  onClick: () => void
  disabled?: boolean
  quiet?: boolean
  testId?: string
}) {
  return (
    <button
      data-testid={testId}
      onClick={onClick}
      disabled={disabled}
      className={
        quiet
          ? 'rounded-md border border-line bg-bg px-3 py-[5px] text-[11.5px] font-semibold text-fg-dim hover:bg-bg-elev disabled:opacity-50'
          : 'rounded-md bg-accent text-bg-hi px-3 py-[5px] text-[11.5px] font-semibold hover:bg-accent-dark disabled:opacity-50'
      }
    >
      {children}
    </button>
  )
}

// ────────────────────────────────────────────────────────────────────
// Queued — pending scheduler jobs across all known projects, FIFO order.
// Exported for a direct regression test (Home.queuedCard.test.tsx) covering
// both the pre-hydrate (snapshot === null) and empty-snapshot states — the
// EMPTY_JOBS fallback above already makes both render 'Nothing pending.'
// rather than a blank card; the test locks that behavior in.
// ────────────────────────────────────────────────────────────────────
export function QueuedCard({ onNavigate }: { onNavigate?: (k: NavKey) => void }) {
  const jobs = useScheduleState((s) => s.snapshot?.jobs) ?? EMPTY_JOBS
  const pending = useMemo(() => jobs.filter((j) => j.status === 'pending'), [jobs])
  const paged = usePagedList(pending, 5)
  const [openSlug, setOpenSlug] = useState<string | null>(null)

  return (
    <div className="bg-bg-hi border border-line rounded-[14px] px-4 py-[14px] min-h-0 overflow-auto">
      <div className="flex items-center justify-between mb-2.5">
        <div className="font-mono text-[11px] uppercase tracking-[0.08em] text-fg-faint">
          Queued{pending.length > 0 ? ` · ${pending.length}` : ''}
        </div>
        <button
          onClick={() => onNavigate?.('scheduler')}
          className="font-mono text-[10.5px] text-accent hover:underline"
        >
          Open Scheduler →
        </button>
      </div>
      {pending.length === 0 ? (
        <div className="text-[13px] text-fg-faint py-1">Nothing pending.</div>
      ) : (
        <div className="space-y-2.5">
          {paged.pageItems.map((q) => (
            <div key={q.slug} className="relative">
              <button
                onClick={() => setOpenSlug(openSlug === q.slug ? null : q.slug)}
                className="w-full text-left hover:bg-bg/40 rounded-md -mx-1 px-1 py-0.5 transition-colors"
              >
                <div className="font-mono text-[11.5px] font-semibold text-fg truncate">{q.title || q.slug}</div>
                <div className="text-[11px] text-fg-faint truncate">
                  {q.cwd ? projectNameFromCwd(q.cwd) : '—'}
                  {q.estimateMinutes != null ? ` · ~${q.estimateMinutes}m` : ''}
                </div>
              </button>
              {openSlug === q.slug && (
                <QueuedJobPopover
                  job={q as QueuedJobPopoverJob}
                  onClose={() => setOpenSlug(null)}
                  onOpenScheduler={() => { setOpenSlug(null); onNavigate?.('scheduler') }}
                />
              )}
            </div>
          ))}
        </div>
      )}
      <Pager
        compact
        testIdPrefix="home-queued-pager"
        page={paged.page}
        pageSize={paged.pageSize}
        totalItems={paged.total}
        onPageChange={paged.setPage}
      />
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
// Billing meters — Session 5-hour + Weekly windows (moved from the
// now-removed Usage tab; same useBilling store Home already read from).
// ────────────────────────────────────────────────────────────────────
function BillingCard() {
  const billing = useBilling((s) => s.data)
  const data = getBillingData(billing)

  return (
    <div className="space-y-3">
      {billing && billing.kind !== 'ok' && billing.kind !== 'ok-stale' && (
        <BillingStatusOverlay result={billing} onRetry={refreshBilling} />
      )}
      {!billing && <div className="text-xs text-fg-faint">loading usage…</div>}
      {data && <UsageMeters data={data} updatedAt={data.fetchedAt} />}
      <UsageCapControl />
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
// Projects — compact list of known projects with live/activity chips.
// Clicking a row activates the matching SessionTab, or opens one.
// ────────────────────────────────────────────────────────────────────
export function ProjectsCard({ projectRows }: { projectRows: HomeProjectRow[] }) {
  const tabs = useSessions((s) => s.tabs)
  const addTab = useSessions((s) => s.addTab)
  const setActive = useSessions((s) => s.setActive)
  const { unresolvedWorktreeFolders } = useKnownProjects()
  const paged = usePagedList(projectRows, 8)

  const openProject = (cwd: string) => {
    openProjectTab(cwd, tabs, addTab, setActive)
    // Opening a project from Home means "show me it" — lift the Epics
    // workspace overlay so the selected tab isn't masked (see layout.ts).
    useLayout.getState().setEpicsWorkspaceOpen(false)
  }

  return (
    <div className="bg-bg-hi border border-line rounded-[14px] px-4 py-[14px] min-h-0 overflow-auto">
      <div className="font-mono text-[11px] uppercase tracking-[0.08em] text-fg-faint mb-2.5">
        Projects
      </div>
      {projectRows.length === 0 ? (
        <div className="text-[13px] text-fg-faint py-2">No known projects yet.</div>
      ) : (
        <div className="space-y-1">
          {paged.pageItems.map((p) => (
            <button
              key={p.encoded}
              onClick={() => openProject(p.cwd)}
              className="w-full flex items-center gap-2.5 text-left px-2 py-1.5 rounded-lg hover:bg-bg/60 transition-colors"
              title={p.cwd}
            >
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: projectColorFor(p.dotSeed) }}
              />
              <span className="flex-1 min-w-0 text-[13px] text-fg truncate">{p.name}</span>
              {p.liveCount > 0 ? (
                <span className="font-mono text-[11px] text-accent whitespace-nowrap">{p.liveCount} live</span>
              ) : (
                <span className="font-mono text-[11px] text-fg-faint whitespace-nowrap">{formatAgo(p.lastActivityMs, Date.now())}</span>
              )}
            </button>
          ))}
        </div>
      )}
      <Pager
        compact
        testIdPrefix="home-projects-pager"
        page={paged.page}
        pageSize={paged.pageSize}
        totalItems={paged.total}
        onPageChange={paged.setPage}
      />
      {unresolvedWorktreeFolders > 0 && (
        <div data-testid="home-projects-unresolved" className="mt-2 text-[11px] text-fg-faint">
          {unresolvedWorktreeFolders} worktree folders not matched to a project
        </div>
      )}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
// Recent sessions
// ────────────────────────────────────────────────────────────────────
const RECENT_SESSIONS_GRID = '92px minmax(0,1.2fr) minmax(0,1fr) 80px 74px 78px'

export function RecentSessionsCard({ onNavigate }: { onNavigate?: (k: NavKey) => void }) {
  const { projects, recentSessions, loading } = useKnownProjects()
  const paged = usePagedList(recentSessions, 5)
  const rows = paged.pageItems
  const addTab = useSessions((s) => s.addTab)
  const sessions = usePromptSessions((s) => s.sessions)
  const [drawerRow, setDrawerRow] = useState<RecentRow | null>(null)
  // A session's project is the real cwd its transcript folder resolved to;
  // candidatePath's `-`→`/` decode is only a last resort for a folder whose
  // cwd never resolved (it fabricates paths — see knownProjectAggregate.ts).
  const cwdByEncoded = useMemo(() => {
    const m: Record<string, string> = {}
    for (const p of projects) for (const e of p.encodedIds) m[e] = p.cwd
    return m
  }, [projects])
  const resolveCwd = (encoded: string) => cwdByEncoded[encoded] ?? candidatePath(encoded)
  const resume = (r: RecentRow) => {
    const decoded = resolveCwd(r.projectEncoded)
    addTab({
      cwd: decoded,
      startupCommand: `claude --resume ${shellQuote(r.sessionId)}`,
      presetId: 'history-resume',
    })
  }
  const drawerEpicTitle = drawerRow ? recentSessionEpicTitle(drawerRow.sessionId, sessions) : null
  const drawerKeyVals: DrawerKeyVal[] = drawerRow
    ? [
        { label: 'Session', value: drawerRow.sessionId },
        { label: 'Project', value: resolveCwd(drawerRow.projectEncoded) },
        { label: 'Epic', value: drawerEpicTitle ?? '—' },
        { label: 'Last activity', value: `${absoluteTime(drawerRow.mtimeMs)} (${formatAgo(drawerRow.mtimeMs, Date.now())})` },
        { label: 'Size', value: `${Math.round(drawerRow.sizeBytes / 1024)}k` },
      ]
    : []
  return (
    <section className="bg-bg-hi border border-line rounded-[14px] px-4 py-[14px] min-h-0 overflow-auto">
      <div className="flex items-baseline justify-between gap-2 mb-2.5">
        <h2 className="m-0 font-mono text-[11px] uppercase tracking-[0.08em] text-fg-faint font-normal">Recent sessions</h2>
        <button
          onClick={() => onNavigate?.('history')}
          className="text-[13px] text-accent font-medium hover:underline"
        >
          See all history →
        </button>
      </div>
      <div className="overflow-hidden">
        {loading && rows.length === 0 && (
          <div className="px-[18px] py-6 text-[13px] text-fg-faint text-center">Reading transcripts…</div>
        )}
        {!loading && rows.length === 0 && (
          <div className="px-[18px] py-6 text-[13px] text-fg-faint text-center">
            No sessions yet — hit “Start a session” to begin.
          </div>
        )}
        {rows.map((r, i) => {
          const epicTitle = recentSessionEpicTitle(r.sessionId, sessions)
          return (
            <button
              key={r.path}
              onClick={() => setDrawerRow(r)}
              className="w-full grid items-center gap-3.5 px-[18px] py-[11px] text-left hover:bg-bg/40 transition-colors"
              style={{ gridTemplateColumns: RECENT_SESSIONS_GRID, borderTop: i ? '1px solid #d9c9a8' : 'none' }}
            >
              <span className="text-[11.5px] text-fg-faint font-mono truncate">{r.sessionId.slice(0, 8)}</span>
              <span className="text-[12.5px] font-semibold text-fg truncate" title={r.projectEncoded}>
                {projectNameFromCwd(resolveCwd(r.projectEncoded))}
              </span>
              <span className="text-[12.5px] text-fg-dim truncate">{epicTitle ?? '—'}</span>
              <span className="text-[11.5px] text-fg-faint font-mono text-right">
                {Math.round(r.sizeBytes / 1024)}k
              </span>
              <span className="text-[11px] text-fg-faint font-mono text-right">{formatAgo(r.mtimeMs, Date.now())}</span>
              <span
                className="justify-self-end text-[12px] font-semibold px-[11px] py-[5px] rounded-lg text-sage bg-[#e5ecd8]"
                title={`Open ${r.sessionId.slice(0, 8)}…`}
              >
                details
              </span>
            </button>
          )
        })}
        <div className="px-[18px]">
          <Pager
            compact
            testIdPrefix="home-recent-pager"
            page={paged.page}
            pageSize={paged.pageSize}
            totalItems={paged.total}
            onPageChange={paged.setPage}
          />
        </div>
      </div>
      <HomeSessionDrawer
        open={drawerRow != null}
        onClose={() => setDrawerRow(null)}
        title={drawerEpicTitle ?? (drawerRow ? projectNameFromCwd(resolveCwd(drawerRow.projectEncoded)) : '')}
        sub={drawerRow ? `Recent session · ${drawerRow.sessionId.slice(0, 8)}…` : null}
        keyVals={drawerKeyVals}
        footer={
          drawerRow && (
            <button
              onClick={() => { resume(drawerRow); setDrawerRow(null) }}
              className="text-[12px] font-semibold px-[13px] py-[7px] rounded-lg text-sage bg-[#e5ecd8] hover:brightness-95 transition-[filter]"
            >
              Resume
            </button>
          )
        }
      />
    </section>
  )
}

function absoluteTime(ms: number): string {
  return new Date(ms).toLocaleString()
}

// ────────────────────────────────────────────────────────────────────
// Active sessions — the machine-wide `claude -p` session-slot pool
// (lib/scheduler/sessionSlots.cjs) joined against running scheduler jobs / chat runs.
// ────────────────────────────────────────────────────────────────────

export function ActiveSessionsCard({ onNavigate }: { onNavigate?: (k: NavKey) => void }) {
  const slots = useSessionSlots()
  const jobs = useScheduleState((s) => s.snapshot?.jobs) ?? EMPTY_JOBS
  const chats = useChatSignals()
  const sessions = usePromptSessions((s) => s.sessions)
  const [drawerRow, setDrawerRow] = useState<ActiveSessionRow | null>(null)

  const total = slots?.total ?? 5
  const inUse = slots?.inUse ?? 0
  const runningJobs = useMemo(() => jobs.filter((j) => j.status === 'running'), [jobs])
  // Why the queue is running narrower than the pool. Sourced entirely from the
  // scheduler's own last-tick record — never recomputed here, and deliberately
  // silent when the queue is simply idle so an empty queue can't read as a
  // blocked one.
  const lastTick = useScheduleState((s) => s.snapshot?.lastTick)
  const constraint = useMemo(() => {
    const pending = jobs.filter((j) => j.status === 'pending').length
    return queueConstraintLabel(lastTick, pending, total)
  }, [lastTick, jobs, total])
  const rows = useMemo(
    () => activeSessionRows(slots?.holders ?? [], runningJobs, chats, sessions),
    [slots, runningJobs, chats, sessions],
  )

  const paged = usePagedList(rows, 5)

  const open = (row: ActiveSessionRow) => {
    if (row.openTarget === 'scheduler') { onNavigate?.('scheduler'); return }
    if (row.openTarget === 'terminal' && row.epicId) {
      setPendingPromptSessionId(row.epicId)
      onNavigate?.('terminal')
    }
  }

  const drawerTail: DrawerTailLine[] | undefined =
    drawerRow?.kind === 'chat run' && drawerRow.epicId
      ? chats[drawerRow.epicId]?.turns.slice(-4).map((t) => ({ id: t.id, role: t.role, text: t.text }))
      : undefined
  const drawerKeyVals: DrawerKeyVal[] = drawerRow
    ? [
        { label: 'Owner', value: drawerRow.owner },
        { label: 'Kind', value: drawerRow.kind },
        { label: 'Epic', value: drawerRow.epicTitle ?? '—' },
        { label: 'Project', value: drawerRow.project ?? '—' },
        { label: 'Started', value: `${absoluteTime(new Date(drawerRow.at).getTime())} (${formatAgo(new Date(drawerRow.at).getTime(), Date.now())})` },
      ]
    : []

  return (
    <section className="bg-bg-hi border border-line rounded-[14px] px-4 py-[14px] min-h-0 overflow-auto">
      <div className="flex items-baseline justify-between gap-2 mb-2.5">
        <h2 className="m-0 font-mono text-[11px] uppercase tracking-[0.08em] text-fg-faint font-normal">Active sessions</h2>
        <span className="flex items-center gap-4">
          <span className="font-mono text-[12px] text-fg-faint">
            {inUse} of {total} busy
            {constraint && <span className="ml-2 text-amber-400/90">· {constraint}</span>}
          </span>
        </span>
      </div>
      {rows.length === 0 ? (
        <div className="text-[13px] text-fg-faint py-1">No headless Claude sessions running.</div>
      ) : (
        <div className="grid gap-2">
          {paged.pageItems.map((row) => (
            <button
              key={row.owner}
              onClick={() => setDrawerRow(row)}
              className="w-full text-left bg-bg-hi border border-line rounded-[13px] px-4 py-[13px] grid items-center gap-3.5 hover:bg-bg-elev/40 transition-colors"
              style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}
            >
              <span className="min-w-0">
                <span className="flex items-center gap-2 mb-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />
                  <span className="font-mono text-[12.5px] font-semibold text-fg truncate">{row.owner}</span>
                  <span className="font-mono text-[10.5px] text-fg-faint shrink-0">{row.kind}</span>
                </span>
                {(row.project || row.epicTitle) && (
                  <span className="block text-[12px] text-fg-faint truncate">
                    {[row.project, row.epicTitle ? `Epic · ${row.epicTitle}` : null].filter(Boolean).join(' · ')}
                  </span>
                )}
              </span>
              <span className="flex items-center gap-3.5 shrink-0">
                <span className="font-mono text-[11px] text-fg-faint">{formatAgo(new Date(row.at).getTime(), Date.now())}</span>
                {row.openTarget && (
                  <span
                    onClick={(e) => { e.stopPropagation(); open(row) }}
                    className="border border-line bg-bg rounded-lg px-[11px] py-[5px] text-[12px] font-semibold text-fg-dim hover:bg-bg/60 transition-colors"
                  >
                    Open
                  </span>
                )}
              </span>
            </button>
          ))}
        </div>
      )}
      <Pager
        compact
        testIdPrefix="home-active-pager"
        page={paged.page}
        pageSize={paged.pageSize}
        totalItems={paged.total}
        onPageChange={paged.setPage}
      />
      <HomeSessionDrawer
        open={drawerRow != null}
        onClose={() => setDrawerRow(null)}
        title={drawerRow?.epicTitle ?? drawerRow?.owner ?? ''}
        sub={drawerRow ? `Active session · ${drawerRow.kind}` : null}
        keyVals={drawerKeyVals}
        tail={drawerTail}
        footer={
          drawerRow?.openTarget && (
            <button
              onClick={() => { open(drawerRow); setDrawerRow(null) }}
              className="text-[12px] font-semibold px-[13px] py-[7px] rounded-lg bg-accent text-bg-hi hover:bg-accent-dark"
            >
              Open
            </button>
          )
        }
      />
    </section>
  )
}
