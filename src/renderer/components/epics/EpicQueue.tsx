/**
 * Left pane of the redesigned Epics workspace — grouped, collapsible,
 * selectable Epic rows. Built from session-manager-operations/design-mocks/
 * epics/DESIGN_SPEC.md ("Left pane") + epics-mock.jsx's QueueRow/EpicQueue,
 * translated from inline styles to Tailwind Almanac tokens.
 *
 * Search/filter/sort/pin/paging/keyboard controls are PRD 828's job, wired
 * in via `EpicQueueControls.tsx`. This component's own default (status-only,
 * unpaged) grouping still runs when the `sections` prop is omitted, so PRD
 * 827's original contract keeps working for any caller that only needs the
 * plain grouped list.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { usePromptSessions, type PromptSession, type PromptSessionEvent } from '../../state/promptSessions'
import { useSessions } from '../../state/sessions'
import { useChat } from '../../state/chat'
import { useEpicTerminal } from '../../state/epicTerminal'
import { toast } from '../../state/toast'
import {
  epicDisplayStatus,
  epicPrds,
  epicQueuedDetail,
  epicStats,
  splitTitleAndGoal,
  type EpicDisplayStatus,
  type EpicSnapshots,
} from '../../lib/epicDerive'
import { EpicStatusChip, EpicKindTag, epicStatusDotClass, epicStatusLabel } from './epic-primitives'
import { EmptyState } from '../ui/EmptyState'
import { formatAgo } from '../../lib/formatTime'
import { composeEpicIntake } from '../../lib/epicIntake'
import { useBuildTarget } from '../../lib/useBuildTarget'

const BUILD_GOAL_TEXT =
  '/builder\n\nCheck git vs the published package for this project, decide the right version bump, and publish if there\'s anything new.'

/** Any other 'build'-tagged Epic for this cwd that hasn't been marked
 *  completed yet — used to stop "Build Project" from spawning a second,
 *  redundant build Epic while one is already running. Returns a reference
 *  into the store's own session objects (not a fresh allocation) so this
 *  stays a stable zustand selector. */
function useInFlightBuildEpic(cwd: string | null): PromptSession | null {
  return usePromptSessions((s) => {
    if (!cwd) return null
    for (const key in s.sessions) {
      const session = s.sessions[key]
      if (session.cwd === cwd && session.tag === 'build' && session.status !== 'completed') return session
    }
    return null
  })
}

/** Toolbar action (not per-row — Builder isn't scoped to one Epic): creates a
 *  brand-new 'build'-tagged Epic via the same creation path NewEpicCard's
 *  submit uses, and auto-sends its opening prompt so a fresh, isolated agent
 *  session starts the git-diff -> publish loop immediately. Disabled when
 *  the active project has no resolvable publish target. If a build Epic for
 *  this cwd is already in flight, both entry points open it instead of
 *  minting a second one. */
function useBuildAction(onSelect: (id: string) => void) {
  const activeTabCwd = useSessions((s) => s.tabs.find((t) => t.id === s.activeTabId)?.cwd ?? null)
  const target = useBuildTarget(activeTabCwd)
  const [creating, setCreating] = useState(false)
  const inFlight = useInFlightBuildEpic(activeTabCwd)
  // Actor for the 'build' Epic — same lookup-by-name pattern HostBilko.tsx
  // and ProjectPagesSection.tsx already use for their own dedicated-pipeline
  // agents, so Build Epics get an Actor line instead of opening on Default.
  const [builderPersona, setBuilderPersona] = useState<{ name: string; description: string | null } | null>(null)
  useEffect(() => {
    let cancelled = false
    const listPersonas = window.api?.agents?.listPersonas
    if (!listPersonas) return
    listPersonas()
      .then((list) => {
        if (cancelled) return
        const found = list.find((a) => a.name === 'builder')
        setBuilderPersona(found ? { name: found.name, description: found.description } : null)
      })
      .catch(() => {
        if (!cancelled) setBuilderPersona(null)
      })
    return () => {
      cancelled = true
    }
  }, [])
  // Reaching an in-flight build Epic must stay possible even when the
  // project currently has no resolvable publish target — the guard's whole
  // point is getting the user back to that Epic, not blocking them.
  const disabled = !activeTabCwd || (!target && !inFlight) || creating

  /** Shared creation sequence for both entry points: mints the fresh
   *  'build'-tagged Epic and approves it out of `proposed`. Callers decide
   *  what happens to `openingPrompt` next (auto-send vs. leave in the
   *  composer as a draft). */
  const createBuildEpic = async () => {
    if (!activeTabCwd || !target) return null
    const { goalText, openingPrompt } = composeEpicIntake({
      title: '',
      goal: BUILD_GOAL_TEXT,
      tag: 'build',
      agentName: builderPersona?.name,
      agentDescription: builderPersona?.description ?? undefined,
    })
    const session = builderPersona
      ? await usePromptSessions.getState().createPromptSession(activeTabCwd, goalText, 'build', 'EpicQueue Run Build', builderPersona.name)
      : await usePromptSessions.getState().createPromptSession(activeTabCwd, goalText, 'build', 'EpicQueue Run Build')
    usePromptSessions.getState().approveProposed(session.id, 'EpicQueue Run Build')
    return { session, openingPrompt }
  }

  const handleClick = async () => {
    if (!activeTabCwd || creating) return
    if (inFlight) {
      onSelect(inFlight.id)
      toast.info('A Build Epic is already in flight for this project — opening it.')
      return
    }
    if (!target) return
    setCreating(true)
    try {
      const created = await createBuildEpic()
      if (!created) return
      const { session, openingPrompt } = created
      useChat.getState().send({
        tabId: session.id,
        sessionId: session.claudeSessionId,
        cwd: activeTabCwd,
        prompt: openingPrompt,
      })
      onSelect(session.id)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setCreating(false)
    }
  }

  const tooltip = !activeTabCwd
    ? 'No active project tab — open a project to use Build'
    : !target
      ? 'No publish target found for this project — add session-manager-operations/architecture/build-target.json or a publishable package.json'
      : inFlight
        ? 'A Build Epic is already in flight for this project — opens it instead of starting a new one'
        : 'Start a fresh Epic that checks git vs the published package and publishes if there\'s anything new'

  return { disabled, inFlight, tooltip, handleClick }
}

const STATUS_ORDER: EpicDisplayStatus[] = ['proposed', 'failed', 'attention', 'running', 'needs', 'queued', 'active', 'completed']

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={11}
      height={11}
      aria-hidden="true"
      className={`shrink-0 text-fg-faint transition-transform duration-100 ${open ? 'rotate-90' : ''}`}
    >
      <path d="M5 3l6 5-6 5" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function PinIcon({ filled }: { filled: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width={11} height={11} aria-hidden="true" fill={filled ? 'currentColor' : 'none'}>
      <path d="M8 2l1.5 3.2L13 6l-2.5 2.4L11 12l-3-1.8L5 12l.5-3.6L3 6l3.5-.8L8 2z" stroke="currentColor" strokeWidth={1.2} strokeLinejoin="round" />
    </svg>
  )
}

function DotsIcon() {
  return (
    <svg viewBox="0 0 16 16" width={13} height={13} aria-hidden="true" fill="currentColor">
      <circle cx="3.5" cy="8" r="1.4" />
      <circle cx="8" cy="8" r="1.4" />
      <circle cx="12.5" cy="8" r="1.4" />
    </svg>
  )
}

interface MenuItem {
  label: string
  onSelect: () => void
  danger?: boolean
  /** Requires a second click within 3s to actually fire — the item's label
   *  flips to `confirmLabel` in between. Used for Delete Epic instead of a
   *  native window.confirm popup. */
  confirm?: boolean
  confirmLabel?: string
  /** Greys the item out and blocks its onSelect — for entry points that
   *  genuinely can't act right now (e.g. Build with no publish target). */
  disabled?: boolean
  /** Optional hover tooltip, e.g. explaining why an item is disabled. */
  title?: string
  testId?: string
}

const CONFIRM_WINDOW_MS = 3000

/** Fixed-position dropdown anchored to a trigger button — mirrors the
 *  design's RowMenu (epics.jsx), reflowing above the anchor when there's
 *  more room up than down and closing on outside click / Escape. */
function RowMenu({ anchor, items, onClose }: { anchor: HTMLElement; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const [confirmingLabel, setConfirmingLabel] = useState<string | null>(null)
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useLayoutEffect(() => {
    const menu = ref.current
    if (!menu) return
    const r = anchor.getBoundingClientRect()
    const h = menu.offsetHeight
    const w = menu.offsetWidth
    const pad = 8
    const below = window.innerHeight - r.bottom - pad
    const above = r.top - pad
    const up = below < h && above > below
    setPos({
      left: Math.max(pad, Math.min(r.right - w, window.innerWidth - w - pad)),
      top: up ? Math.max(pad, r.top - 2 - h) : r.bottom + 2,
    })
  }, [anchor])

  useEffect(() => {
    const away = (ev: MouseEvent) => {
      if (ref.current && !ref.current.contains(ev.target as Node) && !anchor.contains(ev.target as Node)) onClose()
    }
    const esc = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', esc)
      if (confirmTimer.current) clearTimeout(confirmTimer.current)
    }
  }, [anchor, onClose])

  return (
    <div
      ref={ref}
      data-testid="epic-queue-row-menu"
      className="fixed z-[60] min-w-[180px] grid gap-0.5 rounded-lg border border-rule bg-bg-elev p-1 shadow-lg"
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, visibility: pos ? 'visible' : 'hidden' }}
    >
      {items.map((it) => {
        const confirming = Boolean(it.confirm) && confirmingLabel === it.label
        return (
          <button
            key={it.label}
            type="button"
            onClick={(ev) => {
              ev.stopPropagation()
              if (it.disabled) return
              if (it.confirm && !confirming) {
                setConfirmingLabel(it.label)
                if (confirmTimer.current) clearTimeout(confirmTimer.current)
                confirmTimer.current = setTimeout(() => setConfirmingLabel(null), CONFIRM_WINDOW_MS)
                return
              }
              if (confirmTimer.current) clearTimeout(confirmTimer.current)
              onClose()
              it.onSelect()
            }}
            disabled={it.disabled}
            title={it.title}
            data-testid={confirming ? 'epic-queue-row-menu-confirm' : it.testId}
            className={`rounded-md px-2.5 py-1.5 text-left text-[12.5px] font-medium hover:bg-bg-hi disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent ${
              it.danger ? 'text-delta-bad' : 'text-fg'
            }`}
          >
            {confirming ? (it.confirmLabel ?? 'Click again to confirm…') : it.label}
          </button>
        )
      })}
    </div>
  )
}

/** Replaces a QueueRow in place while renaming/editing its goal — title
 *  input + goal textarea prefilled via EpicDetail's splitTitleAndGoal, Save
 *  disabled until dirty + title non-empty, ⌘/Ctrl+Enter saves, Escape
 *  cancels. Save calls promptSessions' renameEpic(id, title, goal). */
function RowEditor({ epic, mode, onCancel }: { epic: PromptSession; mode: 'title' | 'goal'; onCancel: () => void }) {
  const initial = useMemo(() => splitTitleAndGoal(epic.goalText), [epic.goalText])
  const [title, setTitle] = useState(initial.title)
  const [goal, setGoal] = useState(initial.goal)
  const [saving, setSaving] = useState(false)
  const titleRef = useRef<HTMLInputElement | null>(null)
  const goalRef = useRef<HTMLTextAreaElement | null>(null)
  // Cancel unmounts this RowEditor before an in-flight save() settles — guard
  // the post-await state updates so a stale save from a since-abandoned edit
  // can't clobber a freshly reopened editor for the same epic.
  const liveRef = useRef(true)
  useEffect(() => () => {
    liveRef.current = false
  }, [])

  useEffect(() => {
    if (mode === 'title') titleRef.current?.focus()
    else goalRef.current?.focus()
  }, [mode])

  const dirty = title.trim() !== initial.title.trim() || goal.trim() !== initial.goal.trim()
  const canSave = title.trim().length > 0 && dirty && !saving

  const save = async () => {
    if (!canSave) return
    setSaving(true)
    try {
      await usePromptSessions.getState().renameEpic(epic.id, title, goal)
      if (liveRef.current) onCancel()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
      if (liveRef.current) setSaving(false)
    }
  }

  return (
    <div
      data-testid="epic-queue-row-editor"
      onClick={(ev) => ev.stopPropagation()}
      onKeyDown={(ev) => {
        if (ev.key === 'Escape') {
          ev.stopPropagation()
          onCancel()
        } else if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') {
          ev.stopPropagation()
          void save()
        }
      }}
      className="rounded-lg border border-line bg-bg p-2.5 grid gap-1.5"
    >
      <input
        ref={titleRef}
        type="text"
        value={title}
        onChange={(ev) => setTitle(ev.target.value)}
        placeholder="Title"
        data-testid="epic-queue-row-editor-title"
        className="w-full rounded-md border border-rule bg-bg-elev px-2 py-1 text-[12.5px] font-semibold text-fg outline-none focus:border-accent"
      />
      <textarea
        ref={goalRef}
        value={goal}
        onChange={(ev) => setGoal(ev.target.value)}
        placeholder="Goal / first prompt"
        rows={3}
        data-testid="epic-queue-row-editor-goal"
        className="w-full resize-none rounded-md border border-rule bg-bg-elev px-2 py-1 text-[12px] text-fg-dim outline-none focus:border-accent"
      />
      <div className="flex items-center justify-end gap-1.5">
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          data-testid="epic-queue-row-editor-cancel"
          className="rounded-md px-2.5 py-1 text-[11.5px] font-semibold text-fg-faint hover:text-fg disabled:opacity-40"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={!canSave}
          data-testid="epic-queue-row-editor-save"
          className="rounded-md bg-accent px-2.5 py-1 text-[11.5px] font-semibold text-white disabled:opacity-40"
        >
          Save
        </button>
      </div>
    </div>
  )
}

function activityAgeLabel(epicId: string, epic: PromptSession, events: Record<string, PromptSessionEvent[]>, now: number): string {
  const tail = events[epicId]?.slice(-1)[0] ?? null
  const at = tail?.at ?? epic.createdAt
  const ms = Date.parse(at)
  if (Number.isNaN(ms)) return ''
  return formatAgo(ms, now)
}

interface QueueRowProps {
  epic: PromptSession
  snapshots: EpicSnapshots
  events: Record<string, PromptSessionEvent[]>
  status: EpicDisplayStatus
  selected: boolean
  compact: boolean
  now: number
  onSelect: (id: string) => void
  pinned?: boolean
  onPin?: (id: string) => void
}

/** Row actions available from every Epic's overflow menu — built from store
 *  actions that already exist: copy the claude session id, mark completed
 *  (mirrors EpicDetail's own button), jump straight into the Epic's Terminal
 *  view, rename/edit-goal (opens the in-place RowEditor), duplicate as a new
 *  Epic, reopen a completed Epic, and delete (with an in-menu confirm step). */
function useRowMenuItems(
  epic: PromptSession,
  status: EpicDisplayStatus,
  onSelect: (id: string) => void,
  onEdit: (mode: 'title' | 'goal') => void,
): MenuItem[] {
  const items: MenuItem[] = [
    {
      label: 'Copy Epic ID',
      onSelect: () => {
        void navigator.clipboard?.writeText(epic.id).then(
          () => toast.info('Epic id copied'),
          () => toast.error('Copy failed'),
        )
      },
    },
    { label: 'Rename title', onSelect: () => onEdit('title') },
    { label: 'Edit goal / first prompt', onSelect: () => onEdit('goal') },
  ]
  if (epic.status === 'active') {
    items.push({
      label: 'Resume in terminal',
      onSelect: () => {
        onSelect(epic.id)
        useEpicTerminal.getState().setMode(epic.id, 'terminal')
      },
    })
    if (status !== 'completed') {
      items.push({
        label: 'Mark completed',
        onSelect: () => void usePromptSessions.getState().markCompleted(epic.id, 'EpicQueue row menu'),
      })
    }
  }
  if (epic.status === 'completed') {
    items.push({
      label: 'Reopen',
      onSelect: () => {
        usePromptSessions
          .getState()
          .resumeArchived(epic.id, 'EpicQueue row menu')
          .catch((err: unknown) => {
            toast.error(err instanceof Error ? err.message : String(err))
          })
      },
    })
  }
  items.push({
    label: 'Duplicate as new Epic',
    onSelect: () => {
      usePromptSessions
        .getState()
        .duplicateEpic(epic.id, 'EpicQueue row menu')
        .then((dup) => onSelect(dup.id))
        .catch((err: unknown) => {
          toast.error(err instanceof Error ? err.message : String(err))
        })
    },
  })
  items.push({
    label: 'Delete Epic',
    danger: true,
    confirm: true,
    confirmLabel: 'Click again to delete…',
    onSelect: () => {
      usePromptSessions
        .getState()
        .deleteEpic(epic.id, 'EpicQueue row menu')
        .catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)))
    },
  })
  return items
}

function RowMenuButton({
  epic,
  status,
  onSelect,
  onEdit,
  className,
}: {
  epic: PromptSession
  status: EpicDisplayStatus
  onSelect: (id: string) => void
  onEdit: (mode: 'title' | 'goal') => void
  className: string
}) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const items = useRowMenuItems(epic, status, onSelect, onEdit)
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          setOpen((v) => !v)
        }}
        title="Epic actions"
        aria-label={`Actions for ${epic.goalText}`}
        data-testid="epic-queue-row-menu-trigger"
        className={className}
      >
        <DotsIcon />
      </button>
      {open && btnRef.current && <RowMenu anchor={btnRef.current} items={items} onClose={() => setOpen(false)} />}
    </>
  )
}

/** Toolbar's single entry point, replacing the old split Build button + "+ New
 *  Epic" button trio with one accent "Actions" trigger + RowMenu — reuses the
 *  same dropdown pattern as the per-row overflow menu. Exactly two items:
 *  "+ New Epic" and "Run Build" — no further split of Run Build into a
 *  separate "discuss first" entry. */
function ActionsMenuButton({ onNew, onSelect }: { onNew: () => void; onSelect: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const build = useBuildAction(onSelect)

  const items: MenuItem[] = [
    {
      label: '+ New Epic',
      onSelect: onNew,
      testId: 'epic-queue-new',
    },
    {
      label: build.inFlight ? 'Open Build in progress' : 'Run Build',
      onSelect: () => void build.handleClick(),
      disabled: build.disabled,
      title: build.tooltip,
      testId: 'epic-queue-build',
    },
  ]

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        data-testid="epic-queue-actions"
        className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 bg-accent text-white text-xs font-semibold shadow-sm"
      >
        Actions
      </button>
      {open && btnRef.current && <RowMenu anchor={btnRef.current} items={items} onClose={() => setOpen(false)} />}
    </>
  )
}

function QueueRow({ epic, snapshots, events, status, selected, compact, now, onSelect, pinned = false, onPin }: QueueRowProps) {
  const [editing, setEditing] = useState<'title' | 'goal' | null>(null)
  const age = activityAgeLabel(epic.id, epic, events, now)
  const queuedDetail =
    status === 'queued' || status === 'failed' || status === 'attention'
      ? epicQueuedDetail(epic.id, snapshots)
      : undefined

  if (editing) {
    return <RowEditor epic={epic} mode={editing} onCancel={() => setEditing(null)} />
  }

  if (compact) {
    return (
      <div className="relative">
        <button
          type="button"
          onClick={() => onSelect(epic.id)}
          data-testid="epic-queue-row"
          data-epic-id={epic.id}
          title={queuedDetail}
          className={`w-full grid grid-cols-[8px_minmax(0,1fr)_auto] items-center gap-2 rounded-md py-1.5 px-2 text-left border-l-2 ${
            selected ? 'bg-bg-hi border-l-accent' : 'border-l-transparent hover:bg-bg-hi/60'
          } ${onPin ? 'pr-12' : 'pr-6'}`}
        >
          <span className={`w-1.5 h-1.5 rounded-full ${epicStatusDotClass(status)} ${status === 'completed' ? 'opacity-45' : ''}`} aria-hidden="true" />
          <span className="min-w-0 flex items-center gap-1.5">
            {pinned && <span className="text-accent shrink-0" aria-hidden="true"><PinIcon filled /></span>}
            <span className={`min-w-0 truncate text-[12.5px] ${selected ? 'font-semibold text-fg' : 'text-fg-dim'}`}>{epic.goalText}</span>
          </span>
          <span className="font-mono text-[10px] text-fg-faint shrink-0">{age}</span>
        </button>
        {onPin && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onPin(epic.id)
            }}
            title={pinned ? 'Unpin' : 'Pin to top'}
            aria-label={pinned ? `Unpin ${epic.goalText}` : `Pin ${epic.goalText} to top`}
            data-testid="epic-queue-row-pin"
            className={`absolute top-1/2 -translate-y-1/2 right-6 p-0.5 ${pinned ? 'text-accent' : 'text-fg-faint opacity-40 hover:opacity-100'}`}
          >
            <PinIcon filled={pinned} />
          </button>
        )}
        <RowMenuButton
          epic={epic}
          status={status}
          onSelect={onSelect}
          onEdit={setEditing}
          className="absolute top-1/2 -translate-y-1/2 right-1 p-0.5 text-fg-faint opacity-60 hover:opacity-100 hover:text-fg"
        />
      </div>
    )
  }

  const prds = epicPrds(epic.id, snapshots)
  const stats = epicStats(epic.id, snapshots)

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => onSelect(epic.id)}
        data-testid="epic-queue-row"
        data-epic-id={epic.id}
        className={`relative w-full text-left rounded-lg p-2.5 grid gap-1.5 ${
          selected ? 'bg-bg-hi shadow-sm ring-1 ring-line' : 'hover:bg-bg-hi/50'
        }`}
      >
        {selected && (
          <span className={`absolute inset-y-0 left-0 w-[3px] rounded-l-lg ${epicStatusDotClass(status)}`} aria-hidden="true" />
        )}
        <span className="flex items-center gap-1.5">
          <EpicStatusChip status={status} small detail={queuedDetail} />
          <EpicKindTag kind={epic.tag} small />
          <span className="ml-auto font-mono text-[10.5px] text-fg-faint pr-9">{age}</span>
        </span>
        <span className="text-[13px] font-semibold text-fg leading-snug line-clamp-1">{epic.goalText}</span>
        <span className="flex items-center gap-3 font-mono text-[10.5px] text-fg-faint">
          {prds.length > 0 && (
            <span>
              {prds.length} {prds.length === 1 ? 'PRD' : 'PRDs'}
            </span>
          )}
          {stats !== null && <span>{stats.turns} turns</span>}
          {stats?.tokens && <span>{stats.tokens} tok</span>}
        </span>
      </button>
      {onPin && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onPin(epic.id)
          }}
          title={pinned ? 'Unpin' : 'Pin to top'}
          aria-label={pinned ? `Unpin ${epic.goalText}` : `Pin ${epic.goalText} to top`}
          data-testid="epic-queue-row-pin"
          className={`absolute top-2 right-7 p-0.5 ${pinned ? 'text-accent' : 'text-fg-faint opacity-40 hover:opacity-100'}`}
        >
          <PinIcon filled={pinned} />
        </button>
      )}
      <RowMenuButton
        epic={epic}
        status={status}
        onSelect={onSelect}
        onEdit={setEditing}
        className="absolute top-2 right-2 p-0.5 text-fg-faint opacity-60 hover:opacity-100 hover:text-fg"
      />
    </div>
  )
}

/** A precomputed, already-grouped-and-paged section — PRD 828's control layer owns this shape. */
export interface EpicQueueSection {
  key: string
  label: string
  dotClass: string
  /** Rows to render — already sliced to the current page limit. */
  items: PromptSession[]
  /** Full (unpaged) count, for the "N hidden" paging button. */
  total: number
}

export interface EpicQueueProps {
  /** Already-filtered, already-sorted epic list — PRD 828 owns search/sort/pin. */
  epics: PromptSession[]
  snapshots: EpicSnapshots
  events: Record<string, PromptSessionEvent[]>
  selectedId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  compact?: boolean
  /** Injectable for tests; defaults to Date.now(). */
  now?: number
  /** Precomputed grouped+paged sections, overriding the default status-only grouping. */
  sections?: EpicQueueSection[]
  /** Rows pinned to a sticky "pinned" section above the groups. */
  pinnedEpics?: PromptSession[]
  onPin?: (id: string) => void
  /** Reveal the next page of a section (id === section.key). */
  onShowMore?: (key: string) => void
  /** Overrides the zero-epics empty state — e.g. a "no search match" state. */
  emptyState?: { title: string; hint?: ReactNode }
  /** Controlled collapse state, keyed by section key — lets a caller (e.g. keyboard nav) read it. Falls back to internal state when omitted. */
  closedKeys?: ReadonlySet<string>
  onToggleSection?: (key: string) => void
  /** Search/chips/group-sort controls, rendered inside this component's own
   *  header block (below the title row, above the scrollable list) — keeps
   *  the 352px/border-r container single-owned instead of a caller nesting
   *  a second one around this component. */
  filters?: ReactNode
  /** Rendered below the scrollable list, inside this component's own container. */
  footer?: ReactNode
}

export function EpicQueue({
  epics,
  snapshots,
  events,
  selectedId,
  onSelect,
  onNew,
  compact = false,
  now,
  sections: sectionsProp,
  pinnedEpics = [],
  onPin,
  onShowMore,
  emptyState,
  closedKeys,
  onToggleSection,
  filters,
  footer,
}: EpicQueueProps) {
  const [internalClosed, setInternalClosed] = useState<Set<string>>(() => new Set(['completed']))
  const closedSections = closedKeys ?? internalClosed
  const nowMs = now ?? Date.now()

  const defaultSections = useMemo<EpicQueueSection[]>(() => {
    const buckets = new Map<EpicDisplayStatus, PromptSession[]>()
    for (const epic of epics) {
      const status = epicDisplayStatus(epic.id, snapshots)
      if (!buckets.has(status)) buckets.set(status, [])
      buckets.get(status)!.push(epic)
    }
    return STATUS_ORDER.filter((s) => buckets.has(s)).map((s) => {
      const items = buckets.get(s)!
      return { key: s, label: epicStatusLabel(s), dotClass: epicStatusDotClass(s), items, total: items.length }
    })
  }, [epics, snapshots])

  const sections = sectionsProp ?? defaultSections

  const toggleSection = (key: string) => {
    if (onToggleSection) {
      onToggleSection(key)
      return
    }
    setInternalClosed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const isEmpty = sectionsProp
    ? sectionsProp.length === 0 && pinnedEpics.length === 0
    : epics.length === 0 && pinnedEpics.length === 0

  return (
    <aside className="w-[352px] h-full shrink-0 border-r border-line bg-bg-elev flex flex-col min-h-0">
      <div className={`flex items-center gap-2 px-3.5 py-3 ${filters ? '' : 'border-b border-line'}`}>
        <span className="font-mono text-[10.5px] font-semibold tracking-[1.1px] uppercase text-fg-faint">Epic queue</span>
        <span className="font-mono text-[10.5px] text-fg-faint">{epics.length}</span>
        <span className="ml-auto flex items-center gap-1.5">
          <ActionsMenuButton onNew={onNew} onSelect={onSelect} />
        </span>
      </div>

      {filters}

      <div className="flex-1 overflow-y-auto min-h-0 px-2 py-1.5">
        {isEmpty ? (
          <EmptyState
            title={emptyState?.title ?? 'No Epics yet'}
            hint={
              emptyState?.hint ?? (
                <button type="button" onClick={onNew} className="mt-2 text-accent font-semibold text-xs">
                  + New Epic
                </button>
              )
            }
          />
        ) : (
          <>
            {pinnedEpics.length > 0 && (
              <div className="mb-2">
                <div className="sticky top-0 z-10 flex items-center gap-1.5 bg-bg-elev py-1.5 px-1.5">
                  <span className="text-accent" aria-hidden="true">
                    <PinIcon filled />
                  </span>
                  <span className="font-mono text-[10px] font-semibold tracking-[0.9px] uppercase text-fg-dim">pinned</span>
                  <span className="font-mono text-[10px] text-fg-faint">{pinnedEpics.length}</span>
                </div>
                <div className={`grid ${compact ? 'gap-px' : 'gap-1.5'}`}>
                  {pinnedEpics.map((epic) => (
                    <QueueRow
                      key={epic.id}
                      epic={epic}
                      snapshots={snapshots}
                      events={events}
                      status={epicDisplayStatus(epic.id, snapshots)}
                      selected={epic.id === selectedId}
                      compact={compact}
                      now={nowMs}
                      onSelect={onSelect}
                      pinned
                      onPin={onPin}
                    />
                  ))}
                </div>
              </div>
            )}

            {sections.map((section) => {
              const closed = closedSections.has(section.key)
              const hidden = section.total - section.items.length
              return (
                <div key={section.key} className="mb-1.5">
                  <button
                    type="button"
                    onClick={() => toggleSection(section.key)}
                    className="sticky top-0 z-10 w-full flex items-center gap-1.5 bg-bg-elev py-1.5 px-1.5 text-left"
                  >
                    <ChevronIcon open={!closed} />
                    <span className={`w-1.5 h-1.5 rounded-full ${section.dotClass}`} aria-hidden="true" />
                    <span className="font-mono text-[10px] font-semibold tracking-[0.9px] uppercase text-fg-dim">
                      {section.label}
                    </span>
                    <span className="font-mono text-[10px] text-fg-faint">{section.total}</span>
                    <span className="ml-auto h-px flex-1 bg-rule opacity-70" />
                  </button>
                  {!closed && (
                    <div className={`grid ${compact ? 'gap-px' : 'gap-1.5'}`}>
                      {section.items.map((epic) => (
                        <QueueRow
                          key={epic.id}
                          epic={epic}
                          snapshots={snapshots}
                          events={events}
                          status={epicDisplayStatus(epic.id, snapshots)}
                          selected={epic.id === selectedId}
                          compact={compact}
                          now={nowMs}
                          onSelect={onSelect}
                          onPin={onPin}
                        />
                      ))}
                      {hidden > 0 && onShowMore && (
                        <button
                          type="button"
                          onClick={() => onShowMore(section.key)}
                          data-testid="epic-queue-show-more"
                          className="text-left rounded-md border border-dashed border-rule px-2.5 py-1.5 my-0.5 text-[11.5px] font-semibold text-fg-faint"
                        >
                          Show {Math.min(40, hidden)} more · {hidden} hidden
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </>
        )}
      </div>

      {footer}
    </aside>
  )
}
