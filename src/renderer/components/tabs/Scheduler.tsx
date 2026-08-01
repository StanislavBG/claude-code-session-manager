import { useEffect, useMemo, useRef, useState } from 'react'
import { useSessions } from '../../state/sessions'
import { usePromptSessions } from '../../state/promptSessions'
import { SchedulerSubTabs } from './scheduler/SchedulerSubTabs'
import { SchedulePanel } from '../SchedulePanel'
import { SchedulerPrdsView } from './plans/SchedulerPrdsView'
import { SchedulerHistoryView } from './plans/SchedulerHistoryView'
import { useScheduleState } from '../../state/scheduleState'
import { formatAgo, formatRelative } from '../../lib/formatTime'
import { AlmanacIcon } from '../layout/AlmanacIcon'
import { LegendItem } from './scheduler/sched-primitives'
import { LearningPanel } from '../LearningPanel'
import { useLayout } from '../../state/layout'

/**
 * Scheduler — the single home for the claude -p batch workflow. Three tabs,
 * split by operate vs. author rather than by item set — scheduler.cjs's
 * reconcile() (src/main/scheduler.cjs:35, run on every scan/tick) walks
 * prds/ and gives every .md a queue.json entry immediately, so Queue and
 * PRDs always show the same underlying slugs; there is no "authored but not
 * yet queued" state to distinguish them by:
 *   • Queue   — OPERATE: monitor job execution (fire policy, concurrency,
 *     per-job status/ETA/logs, reset/resume actions)
 *   • PRDs    — AUTHOR: edit the .md source (structured frontmatter form +
 *     body editor, lint, archive/retag) — the old "Plans"
 *   • History — last 50 completed/failed jobs with project + date-range filters
 *
 * Consolidates what used to be three separate nav destinations (Scheduler,
 * Plans, and the duplicate "Background Agents" tool) — all three read the same
 * queue.json + each active project's <cwd>/session-manager-operations/scheduler/prds/
 * files. One surface, no duplication.
 *
 * The project/all scope toggle defaults from the NavFace
 * (leftnav-two-face-framework): Home face -> all projects, Project face ->
 * the active tab's cwd. The default only re-applies on an actual face
 * transition, never on a same-face re-render, and never once the user has
 * manually toggled scope since the last transition.
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

// ─── Scheduler shell ─────────────────────────────────────────────────────────

export function Scheduler() {
  const [subView, setSubView] = useState<SubView>(() => {
    const stored = localStorage.getItem(LS_KEY)
    return (stored === 'prds' || stored === 'history') ? stored : 'queue'
  })
  // Scheduler is a BROWSER over TAB → EPIC → PRD (CLAUDE.md domain model):
  // default to the active tab's project. "All projects" stays as an explicit
  // machine-wide escape hatch. The default is NavFace-driven (see the
  // module docstring) — Home face defaults to 'all', Project face to
  // 'project' — and only re-applies on an actual face transition.
  const navFace = useLayout((s) => s.navFace)
  const [scope, setScope] = useState<'project' | 'all'>(() => (navFace === 'project' ? 'project' : 'all'))
  const manuallyTouchedRef = useRef(false)
  const prevNavFaceRef = useRef(navFace)
  const handleScopeChange = (next: 'project' | 'all') => {
    manuallyTouchedRef.current = true
    setScope(next)
  }
  useEffect(() => {
    if (prevNavFaceRef.current === navFace) return
    prevNavFaceRef.current = navFace
    if (manuallyTouchedRef.current) {
      manuallyTouchedRef.current = false
      return
    }
    setScope(navFace === 'project' ? 'project' : 'all')
  }, [navFace])
  const tabs = useSessions((s) => s.tabs)
  const activeTabId = useSessions((s) => s.activeTabId)
  const activeCwd = tabs.find((t) => t.id === activeTabId)?.cwd ?? null
  const scopeCwd = scope === 'project' ? activeCwd : null

  // Epic names shown on Queue/PRD/History rows come from the promptSessions
  // store, which is hydrated lazily per project. Without this, booting
  // straight into Scheduler renders bare epic ids until the user happens to
  // visit Home or Epics. Archived Epics are hydrated too — History rows point
  // at Epics that are, by definition, usually finished.
  const openCwds = useMemo(() => {
    const seen: string[] = []
    for (const t of tabs) {
      if (t.cwd && !seen.includes(t.cwd)) seen.push(t.cwd)
    }
    return seen
  }, [tabs])

  useEffect(() => {
    const targets = scope === 'project' ? (activeCwd ? [activeCwd] : []) : openCwds
    for (const cwd of targets) {
      void usePromptSessions.getState().hydrate(cwd)
      void usePromptSessions.getState().hydrateArchived(cwd)
    }
  }, [scope, activeCwd, openCwds])

  useEffect(() => {
    localStorage.setItem(LS_KEY, subView)
  }, [subView])

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
          Scheduler
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
          {/* Project scope toggle — Scheduler browses the active TAB's project by default */}
          <div className="ml-auto flex items-center gap-1 text-[12px]" role="group" aria-label="Scheduler scope">
            <button
              type="button"
              data-testid="scheduler-scope-project"
              onClick={() => handleScopeChange('project')}
              className={`px-2.5 py-1 rounded-full border transition-colors ${
                scope === 'project'
                  ? 'border-accent/60 bg-accent/10 text-fg font-medium'
                  : 'border-line text-fg-faint hover:text-fg-dim'
              }`}
              title={activeCwd ? `Only ${activeCwd}` : 'No active tab — showing all projects'}
            >
              This project
            </button>
            <button
              type="button"
              data-testid="scheduler-scope-all"
              onClick={() => handleScopeChange('all')}
              className={`px-2.5 py-1 rounded-full border transition-colors ${
                scope === 'all'
                  ? 'border-accent/60 bg-accent/10 text-fg font-medium'
                  : 'border-line text-fg-faint hover:text-fg-dim'
              }`}
            >
              All projects
            </button>
          </div>
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
