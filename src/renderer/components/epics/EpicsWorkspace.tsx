import { useEffect, useMemo, useState } from 'react'
import { usePromptSessions, promptSessionActiveIndexPath } from '../../state/promptSessions'
import { useChatSignals } from '../../lib/useChatSignals'
import { useScheduleState } from '../../state/scheduleState'
import { useEpicTerminal } from '../../state/epicTerminal'
import { useEpicUsage } from '../../state/epicUsage'
import { useKnownProjects, candidatePath } from '../../lib/useKnownProjects'
import { takePendingPromptSessionId } from '../../lib/promptSessionDeepLink'
import { useScheduledPrds } from '../../lib/useScheduledPrds'
import { lastActivityMs } from '../../lib/epicQueueControls'
import { useSessions } from '../../state/sessions'
import type { EpicSnapshots } from '../../lib/epicDerive'
import type { ScheduleJob } from '../../../preload/api'
import { EpicQueueControls } from './EpicQueueControls'
import { EpicDetail } from './EpicDetail'
import { EpicComposer, canCompose } from './EpicComposer'
import { EpicApprovalBar } from './EpicApprovalBar'
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
 *
 * Also mounted by Terminal.tsx in place of the retired TerminalChat for a
 * dormant SessionTab — `cwd`, when passed, scopes the visible Epics to that
 * tab's project and preselects its most recently active Epic.
 *
 * TerminalStage's always-on singleton mount passes no `cwd` — it renders
 * whenever the user explicitly opens the Epics workspace (Project-face-only
 * nav item, so an active SessionTab always exists then) or when no tab is
 * open at all. In the former case this component scopes itself to the
 * active tab's cwd directly (no picker: the Epics nav can't be reached
 * without a project tab already selected). In the latter (genuinely no tabs
 * open) it renders an empty-state message instead.
 */
export function EpicsWorkspace({ cwd }: { cwd?: string } = {}) {
  const sessions = usePromptSessions((s) => s.sessions)
  const events = usePromptSessions((s) => s.events)
  // Signal-level chats snapshot — a raw whole-map subscription would
  // re-render the entire workspace on every streaming token (PRD 833 I6).
  const chats = useChatSignals()
  const scheduleJobs = useScheduleState((s) => s.snapshot?.jobs) ?? EMPTY_JOBS
  const { rows, enriched } = useKnownProjects()

  const [selectedId, setSelectedId] = useState<string | null>(null)
  // Mirrors the open Epic into the store so mergeAppendedEvent (main-process
  // 'response' events landing via IPC) can tell whether the user is already
  // looking at the Epic a PRD just reported back to, and skip the toast if
  // so. Cleared on unmount so a torn-down workspace mount (this component
  // has more than one possible mount site — see the doc comment above)
  // never leaves a stale focus id blocking a toast for the other one.
  useEffect(() => {
    usePromptSessions.getState().setFocusedEpicId(selectedId)
    return () => usePromptSessions.getState().setFocusedEpicId(null)
  }, [selectedId])
  const [showNewEpic, setShowNewEpic] = useState(false)
  const prds = useScheduledPrds()
  // Reply-context quote (Turn's hover "Quote" button -> EpicComposer's
  // dismissible strip) — held here since EpicDetail (Turn) and EpicComposer
  // are rendered as siblings, not parent/child.
  const [quote, setQuote] = useState<string | undefined>(undefined)

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

  // TerminalStage's singleton mount (no `cwd` prop) always scopes to the
  // active tab — Terminal.tsx's dormant-tab mount passes `cwd` explicitly,
  // which always wins below.
  const tabs = useSessions((s) => s.tabs)
  const activeTabId = useSessions((s) => s.activeTabId)
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null
  const effectiveCwd = cwd ?? activeTab?.cwd ?? undefined

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

  // Watch each project's active-Epic index so out-of-band edits reach the UI
  // while it's open. Two writers exist besides this renderer: epicMint.cjs in
  // the main process (an Epic auto-minted by a headless PRD dispatch) and
  // anything editing the file directly. Without this, hydrate() only ran on
  // mount, so a minted Epic never appeared and a deleted one stayed listed
  // until a full reload — and the stale copy got persisted back over the
  // deletion on the next mutation.
  useEffect(() => {
    const cwds = knownCwdsKey ? knownCwdsKey.split('\n') : []
    if (!cwds.length) return
    // Absent in test harnesses that stub only the config calls this workspace
    // reads — the watch is an enhancement, never a mount requirement.
    if (typeof window.api?.config?.watch !== 'function' || typeof window.api?.config?.onChanged !== 'function') return
    const paths = cwds.map((c) => promptSessionActiveIndexPath(c))
    const byPath = new Map(paths.map((p, i) => [p, cwds[i]]))
    window.api.config.watch(paths)
    const off = window.api.config.onChanged(({ path }) => {
      const cwd = byPath.get(path)
      if (cwd) void usePromptSessions.getState().hydrate(cwd)
    })
    return () => {
      off()
      if (typeof window.api?.config?.unwatch === 'function') window.api.config.unwatch(paths)
    }
  }, [knownCwdsKey])

  // Deep links: a Scheduler job row or EpicDetail's dispatched-ticket chip
  // (see promptSessionDeepLink.ts) select an Epic here — for a completed
  // Epic this opens EpicDetail in its read-only (no composer) mode, never
  // a crash. A target not hydrated yet (first jump right after boot,
  // especially to an archived Epic) is HELD and retried once hydration
  // delivers it, instead of being destructively consumed (PRD 833 I4).
  const [pendingDeepLink, setPendingDeepLink] = useState<string | null>(null)
  useEffect(() => {
    const openFromDeepLink = (id: string) => {
      setShowNewEpic(false)
      if (usePromptSessions.getState().sessions[id]) {
        setSelectedId(id)
        setPendingDeepLink(null)
      } else {
        setPendingDeepLink(id)
      }
    }
    const pendingId = takePendingPromptSessionId()
    if (pendingId) openFromDeepLink(pendingId)
    const h = (e: Event) => openFromDeepLink((e as CustomEvent<string>).detail)
    window.addEventListener('sm:select-prompt-session', h)
    return () => window.removeEventListener('sm:select-prompt-session', h)
  }, [])
  useEffect(() => {
    if (pendingDeepLink && sessions[pendingDeepLink]) {
      setSelectedId(pendingDeepLink)
      setShowNewEpic(false)
      setPendingDeepLink(null)
    }
  }, [pendingDeepLink, sessions])

  // PRD 833 C1: PTYs survive a renderer reload but the in-memory attachment
  // record does not — a surviving interactive claude would invisibly hold its
  // Epic's claudeSessionId while chat.ts's isAttached guard reads false,
  // allowing a second attachment. Reconcile: re-adopt any live PTY whose key
  // matches an active Epic's session (mode back to 'terminal', attached
  // re-recorded; the pane's reattach path never re-types the launch command).
  useEffect(() => {
    const bySession: Record<string, string> = {}
    for (const s of Object.values(sessions)) {
      if (s.status === 'active') bySession[s.claudeSessionId] = s.id
    }
    const keys = Object.keys(bySession)
    if (!keys.length) return
    const probeAlive = window.api.pty?.alive
    if (typeof probeAlive !== 'function') return
    void probeAlive(keys)
      .then((live) => {
        const et = useEpicTerminal.getState()
        for (const sessionId of live) {
          const epicId = bySession[sessionId]
          if (!et.isAttached(epicId)) {
            et.setMode(epicId, 'terminal')
            et.setAttached(epicId, true)
          }
        }
      })
      .catch(() => { /* reconcile is best-effort; a failed probe changes nothing */ })
  }, [sessions])

  const epics = useMemo(
    () => (effectiveCwd ? Object.values(sessions).filter((s) => s.cwd === effectiveCwd) : Object.values(sessions)),
    [sessions, effectiveCwd],
  )
  const usage = useEpicUsage((s) => s.usage)
  const fetchUsage = useEpicUsage((s) => s.fetch)
  // Batched token-usage refresh — one call per distinct cwd among the
  // visible Epics, never per row. Re-runs when the visible Epic set changes
  // or the selected Epic changes (its transcript is the one most likely to
  // have grown), plus a ≥30s interval to pick up usage from a run in flight.
  const epicUsageKey = epics.map((e) => e.id).join('\n')
  useEffect(() => {
    if (!epics.length) return
    const rows = epics.map((e) => ({ id: e.id, cwd: e.cwd, claudeSessionId: e.claudeSessionId }))
    void fetchUsage(rows)
    const t = setInterval(() => void fetchUsage(rows), 30_000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epicUsageKey, selectedId])
  const snapshots: EpicSnapshots = { sessions, chats, jobs: scheduleJobs, prds, usage }
  const selectedEpic = selectedId ? (sessions[selectedId] ?? null) : null

  // Preselect the scoped project's most recently active Epic (Terminal.tsx's
  // dormant-tab mount) so switching to that tab lands directly in its own
  // ongoing work instead of an empty "No Epic selected" pane. Re-runs while
  // `epics` is still empty (hydration hasn't landed this cwd's Epics yet)
  // and stops once any Epic is selected — a manual selection afterwards
  // (including the user's own pick) sticks.
  useEffect(() => {
    if (!cwd || selectedId || showNewEpic || !epics.length) return
    const mostRecent = [...epics].sort((a, b) => lastActivityMs(b, events) - lastActivityMs(a, events))[0]
    setSelectedId(mostRecent.id)
  }, [cwd, epics, events, selectedId, showNewEpic])
  // Terminal mode (PRD 831) replaces the tabs+thread+composer area inside
  // EpicDetail itself — the composer is this file's sibling, so it must be
  // hidden here too rather than EpicDetail reaching out to unmount it.
  const selectedMode = useEpicTerminal((s) => s.modes[selectedId ?? ''] ?? 'chat')

  // A quoted turn belongs to the Epic it was quoted from — drop it on switch.
  useEffect(() => {
    setQuote(undefined)
  }, [selectedId])

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

  if (cwd === undefined && !activeTab) {
    return (
      <div className="flex h-full min-h-0 w-full" data-testid="epics-workspace">
        <EmptyState title="No project open" hint="Open a project tab to see its Epics." />
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 w-full" data-testid="epics-workspace">
      <div className="flex min-h-0 shrink-0 flex-col">
        <EpicQueueControls
          epics={epics}
          snapshots={snapshots}
          events={events}
          selectedId={selectedId}
          onSelect={handleSelect}
          onNew={handleNew}
        />
      </div>

      {showNewEpic ? (
        <NewEpicCard onCreated={handleCreated} onCancel={() => setShowNewEpic(false)} />
      ) : selectedEpic ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <EpicDetail promptSession={selectedEpic} onQuote={setQuote} />
          {selectedEpic.status === 'proposed' ? (
            <EpicApprovalBar epic={selectedEpic} />
          ) : (
            selectedMode === 'chat' && canCompose(selectedEpic) && (
              <EpicComposer
                epic={selectedEpic}
                snapshots={snapshots}
                quote={quote}
                onClearQuote={() => setQuote(undefined)}
              />
            )
          )}
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
