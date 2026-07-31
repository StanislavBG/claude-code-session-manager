import { useMemo, useState } from 'react'
import { usePromptSessions, type PromptSession } from '../state/promptSessions'
import { useKnownProjects, candidatePath } from '../lib/useKnownProjects'
import { compactPath } from '../lib/compactPath'
import { formatAgo } from '../lib/formatTime'

/**
 * Landing content for the (renamed) 'terminal' nav item — shown in place of
 * TerminalStage's old empty "no active session" state. Lists every
 * PromptSession (PRD 802's independent goal-scoped session model) grouped by
 * cwd, one row per goal. Clicking a row is a placeholder until PRD 804 wires
 * the actual scoped conversation view.
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

  const [cwd, setCwd] = useState('')
  const [goalText, setGoalText] = useState('')
  const [openedStubId, setOpenedStubId] = useState<string | null>(null)

  const effectiveCwd = cwd || knownCwds[0] || ''

  const groups = useMemo(() => {
    const byCwd = new Map<string, PromptSession[]>()
    for (const session of Object.values(sessions)) {
      const list = byCwd.get(session.cwd) ?? []
      list.push(session)
      byCwd.set(session.cwd, list)
    }
    for (const list of byCwd.values()) {
      list.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    }
    return Array.from(byCwd.entries()).sort((a, b) => a[0].localeCompare(b[0]))
  }, [sessions])

  const submit = () => {
    const trimmedGoal = goalText.trim()
    if (!effectiveCwd || !trimmedGoal) return
    createPromptSession(effectiveCwd, trimmedGoal)
    setGoalText('')
  }

  return (
    <div className="h-full overflow-auto bg-bg" data-testid="projects-landing">
      <div className="max-w-2xl mx-auto px-6 py-8">
        <div className="mb-6">
          <h1 className="font-serif text-[20px] font-medium text-fg">Projects</h1>
          <p className="text-[12.5px] text-fg-faint mt-1">
            Each row is an independent goal-oriented session you can jump into.
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
          groups.map(([groupCwd, groupSessions]) => (
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
                    onClick={() => setOpenedStubId(session.id)}
                  />
                ))}
              </div>
            </div>
          ))
        )}

        {openedStubId && (
          <div data-testid="prompt-session-stub" className="mt-4 p-3 rounded-lg border border-dashed border-line text-[12px] text-fg-faint">
            Conversation view coming soon (PRD 804).
          </div>
        )}
      </div>
    </div>
  )
}

function PromptSessionRow({ session, onClick }: { session: PromptSession; onClick: () => void }) {
  const isActive = session.status === 'active'
  return (
    <button
      data-testid="prompt-session-row"
      data-status={session.status}
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-3 py-2 rounded-md border text-left transition-colors ${
        isActive
          ? 'border-accent/40 bg-accent/5 hover:bg-accent/10'
          : 'border-line bg-bg-elev hover:bg-bg-hi/50'
      }`}
    >
      <span
        data-testid="prompt-session-status-badge"
        className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide ${
          isActive ? 'bg-accent/20 text-accent' : 'bg-bg-hi text-fg-faint'
        }`}
      >
        {isActive ? 'Active' : 'Completed'}
      </span>
      <span className="flex-1 min-w-0 truncate text-[13px] text-fg">
        {truncateGoal(session.goalText)}
      </span>
      <span className="shrink-0 text-[11px] text-fg-faint font-mono">
        {formatAgo(new Date(session.createdAt).getTime(), Date.now())}
      </span>
    </button>
  )
}

function truncateGoal(text: string, max = 80): string {
  if (text.length <= max) return text
  return `${text.slice(0, max - 1)}…`
}
