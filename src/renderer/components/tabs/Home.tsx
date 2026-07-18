/**
 * Home — the Almanac landing page. Replaces Overview as the `overview` route.
 *
 * Sections (top to bottom):
 *   1. Hero — greeting + mascot + "Your local cockpit for Claude Code"
 *   2. Grid — 5h billing window card + Quick start card
 *   3. Recent sessions — pulls `.claude/projects/*.jsonl` (same source as the
 *      History tab) and shows the 4 most-recent.
 *   4. Scheduler peek — first 3 jobs from useScheduleState.
 *
 * Data sources are all existing zustand stores; nothing new on the backend.
 */

import { useEffect, useMemo, useState } from 'react'
import type { NavKey } from '../LeftNav'
import { useBilling, getBillingData } from '../../state/billing'
import { useScheduleState } from '../../state/scheduleState'
import { useSessions } from '../../state/sessions'
import { useHomeDir } from '../../lib/useHomeDir'
import { shellQuote } from '../../lib/presets'
import { candidatePath } from '../../lib/useKnownProjects'
import { AlmanacIcon } from '../layout/AlmanacIcon'
import type { DirEntry, ScheduleJob } from '../../../preload/api'

interface HomeProps {
  onNavigate?: (k: NavKey) => void
  onNewSession?: () => void
  onOpenVoice?: () => void
  onOpenScheduler?: () => void
}

export function Home({ onNavigate, onNewSession, onOpenVoice, onOpenScheduler }: HomeProps) {
  const greeting = useMemo(() => {
    const h = new Date().getHours()
    if (h < 5)  return 'Up late'
    if (h < 12) return 'Good morning'
    if (h < 18) return 'Good afternoon'
    return 'Good evening'
  }, [])

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-[1100px] px-10 py-9 text-fg">
        <Hero greeting={greeting} />
        <div className="grid gap-[18px] mb-7" style={{ gridTemplateColumns: '1.25fr 1fr' }}>
          <BillingWindowCard />
          <QuickStartCard
            onNewSession={onNewSession}
            onOpenVoice={onOpenVoice}
            onNavigate={onNavigate}
          />
        </div>
        <RecentSessionsCard onNavigate={onNavigate} />
        <SchedulerPeek onNavigate={onNavigate} onOpenScheduler={onOpenScheduler} />
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
// Hero
// ────────────────────────────────────────────────────────────────────
function Hero({ greeting }: { greeting: string }) {
  return (
    <header className="flex items-start gap-[18px] mb-7">
      <div className="w-14 h-14 rounded-[14px] bg-bg-hi border border-line grid place-items-center shadow-[0_2px_0_#e0d3b8]">
        <Mascot size={32} />
      </div>
      <div>
        <div className="text-[13px] text-fg-dim tracking-[0.01em]">{greeting}.</div>
        <h1 className="m-0 mt-0.5 mb-1.5 font-serif text-[38px] font-medium leading-[1.1] text-fg tracking-[-0.01em]">
          Your <em className="text-accent not-italic font-serif italic">local cockpit</em> for Claude Code.
        </h1>
        <p className="m-0 text-[15px] text-fg-dim max-w-[620px] leading-[1.5]">
          Wraps the CLI alongside skills, hooks, MCP servers, and a scheduler that runs jobs against your 5-hour window. Nothing here phones home.
        </p>
      </div>
    </header>
  )
}

function Mascot({ size = 28 }: { size?: number }) {
  // 8x8 pixel mascot — terracotta face on paper. Matches the design bundle's
  // SMMascot exactly (project/variants/shared.jsx) so the icon stays on-brand.
  const grid = [
    '00111100',
    '01111110',
    '11011011',
    '11111111',
    '11011011',
    '01111110',
    '00111100',
    '00100100',
  ]
  return (
    <svg width={size} height={size} viewBox="0 0 8 8" shapeRendering="crispEdges">
      {grid.map((row, y) =>
        row.split('').map((c, x) =>
          c === '1' ? <rect key={`${x},${y}`} x={x} y={y} width="1" height="1" fill="#b85c34" /> : null
        )
      )}
    </svg>
  )
}

// ────────────────────────────────────────────────────────────────────
// 5-hour billing window
// ────────────────────────────────────────────────────────────────────
function BillingWindowCard() {
  const billing = useBilling((s) => s.data)
  const data = getBillingData(billing)
  const fiveHour = data?.usage.five_hour ?? null
  const util = fiveHour?.utilization ?? 0
  const elapsedPct = Math.min(100, Math.max(0, util))
  const resetsAt = fiveHour?.resets_at ?? null
  const remaining = useCountdown(resetsAt)

  return (
    <div className="bg-bg-hi border border-line rounded-[14px] px-5 py-[18px]">
      <div className="flex items-baseline justify-between mb-2.5">
        <div className="flex items-center gap-2">
          <span className="text-accent inline-flex"><AlmanacIcon name="clock" size={16} /></span>
          <span className="font-serif text-[18px] font-medium">5-hour window</span>
        </div>
        <span className="font-mono text-[12px] text-fg-faint">
          {resetsAt ? `resets ${formatLocalTime(resetsAt)}` : '—'}
        </span>
      </div>
      <div className="h-2.5 bg-bg rounded-full overflow-hidden border border-rule">
        <div
          className="h-full transition-[width] duration-300"
          style={{
            width: `${elapsedPct}%`,
            background: 'linear-gradient(90deg, #b85c34, #e8a988)',
          }}
        />
      </div>
      <div className="flex justify-between mt-3 text-[13px] text-fg-dim">
        <span>
          <strong className="text-fg font-mono">{Math.round(util)}%</strong> used
        </span>
        <span className="text-sage">{remaining ?? '—'} remaining</span>
      </div>
    </div>
  )
}

function useCountdown(iso: string | null): string | null {
  const [, force] = useState(0)
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 30_000)
    return () => clearInterval(id)
  }, [])
  if (!iso) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  const diff = t - Date.now()
  if (diff <= 0) return '0m'
  const h = Math.floor(diff / 3_600_000)
  const m = Math.floor((diff % 3_600_000) / 60_000)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

function formatLocalTime(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  } catch { return '' }
}

// ────────────────────────────────────────────────────────────────────
// Quick start
// ────────────────────────────────────────────────────────────────────
function QuickStartCard({
  onNewSession, onOpenVoice, onNavigate,
}: {
  onNewSession?: () => void
  onOpenVoice?: () => void
  onNavigate?: (k: NavKey) => void
}) {
  const actions = [
    { id: 'new',    label: 'Start a session',  hint: 'Open Claude Code in a project',  icon: 'play'    as const, run: () => onNewSession?.() },
    { id: 'resume', label: 'Resume last',      hint: 'Reattach to a recent session',   icon: 'sparkle' as const, run: () => onNavigate?.('history') },
    { id: 'plan',   label: 'Draft a PRD',      hint: 'Plan a job for the scheduler',   icon: 'book'    as const, run: () => onNavigate?.('scheduler') },
    { id: 'invite', label: 'Add a project',    hint: 'Point me at a folder on disk',   icon: 'plus'    as const, run: () => onNavigate?.('projects') },
  ]
  return (
    <div className="bg-bg-hi border border-line rounded-[14px] px-4 py-[14px]">
      <div className="flex items-center justify-between mb-2">
        <div className="font-serif text-[17px] font-medium">Quick start</div>
        <button
          title="Voice (Whisper)"
          onClick={() => onOpenVoice?.()}
          className="w-[30px] h-[30px] rounded-lg border border-line bg-bg grid place-items-center text-accent hover:bg-bg-hi/70 transition-colors"
        >
          <AlmanacIcon name="mic" size={15} />
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {actions.map((a) => (
          <button
            key={a.id}
            onClick={a.run}
            className="text-left bg-bg border border-line rounded-[10px] px-3 py-2.5 hover:border-accent/40 hover:bg-bg-hi/40 transition-colors"
          >
            <div className="flex items-center gap-2">
              <span className="text-accent inline-flex"><AlmanacIcon name={a.icon} size={14} /></span>
              <span className="text-[13px] font-semibold text-fg">{a.label}</span>
            </div>
            <div className="text-[11.5px] text-fg-faint mt-0.5">{a.hint}</div>
          </button>
        ))}
      </div>
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
