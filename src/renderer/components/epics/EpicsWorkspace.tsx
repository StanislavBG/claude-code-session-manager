import { useEffect, useMemo, useState } from 'react'
import { usePromptSessions } from '../../state/promptSessions'
import { useChat } from '../../state/chat'
import { useScheduleState } from '../../state/scheduleState'
import { useKnownProjects, candidatePath } from '../../lib/useKnownProjects'
import { takePendingPromptSessionId } from '../../lib/promptSessionDeepLink'
import { useScheduledPrds } from '../../lib/useScheduledPrds'
import { toast } from '../../state/toast'
import type { EpicSnapshots } from '../../lib/epicDerive'
import type { ScheduleJob } from '../../../preload/api'
import { EpicQueueControls } from './EpicQueueControls'
import { EpicDetail } from './EpicDetail'
import { EpicComposer, canCompose } from './EpicComposer'
import { NewEpicCard } from './NewEpicCard'
import { EmptyState } from '../ui/EmptyState'

const EMPTY_JOBS: ScheduleJob[] = []

/**
 * Top-level Epics workspace — mounted by TerminalStage in place of the
 * retired ProjectsLanding whenever no SessionTab is active. Composes the
 * left Epic queue (EpicQueueControls -> EpicQueue) with the right detail
 * pane (EpicDetail + EpicComposer, or NewEpicCard while creating), per
 * session-manager-operations/design-mocks/epics/DESIGN_SPEC.md's two-pane
 * layout.
 */
export function EpicsWorkspace() {
  const sessions = usePromptSessions((s) => s.sessions)
  const events = usePromptSessions((s) => s.events)
  const chats = useChat((s) => s.chats)
  const scheduleJobs = useScheduleState((s) => s.snapshot?.jobs) ?? EMPTY_JOBS
  const { rows, enriched } = useKnownProjects()

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showNewEpic, setShowNewEpic] = useState(false)
  const prds = useScheduledPrds()

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

  // Backfill any active/archived PromptSessions persisted from a prior app
  // run, one call per known cwd as they're discovered — mirrors the retired
  // ProjectsLanding's own hydrate loop. Keyed off a joined string (not the
  // `knownCwds` array itself, which useKnownProjects hands back as a fresh
  // reference every render) so this doesn't refire every render.
  const knownCwdsKey = knownCwds.join('\n')
  useEffect(() => {
    for (const c of knownCwdsKey ? knownCwdsKey.split('\n') : []) {
      void usePromptSessions.getState().hydrate(c)
      void usePromptSessions.getState().hydrateArchived(c)
    }
  }, [knownCwdsKey])

  // Deep links: a Scheduler job row or TerminalChat's dispatched-ticket chip
  // (see promptSessionDeepLink.ts) select an Epic here — for a completed
  // Epic this opens EpicDetail in its read-only (no composer) mode, never
  // a crash.
  useEffect(() => {
    const openFromDeepLink = (id: string) => {
      const target = usePromptSessions.getState().sessions[id]
      if (!target) return
      setShowNewEpic(false)
      setSelectedId(id)
    }
    const pendingId = takePendingPromptSessionId()
    if (pendingId) openFromDeepLink(pendingId)
    const h = (e: Event) => openFromDeepLink((e as CustomEvent<string>).detail)
    window.addEventListener('sm:select-prompt-session', h)
    return () => window.removeEventListener('sm:select-prompt-session', h)
  }, [])

  const epics = useMemo(() => Object.values(sessions), [sessions])
  const snapshots: EpicSnapshots = { sessions, chats, jobs: scheduleJobs, prds }
  const selectedEpic = selectedId ? (sessions[selectedId] ?? null) : null

  const handleSelect = (id: string) => {
    setShowNewEpic(false)
    setSelectedId(id)
  }

  const handleNew = () => {
    setSelectedId(null)
    setShowNewEpic(true)
  }

  const handleCreated = (id: string) => {
    setShowNewEpic(false)
    setSelectedId(id)
  }

  // Terminal view (in-pane xterm over the Epic's own claudeSessionId) isn't
  // wired yet — PRD 831 replaces this stub with the Chat <-> Terminal mode
  // toggle. Routing to a SessionTab instead would orphan the Epic's context
  // (an Epic IS its claude session, 1:1), so this is a no-op + toast, not a
  // navigation.
  const handleOpenRawSession = () => {
    toast.info('Terminal view lands with PRD 831')
  }

  return (
    <div className="flex h-full min-h-0 w-full" data-testid="epics-workspace">
      <EpicQueueControls
        epics={epics}
        snapshots={snapshots}
        events={events}
        selectedId={selectedId}
        onSelect={handleSelect}
        onNew={handleNew}
      />

      {showNewEpic ? (
        <NewEpicCard onCreated={handleCreated} onCancel={() => setShowNewEpic(false)} />
      ) : selectedEpic ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <EpicDetail promptSession={selectedEpic} onOpenRawSession={handleOpenRawSession} />
          {canCompose(selectedEpic) && <EpicComposer epic={selectedEpic} snapshots={snapshots} />}
        </div>
      ) : (
        <div className="min-h-0 min-w-0 flex-1">
          <EmptyState
            title="No Epic selected"
            hint={
              <button type="button" onClick={handleNew} className="mt-2 text-accent font-semibold text-xs">
                + New Epic
              </button>
            }
          />
        </div>
      )}
    </div>
  )
}
