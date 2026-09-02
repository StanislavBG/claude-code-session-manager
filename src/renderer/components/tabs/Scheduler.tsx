import { memo, useEffect, useState } from 'react'
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
import type { NavKey } from '../LeftNav'

/**
 * Scheduler — ONE screen for both sidebar faces (Home and Project), no fork
 * on navFace. Previously (2026-08-01, commit 481cef1) this split into two
 * genuinely different screens — Home's "Scheduler Configs" (global policy
 * only, no PRDs) vs. Project's "Epic's Execution Queue" (this project's live
 * PRD queue, no global config) — reached via lib/navGroups.ts's labelByFace.
 * That split was reverted the same day: the two screens dodged real overlap
 * (SessionManagerConfig's "Scheduler policy" section duplicated the exact
 * same fire-policy/concurrency/threshold controls SchedulePanel's PolicyBar
 * already renders live) instead of resolving it, so it's back to one
 * combined view — with four destinations split by how often the content
 * changes (2026-08 restyle): three tabs in one segmented pillbar for the
 * per-project, minute-to-minute surfaces, plus a separate "Machine" pill for
 * the monthly-changing global config — scheduler.cjs's reconcile()
 * (src/main/scheduler.cjs:35, run on every scan/tick) walks prds/ and gives
 * every .md a queue.json entry immediately, so Queue and PRDs always show the
 * same underlying slugs; there is no "authored but not yet queued" state to
 * distinguish them by:
 *   • Queue   — OPERATE: live status strip, fire policy, and this project's
 *     job execution (per-job status/ETA/logs, reset/resume actions).
 *   • PRDs    — AUTHOR: edit the .md source (structured frontmatter form +
 *     body editor, lint, archive/retag) — the old "Plans"
 *   • History — last 50 completed/failed jobs with project + date-range filters
 *   • Machine — global session pool, fire-policy scaffolding, on-disk paths;
 *     applies to every project, not just the active tab (SessionManagerConfig).
 * scopeCwd derives directly from the active tab's cwd every render (no
 * stored scope state): the currently-active project's tab, or null (every
 * project) if no tab is active — e.g. sitting on the Home face with nothing
 * open. There is no manual "All projects" escape hatch; to see another
 * project's queue, switch tabs (matches HistoryDashboard's scoping).
 */

type SubView = 'queue' | 'prds' | 'history' | 'machine'

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
  // Launch circuit breakers (issue #11): a persona whose headless launches
  // are being rejected by the API before any turn. Distinct from `paused` —
  // the rest of the queue keeps running; only the broken persona is held.
  const launchBlocks = Object.entries(snapshot.launchBlocks ?? {})
  const launchMitigations = Object.entries(snapshot.launchMitigations ?? {})
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

      {/* Launch circuit breakers — one red banner per blocked persona */}
      {launchBlocks.map(([key, block]) => (
        <div
          key={`launch-block-${key}`}
          data-testid="launch-block-banner"
          className="flex items-start gap-3 border rounded-xl px-4 py-2.5 text-[13px] bg-red-950/60 border-red-700/50 text-red-200"
        >
          <div className="flex-1 leading-snug min-w-0">
            <div className="font-medium">
              Launches for <span className="font-mono">{key}</span> jobs are failing before any work starts
              {block.httpStatus ? ` (HTTP ${block.httpStatus}, ${block.kind})` : ` (${block.kind})`}
              {block.exhausted
                ? ' — held until the Claude CLI version changes or you press Retry now.'
                : block.until
                  ? ` — next automatic probe ${new Date(block.until).getTime() > now ? `in ${formatRelative(new Date(block.until).getTime() - now)}` : 'on the next tick'}.`
                  : '.'}
            </div>
            <div className="mt-0.5 text-red-200/80">{block.hint}</div>
            <div className="mt-0.5 font-mono text-[12px] text-red-200/70 truncate" title={block.message}>
              {block.attempts} failed probe{block.attempts === 1 ? '' : 's'}
              {block.claudeVersion ? ` · CLI ${block.claudeVersion}` : ''}
              {block.lastSlug ? ` · last: ${block.lastSlug}` : ''}
              {' · '}{block.message}
            </div>
          </div>
          <button
            type="button"
            onClick={() => window.api.schedule.resume()}
            className="shrink-0 px-2.5 py-1 rounded border border-current/40 hover:bg-white/10 transition-colors text-[12px] font-medium"
          >
            Retry now
          </button>
        </div>
      ))}
      {/* Degraded-mode launches — amber, informational */}
      {launchMitigations.map(([key, m]) => (
        <div
          key={`launch-mitigation-${key}`}
          data-testid="launch-mitigation-banner"
          className="flex items-start gap-3 border rounded-xl px-4 py-2.5 text-[13px] bg-amber-950/60 border-amber-700/50 text-amber-200"
        >
          <div className="flex-1 leading-snug min-w-0">
            <div className="font-medium">
              <span className="font-mono">{key}</span> jobs are running in degraded mode
              {' '}(<span className="font-mono">{Object.entries(m.env).map(([k, v]) => `${k}=${v}`).join(' ')}</span>)
              {m.claudeVersion ? ` since CLI ${m.claudeVersion}` : ''}.
            </div>
            <div className="mt-0.5 text-amber-200/80">{m.hint}</div>
          </div>
        </div>
      ))}

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

interface SchedulerProps {
  navigate?: (k: NavKey) => void
}

function SchedulerComponent({ navigate }: SchedulerProps = {}) {
  const [subView, setSubView] = useState<SubView>(() => {
    const stored = localStorage.getItem(LS_KEY)
    return (stored === 'prds' || stored === 'history' || stored === 'machine') ? stored : 'queue'
  })
  // scopeCwd is derived directly from activeCwd every render, not stored
  // state — the currently-active project's tab, or null (every project) if
  // no tab is active. No manual "all projects" escape hatch.
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
          Global scheduler policy and the machine-wide session pool, plus — when a project
          tab is active — that project's PRDs, run as{' '}
          <code className="font-mono text-[13.5px]">claude -p</code>{' '}
          jobs against your 5-hour window. Jobs auto-pause on rate-limit and resume on the
          next reset.
        </p>

        <div className="mt-[18px] mb-[22px]">
          <WindowStrip scopeCwd={scopeCwd} />
        </div>

        <div className="flex items-center gap-3 pb-0">
          <SchedulerSubTabs<SubView> options={VIEW_OPTIONS} active={subView} onChange={setSubView} />
          <button
            type="button"
            onClick={() => setSubView('machine')}
            aria-pressed={subView === 'machine'}
            className={`inline-flex items-center gap-1.5 px-[15px] py-2 rounded-lg text-[13.5px] transition-colors ${
              subView === 'machine'
                ? 'bg-bg-elev border border-line font-semibold text-fg'
                : 'text-fg-faint hover:text-fg-dim'
            }`}
            title="Machine-wide config that applies to every project — not this project's live queue."
          >
            <span aria-hidden="true">⚙</span> Machine
          </button>
        </div>

        {subView === 'queue' && (
          <p className="mt-2 text-[14.5px] text-fg-dim leading-relaxed max-w-[600px]">
            What's running right now, and what fires next.
          </p>
        )}
        {subView === 'prds' && (
          <p className="mt-2 text-[14.5px] text-fg-dim leading-relaxed max-w-[600px]">
            Authored PRD source files on disk — edit, lint, archive, or queue them.
          </p>
        )}
        {subView === 'history' && (
          <p className="mt-2 text-[14.5px] text-fg-dim leading-relaxed max-w-[600px]">
            The last 50 completed and failed jobs, for this project.
          </p>
        )}
        {subView === 'machine' && (
          <p className="mt-2 text-[14.5px] text-fg-dim leading-relaxed max-w-[600px]">
            Machine-wide setup that applies to every project.
          </p>
        )}
      </div>

      {/* ── Content ──────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0">
        {subView === 'queue' && <SchedulePanel scopeCwd={scopeCwd} navigate={navigate} />}
        {subView === 'prds' && <SchedulerPrdsView scopeCwd={scopeCwd} />}
        {subView === 'history' && <SchedulerHistoryView scopeCwd={scopeCwd} />}
        {subView === 'machine' && (
          <div className="h-full overflow-y-auto px-9 py-6">
            <SessionManagerConfig navigate={navigate} />
          </div>
        )}
      </div>
    </div>
  )
}

// Memoized: `navigate` is a stable ScreenRenderCtx callback identity; own
// data comes from store hooks inside the component.
export const Scheduler = memo(SchedulerComponent)
