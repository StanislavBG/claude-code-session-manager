/**
 * Home — the "control room" Almanac landing page (design: Home Screen A).
 * Replaces Overview as the `overview` route.
 *
 * Sections (top to bottom):
 *   1. Hero — "This machine · N projects" kicker + live session-slot greeting,
 *      with the open "needs you" count as a jump-link, plus All history / New
 *      epic actions.
 *   2. Grid — 5h billing window card + Projects card + Queued (pending
 *      scheduler jobs) card.
 *   3. Needs you — real signals only (see lib/homeNeedsYou.ts): a `proposed`
 *      Epic awaiting Approve/Discard, a chat stopped on `needs-input`, or a
 *      scheduler job the queue itself flagged `failed`/`needs_review`. Each
 *      row expands inline with its real actions — nothing here is mocked.
 *   4. Active sessions — the machine session-slot pool's ≤3 holders, joined
 *      against running scheduler jobs / chat runs for context.
 *   5. Recent sessions — pulls `.claude/projects/*.jsonl` (same source as the
 *      History tab) and shows the 5 most-recent.
 *
 * Data sources are all existing zustand stores; nothing new on the backend.
 */

import { useMemo, useEffect, useState, type ReactNode } from 'react'
import type { NavKey } from '../LeftNav'
import { useBilling, getBillingData, refreshBilling } from '../../state/billing'
import { useScheduleState } from '../../state/scheduleState'
import { useSessions } from '../../state/sessions'
import { useLayout } from '../../state/layout'
import { usePromptSessions } from '../../state/promptSessions'
import { useChat } from '../../state/chat'
import { useChatSignals } from '../../lib/useChatSignals'
import { useHomeDir } from '../../lib/useHomeDir'
import { shellQuote } from '../../lib/presets'
import { candidatePath, useKnownProjects } from '../../lib/useKnownProjects'
import { buildHomeProjectRows } from '../../lib/homeProjectRows'
import { activeSessionRows, recentSessionEpicTitle } from '../../lib/homeSessionRows'
import { buildNeedsYouRows, type NeedsYouRow } from '../../lib/homeNeedsYou'
import { setPendingPromptSessionId } from '../../lib/promptSessionDeepLink'
import { projectColorFor } from '../../lib/projectColor'
import { UsageMeters } from './home/UsageMeters'
import { BillingStatusOverlay } from '../ui/BillingStatusBanner'
import { AGENT_TAG_DEFS, AGENT_TAG_ORDER } from '../../lib/agentTagDefs'
import { ticketTagTone } from '../../lib/ticketDisplay'
import { toast } from '../../state/toast'
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
  const { rows: knownProjectRows } = useKnownProjects()
  const needsRows = useNeedsYouRows()

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-[1080px] px-[34px] py-[26px] text-fg">
        <Hero greeting={greeting} projectCount={knownProjectRows.length} needsCount={needsRows.length} onNavigate={onNavigate} />
        <div className="grid gap-[18px] mb-7" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr) 220px' }}>
          <BillingCard />
          <ProjectsCard />
          <QueuedCard onNavigate={onNavigate} />
        </div>
        <NeedsYouSection rows={needsRows} onNavigate={onNavigate} />
        <ActiveSessionsCard onNavigate={onNavigate} />
        <RecentSessionsCard onNavigate={onNavigate} />
        <AgentsCard />
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
// Needs you — real signals only: a `proposed` Epic (the human gate that
// replaced the feedback folder), a chat mid-run and asking a question
// (`needs-input`), or a scheduler job the queue itself flagged `failed` /
// `needs_review`. See lib/homeNeedsYou.ts for the join.
// ────────────────────────────────────────────────────────────────────
function useNeedsYouRows(): NeedsYouRow[] {
  const sessions = usePromptSessions((s) => s.sessions)
  const chats = useChatSignals()
  const jobs = useScheduleState((s) => s.snapshot?.jobs) ?? EMPTY_JOBS
  return useMemo(() => {
    const proposed: Record<string, { id: string; cwd: string; goalText: string; tag?: string }> = {}
    for (const id of Object.keys(sessions)) {
      const s = sessions[id]
      if (s.status === 'proposed') proposed[id] = { id, cwd: s.cwd, goalText: s.goalText, tag: s.tag }
    }
    return buildNeedsYouRows(proposed, chats, jobs)
  }, [sessions, chats, jobs])
}

// ────────────────────────────────────────────────────────────────────
// Agents — the fixed set of Epic tags, each an "agent" grounded by its own
// initial-prompt template (agentTagDefs.ts). An Epic carries exactly one
// tag, chosen once at creation; this card is a read-only reference for what
// each tag actually seeds into the session, not a picker.
// ────────────────────────────────────────────────────────────────────
function AgentsCard() {
  return (
    <section className="mb-6">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="m-0 font-serif text-[22px] font-medium">Agents</h2>
        <span className="font-mono text-[12px] text-fg-faint">1 tag per Epic</span>
      </div>
      <div className="grid gap-2">
        {AGENT_TAG_ORDER.map((tag) => {
          const def = AGENT_TAG_DEFS[tag]
          const tone = ticketTagTone(tag)
          return (
            <div
              key={tag}
              className="bg-bg-hi border border-line rounded-[13px] px-4 py-[13px]"
            >
              <div className="flex items-center gap-2 mb-1.5">
                <span className={`font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] px-1.5 py-0.5 rounded ${tone.bg} ${tone.text}`}>
                  {tone.label}
                </span>
                <span className="text-[12px] text-fg-faint">{def.description}</span>
              </div>
              <p className="m-0 text-[12.5px] text-fg-dim leading-[1.5] font-mono whitespace-pre-wrap">
                {def.initialPromptTemplate}
              </p>
            </div>
          )
        })}
      </div>
    </section>
  )
}

// ────────────────────────────────────────────────────────────────────
// Hero — "This machine" kicker + greeting with live session-slot count.
// ────────────────────────────────────────────────────────────────────
function Hero({
  greeting,
  projectCount,
  needsCount,
  onNavigate,
}: {
  greeting: string
  projectCount: number
  needsCount: number
  onNavigate?: (k: NavKey) => void
}) {
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

  const total = slots?.total ?? 5
  const inUse = slots?.inUse ?? 0

  const scrollToNeeds = () => {
    document.getElementById('home-needs-you')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
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
        <HeroButton onClick={() => onNavigate?.('history')}>All history</HeroButton>
        <HeroButton primary onClick={() => onNavigate?.('terminal')}>New epic</HeroButton>
      </div>
    </header>
  )
}

function HeroButton({ children, onClick, primary }: { children: ReactNode; onClick: () => void; primary?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={
        primary
          ? 'rounded-lg bg-accent text-bg-hi px-4 py-2 text-[12.5px] font-semibold hover:bg-accent-dark'
          : 'rounded-lg border border-line bg-bg-hi px-4 py-2 text-[12.5px] font-semibold text-fg-dim hover:bg-bg-elev'
      }
    >
      {children}
    </button>
  )
}

// ────────────────────────────────────────────────────────────────────
// Needs you section — expandable rows, one card per real signal.
// ────────────────────────────────────────────────────────────────────
function NeedsYouSection({ rows, onNavigate }: { rows: NeedsYouRow[]; onNavigate?: (k: NavKey) => void }) {
  const [openId, setOpenId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const approve = (row: NeedsYouRow) => {
    if (!row.epicId || busyId) return
    setBusyId(row.id)
    try {
      const approved = usePromptSessions.getState().approveProposed(row.epicId, 'Home needs-you')
      if (!approved) {
        toast.error('This Epic is no longer awaiting approval.')
        return
      }
      useChat.getState().send({
        tabId: approved.id,
        sessionId: approved.claudeSessionId,
        cwd: approved.cwd,
        prompt: approved.openingPrompt || approved.goalText,
      })
      toast.info('Epic approved and started.')
    } finally {
      setBusyId(null)
      setOpenId(null)
    }
  }

  const discard = (row: NeedsYouRow) => {
    if (!row.epicId || busyId) return
    setBusyId(row.id)
    void usePromptSessions
      .getState()
      .markCompleted(row.epicId, 'Home needs-you discard')
      .catch((err) => toast.error(`Could not discard: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => { setBusyId(null); setOpenId(null) })
  }

  const openChat = (row: NeedsYouRow) => {
    if (!row.epicId) return
    setPendingPromptSessionId(row.epicId)
    onNavigate?.('terminal')
  }

  const retryJob = (row: NeedsYouRow) => {
    if (!row.jobSlug || busyId) return
    setBusyId(row.id)
    window.api.schedule
      .resetJob(row.jobSlug)
      .then((r) => { if (!r.ok) toast.error(r.error ?? 'Could not reset job.'); else toast.info(`${row.jobSlug} reset to pending.`) })
      .catch((err) => toast.error(err instanceof Error ? err.message : String(err)))
      .finally(() => { setBusyId(null); setOpenId(null) })
  }

  return (
    <section id="home-needs-you" className="mb-6 scroll-mt-4">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="m-0 font-serif text-[22px] font-medium">Needs you</h2>
        <span className="font-mono text-[12px] text-fg-faint">{rows.length ? `${rows.length} open` : 'all clear'}</span>
      </div>
      {rows.length === 0 && (
        <div className="bg-bg-hi border border-line rounded-[11px] px-4 py-[18px] text-center text-[13px] text-fg-faint">
          Nothing waiting on you. Proposed Epics, mid-run questions, and failed jobs will surface here.
        </div>
      )}
      <div className="grid gap-[7px]">
        {rows.map((row) => {
          const open = openId === row.id
          const tone = row.kind === 'job-failed' ? 'bg-accent' : row.kind === 'needs-input' ? 'bg-honey' : 'bg-sage'
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
                  <div className="flex gap-2">
                    {row.kind === 'proposed-epic' && (
                      <>
                        <NeedsButton onClick={() => approve(row)} disabled={busyId === row.id}>Approve &amp; start</NeedsButton>
                        <NeedsButton quiet onClick={() => discard(row)} disabled={busyId === row.id}>Discard</NeedsButton>
                      </>
                    )}
                    {row.kind === 'needs-input' && (
                      <NeedsButton onClick={() => openChat(row)}>Open session</NeedsButton>
                    )}
                    {row.kind === 'job-failed' && (
                      <>
                        <NeedsButton onClick={() => retryJob(row)} disabled={busyId === row.id}>Retry now</NeedsButton>
                        <NeedsButton quiet onClick={() => onNavigate?.('scheduler')}>View in Scheduler</NeedsButton>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}

function NeedsButton({
  children,
  onClick,
  disabled,
  quiet,
}: {
  children: ReactNode
  onClick: () => void
  disabled?: boolean
  quiet?: boolean
}) {
  return (
    <button
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
// ────────────────────────────────────────────────────────────────────
function QueuedCard({ onNavigate }: { onNavigate?: (k: NavKey) => void }) {
  const jobs = useScheduleState((s) => s.snapshot?.jobs) ?? EMPTY_JOBS
  const pending = useMemo(
    () => jobs.filter((j) => j.status === 'pending').slice(0, 4),
    [jobs],
  )
  return (
    <button
      onClick={() => onNavigate?.('scheduler')}
      className="text-left bg-bg-hi border border-line rounded-[14px] px-4 py-[14px]"
    >
      <div className="font-mono text-[11px] uppercase tracking-[0.08em] text-fg-faint mb-2.5">
        Queued
      </div>
      {pending.length === 0 ? (
        <div className="text-[13px] text-fg-faint py-1">Nothing pending.</div>
      ) : (
        <div className="space-y-2.5">
          {pending.map((q) => (
            <div key={q.slug}>
              <div className="font-mono text-[11.5px] font-semibold text-fg truncate">{q.title || q.slug}</div>
              <div className="text-[11px] text-fg-faint truncate">
                {q.cwd ? projectNameFromCwdLocal(q.cwd) : '—'}
                {q.estimateMinutes != null ? ` · ~${q.estimateMinutes}m` : ''}
              </div>
            </div>
          ))}
        </div>
      )}
    </button>
  )
}

function projectNameFromCwdLocal(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : cwd
}

// ────────────────────────────────────────────────────────────────────
// Session slot cap control — 0 (pause all new launches) to 10 (max
// allowed), default 5. Shared by ActiveSessionsCard below.
// ────────────────────────────────────────────────────────────────────
function SessionSlotCapControl({ slots }: { slots: SlotSnapshot | null }) {
  const min = slots?.min ?? 0
  const max = slots?.max ?? 10
  const total = slots?.total ?? 5
  const envOverride = slots?.envOverride ?? false
  const [pending, setPending] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const value = pending ?? total

  const commit = (n: number) => {
    setPending(n)
    setSaving(true)
    window.api.schedule.setSessionSlots(n)
      .catch(() => { /* Toast is reserved for user-triggered actions; snapshot poll will resync display */ })
      .finally(() => { setSaving(false); setPending(null) })
  }

  return (
    <span className="flex items-center gap-2.5 shrink-0" title={envOverride ? 'Pinned by SM_SESSION_SLOTS env var' : 'Max concurrent claude -p sessions on this machine (0 pauses new launches)'}>
      <span className="font-mono text-[11px] text-fg-faint">Max slots</span>
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        disabled={envOverride || saving}
        onChange={(e) => commit(Number(e.target.value))}
        className="w-24 accent-accent disabled:opacity-40 disabled:cursor-not-allowed"
      />
      <span className="font-mono text-[12px] font-semibold text-fg w-4 text-right">{value}</span>
    </span>
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
    // Opening a project from Home means "show me it" — lift the Epics
    // workspace overlay so the selected tab isn't masked (see layout.ts).
    useLayout.getState().setEpicsWorkspaceOpen(false)
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

type SlotSnapshot = {
  total: number; inUse: number; holders: { owner: string; at: string }[]
  min: number; max: number; default: number; envOverride: boolean
}

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

  const total = slots?.total ?? 5
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
        <span className="flex items-center gap-4">
          <span className="font-mono text-[12px] text-fg-faint">{inUse} of {total} slots in use</span>
          <SessionSlotCapControl slots={slots} />
        </span>
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
