import { useEffect, useState } from 'react'
import { useSessions } from '../../state/sessions'
import { usePromptSessions } from '../../state/promptSessions'
import { SchedulerSubTabs } from './scheduler/SchedulerSubTabs'
import { SchedulePanel } from '../SchedulePanel'
import { SchedulerPrdsView } from './plans/SchedulerPrdsView'
import { SchedulerHistoryView } from './plans/SchedulerHistoryView'
import { SessionManagerConfig } from './SessionManagerConfig'
import { useScheduleState } from '../../state/scheduleState'
import { formatAgo, formatRelative } from '../../lib/formatTime'
import { AlmanacIcon } from '../layout/AlmanacIcon'
import { LegendItem } from './scheduler/sched-primitives'
import { LearningPanel } from '../LearningPanel'
import { useLayout } from '../../state/layout'
import type { NavKey } from '../LeftNav'

/**
 * Scheduler — two genuinely different screens sharing one NavKey, split by
 * navFace (see lib/navGroups.ts's labelByFace — sidebar reads "Scheduler
 * Configs" on Home, "Epic's Execution Queue" on Project):
 *
 *   • Home face ("Scheduler Configs")   — global policy, never any PRDs:
 *     the machine-wide session pool, scheduler fire policy/concurrency,
 *     and quick links into the six dual-scope config tabs. Renders
 *     SessionManagerConfig's content directly — this folds in what used to
 *     be the standalone 'sm-config' nav item, so there's one Home-face home
 *     for global scheduler controls, not two.
 *   • Project face ("Epic's Execution Queue") — the claude -p batch
 *     workflow for THIS project, three tabs split by operate vs. author
 *     rather than by item set — scheduler.cjs's reconcile()
 *     (src/main/scheduler.cjs:35, run on every scan/tick) walks prds/ and
 *     gives every .md a queue.json entry immediately, so Queue and PRDs
 *     always show the same underlying slugs; there is no "authored but not
 *     yet queued" state to distinguish them by:
 *       • Queue   — OPERATE: monitor job execution (fire policy, concurrency,
 *         per-job status/ETA/logs, reset/resume actions)
 *       • PRDs    — AUTHOR: edit the .md source (structured frontmatter form +
 *         body editor, lint, archive/retag) — the old "Plans"
 *       • History — last 50 completed/failed jobs with project + date-range filters
 *     FORCE-scoped to the active tab's project — scopeCwd derives directly
 *     from activeCwd every render, no stored scope state, so there is no
 *     "All projects" escape hatch and no way for it to leak in via a stale
 *     manual choice across a face transition (matches HistoryDashboard's
 *     Project-face scoping). To see another project's queue, switch tabs.
 */

type SubView = 'queue' | 'prds' | 'history'

const LS_KEY = 'sm.schedulerTab.subView'

const VIEW_OPTIONS = [
  { key: 'queue' as const, label: 'Queue' },
  { key: 'prds' as const, label: 'PRDs' },
  { key: 'history' as const, label: 'History' },
]

function isToday(isoStr: string, nowMs: number): boolean {
  const d = new Date(isoStr)
  const t = new Date(nowMs)
  return d.getFullYear() === t.getFullYear() && d.getMonth() === t.getMonth() && d.getDate() === t.getDate()
}

// ─── Window status strip ─────────────────────────────────────────────────────

function pauseMessage(reason: string, resumeAt: string | null, now: number): string {
  if (reason === 'auth') {
    return 'Scheduler paused: Claude sign-in expired or invalid. Restart the app or re-run `claude login`, then Resume.'
  }
  if (reason === 'rate_limit') {
    if (resumeAt) {
      const ms = new Date(resumeAt).getTime()
      const remaining = ms - now
      if (remaining > 0) {
        return `Paused for rate limit — resumes in ${formatRelative(remaining)}`
      }
      return 'Paused for rate limit — resume pending'
    }
    return 'Paused for rate limit'
  }
  if (reason === 'network') {
    return 'Paused: billing endpoint unreachable for 30+ min.'
  }
  if (reason === 'manual') {
    return 'Scheduler paused manually. Click Resume to restart.'
  }
  return `Scheduler paused (${reason})`
}

function WindowStrip({ scopeCwd }: { scopeCwd: string | null }) {
  const { snapshot } = useScheduleState()
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  if (!snapshot) return null

  // Job counts follow the scope toggle so the strip agrees with the list
  // rendered directly beneath it. The reset countdown, utilization and
  // last-batch readings below stay machine-wide on purpose — they describe the
  // 5h billing window and the scheduler tick, not this project's work.
  const jobs = (snapshot.jobs ?? []).filter(j => !scopeCwd || j.cwd === scopeCwd)
  const pending   = jobs.filter(j => j.status === 'pending').length
  const running   = jobs.filter(j => j.status === 'running').length
  const completed = jobs.filter(j => j.status === 'completed' && (j.finishedAt ? isToday(j.finishedAt, now) : false)).length

  const nextResetMs = snapshot.nextReset ? new Date(snapshot.nextReset).getTime() : null
  const resetsIn = nextResetMs
    ? (nextResetMs > now ? formatRelative(nextResetMs - now) : 'soon')
    : '—'

  const lastBatch = formatAgo(
    snapshot.lastRunAt ? new Date(snapshot.lastRunAt).getTime() : null,
    now,
  )

  const paused = snapshot.paused
  const pollHealth = snapshot.pollHealth
  const pollStale = pollHealth != null && !pollHealth.lastPollOk

  const isErrorPause = paused?.reason === 'auth' || paused?.reason === 'network'
  const pauseBannerClass = isErrorPause
    ? 'bg-red-950/60 border-red-700/50 text-red-200'
    : 'bg-amber-950/60 border-amber-700/50 text-amber-200'

  return (
    <div className="flex flex-col gap-2">
      {/* Pause banner — only when paused */}
      {paused && (
        <div className={`flex items-center gap-3 border rounded-xl px-4 py-2.5 text-[13px] ${pauseBannerClass}`}>
          <span className="flex-1 leading-snug">
            {pauseMessage(paused.reason, paused.resumeAt, now)}
          </span>
          <button
            type="button"
            onClick={() => window.api.schedule.resume()}
            className="shrink-0 px-2.5 py-1 rounded border border-current/40 hover:bg-white/10 transition-colors text-[12px] font-medium"
          >
            Resume
          </button>
        </div>
      )}

      {/* Stats row */}
      <div className="flex items-center gap-5 flex-wrap bg-bg-hi border border-line rounded-xl px-4 py-3">
        {/* Reset countdown */}
        <span className="inline-flex items-center gap-2 text-[13.5px] text-fg font-semibold whitespace-nowrap">
          <span className="text-sage" aria-hidden="true">
            <AlmanacIcon name="clock" size={15} />
          </span>
          Window resets in {resetsIn}
        </span>

        <span className="w-px h-[18px] bg-rule shrink-0" aria-hidden="true" />

        {/* Job legend */}
        <LegendItem dotClass="bg-fg-faint" n={pending}   label="pending" />
        <LegendItem dotClass="bg-accent"   n={running}   label="running" />
        <LegendItem dotClass="bg-sage"     n={completed} label="completed today" />

        {/* Utilization — stale indicator when polls are failing */}
        {snapshot.utilization !== null && snapshot.utilization !== undefined && (
          <>
            <span className="w-px h-[18px] bg-rule shrink-0" aria-hidden="true" />
            {pollStale ? (
              <span className="font-mono text-[12.5px] text-amber-400/70" title="Billing poll failing — this reading may be outdated">
                {Math.round(snapshot.utilization)}% of window used · last good reading{' '}
                {formatAgo(pollHealth!.lastPollAt, now)}
              </span>
            ) : (
              <span className="font-mono text-[12.5px] text-fg-faint">
                {Math.round(snapshot.utilization)}% of window used
              </span>
            )}
          </>
        )}

        {/* Last batch — right-aligned */}
        <span className="ml-auto font-mono text-[12.5px] text-fg-faint whitespace-nowrap">
          last batch {lastBatch}
        </span>
      </div>
    </div>
  )
}

// ─── Architecture summary (Home face only) ──────────────────────────────────

/**
 * Reserved slot for an agentic-generated architecture summary — a
 * cost-gated claude -p pass over this project's scheduler/queue code,
 * cached to disk, mirroring memoryAggregate.cjs's pattern (only fires on
 * explicit refresh, model pinned). Not wired to a backend yet: this is the
 * layout + interaction shell so a follow-up PRD can drop in the real IPC
 * call without redesigning the card.
 */
function ArchitectureSummarySection() {
  return (
    <section className="border border-line rounded-xl bg-bg-hi px-5 py-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="m-0 mb-1 font-serif text-[18px] font-semibold text-fg">Architecture summary</h2>
          <p className="mt-0 mb-0 text-[13px] text-fg-dim leading-relaxed">
            An agent-generated overview of how the scheduler pieces fit together — reconcile loop,
            queue/history shards, boot reconciliation, the dead-process reaper. Not generated yet.
          </p>
        </div>
        <button
          type="button"
          disabled
          title="Coming soon — will run a cost-gated claude -p pass over the scheduler source, cached to disk"
          className="shrink-0 px-2.5 py-1 rounded border border-line text-fg-faint text-[12px] font-medium cursor-not-allowed opacity-60"
        >
          Generate summary
        </button>
      </div>
      <p className="mt-3 text-[12.5px] text-fg-faint italic">No summary generated yet.</p>
    </section>
  )
}

// ─── Scheduler shell ─────────────────────────────────────────────────────────

interface SchedulerProps {
  navigate?: (k: NavKey) => void
}

export function Scheduler({ navigate }: SchedulerProps = {}) {
  const [subView, setSubView] = useState<SubView>(() => {
    const stored = localStorage.getItem(LS_KEY)
    return (stored === 'prds' || stored === 'history') ? stored : 'queue'
  })
  // Project face is FORCE-scoped to the active tab's project — no manual
  // override, no "all projects" escape hatch (matches History's Project-face
  // scoping). scopeCwd is derived directly from activeCwd every render, not
  // stored state, so there's nothing that could survive a face transition.
  const navFace = useLayout((s) => s.navFace)
  const tabs = useSessions((s) => s.tabs)
  const activeTabId = useSessions((s) => s.activeTabId)
  const activeCwd = tabs.find((t) => t.id === activeTabId)?.cwd ?? null
  const scopeCwd = activeCwd

  // Epic names shown on Queue/PRD/History rows come from the promptSessions
  // store, which is hydrated lazily per project. Without this, booting
  // straight into Scheduler renders bare epic ids until the user happens to
  // visit Home or Epics. Archived Epics are hydrated too — History rows point
  // at Epics that are, by definition, usually finished.
  useEffect(() => {
    if (!activeCwd) return
    void usePromptSessions.getState().hydrate(activeCwd)
    void usePromptSessions.getState().hydrateArchived(activeCwd)
  }, [activeCwd])

  useEffect(() => {
    localStorage.setItem(LS_KEY, subView)
  }, [subView])

  if (navFace === 'home') {
    return (
      <div className="h-full flex flex-col">
        <div className="shrink-0 px-9 pt-7 pb-0">
          <div className="flex items-start justify-between gap-4">
            <div className="text-xs font-bold text-fg-faint tracking-[0.8px] uppercase mb-1">
              Workspace
            </div>
            <LearningPanel active="scheduler" />
          </div>
          <h1 className="m-0 font-serif text-[40px] font-semibold leading-none tracking-tight text-fg">
            Scheduler Configs
          </h1>
          <p className="mt-2 text-[14.5px] text-fg-dim leading-relaxed max-w-[600px]">
            Global scheduler policy and the machine-wide session pool — applies across every
            project. No PRDs here; each project's live queue lives on that project's own tab.
          </p>
          <div className="mt-[18px] mb-[22px]">
            <WindowStrip scopeCwd={null} />
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-auto px-9 pb-9 space-y-6">
          <SessionManagerConfig navigate={navigate} />
          <ArchitectureSummarySection />
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      {/* ── Header + window strip + sub-tabs ─────────────────────── */}
      <div className="shrink-0 px-9 pt-7 pb-0">
        <div className="flex items-start justify-between gap-4">
          <div className="text-xs font-bold text-fg-faint tracking-[0.8px] uppercase mb-1">
            Workspace
          </div>
          <LearningPanel active="scheduler" />
        </div>
        <h1 className="m-0 font-serif text-[40px] font-semibold leading-none tracking-tight text-fg">
          Epic's Execution Queue
        </h1>
        <p className="mt-2 text-[14.5px] text-fg-dim leading-relaxed max-w-[600px]">
          Author PRDs and run them as{' '}
          <code className="font-mono text-[13.5px]">claude -p</code>{' '}
          jobs against your 5-hour window.
          Jobs auto-pause on rate-limit and resume on the next reset.
        </p>

        <div className="mt-[18px] mb-[22px]">
          <WindowStrip scopeCwd={scopeCwd} />
        </div>

        <div className="flex items-center gap-3 pb-0">
          <SchedulerSubTabs options={VIEW_OPTIONS} active={subView} onChange={setSubView} />
        </div>

        {subView === 'queue' && (
          <p className="mt-2 text-[14.5px] text-fg-dim leading-relaxed max-w-[600px]">
            Live job status — pending, running, needs review, completed, failed.
          </p>
        )}
        {subView === 'prds' && (
          <p className="mt-2 text-[14.5px] text-fg-dim leading-relaxed max-w-[600px]">
            Authored PRD source files on disk — edit, lint, archive, or queue them.
          </p>
        )}
      </div>

      {/* ── Content ──────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0">
        {subView === 'queue' && <SchedulePanel scopeCwd={scopeCwd} />}
        {subView === 'prds' && <SchedulerPrdsView scopeCwd={scopeCwd} />}
        {subView === 'history' && <SchedulerHistoryView scopeCwd={scopeCwd} />}
      </div>
    </div>
  )
}
