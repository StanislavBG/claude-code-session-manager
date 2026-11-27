/**
 * Home — the Guild Hall (route `overview`): a full-page WorldView with one
 * character per active session-slot holder, grouped by agent type.
 *
 * Layout: the world fills the page; a thin overlay bar on top carries the
 * title, "N of M slots busy", Refresh (with its last-refresh stamp), the usage
 * "pause above" control (owner's explicit Home exception), and a "Quest board
 * (K)" toggle. The Quest board is a collapsible right-hand panel holding the
 * Needs-you list (lib/homeNeedsYou.ts) — the only place outside apps' questions
 * (external-contract §6) and tool confirmations can be answered. It starts
 * closed, even when K > 0.
 *
 * Refresh model: this panel stays mounted for the app's life, so
 * `useDashboardRefresh` re-reads the needs-you/outside sources and Epics each
 * time the page is opened (at most every 30 s) and on the Refresh button.
 */

import { memo, useMemo, useEffect, useRef, useState, type ReactNode } from 'react'
import type { NavKey } from '../../lib/navKey'
import { useScheduleState } from '../../state/scheduleState'
import { usePromptSessions } from '../../state/promptSessions'
import { useChatSignals } from '../../lib/useChatSignals'
import { useKnownProjects } from '../../lib/useKnownProjects'
import { buildNeedsYouRows, type NeedsYouRow } from '../../lib/homeNeedsYou'
import { useOutsideNeedsYou } from '../../lib/useOutsideNeedsYou'
import { usePanelFocus } from '../../lib/panelFocus'
import { useDashboardRefresh } from '../../lib/useDashboardRefresh'
import { setPendingPromptSessionId } from '../../lib/promptSessionDeepLink'
import { useSessionSlots } from '../../lib/useSessionSlots'
import { worldRoster } from '../../lib/worldRoster'
import { Z } from '../../lib/zLayers'
import { usePagedList } from '../../lib/usePagedList'
import { Pager } from '../ui/Pager'
import { UsageCapControl } from './home/UsageCapControl'
import { WorldView } from './home/WorldView'
import { toast } from '../../state/toast'
import { formatAgo } from '../../lib/formatTime'
import type { ScheduleJob } from '../../../preload/api'

const EMPTY_JOBS: ScheduleJob[] = []
const EMPTY_HOLDERS: { owner: string; at: string }[] = []

interface HomeProps {
  onNavigate?: (k: NavKey) => void
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
  const [questOpen, setQuestOpen] = useState(false)

  const slots = useSessionSlots()
  const jobs = useScheduleState((s) => s.snapshot?.jobs) ?? EMPTY_JOBS
  const chats = useChatSignals()
  const sessions = usePromptSessions((s) => s.sessions)
  const holders = slots?.holders ?? EMPTY_HOLDERS
  const roster = useMemo(() => worldRoster(holders, jobs, chats, sessions), [holders, jobs, chats, sessions])

  const barRef = useRef<HTMLElement | null>(null)
  const [barInset, setBarInset] = useState(0)
  useEffect(() => {
    const el = barRef.current
    if (!el) return
    const measure = () => setBarInset(el.offsetTop + el.offsetHeight + BAR_GAP)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    if (el.parentElement) ro.observe(el.parentElement)
    return () => ro.disconnect()
  }, [])

  return (
    <div className="relative h-full w-full overflow-hidden text-fg" data-testid="guild-hall">
      <div className="absolute inset-0">
        <WorldView roster={roster} insetTop={barInset} />
      </div>
      <GuildHallBar
        barRef={barRef}
        inUse={slots?.inUse ?? 0}
        total={slots?.total ?? 5}
        questCount={needsRows.length}
        questOpen={questOpen}
        onToggleQuest={() => setQuestOpen((o) => !o)}
        onRefresh={refresh}
        refreshing={refreshing}
        lastRefreshedAt={lastRefreshedAt}
        failedSources={failedSources}
        focused={focused}
      />
      {questOpen && (
        <aside
          data-testid="quest-board"
          className={`absolute right-3 top-14 bottom-3 w-[380px] max-w-[90%] overflow-auto ${Z.dialog}`}
        >
          <NeedsYouSection rows={needsRows} onNavigate={onNavigate} onAnswer={answerOutside} />
        </aside>
      )}
    </div>
  )
}

/**
 * Memoized: Home only reads ScreenRenderCtx callbacks as props (stable
 * identities), its own data comes from store hooks inside the component.
 */
export const Home = memo(HomeComponent)

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

const REFRESH_STAMP_TICK_MS = 15_000
/** Breathing room between the overlay bar and the first group label. */
const BAR_GAP = 8

// ────────────────────────────────────────────────────────────────────
// Overlay bar — title, slot count, Refresh + stamp, pause-above control,
// Quest board toggle. Exported for Home.refresh.test.tsx.
// ────────────────────────────────────────────────────────────────────
export function GuildHallBar({
  inUse,
  total,
  questCount,
  questOpen,
  onToggleQuest,
  onRefresh,
  refreshing = false,
  lastRefreshedAt = null,
  failedSources,
  focused = true,
  barRef,
}: {
  barRef?: React.Ref<HTMLElement>
  inUse: number
  total: number
  questCount: number
  questOpen: boolean
  onToggleQuest: () => void
  /** useDashboardRefresh().refresh — with none, neither the button nor the stamp renders. */
  onRefresh?: () => void
  refreshing?: boolean
  lastRefreshedAt?: number | null
  failedSources?: string[]
  /** Panel focus — the stamp only ticks while the page is visible. */
  focused?: boolean
}) {
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

  return (
    <header ref={barRef} className={`absolute left-3 right-3 top-3 flex items-center gap-3 rounded-[12px] border border-line bg-bg-hi/90 px-4 py-2 backdrop-blur ${Z.dialog}`}>
      <h1 className="m-0 font-serif text-[20px] font-semibold leading-none text-fg">Guild Hall</h1>
      <span data-testid="guild-hall-slots" className="font-mono text-[12px] text-fg-dim">
        {inUse} of {total} slots busy
      </span>
      <div className="ml-auto flex items-center gap-2 shrink-0">
        {onRefresh && stamp && (
          <span
            data-testid="home-updated-at"
            className={`font-mono text-[11px] ${failed.length > 0 ? 'text-honey-dark' : 'text-fg-faint'}`}
          >
            {stamp}
          </span>
        )}
        <UsageCapControl />
        {onRefresh && (
          <HeroButton testId="home-refresh" disabled={refreshing} onClick={onRefresh}>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </HeroButton>
        )}
        <HeroButton testId="quest-board-toggle" onClick={onToggleQuest}>
          {`Quest board (${questCount})`}
        </HeroButton>
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
      className="rounded-lg border border-line bg-bg-hi px-3 py-1.5 text-[12.5px] font-semibold text-fg-dim hover:bg-bg-elev disabled:opacity-50"
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
