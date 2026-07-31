import { useEffect, useMemo, useState } from 'react'
import { usePromptSessions, type PromptSession } from '../state/promptSessions'
import { useKnownProjects, candidatePath } from '../lib/useKnownProjects'
import { compactPath } from '../lib/compactPath'
import { formatAgo } from '../lib/formatTime'
import { PromptSessionConversation } from './PromptSessionConversation'
import { PromptSessionArchiveView } from './PromptSessionArchiveView'
import { toast } from '../state/toast'
import { takePendingPromptSessionId } from '../lib/promptSessionDeepLink'

/**
 * Landing content for the (renamed) 'terminal' nav item — shown in place of
 * TerminalStage's old empty "no active session" state. Lists every
 * PromptSession (PRD 802's independent goal-scoped session model) grouped by
 * cwd, one row per goal. Clicking a row opens PromptSessionConversation
 * (PRD 804) scoped to that session — never a top-level SessionTab/TabBar entry.
 */
export function ProjectsLanding() {
  const sessions = usePromptSessions((s) => s.sessions)
  const createPromptSession = usePromptSessions((s) => s.createPromptSession)
  const { rows, enriched } = useKnownProjects()

  const knownCwds = useMemo(() => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const row of rows) {
      const cwd = enriched[row.encoded]?.cwd ?? candidatePath(row.encoded)
      if (!cwd || seen.has(cwd)) continue
      seen.add(cwd)
      out.push(cwd)
    }
    return out
  }, [rows, enriched])

  const markCompleted = usePromptSessions((s) => s.markCompleted)
  const resumeArchived = usePromptSessions((s) => s.resumeArchived)

  const [cwd, setCwd] = useState('')
  const [goalText, setGoalText] = useState('')
  const [openedId, setOpenedId] = useState<string | null>(null)
  const [openedArchiveId, setOpenedArchiveId] = useState<string | null>(null)
  const [completingId, setCompletingId] = useState<string | null>(null)

  const effectiveCwd = cwd || knownCwds[0] || ''
  const openedSession = openedId ? sessions[openedId] : null
  const openedArchiveSession = openedArchiveId ? sessions[openedArchiveId] : null

  // Scheduler-job → PromptSession traceability link (see promptSessionDeepLink.ts):
  // opens the session a job row traced back to, live conversation for an
  // active session or the read-only archive for a completed one.
  const openFromDeepLink = (id: string) => {
    const target = usePromptSessions.getState().sessions[id]
    if (!target) return
    if (target.status === 'completed') {
      setOpenedArchiveId(id)
      setOpenedId(null)
    } else {
      setOpenedId(id)
      setOpenedArchiveId(null)
    }
  }
  useEffect(() => {
    const pendingId = takePendingPromptSessionId()
    if (pendingId) openFromDeepLink(pendingId)
    const h = (e: Event) => openFromDeepLink((e as CustomEvent<string>).detail)
    window.addEventListener('sm:select-prompt-session', h)
    return () => window.removeEventListener('sm:select-prompt-session', h)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Backfill any active PromptSessions persisted from a prior app run — best
  // effort, one call per known cwd as they're discovered. Keyed off a joined
  // string (not the `knownCwds` array itself, which useKnownProjects hands
  // back as a fresh reference on every render) so this doesn't refire every
  // render — hydrate() itself is also a safe no-op re-call since it only
  // mutates the store when it finds a session not already in memory.
  const knownCwdsKey = knownCwds.join('\n')
  useEffect(() => {
    for (const c of knownCwdsKey ? knownCwdsKey.split('\n') : []) {
      void usePromptSessions.getState().hydrate(c)
    }
  }, [knownCwdsKey])

  // Only active sessions appear in the working Projects list — a completed
  // session is removed from here and moves to the read-only History section
  // below, per the explicit user requirement that completion never happens
  // implicitly and a completed session shouldn't clutter active work.
  const groups = useMemo(() => {
    const byCwd = new Map<string, PromptSession[]>()
    for (const session of Object.values(sessions)) {
      if (session.status !== 'active') continue
      const list = byCwd.get(session.cwd) ?? []
      list.push(session)
      byCwd.set(session.cwd, list)
    }
    for (const list of byCwd.values()) {
      list.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    }
    return Array.from(byCwd.entries()).sort((a, b) => a[0].localeCompare(b[0]))
  }, [sessions])

  const history = useMemo(() => {
    return Object.values(sessions)
      .filter((s) => s.status === 'completed')
      .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''))
  }, [sessions])

  const submit = () => {
    const trimmedGoal = goalText.trim()
    if (!effectiveCwd || !trimmedGoal) return
    createPromptSession(effectiveCwd, trimmedGoal)
    setGoalText('')
  }

  const handleMarkCompleted = async (id: string) => {
    setCompletingId(id)
    try {
      await markCompleted(id)
      if (openedId === id) setOpenedId(null)
    } catch (e) {
      toast.error(`Could not mark session completed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setCompletingId(null)
    }
  }

  const handleResume = (archivedId: string) => {
    const resumed = resumeArchived(archivedId)
    setOpenedArchiveId(null)
    setOpenedId(resumed.id)
  }

  if (openedArchiveSession) {
    return (
      <div className="h-full flex flex-col bg-bg" data-testid="projects-landing">
        <div className="shrink-0 border-b border-rule px-3 py-1.5 flex items-center justify-between">
          <button
            data-testid="prompt-session-archive-back"
            onClick={() => setOpenedArchiveId(null)}
            className="rounded border border-line px-2 py-1 text-xs text-fg-dim hover:bg-elev hover:text-fg"
          >
            ← Back to Epics
          </button>
          <button
            data-testid="prompt-session-resume"
            onClick={() => handleResume(openedArchiveSession.id)}
            className="rounded border border-accent/40 px-2 py-1 text-xs text-accent hover:bg-accent/10"
          >
            Resume
          </button>
        </div>
        <div className="min-h-0 flex-1">
          <PromptSessionArchiveView cwd={openedArchiveSession.cwd} promptSessionId={openedArchiveSession.id} />
        </div>
      </div>
    )
  }

  if (openedSession) {
    return (
      <div className="h-full flex flex-col bg-bg" data-testid="projects-landing">
        <div className="shrink-0 border-b border-rule px-3 py-1.5 flex items-center justify-between">
          <button
            data-testid="prompt-session-back"
            onClick={() => setOpenedId(null)}
            className="rounded border border-line px-2 py-1 text-xs text-fg-dim hover:bg-elev hover:text-fg"
          >
            ← Back to Epics
          </button>
          <button
            data-testid="prompt-session-mark-completed"
            onClick={() => void handleMarkCompleted(openedSession.id)}
            disabled={completingId === openedSession.id}
            className="rounded border border-line px-2 py-1 text-xs text-fg-dim hover:bg-elev hover:text-fg disabled:opacity-40"
          >
            {completingId === openedSession.id ? 'Marking completed…' : 'Mark completed'}
          </button>
        </div>
        <div className="min-h-0 flex-1">
          <PromptSessionConversation promptSession={openedSession} />
        </div>
      </div>
    )
  }

  return (
    <div className="h-full overflow-auto bg-bg" data-testid="projects-landing">
      <div className="max-w-2xl mx-auto px-6 py-8">
        <div className="mb-6">
          <h1 className="font-serif text-[20px] font-medium text-fg">Epics</h1>
          <p className="text-[12.5px] text-fg-faint mt-1">
            Each row is an independent Epic you can jump into.
          </p>
        </div>

        <div className="mb-8 p-3 rounded-lg border border-line bg-bg-elev flex flex-col gap-2">
          <div className="text-[11px] font-semibold tracking-[0.05em] text-fg-faint uppercase">
            New starting prompt
          </div>
          <select
            data-testid="new-prompt-cwd"
            value={effectiveCwd}
            onChange={(e) => setCwd(e.target.value)}
            className="px-2 py-1.5 rounded-md border border-line bg-bg text-fg text-[12.5px] font-mono"
          >
            {knownCwds.length === 0 && <option value="">No known projects</option>}
            {knownCwds.map((c) => (
              <option key={c} value={c}>{compactPath(c)}</option>
            ))}
          </select>
          <input
            data-testid="new-prompt-goal"
            type="text"
            value={goalText}
            onChange={(e) => setGoalText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
            placeholder="What's the goal for this session?"
            className="px-2 py-1.5 rounded-md border border-line bg-bg text-fg text-[12.5px]"
          />
          <button
            data-testid="new-prompt-submit"
            onClick={submit}
            disabled={!effectiveCwd || !goalText.trim()}
            className="self-start px-3 py-1.5 rounded-md bg-bg-hi border border-line text-fg text-[12.5px] font-medium hover:bg-bg-hi/80 hover:border-accent/40 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            New starting prompt
          </button>
        </div>

        {groups.length === 0 ? (
          <div className="text-center text-[12.5px] text-fg-faint py-10">
            No prompt sessions yet — start one above.
          </div>
        ) : (
          <>
          <div className="mb-2 text-[11px] font-semibold tracking-[0.05em] text-fg-faint uppercase">
            Epic queue
          </div>
          {groups.map(([groupCwd, groupSessions]) => (
            <div key={groupCwd} data-testid="prompt-session-group" className="mb-6">
              <div
                className="text-[11.5px] font-mono text-fg-faint mb-1.5 truncate"
                title={groupCwd}
              >
                {compactPath(groupCwd)}
              </div>
              <div className="flex flex-col gap-1">
                {groupSessions.map((session) => (
                  <PromptSessionRow
                    key={session.id}
                    session={session}
                    onClick={() => setOpenedId(session.id)}
                    onMarkCompleted={() => void handleMarkCompleted(session.id)}
                    completing={completingId === session.id}
                  />
                ))}
              </div>
            </div>
          ))}
          </>
        )}

        <div className="mt-10">
          <div className="mb-2 text-[11px] font-semibold tracking-[0.05em] text-fg-faint uppercase">
            History
          </div>
          {history.length === 0 ? (
            <div className="text-center text-[12.5px] text-fg-faint py-6">
              No completed prompt sessions yet.
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              {history.map((session) => (
                <PromptSessionHistoryRow
                  key={session.id}
                  session={session}
                  onOpen={() => setOpenedArchiveId(session.id)}
                  onResume={() => handleResume(session.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function PromptSessionRow({
  session,
  onClick,
  onMarkCompleted,
  completing,
}: {
  session: PromptSession
  onClick: () => void
  onMarkCompleted: () => void
  completing: boolean
}) {
  return (
    <div
      data-testid="prompt-session-row"
      data-status={session.status}
      className="w-full flex items-center gap-3 px-3 py-2 rounded-md border border-accent/40 bg-accent/5 hover:bg-accent/10 transition-colors"
    >
      <button onClick={onClick} className="flex flex-1 min-w-0 items-center gap-3 text-left">
        <span
          data-testid="prompt-session-status-badge"
          className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-accent/20 text-accent"
        >
          Active
        </span>
        <span className="flex-1 min-w-0 truncate text-[13px] text-fg">
          {truncateGoal(session.goalText)}
        </span>
        <span className="shrink-0 text-[11px] text-fg-faint font-mono">
          {formatAgo(new Date(session.createdAt).getTime(), Date.now())}
        </span>
      </button>
      <button
        data-testid="prompt-session-row-mark-completed"
        onClick={(e) => {
          e.stopPropagation()
          onMarkCompleted()
        }}
        disabled={completing}
        className="shrink-0 rounded border border-line px-2 py-1 text-[11px] text-fg-dim hover:bg-elev hover:text-fg disabled:opacity-40"
      >
        {completing ? 'Marking…' : 'Mark completed'}
      </button>
    </div>
  )
}

function PromptSessionHistoryRow({
  session,
  onOpen,
  onResume,
}: {
  session: PromptSession
  onOpen: () => void
  onResume: () => void
}) {
  return (
    <div
      data-testid="prompt-session-history-row"
      data-status={session.status}
      className="w-full flex items-center gap-3 px-3 py-2 rounded-md border border-line bg-bg-elev hover:bg-bg-hi/50 transition-colors"
    >
      <button onClick={onOpen} className="flex flex-1 min-w-0 items-center gap-3 text-left">
        <span
          data-testid="prompt-session-status-badge"
          className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-bg-hi text-fg-faint"
        >
          Completed
        </span>
        <span className="flex-1 min-w-0 truncate text-[13px] text-fg">
          {truncateGoal(session.goalText)}
        </span>
        <span className="shrink-0 text-[11px] text-fg-faint font-mono">
          {session.completedAt ? formatAgo(new Date(session.completedAt).getTime(), Date.now()) : ''}
        </span>
      </button>
      <button
        data-testid="prompt-session-history-open"
        onClick={(e) => {
          e.stopPropagation()
          onOpen()
        }}
        className="shrink-0 rounded border border-line px-2 py-1 text-[11px] text-fg-dim hover:bg-elev hover:text-fg"
      >
        Open
      </button>
      <button
        data-testid="prompt-session-history-resume"
        onClick={(e) => {
          e.stopPropagation()
          onResume()
        }}
        className="shrink-0 rounded border border-accent/40 px-2 py-1 text-[11px] text-accent hover:bg-accent/10"
      >
        Resume
      </button>
    </div>
  )
}

function truncateGoal(text: string, max = 80): string {
  if (text.length <= max) return text
  return `${text.slice(0, max - 1)}…`
}
