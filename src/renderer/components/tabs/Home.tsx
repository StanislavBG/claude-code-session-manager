/**
 * Home — the Almanac landing page. Replaces Overview as the `overview` route.
 *
 * Sections (top to bottom):
 *   1. Hero — "This machine" kicker + live session-slot greeting.
 *   2. Grid — 5h billing window card + Projects card.
 *   3. Active sessions — the machine session-slot pool's ≤3 holders, joined
 *      against running scheduler jobs / chat runs for context.
 *   4. Recent sessions — pulls `.claude/projects/*.jsonl` (same source as the
 *      History tab) and shows the 5 most-recent.
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
import { activeSessionRows, recentSessionEpicTitle } from '../../lib/homeSessionRows'
import { setPendingPromptSessionId } from '../../lib/promptSessionDeepLink'
import { projectColorFor } from '../../lib/projectColor'
import { UsageMeters } from './home/UsageMeters'
import { BillingStatusOverlay } from '../ui/BillingStatusBanner'
import type { DirEntry, ScheduleJob } from '../../../preload/api'

const EMPTY_JOBS: ScheduleJob[] = []


interface HomeProps {
  onNavigate?: (k: NavKey) => void
  onNewSession?: () => void
  onOpenVoice?: () => void
  onOpenScheduler?: () => void
}

export function Home({ onNavigate }: HomeProps) {
  const greeting = useMemo(() => {
    const h = new Date().getHours()
    if (h < 5)  return 'Up late'
    if (h < 12) return 'Good morning'
    if (h < 18) return 'Good afternoon'
    return 'Good evening'
  }, [])

  useHydrateKnownEpics()

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-[1080px] px-[34px] py-[26px] text-fg">
        <Hero greeting={greeting} />
        <div className="grid gap-[18px] mb-7" style={{ gridTemplateColumns: 'minmax(0,1fr) 300px' }}>
          <BillingCard />
          <ProjectsCard />
        </div>
        <ActiveSessionsCard onNavigate={onNavigate} />
        <RecentSessionsCard onNavigate={onNavigate} />
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
// Epic hydration — active + archived PromptSessions for every known cwd, so
// Active/Recent sessions can resolve Epic titles. Mirrors EpicsWorkspace's
// knownCwds hydrate loop.
// ────────────────────────────────────────────────────────────────────
function useHydrateKnownEpics(): void {
  const { rows, enriched } = useKnownProjects()
  const knownCwdsKey = useMemo(
    () => rows.map((r) => enriched[r.encoded]?.cwd ?? r.displayPath).join('\n'),
    [rows, enriched],
  )
  useEffect(() => {
    for (const cwd of knownCwdsKey ? knownCwdsKey.split('\n') : []) {
      void usePromptSessions.getState().hydrate(cwd)
      void usePromptSessions.getState().hydrateArchived(cwd)
    }
  }, [knownCwdsKey])
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

const RECENT_SESSIONS_GRID = '92px minmax(0,1.2fr) minmax(0,1fr) 80px 74px 78px'

function RecentSessionsCard({ onNavigate }: { onNavigate?: (k: NavKey) => void }) {
  const { rows, loading } = useRecentSessions(5)
  const addTab = useSessions((s) => s.addTab)
  const sessions = usePromptSessions((s) => s.sessions)
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
        {rows.map((r, i) => {
          const epicTitle = recentSessionEpicTitle(r.sessionId, sessions)
          return (
            <div
              key={r.path}
              className="grid items-center gap-3.5 px-[18px] py-[11px]"
              style={{ gridTemplateColumns: RECENT_SESSIONS_GRID, borderTop: i ? '1px solid #d9c9a8' : 'none' }}
            >
              <span className="text-[11.5px] text-fg-faint font-mono truncate">{r.sessionId.slice(0, 8)}</span>
              <span className="text-[12.5px] font-semibold text-fg truncate" title={r.projectEncoded}>
                {decodeProject(r.projectEncoded)}
              </span>
              <span className="text-[12.5px] text-fg-dim truncate">{epicTitle ?? '—'}</span>
              <span className="text-[11.5px] text-fg-faint font-mono text-right">
                {Math.round(r.sizeBytes / 1024)}k
              </span>
              <span className="text-[11px] text-fg-faint font-mono text-right">{relativeTime(r.mtimeMs)}</span>
              <button
                onClick={() => resume(r)}
                className="justify-self-end text-[12px] font-semibold px-[11px] py-[5px] rounded-lg text-sage bg-[#e5ecd8] hover:brightness-95 transition-[filter]"
                title={`Resume ${r.sessionId.slice(0, 8)}…`}
              >
                resume
              </button>
            </div>
          )
        })}
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
// Active sessions — the machine-wide `claude -p` session-slot pool
// (lib/sessionSlots.cjs) joined against running scheduler jobs / chat runs.
// ────────────────────────────────────────────────────────────────────

type SlotSnapshot = { total: number; inUse: number; holders: { owner: string; at: string }[] }

function ActiveSessionsCard({ onNavigate }: { onNavigate?: (k: NavKey) => void }) {
  const [slots, setSlots] = useState<SlotSnapshot | null>(null)
  const jobs = useScheduleState((s) => s.snapshot?.jobs) ?? EMPTY_JOBS
  const chats = useChatSignals()
  const sessions = usePromptSessions((s) => s.sessions)

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
  const runningJobs = useMemo(() => jobs.filter((j) => j.status === 'running'), [jobs])
  const rows = useMemo(
    () => activeSessionRows(slots?.holders ?? [], runningJobs, chats, sessions),
    [slots, runningJobs, chats, sessions],
  )

  const open = (row: ReturnType<typeof activeSessionRows>[number]) => {
    if (row.openTarget === 'scheduler') { onNavigate?.('scheduler'); return }
    if (row.openTarget === 'terminal' && row.epicId) {
      setPendingPromptSessionId(row.epicId)
      onNavigate?.('terminal')
    }
  }

  return (
    <section className="mb-6">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="m-0 font-serif text-[22px] font-medium">Active sessions</h2>
        <span className="font-mono text-[12px] text-fg-faint">{inUse} of {total} slots in use</span>
      </div>
      {rows.length === 0 ? (
        <div className="text-[13px] text-fg-faint py-1">No headless Claude sessions running.</div>
      ) : (
        <div className="grid gap-2">
          {rows.map((row) => (
            <div
              key={row.owner}
              className="bg-bg-hi border border-line rounded-[13px] px-4 py-[13px] grid items-center gap-3.5"
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
                <span className="font-mono text-[11px] text-fg-faint">{relativeTime(new Date(row.at).getTime())}</span>
                {row.openTarget && (
                  <button
                    onClick={() => open(row)}
                    className="border border-line bg-bg rounded-lg px-[11px] py-[5px] text-[12px] font-semibold text-fg-dim hover:bg-bg/60 transition-colors"
                  >
                    Open
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
