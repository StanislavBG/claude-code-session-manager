/**
 * ProjectHome — "The Brief" for the active project (NavKey `project-home`).
 *
 * Renders PRD 837's backend (`window.api.projectBrief`) on top of PRD 839's
 * live Now/Waiting-on-you blocks: header card (purpose, refresh, provenance
 * chips), the synthesized What/Structure/Scope/Conventions blocks, and the
 * no-brief-yet "Generate the brief" empty state — same code path as Refresh.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSessions } from '../../../state/sessions'
import { usePromptSessions } from '../../../state/promptSessions'
import { useChatSignals } from '../../../lib/useChatSignals'
import { useScheduleState } from '../../../state/scheduleState'
import { useScheduledPrds } from '../../../lib/useScheduledPrds'
import { inFlightCards, openQuestions } from '../../../lib/projectHomeDerive'
import { setPendingPromptSessionId } from '../../../lib/promptSessionDeepLink'
import {
  formatSourceChip,
  heatPercent,
  safeList,
  scopeTone,
  synthesizedAgoLabel,
  tokenizeMd,
} from '../../../lib/projectBriefView'
import type { EpicSnapshots } from '../../../lib/epicDerive'
import type {
  ProjectBrief,
  ProjectBriefPinnableBlock,
  ProjectBriefSource,
  ScheduleJob,
} from '../../../../preload/api'
import { EpicStatusChip } from '../../epics/epic-primitives'
import { AlmanacIcon } from '../../layout/AlmanacIcon'
import { EmptyState } from '../../ui/EmptyState'
import { toast } from '../../../state/toast'
import { PhBlock, PhCard } from './ph-primitives'

const EMPTY_JOBS: ScheduleJob[] = []

function projectNameFromCwd(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean)
  return parts[parts.length - 1] || cwd
}

function answerInEpic(epicId: string): void {
  setPendingPromptSessionId(epicId)
  window.dispatchEvent(new CustomEvent('sm:navigate', { detail: 'terminal' }))
}

function PhNow({ cwd, snapshots }: { cwd: string; snapshots: EpicSnapshots }) {
  const cards = useMemo(() => inFlightCards(cwd, snapshots), [cwd, snapshots])
  return (
    <PhBlock kicker="now" title="What is in flight" note="Live from the Epic queue — this block is never hand-written.">
      {cards.length === 0 ? (
        <p className="text-xs text-fg-faint">No Epics in flight.</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
          {cards.map((card) => (
            <PhCard key={card.epicId} className="px-4 py-3.5 grid gap-1.5">
              <EpicStatusChip status={card.status} small />
              <span className="text-sm font-semibold text-fg leading-tight">{card.title}</span>
              <span className="text-xs text-fg-faint leading-relaxed">{card.note}</span>
            </PhCard>
          ))}
        </div>
      )}
    </PhBlock>
  )
}

function PhOpenQuestions({
  cwd,
  sessions,
  chats,
}: {
  cwd: string
  sessions: EpicSnapshots['sessions']
  chats: EpicSnapshots['chats']
}) {
  const questions = useMemo(() => openQuestions(cwd, sessions, chats), [cwd, sessions, chats])
  if (questions.length === 0) return null
  return (
    <PhBlock kicker="open" title="Waiting on you" note="Questions the last run could not resolve on its own.">
      <div className="grid gap-2.5">
        {questions.map((q) => (
          <div key={q.ticketId} className="rounded-xl border border-accent-dark/30 bg-accent/10 px-4 py-3.5">
            <div className="text-sm text-fg leading-relaxed">{q.question}</div>
            <div className="mt-2.5 flex items-center justify-between gap-3">
              <span className="font-mono text-[10.5px] text-fg-faint">Epic · {q.epicGoalText}</span>
              <button
                type="button"
                onClick={() => answerInEpic(q.epicId)}
                className="shrink-0 rounded-md border border-line bg-bg-hi px-2.5 py-1 text-xs font-semibold text-fg-dim hover:text-fg"
              >
                Answer in Epic →
              </button>
            </div>
          </div>
        ))}
      </div>
    </PhBlock>
  )
}

// ── mini-markdown span renderer (PhMd) ────────────────────────────────────
function PhMd({ text }: { text: string }) {
  return (
    <>
      {tokenizeMd(text).map((tok, i) => {
        if (tok.type === 'bold') {
          return (
            <strong key={i} className="font-semibold text-fg">
              {tok.text}
            </strong>
          )
        }
        if (tok.type === 'code') {
          return (
            <code key={i} className="font-mono text-[0.92em] bg-bg border border-rule rounded px-[5px] py-px">
              {tok.text}
            </code>
          )
        }
        return <span key={i}>{tok.text}</span>
      })}
    </>
  )
}

// ── header: identity + provenance + refresh ───────────────────────────────
function PhHeader({
  brief,
  sources,
  projectName,
  refreshing,
  onRefresh,
}: {
  brief: ProjectBrief | null
  sources: ProjectBriefSource[]
  projectName: string
  refreshing: boolean
  onRefresh: () => void
}) {
  const now = Date.now()
  return (
    <div className="rounded-xl border border-line bg-bg-hi px-6 py-5 mb-6">
      <div className="flex items-start gap-4">
        <div className="min-w-0">
          <div className="font-mono text-[10px] font-semibold uppercase tracking-wide text-fg-faint mb-2">
            The Brief
          </div>
          <h1 className="font-serif text-[26px] font-semibold text-fg leading-tight max-w-[760px]">
            {brief?.purpose || projectName}
          </h1>
        </div>
        <div className="ml-auto text-right shrink-0">
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-semibold ${
              refreshing ? 'bg-accent-muted/60 text-fg-dim cursor-default' : 'bg-accent text-bg-hi cursor-pointer hover:bg-accent-dark'
            }`}
          >
            <span className={`inline-flex ${refreshing ? 'animate-spin' : ''}`}>
              <AlmanacIcon name="reload" size={14} />
            </span>
            {refreshing ? 'Re-reading the project…' : 'Refresh brief'}
          </button>
          <div className="font-mono text-[10.5px] text-fg-faint mt-2 leading-relaxed">
            {synthesizedAgoLabel(brief?.synthesizedAt, now)}
            {brief && (
              <>
                <br />
                by {brief.model}
              </>
            )}
          </div>
        </div>
      </div>
      {sources.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-4 pt-3.5 border-t border-rule">
          <span className="font-mono text-[10px] font-semibold uppercase tracking-wide text-fg-faint self-center mr-1">
            read from
          </span>
          {sources.map((s) => {
            const chip = formatSourceChip(s)
            return (
              <span
                key={chip.label}
                className={`inline-flex items-center gap-1.5 bg-bg border rounded-full px-2.5 py-1 ${
                  chip.drift ? 'border-accent-dark/50' : 'border-rule'
                }`}
              >
                <span className="font-mono text-[11px] font-semibold text-fg-dim">{chip.label}</span>
                <span className="text-[11px] text-fg-faint">{chip.detail}</span>
                {chip.driftMark && (
                  <span className="font-mono text-[10px] font-semibold text-accent-dark">{chip.driftMark}</span>
                )}
              </span>
            )
          })}
        </div>
      )}
    </div>
  )
}

function PhWhat({ paragraphs, pinned, onPin }: { paragraphs: string[]; pinned: boolean; onPin: () => void }) {
  return (
    <PhBlock
      kicker="the project"
      title="What this is"
      pinned={pinned}
      onPin={onPin}
      note="Generated summary. Pin it once it reads right and refreshes will leave it alone."
    >
      <PhCard className="px-5 py-4 grid gap-3">
        {paragraphs.map((p, i) => (
          <p key={i} className="text-sm leading-relaxed text-fg-dim max-w-[780px]">
            <PhMd text={p} />
          </p>
        ))}
      </PhCard>
    </PhBlock>
  )
}

function PhAreas({ areas }: { areas: ProjectBrief['areas'] }) {
  return (
    <PhBlock kicker="structure" title="How it is put together" note="Areas inferred from the tree and from which Epic has been editing them.">
      <PhCard className="overflow-hidden">
        {areas.map((a, i) => (
          <div
            key={a.name}
            className={`grid gap-4 items-center px-4 py-3 grid-cols-[minmax(0,1.5fr)_minmax(0,1.15fr)_116px] ${i > 0 ? 'border-t border-rule' : ''}`}
          >
            <span className="min-w-0">
              <span className="flex items-baseline gap-2">
                <span className="font-mono text-xs font-semibold text-fg">{a.name}</span>
                <span className="font-mono text-[11px] text-fg-faint">{a.files} files</span>
              </span>
              <span className="block text-xs text-fg-dim leading-relaxed mt-0.5">{a.note}</span>
            </span>
            <span className={`min-w-0 text-xs leading-snug ${a.epic ? 'text-fg-dim' : 'text-fg-faint'}`}>
              {a.epic ? (
                <>
                  <span className="font-mono text-[10px] uppercase tracking-wide text-fg-faint block mb-0.5">touched by</span>
                  {a.epic}
                </>
              ) : (
                <span className="font-mono text-[11px]">no open Epic</span>
              )}
            </span>
            <span className="flex items-center gap-2">
              <span className="flex-1 h-1.5 bg-bg border border-rule rounded-full overflow-hidden">
                <span className="block h-full bg-accent/70" style={{ width: `${heatPercent(a.heat)}%` }} />
              </span>
              <span className="font-mono text-[10.5px] text-fg-faint w-6 text-right">{heatPercent(a.heat)}</span>
            </span>
          </div>
        ))}
      </PhCard>
    </PhBlock>
  )
}

function PhScope({ scope }: { scope: ProjectBrief['scope'] }) {
  return (
    <PhBlock kicker="scope" title="How the goal has moved" note="Corrections and CLAUDE.md changes, newest first — the reason the brief above says what it says.">
      <div className="grid">
        {scope.map((s, i) => {
          const tone = scopeTone(s.kind)
          return (
            <div key={i} className="grid gap-3.5 items-start py-3 border-t border-rule grid-cols-[92px_84px_minmax(0,1fr)]">
              <span className="font-mono text-[11px] text-fg-faint pt-0.5">{s.when}</span>
              <span className={`font-mono text-[10px] font-semibold uppercase tracking-wide rounded border px-1.5 py-0.5 justify-self-start mt-px ${tone.textClass} ${tone.borderClass}`}>
                {tone.label}
              </span>
              <span>
                <span className="block text-sm text-fg leading-relaxed">{s.text}</span>
                <span className="block font-mono text-[10.5px] text-fg-faint mt-1">from {s.src}</span>
              </span>
            </div>
          )
        })}
      </div>
    </PhBlock>
  )
}

function PhConventions({ conventions, pinned, onPin }: { conventions: string[]; pinned: boolean; onPin: () => void }) {
  return (
    <PhBlock
      kicker="rules"
      title="Conventions Claude follows"
      pinned={pinned}
      onPin={onPin}
      note="Mirrored from CLAUDE.md. Pinned, so a refresh cannot soften them."
    >
      <PhCard className="px-4 py-3.5 grid gap-2.5">
        {conventions.map((c, i) => (
          <div key={i} className="grid grid-cols-[16px_minmax(0,1fr)] gap-2.5 items-start">
            <span className="text-sage mt-0.5 inline-flex">
              <AlmanacIcon name="check" size={13} />
            </span>
            <span className="text-[13px] leading-relaxed text-fg-dim">{c}</span>
          </div>
        ))}
      </PhCard>
    </PhBlock>
  )
}

export function ProjectHome() {
  const tabs = useSessions((s) => s.tabs)
  const activeTabId = useSessions((s) => s.activeTabId)
  const activeTab = tabs.find((t) => t.id === activeTabId)

  const sessions = usePromptSessions((s) => s.sessions)
  // Signal-level chats snapshot — a raw whole-map `useChat((s) => s.chats)`
  // subscription would re-render on every streaming token (PRD 833 I6).
  const chats = useChatSignals()
  const scheduleJobs = useScheduleState((s) => s.snapshot?.jobs) ?? EMPTY_JOBS
  const prds = useScheduledPrds()

  const cwd = activeTab?.cwd ?? null
  useEffect(() => {
    if (!cwd) return
    void usePromptSessions.getState().hydrate(cwd)
    void usePromptSessions.getState().hydrateArchived(cwd)
  }, [cwd])

  const [brief, setBrief] = useState<ProjectBrief | null>(null)
  const [sources, setSources] = useState<ProjectBriefSource[]>([])
  const [refreshing, setRefreshing] = useState(false)

  const loadBrief = useCallback((targetCwd: string) => {
    let cancelled = false
    window.api.projectBrief
      .get(targetCwd)
      .then((res) => {
        if (cancelled) return
        setBrief(res.brief)
        setSources(res.sources)
      })
      .catch((err) => {
        if (cancelled) return
        toast.error(`Could not load the brief: ${err instanceof Error ? err.message : String(err)}`)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!cwd) return
    return loadBrief(cwd)
  }, [cwd, loadBrief])

  const handleRefresh = useCallback(() => {
    if (!cwd || refreshing) return
    setRefreshing(true)
    window.api.projectBrief
      .refresh(cwd)
      .then((res) => {
        if (!res.ok) {
          toast.error(res.error)
          return
        }
        loadBrief(cwd)
      })
      .catch((err) => {
        toast.error(`Refresh failed: ${err instanceof Error ? err.message : String(err)}`)
      })
      .finally(() => setRefreshing(false))
  }, [cwd, refreshing, loadBrief])

  const handlePin = useCallback(
    (block: ProjectBriefPinnableBlock) => {
      if (!cwd || !brief) return
      const nextPinned = !brief.pins?.[block]
      window.api.projectBrief
        .setPin(cwd, block, nextPinned)
        .then((res) => {
          if (!res.ok) {
            toast.error(res.error)
            return
          }
          setBrief(res.brief)
        })
        .catch((err) => {
          toast.error(`Could not pin the block: ${err instanceof Error ? err.message : String(err)}`)
        })
    },
    [cwd, brief],
  )

  if (!activeTab) {
    return <EmptyState title="Open a project to see its brief" />
  }

  const projectName = projectNameFromCwd(activeTab.cwd)
  const snapshots: EpicSnapshots = { sessions, chats, jobs: scheduleJobs, prds }

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-[1080px] px-[34px] py-[26px] text-fg">
        <PhHeader
          brief={brief}
          sources={sources}
          projectName={projectName}
          refreshing={refreshing}
          onRefresh={handleRefresh}
        />

        {refreshing && (
          <div className="rounded-xl border border-accent-muted bg-accent-muted/20 px-4 py-2.5 mb-3.5 flex items-center gap-2.5 text-xs text-fg-dim">
            <span className="inline-flex text-accent">
              <AlmanacIcon name="sparkle" size={14} />
            </span>
            A headless session is re-reading CLAUDE.md, the Epic archive and recent commits. Pinned blocks are left
            untouched.
          </div>
        )}

        <PhNow cwd={activeTab.cwd} snapshots={snapshots} />

        {brief ? (
          <>
            <PhWhat paragraphs={safeList(brief.what)} pinned={!!brief.pins?.what} onPin={() => handlePin('what')} />
            <PhAreas areas={safeList(brief.areas)} />
            <PhScope scope={safeList(brief.scope)} />

            <div className="grid gap-3.5 grid-cols-1 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
              <PhConventions
                conventions={safeList(brief.conventions)}
                pinned={!!brief.pins?.conventions}
                onPin={() => handlePin('conventions')}
              />
              <PhOpenQuestions cwd={activeTab.cwd} sessions={sessions} chats={chats} />
            </div>

            <p className="text-xs text-fg-faint leading-relaxed max-w-[780px] mt-2">
              The brief is regenerated by a headless session on demand. Pinned blocks are treated as source of truth
              and are fed back into the next synthesis instead of being rewritten.
            </p>
          </>
        ) : (
          <>
            <PhOpenQuestions cwd={activeTab.cwd} sessions={sessions} chats={chats} />
            <div className="py-10 flex flex-col items-center gap-3 text-center">
              <p className="text-xs text-fg-faint max-w-sm">
                No brief yet — generate one from CLAUDE.md, the Epic archive and recent commits.
              </p>
              <button
                type="button"
                onClick={handleRefresh}
                disabled={refreshing}
                className={`inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-semibold ${
                  refreshing ? 'bg-accent-muted/60 text-fg-dim cursor-default' : 'bg-accent text-bg-hi cursor-pointer hover:bg-accent-dark'
                }`}
              >
                <span className={`inline-flex ${refreshing ? 'animate-spin' : ''}`}>
                  <AlmanacIcon name="reload" size={14} />
                </span>
                {refreshing ? 'Re-reading the project…' : 'Generate the brief'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
