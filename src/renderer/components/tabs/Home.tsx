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
import { buildHomeProjectRows, type HomeProjectRow } from '../../lib/homeProjectRows'
import { activeSessionRows, recentSessionEpicTitle, type ActiveSessionRow } from '../../lib/homeSessionRows'
import { buildNeedsYouRows, type NeedsYouRow } from '../../lib/homeNeedsYou'
import { setPendingPromptSessionId } from '../../lib/promptSessionDeepLink'
import { projectColorFor } from '../../lib/projectColor'
import { openProjectTab } from '../../lib/homeOpenProject'
import { UsageMeters } from './home/UsageMeters'
import { HomeSessionDrawer, type DrawerKeyVal, type DrawerTailLine } from './home/HomeSessionDrawer'
import { NewEpicProjectDrawer } from './home/NewEpicProjectDrawer'
import { QueuedJobPopover, type QueuedJobPopoverJob } from './home/QueuedJobPopover'
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
  const projectRows = useHomeProjectRows()
  const tabs = useSessions((s) => s.tabs)
  const addTab = useSessions((s) => s.addTab)
  const setActive = useSessions((s) => s.setActive)
  const [newEpicOpen, setNewEpicOpen] = useState(false)

  const confirmNewEpicProject = (cwd: string) => {
    openProjectTab(cwd, tabs, addTab, setActive)
    onNavigate?.('terminal')
  }

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-[1080px] px-[34px] py-[26px] text-fg">
        <HomeHeaderWithLegend
          greeting={greeting}
          projectCount={knownProjectRows.length}
          needsCount={needsRows.length}
          onNavigate={onNavigate}
          onOpenNewEpic={() => setNewEpicOpen(true)}
        />
        <div className="grid gap-[18px] mb-7" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr) 220px' }}>
          <BillingCard />
          <ProjectsCard projectRows={projectRows} />
          <QueuedCard onNavigate={onNavigate} />
        </div>
        <NeedsYouSection rows={needsRows} onNavigate={onNavigate} />
        <ActiveSessionsCard onNavigate={onNavigate} />
        <RecentSessionsCard onNavigate={onNavigate} />
        <AgentsCard />
      </div>
      <NewEpicProjectDrawer
        open={newEpicOpen}
        onClose={() => setNewEpicOpen(false)}
        projects={projectRows}
        onConfirm={confirmNewEpicProject}
      />
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
// Home project rows — single source for both ProjectsCard and the New-epic
// project picker drawer, so "known projects" is computed once (useKnownProjects
// + running chats + Epic sessions, via buildHomeProjectRows) rather than the
// picker growing its own divergent copy.
// ────────────────────────────────────────────────────────────────────
function useHomeProjectRows(): HomeProjectRow[] {
  const { rows, enriched } = useKnownProjects()
  const chats = useChatSignals()
  const sessions = usePromptSessions((s) => s.sessions)
  return useMemo(
    () => buildHomeProjectRows(rows, enriched, chats, sessions),
    [rows, enriched, chats, sessions],
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
// Hero + Interactions legend toggle — owns the legend's open/closed state
// so it can be mounted (and its toggle tested) without every other Home
// section's store dependencies. Exported for Home.interactionsLegend.test.tsx.
// ────────────────────────────────────────────────────────────────────
export function HomeHeaderWithLegend({
  greeting,
  projectCount,
  needsCount,
  onNavigate,
  onOpenNewEpic,
}: {
  greeting: string
  projectCount: number
  needsCount: number
  onNavigate?: (k: NavKey) => void
  onOpenNewEpic: () => void
}) {
  const [legendOpen, setLegendOpen] = useState(false)
  return (
    <>
      <Hero
        greeting={greeting}
        projectCount={projectCount}
        needsCount={needsCount}
        onNavigate={onNavigate}
        onOpenNewEpic={onOpenNewEpic}
        legendOpen={legendOpen}
        onToggleLegend={() => setLegendOpen((v) => !v)}
      />
      {legendOpen && <InteractionsLegend />}
    </>
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
  onOpenNewEpic,
  legendOpen,
  onToggleLegend,
}: {
  greeting: string
  projectCount: number
  needsCount: number
  onNavigate?: (k: NavKey) => void
  onOpenNewEpic: () => void
  legendOpen: boolean
  onToggleLegend: () => void
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
        <HeroButton onClick={onToggleLegend}>{legendOpen ? 'Hide interactions' : 'Interactions'}</HeroButton>
        <HeroButton onClick={() => onNavigate?.('history')}>All history</HeroButton>
        <HeroButton primary onClick={onOpenNewEpic}>New epic</HeroButton>
      </div>
    </header>
  )
}

// ────────────────────────────────────────────────────────────────────
// Interactions legend — a reference panel explaining what each interactive
// element on this page actually does. Adapted from the Home Screen A mock's
// `legend` panel (variants/home-a.jsx), but every line below describes a
// REAL wired action in this codebase — no fictional Pace chart / breakdown
// popovers, which this Epic deliberately did not build (see file header).
// ────────────────────────────────────────────────────────────────────
const INTERACTIONS_LEGEND: { term: string; description: string }[] = [
  { term: 'Usage card', description: 'Read-only — shows the live 5-hour and weekly billing windows. Not clickable.' },
  { term: 'Queued job', description: 'Click a job row to open a popover with its real details (project, estimate, status) and actions — Open in Scheduler, plus Nudge scheduler now while it\'s pending. Use "Open Scheduler →" in the card header to jump straight to the Scheduler tab.' },
  { term: 'Needs-you row', description: 'Click a row to expand it inline, then Approve & start / Discard a proposed Epic, Open a session waiting on input, or Retry / view a failed job.' },
  { term: 'Active session row', description: 'Click Open to jump to the Scheduler tab (job) or the session\'s Terminal view (Epic).' },
  { term: 'Recent row', description: 'Click resume to open a new Terminal tab that resumes that transcript session.' },
  { term: 'Project row', description: 'Click a project to activate its open Terminal tab, or open a new dormant one.' },
  { term: 'New epic', description: 'Opens a project picker; confirming activates-or-opens that project\'s tab and lands you in its Epics workspace to start the Epic.' },
]

function InteractionsLegend() {
  return (
    <div className="mb-7 bg-bg-hi border border-line rounded-[13px] px-4 py-[13px]">
      <div className="font-mono text-[11px] uppercase tracking-[0.08em] text-fg-faint mb-2.5">
        Interactions
      </div>
      <div className="grid gap-2" style={{ gridTemplateColumns: 'minmax(0,140px) minmax(0,1fr)' }}>
        {INTERACTIONS_LEGEND.map((row) => (
          <div key={row.term} className="contents">
            <div className="text-[12.5px] font-semibold text-fg underline decoration-dotted underline-offset-4">{row.term}</div>
            <div className="text-[12.5px] text-fg-dim leading-[1.5]">{row.description}</div>
          </div>
        ))}
      </div>
    </div>
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
// Exported for a direct regression test (Home.queuedCard.test.tsx) covering
// both the pre-hydrate (snapshot === null) and empty-snapshot states — the
// EMPTY_JOBS fallback above already makes both render 'Nothing pending.'
// rather than a blank card; the test locks that behavior in.
// ────────────────────────────────────────────────────────────────────
export function QueuedCard({ onNavigate }: { onNavigate?: (k: NavKey) => void }) {
  const jobs = useScheduleState((s) => s.snapshot?.jobs) ?? EMPTY_JOBS
  const pending = useMemo(
    () => jobs.filter((j) => j.status === 'pending').slice(0, 4),
    [jobs],
  )
  const [openSlug, setOpenSlug] = useState<string | null>(null)

  const runNow = () => {
    window.api.schedule.runNow()
      .catch((err) => toast.error(err instanceof Error ? err.message : String(err)))
    setOpenSlug(null)
  }

  return (
    <div className="bg-bg-hi border border-line rounded-[14px] px-4 py-[14px]">
      <div className="flex items-center justify-between mb-2.5">
        <div className="font-mono text-[11px] uppercase tracking-[0.08em] text-fg-faint">
          Queued
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
          {pending.map((q) => (
            <div key={q.slug} className="relative">
              <button
                onClick={() => setOpenSlug(openSlug === q.slug ? null : q.slug)}
                className="w-full text-left hover:bg-bg/40 rounded-md -mx-1 px-1 py-0.5 transition-colors"
              >
                <div className="font-mono text-[11.5px] font-semibold text-fg truncate">{q.title || q.slug}</div>
                <div className="text-[11px] text-fg-faint truncate">
                  {q.cwd ? projectNameFromCwdLocal(q.cwd) : '—'}
                  {q.estimateMinutes != null ? ` · ~${q.estimateMinutes}m` : ''}
                </div>
              </button>
              {openSlug === q.slug && (
                <QueuedJobPopover
                  job={q as QueuedJobPopoverJob}
                  onClose={() => setOpenSlug(null)}
                  onOpenScheduler={() => { setOpenSlug(null); onNavigate?.('scheduler') }}
                  onRunNow={q.status === 'pending' ? runNow : undefined}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
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
function ProjectsCard({ projectRows }: { projectRows: HomeProjectRow[] }) {
  const tabs = useSessions((s) => s.tabs)
  const addTab = useSessions((s) => s.addTab)
  const setActive = useSessions((s) => s.setActive)

  const openProject = (cwd: string) => {
    openProjectTab(cwd, tabs, addTab, setActive)
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

export function RecentSessionsCard({ onNavigate }: { onNavigate?: (k: NavKey) => void }) {
  const { rows, loading } = useRecentSessions(5)
  const addTab = useSessions((s) => s.addTab)
  const sessions = usePromptSessions((s) => s.sessions)
  const [drawerRow, setDrawerRow] = useState<RecentRow | null>(null)
  const resume = (r: RecentRow) => {
    const decoded = candidatePath(r.projectEncoded)
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
        { label: 'Project', value: decodeProject(drawerRow.projectEncoded) },
        { label: 'Epic', value: drawerEpicTitle ?? '—' },
        { label: 'Last activity', value: `${absoluteTime(drawerRow.mtimeMs)} (${relativeTime(drawerRow.mtimeMs)})` },
        { label: 'Size', value: `${Math.round(drawerRow.sizeBytes / 1024)}k` },
      ]
    : []
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
            <button
              key={r.path}
              onClick={() => setDrawerRow(r)}
              className="w-full grid items-center gap-3.5 px-[18px] py-[11px] text-left hover:bg-bg/40 transition-colors"
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
              <span
                className="justify-self-end text-[12px] font-semibold px-[11px] py-[5px] rounded-lg text-sage bg-[#e5ecd8]"
                title={`Open ${r.sessionId.slice(0, 8)}…`}
              >
                details
              </span>
            </button>
          )
        })}
      </div>
      <HomeSessionDrawer
        open={drawerRow != null}
        onClose={() => setDrawerRow(null)}
        title={drawerEpicTitle ?? (drawerRow ? decodeProject(drawerRow.projectEncoded) : '')}
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

function decodeProject(encoded: string): string {
  // Show the last path segment for compactness. Reuses useKnownProjects'
  // candidatePath so the encoded→path decode logic has one implementation.
  const parts = candidatePath(encoded).split('/').filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : encoded
}

function absoluteTime(ms: number): string {
  return new Date(ms).toLocaleString()
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

export function ActiveSessionsCard({ onNavigate }: { onNavigate?: (k: NavKey) => void }) {
  const [slots, setSlots] = useState<SlotSnapshot | null>(null)
  const jobs = useScheduleState((s) => s.snapshot?.jobs) ?? EMPTY_JOBS
  const chats = useChatSignals()
  const sessions = usePromptSessions((s) => s.sessions)
  const [drawerRow, setDrawerRow] = useState<ActiveSessionRow | null>(null)

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
  // Why the queue is running narrower than the pool. Sourced entirely from the
  // scheduler's own last-tick record — never recomputed here, and deliberately
  // silent when the queue is simply idle so an empty queue can't read as a
  // blocked one.
  const lastTick = useScheduleState((s) => s.snapshot?.lastTick)
  const constraint = useMemo(() => {
    if (!lastTick || lastTick.fired) return null
    const pending = jobs.filter((j) => j.status === 'pending').length
    if (pending === 0) return null
    switch (lastTick.reason) {
      case 'memory-deferred':
        return `memory gate: ${lastTick.availableMb} MB free, need ${lastTick.threshold} MB`
      case 'slots-exhausted':
        return `all ${total} slots busy — ${lastTick.deferredCount ?? pending} pending`
      case 'held': {
        const n = lastTick.holds?.length ?? 0
        return n > 0
          ? `${n} pending held behind dependencies`
          : (lastTick.detail ?? 'held')
      }
      case 'paused':
        return 'scheduler paused'
      default:
        return null
    }
  }, [lastTick, jobs, total])
  const rows = useMemo(
    () => activeSessionRows(slots?.holders ?? [], runningJobs, chats, sessions),
    [slots, runningJobs, chats, sessions],
  )

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
        { label: 'Started', value: `${absoluteTime(new Date(drawerRow.at).getTime())} (${relativeTime(new Date(drawerRow.at).getTime())})` },
      ]
    : []

  return (
    <section className="mb-6">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="m-0 font-serif text-[22px] font-medium">Active sessions</h2>
        <span className="flex items-center gap-4">
          <span className="font-mono text-[12px] text-fg-faint">
            {inUse} of {total} slots in use
            {constraint && <span className="ml-2 text-amber-400/90">· {constraint}</span>}
          </span>
          <SessionSlotCapControl slots={slots} />
        </span>
      </div>
      {rows.length === 0 ? (
        <div className="text-[13px] text-fg-faint py-1">No headless Claude sessions running.</div>
      ) : (
        <div className="grid gap-2">
          {rows.map((row) => (
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
                <span className="font-mono text-[11px] text-fg-faint">{relativeTime(new Date(row.at).getTime())}</span>
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
