/**
 * Home — the Almanac landing page. Replaces Overview as the `overview` route.
 *
 * Sections (top to bottom):
 *   1. Hero — "This machine" kicker + live session-slot greeting.
 *   2. Grid — 5h billing window card + Projects card.
 *   3. Recent sessions — pulls `.claude/projects/*.jsonl` (same source as the
 *      History tab) and shows the 4 most-recent.
 *   4. Scheduler peek — first 3 jobs from useScheduleState.
 *
 * Data sources are all existing zustand stores; nothing new on the backend.
 */

import { useMemo, useEffect, useState } from 'react'
import type { NavKey } from '../LeftNav'
import { useBilling, getBillingData, refreshBilling } from '../../state/billing'
import { useScheduleState } from '../../state/scheduleState'
import { useSessions } from '../../state/sessions'
import { usePromptSessions } from '../../state/promptSessions'
import { useChatSignals } from '../../lib/useChatSignals'
import { useHomeDir } from '../../lib/useHomeDir'
import { shellQuote } from '../../lib/presets'
import { candidatePath, useKnownProjects } from '../../lib/useKnownProjects'
import { buildHomeProjectRows } from '../../lib/homeProjectRows'
import { projectColorFor } from '../../lib/projectColor'
import { UsageMeters } from './home/UsageMeters'
import { BillingStatusOverlay } from '../ui/BillingStatusBanner'
import type { DirEntry, ScheduleJob } from '../../../preload/api'


interface HomeProps {
  onNavigate?: (k: NavKey) => void
  onNewSession?: () => void
  onOpenVoice?: () => void
  onOpenScheduler?: () => void
}

export function Home({ onNavigate, onOpenScheduler }: HomeProps) {
  const greeting = useMemo(() => {
    const h = new Date().getHours()
    if (h < 5)  return 'Up late'
    if (h < 12) return 'Good morning'
    if (h < 18) return 'Good afternoon'
    return 'Good evening'
  }, [])

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-[1080px] px-[34px] py-[26px] text-fg">
        <Hero greeting={greeting} />
        <div className="grid gap-[18px] mb-7" style={{ gridTemplateColumns: 'minmax(0,1fr) 300px' }}>
          <BillingCard />
          <ProjectsCard />
        </div>
        <SessionsPoolCard />
        <RecentSessionsCard onNavigate={onNavigate} />
        <SchedulerPeek onNavigate={onNavigate} onOpenScheduler={onOpenScheduler} />
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
// Hero — "This machine" kicker + greeting with live session-slot count.
// ────────────────────────────────────────────────────────────────────
function Hero({ greeting }: { greeting: string }) {
  const [slots, setSlots] = useState<SlotSnapshot | null>(null)

  useEffect(() => {
    let alive = true
    const poll = () => {
      window.api.schedule.sessionSlots()
        .then((s) => { if (alive) setSlots(s) })
        .catch(() => { /* hero slot count is diagnostic-only */ })
    }
    poll()
    const id = setInterval(poll, 5000)
    return () => { alive = false; clearInterval(id) }
  }, [])

  const total = slots?.total ?? 3
  const inUse = slots?.inUse ?? 0

  return (
    <header className="mb-7">
      <div className="font-mono text-[11px] uppercase tracking-[0.08em] text-fg-faint mb-1.5">
        This machine
      </div>
      <h1 className="m-0 font-serif text-[32px] font-medium leading-[1.15] text-fg tracking-[-0.01em]">
        {greeting}. <span className="text-accent">{inUse} of {total}</span> session slots are busy.
      </h1>
    </header>
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
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
// Projects — compact list of known projects with live/activity chips.
// Clicking a row activates the matching SessionTab, or opens one.
// ────────────────────────────────────────────────────────────────────
function ProjectsCard() {
  const { rows, enriched } = useKnownProjects()
  const chats = useChatSignals()
  const sessions = usePromptSessions((s) => s.sessions)
  const tabs = useSessions((s) => s.tabs)
  const addTab = useSessions((s) => s.addTab)
  const setActive = useSessions((s) => s.setActive)

  const projectRows = useMemo(
    () => buildHomeProjectRows(rows, enriched, chats, sessions),
    [rows, enriched, chats, sessions],
  )

  const openProject = (cwd: string) => {
    const existing = tabs.find((t) => t.cwd === cwd)
    if (existing) {
      setActive(existing.id)
    } else {
      addTab({ cwd, startupCommand: null, dormant: true })
    }
  }

  return (
    <div className="bg-bg-hi border border-line rounded-[14px] px-4 py-[14px]">
      <div className="font-mono text-[11px] uppercase tracking-[0.08em] text-fg-faint mb-2.5">
        Projects
      </div>
      {projectRows.length === 0 ? (
        <div className="text-[13px] text-fg-faint py-2">No known projects yet.</div>
      ) : (
        <div className="space-y-1">
          {projectRows.map((p) => (
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
                <span className="font-mono text-[11px] text-fg-faint whitespace-nowrap">{relativeTime(p.lastActivityMs)}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
// Recent sessions
// ────────────────────────────────────────────────────────────────────
interface RecentRow {
  sessionId: string
  projectEncoded: string
  path: string
  mtimeMs: number
  sizeBytes: number
}

function useRecentSessions(limit = 4): { rows: RecentRow[]; loading: boolean } {
  const home = useHomeDir()
  const [rows, setRows] = useState<RecentRow[]>([])
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    if (!home) return
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const projects = await window.api.config.listDir(`${home}/.claude/projects`, { dirsOnly: true })
        const all: RecentRow[] = []
        for (const proj of projects.entries as DirEntry[]) {
          if (cancelled) return
          const files = await window.api.config.listDir(proj.path, { filesOnly: true })
          for (const f of files.entries as DirEntry[]) {
            if (!f.name.endsWith('.jsonl')) continue
            all.push({
              sessionId: f.name.replace(/\.jsonl$/, ''),
              projectEncoded: proj.name,
              path: f.path,
              mtimeMs: f.mtimeMs,
              sizeBytes: f.size,
            })
          }
        }
        all.sort((a, b) => b.mtimeMs - a.mtimeMs)
        if (!cancelled) setRows(all.slice(0, limit))
      } catch (e) {
        console.error('[Home] recent-sessions scan failed:', e)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [home, limit])
  return { rows, loading }
}

function RecentSessionsCard({ onNavigate }: { onNavigate?: (k: NavKey) => void }) {
  const { rows, loading } = useRecentSessions(4)
  const addTab = useSessions((s) => s.addTab)
  const resume = (r: RecentRow) => {
    const decoded = candidatePath(r.projectEncoded)
    addTab({
      cwd: decoded,
      startupCommand: `claude --resume ${shellQuote(r.sessionId)}`,
      presetId: 'history-resume',
    })
  }
  return (
    <section className="mb-6">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="m-0 font-serif text-[22px] font-medium">Recent sessions</h2>
        <button
          onClick={() => onNavigate?.('history')}
          className="text-[13px] text-accent font-medium hover:underline"
        >
          See all history →
        </button>
      </div>
      <div className="bg-bg-hi border border-line rounded-[14px] overflow-hidden">
        {loading && rows.length === 0 && (
          <div className="px-[18px] py-6 text-[13px] text-fg-faint text-center">Reading transcripts…</div>
        )}
        {!loading && rows.length === 0 && (
          <div className="px-[18px] py-6 text-[13px] text-fg-faint text-center">
            No sessions yet — hit “Start a session” to begin.
          </div>
        )}
        {rows.map((r, i) => (
          <button
            key={r.path}
            onClick={() => resume(r)}
            className="w-full text-left grid items-center gap-4 px-[18px] py-3 hover:bg-bg/40 transition-colors"
            style={{ gridTemplateColumns: '1.4fr 2fr auto auto', borderTop: i ? '1px solid #d9c9a8' : 'none' }}
            title={`Resume ${r.sessionId.slice(0, 8)}…`}
          >
            <div>
              <div className="text-[13.5px] font-semibold text-fg truncate">
                {decodeProject(r.projectEncoded)}
              </div>
              <div className="text-[11.5px] text-fg-faint font-mono mt-0.5">
                {r.sessionId.slice(0, 8)}
              </div>
            </div>
            <div className="text-[13.5px] text-fg-dim font-serif italic truncate">
              {Math.round(r.sizeBytes / 1024)}k transcript
            </div>
            <div className="text-[12px] text-fg-faint font-mono text-right whitespace-nowrap">
              {relativeTime(r.mtimeMs)}
            </div>
            <span className="text-[11px] font-semibold px-2 py-[3px] rounded-full text-sage bg-[#e5ecd8]">
              resume
            </span>
          </button>
        ))}
      </div>
    </section>
  )
}

function decodeProject(encoded: string): string {
  // Show the last path segment for compactness. Reuses useKnownProjects'
  // candidatePath so the encoded→path decode logic has one implementation.
  const parts = candidatePath(encoded).split('/').filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : encoded
}

function relativeTime(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

// ────────────────────────────────────────────────────────────────────
// Sessions pool (Session-Manager global guardrails)
// ────────────────────────────────────────────────────────────────────

type SlotSnapshot = { total: number; inUse: number; holders: { owner: string; at: string }[] }

/**
 * SessionsPoolCard — the machine-wide `claude -p` session pool owned by
 * Session-Manager (lib/sessionSlots.cjs). The scheduler and chat lanes both
 * request capacity from this one pool; this widget shows it live, plus the
 * guardrails and a first-run explainer of the TAB → EPIC → PRD model.
 */
function SessionsPoolCard() {
  const [slots, setSlots] = useState<SlotSnapshot | null>(null)

  useEffect(() => {
    let alive = true
    const poll = () => {
      window.api.schedule.sessionSlots()
        .then((s) => { if (alive) setSlots(s) })
        .catch(() => { /* pool surface is diagnostic-only */ })
    }
    poll()
    const id = setInterval(poll, 5000)
    return () => { alive = false; clearInterval(id) }
  }, [])

  const total = slots?.total ?? 3
  const inUse = slots?.inUse ?? 0

  return (
    <section className="mb-6">
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="m-0 font-serif text-[19px] font-semibold text-fg">Active sessions</h2>
        <span className="font-mono text-[12px] text-fg-faint">{inUse} of {total} slots in use</span>
      </div>
      <div className="border border-line rounded-xl bg-bg-hi px-[18px] py-4">
        {/* Slot dots */}
        <div className="flex items-center gap-2 mb-3" aria-label={`${inUse} of ${total} session slots in use`}>
          {Array.from({ length: total }, (_, i) => (
            <span
              key={i}
              className={`w-3.5 h-3.5 rounded-full border ${
                i < inUse ? 'bg-accent border-accent' : 'bg-bg border-line'
              }`}
            />
          ))}
          <span className="ml-2 text-[12.5px] text-fg-dim">
            {inUse === 0
              ? 'No headless Claude sessions running.'
              : slots!.holders.map((h) => h.owner).join(' · ')}
          </span>
        </div>
      </div>
    </section>
  )
}

// ────────────────────────────────────────────────────────────────────
// Scheduler peek
// ────────────────────────────────────────────────────────────────────
function SchedulerPeek({
  onNavigate, onOpenScheduler,
}: {
  onNavigate?: (k: NavKey) => void
  onOpenScheduler?: () => void
}) {
  const snap = useScheduleState((s) => s.snapshot)
  const jobs = (snap?.jobs ?? []).slice(0, 3)
  const openFull = () => {
    if (onNavigate) { onNavigate('scheduler' as NavKey); return }
    onOpenScheduler?.()
  }
  return (
    <section>
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="m-0 font-serif text-[22px] font-medium">In the scheduler</h2>
        <button
          onClick={openFull}
          className="text-[13px] text-accent font-medium hover:underline"
        >
          Open scheduler →
        </button>
      </div>
      {jobs.length === 0 ? (
        <div className="bg-bg-hi border border-line rounded-[14px] px-5 py-6 text-[13px] text-fg-faint text-center">
          No jobs queued. Draft a PRD to schedule one.
        </div>
      ) : (
        <div className="grid gap-3" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
          {jobs.map((j) => <JobCard key={j.slug} job={j} />)}
        </div>
      )}
    </section>
  )
}

function JobCard({ job }: { job: ScheduleJob }) {
  const state = job.status === 'running' ? 'running' : job.status === 'pending' ? 'queued' : job.status
  const isRunning = state === 'running'
  const eta = job.estimateMinutes ? `~${job.estimateMinutes} min` : 'queued'
  return (
    <div className="bg-bg-hi border border-line rounded-[12px] px-3.5 py-3">
      <div className="flex items-center justify-between mb-1.5">
        <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${
          isRunning
            ? 'bg-accent text-white'
            : 'bg-bg text-fg-dim border border-line'
        }`}>
          {state}
        </span>
        <span className="text-[11px] text-fg-faint font-mono">{eta}</span>
      </div>
      <div className="text-[12.5px] font-semibold text-fg truncate">{job.slug}</div>
      <div className="text-[12.5px] text-fg-dim font-serif italic mt-0.5 line-clamp-2">
        “{job.title}”
      </div>
    </div>
  )
}
