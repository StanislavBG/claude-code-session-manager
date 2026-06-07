import { useEffect, useState } from 'react'
import { useSessions } from '../../state/sessions'
import { useLiveTab, type ToolUseEntry, type ActivityEvent, type TodoItem } from '../../state/live'
import { useBilling, getFiveHourUtil } from '../../state/billing'
import { useScheduleState } from '../../state/scheduleState'
import { formatRelative } from '../../lib/formatTime'
import { SessionPlansView } from './plans/SessionPlansView'

/**
 * AgentView — single-screen observability for the active session.
 *
 * Three zones, each answering a clear question:
 *   1. Hero    — what is the agent doing right now?
 *   2. Body    — what is it trying to accomplish (todos) and what just
 *                happened (activity feed) or planned (session plans)?
 *   3. Footer  — resource status (5h budget, subagents, scheduler).
 *
 * The right body column toggles Activity ⇄ Plans; "Session Plans" used to be a
 * top-level nav destination but is session-scoped observability, so it lives
 * here. Scheduler PRDs (the long-term planning surface) live in the Scheduler.
 */

const IDLE_AFTER_MS = 3000
const ACTIVITY_LIMIT = 14
type SessionState = 'offline' | 'idle' | 'working'

function extractToolTarget(entry: ToolUseEntry): string {
  try {
    const input = entry.input as Record<string, unknown>
    switch (entry.name) {
      case 'Bash':
        return String(input.command ?? '').slice(0, 80)
      case 'Read': case 'Edit': case 'Write': case 'NotebookEdit': {
        const fp = String(input.file_path ?? '')
        return fp.split('/').pop() ?? fp.slice(0, 80)
      }
      case 'Grep': case 'Glob':
        return String(input.pattern ?? '').slice(0, 80)
      case 'WebFetch': {
        const url = String(input.url ?? '')
        try { return new URL(url).hostname }
        catch { return url.slice(0, 80) }
      }
      case 'WebSearch':
        return String(input.query ?? '').slice(0, 80)
      case 'Task':
        return String(input.subagent_type ?? input.description ?? '').slice(0, 80)
      default:
        return ''
    }
  } catch {
    return ''
  }
}

export function AgentView() {
  const tabs = useSessions((s) => s.tabs)
  const activeTabId = useSessions((s) => s.activeTabId)
  const tab = tabs.find((t) => t.id === activeTabId) ?? null
  const live = useLiveTab(tab)

  const billing = useBilling((s) => s.data)
  const fiveHourUtil = getFiveHourUtil(billing)

  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])

  const schedulerJobs = useScheduleState((s) => s.snapshot?.jobs ?? [])

  const sessionRunning = tab?.status === 'running'
  const lastEventAt = live?.lastEventAt ?? 0
  const state: SessionState = !sessionRunning
    ? 'offline'
    : lastEventAt > 0 && now - lastEventAt < IDLE_AFTER_MS
      ? 'working'
      : 'idle'

  const latestTool = live?.lastToolUses[0]
  const latestToolAge = latestTool ? now - latestTool.at : Infinity
  const showTool = latestTool && latestToolAge < 30_000
  const toolTarget = showTool ? extractToolTarget(latestTool!) : ''

  const todos = live?.todos ?? []
  const todoActive = todos.find((t) => t.status === 'in_progress')
  const todoP = todos.filter((t) => t.status === 'pending').length
  const todoI = todos.filter((t) => t.status === 'in_progress').length
  const todoD = todos.filter((t) => t.status === 'completed').length

  const toolCount60 = live?.lastToolUses.filter((t) => now - t.at < 60_000).length ?? 0
  const recentAgents = (live?.agents ?? []).filter((a) => now - a.lastActivityAt < 5 * 60_000)
  const runningJobs = schedulerJobs.filter((j) => j.status === 'running')

  // Activity feed: ring is appended (newest at tail) — reverse so newest renders first.
  const activity = (live?.activityRing ?? []).slice(-ACTIVITY_LIMIT).reverse()

  const dotColor =
    state === 'offline' ? 'var(--color-fg-faint, #6b7280)'
    : state === 'working' ? '#fbbf24'
    : '#34d399'
  const stateLabel = state === 'offline' ? 'offline' : state
  const stateDescription =
    state === 'offline'
      ? (tab ? `session ${tab.status}` : 'no active session')
      : showTool
        ? (
            <>
              calling <span className="text-accent">{latestTool!.name}</span>
              {toolTarget && <span className="text-fg-dim"> · {toolTarget}</span>}
            </>
          )
        : state === 'working'
          ? 'thinking…'
          : 'idle — waiting for input'

  return (
    <div className="h-full w-full flex flex-col bg-bg text-fg overflow-hidden">
      {/* HERO — what's happening right now */}
      <header className="shrink-0 px-8 pt-7 pb-6 border-b border-rule">
        <div className="flex items-baseline gap-3">
          <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-fg-faint">
            Workspace
          </span>
          <span className="text-fg-faint">·</span>
          <span className="text-[11px] font-mono text-fg-dim truncate">
            {tab ? tab.cwd.replace(/^\/home\/[^/]+/, '~') : '—'}
          </span>
          <span className="ml-auto flex items-center gap-2">
            <span
              className="inline-block w-2 h-2 rounded-full"
              style={{
                background: dotColor,
                boxShadow: state === 'working' ? `0 0 0 3px ${dotColor}33` : undefined,
              }}
              aria-hidden
            />
            <span className="text-[11px] font-mono uppercase tracking-[0.14em] text-fg-dim">
              {stateLabel}
            </span>
          </span>
        </div>
        <h1 className="mt-3 font-serif text-[32px] font-medium leading-[1.15] text-fg m-0">
          {tab ? (tab.label || tab.id.slice(0, 8)) : 'Agent view'}
        </h1>
        <div className="mt-2 text-[14px] font-mono text-fg-dim min-h-[22px]">
          {stateDescription}
        </div>
      </header>

      {/* BODY — todos (left) + activity (right) */}
      <div className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-[1.05fr_1fr] gap-px bg-rule/50">
        <Panel
          title="Tasks"
          subtitle={todos.length === 0 ? 'no tasks declared' : `${todoI} active · ${todoP} pending · ${todoD} done`}
        >
          {todos.length === 0 ? (
            <EmptyHint>
              {state === 'offline'
                ? 'Start or attach a session.'
                : 'The agent has not declared any todos yet.'}
            </EmptyHint>
          ) : (
            <ul className="space-y-1.5">
              {todos.map((t, i) => (
                <TodoRow key={i} todo={t} active={t === todoActive} />
              ))}
            </ul>
          )}
        </Panel>

        <ActivityPlansPanel
          activity={activity}
          now={now}
          toolCount60={toolCount60}
          state={state}
          planCount={live?.plans.length ?? 0}
        />
      </div>

      {/* FOOTER — resources & background work */}
      <footer className="shrink-0 px-8 py-4 border-t border-rule bg-bg-elev/30">
        <div className="flex items-center gap-6 flex-wrap">
          <BudgetBar util={fiveHourUtil} />
          <Pill
            label="Subagents"
            value={recentAgents.length}
            detail={recentAgents.slice(0, 2).map((a) => a.subagentType ?? 'agent').join(', ')}
          />
          <Pill
            label="Scheduler"
            value={runningJobs.length}
            detail={runningJobs.slice(0, 1).map((j) => j.slug).join(', ')}
          />
        </div>
      </footer>
    </div>
  )
}

/* ---------- panels & rows ---------- */

function Panel({
  title, subtitle, children,
}: {
  title: string
  subtitle?: string
  children: React.ReactNode
}) {
  return (
    <section className="bg-bg min-h-0 flex flex-col">
      <div className="shrink-0 px-6 pt-5 pb-3 flex items-baseline gap-3">
        <h2 className="font-serif text-[18px] font-medium text-fg m-0">{title}</h2>
        {subtitle && (
          <span className="text-[11px] font-mono text-fg-faint uppercase tracking-[0.08em]">
            {subtitle}
          </span>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-auto px-6 pb-6">
        {children}
      </div>
    </section>
  )
}

/**
 * Right body column — switches between the live Activity feed and this
 * session's Plans (revisions parsed from the transcript). Plans used to be a
 * top-level nav destination ("Plans → Session Plans"); it's session-scoped
 * observability, so it belongs here next to the activity feed.
 */
function ActivityPlansPanel({
  activity, now, toolCount60, state, planCount,
}: {
  activity: ActivityEvent[]
  now: number
  toolCount60: number
  state: SessionState
  planCount: number
}) {
  const [view, setView] = useState<'activity' | 'plans'>('activity')
  return (
    <section className="bg-bg min-h-0 flex flex-col">
      <div className="shrink-0 px-6 pt-5 pb-3 flex items-baseline gap-4">
        {(['activity', 'plans'] as const).map((v) => (
          <button
            key={v}
            onClick={() => setView(v)}
            className={[
              'font-serif text-[18px] font-medium m-0 transition-colors',
              view === v ? 'text-fg' : 'text-fg-faint hover:text-fg-dim',
            ].join(' ')}
          >
            {v === 'activity' ? 'Activity' : 'Plans'}
            {v === 'plans' && planCount > 0 && (
              <span className="ml-1.5 text-[11px] font-mono text-fg-faint align-middle">{planCount}</span>
            )}
          </button>
        ))}
        {view === 'activity' && (
          <span className="ml-auto text-[11px] font-mono text-fg-faint uppercase tracking-[0.08em]">
            {activity.length === 0 ? 'no events yet' : `${toolCount60} tool calls in last 60s`}
          </span>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {view === 'plans' ? (
          <SessionPlansView />
        ) : (
          <div className="px-6 pb-6">
            {activity.length === 0 ? (
              <EmptyHint>
                {state === 'offline'
                  ? 'Activity will appear once the session is running.'
                  : 'Waiting for the agent to act…'}
              </EmptyHint>
            ) : (
              <ol className="space-y-1">
                {activity.map((ev) => (
                  <ActivityRow key={ev.id} ev={ev} now={now} />
                ))}
              </ol>
            )}
          </div>
        )}
      </div>
    </section>
  )
}

function TodoRow({ todo, active }: { todo: TodoItem; active: boolean }) {
  const isDone = todo.status === 'completed'
  const isActive = todo.status === 'in_progress'
  const label = isActive && todo.activeForm ? todo.activeForm : todo.content

  // Vertical accent bar marks the in-progress item without taking extra rows.
  return (
    <li
      className={[
        'relative flex items-start gap-3 pl-3 py-1.5 rounded-sm',
        active ? 'bg-bg-elev/50' : '',
      ].join(' ')}
    >
      {isActive && (
        <span
          aria-hidden
          className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-full bg-accent"
        />
      )}
      <span
        className={[
          'mt-[3px] inline-flex w-3.5 h-3.5 shrink-0 items-center justify-center text-[10px] font-mono',
          isDone ? 'text-fg-faint' : isActive ? 'text-accent' : 'text-fg-dim',
        ].join(' ')}
        aria-hidden
      >
        {isDone ? '✓' : isActive ? '▸' : '○'}
      </span>
      <span
        className={[
          'text-[13px] leading-[1.4]',
          isDone ? 'text-fg-faint line-through' : isActive ? 'text-fg' : 'text-fg-dim',
        ].join(' ')}
      >
        {label}
      </span>
    </li>
  )
}

function ActivityRow({ ev, now }: { ev: ActivityEvent; now: number }) {
  const age = formatRelative(now - ev.at)
  const accent = activityAccent(ev)
  return (
    <li className="flex items-baseline gap-3 py-1 font-mono text-[12.5px]">
      <span className="shrink-0 w-10 text-[10.5px] text-fg-faint tabular-nums">{age}</span>
      <span className={`shrink-0 ${accent}`}>{activityIcon(ev)}</span>
      <span className="truncate text-fg-dim">{ev.label}</span>
    </li>
  )
}

function activityIcon(ev: ActivityEvent): string {
  switch (ev.kind) {
    case 'tool-use':      return ev.toolName ?? 'tool'
    case 'file-edit':     return 'edit'
    case 'todo-update':   return 'todos'
    case 'plan-revision': return 'plan'
    case 'agent-spawn':   return 'agent'
    case 'usage-tick':    return 'tokens'
    default:              return '·'
  }
}

function activityAccent(ev: ActivityEvent): string {
  switch (ev.kind) {
    case 'tool-use':
    case 'file-edit':
      return 'text-accent'
    case 'agent-spawn':
      return 'text-fg'
    case 'plan-revision':
      return 'text-fg'
    default:
      return 'text-fg-dim'
  }
}

/* ---------- footer chrome ---------- */

function BudgetBar({ util }: { util: number }) {
  const pct = Math.round(util)
  const color = util < 50 ? '#34d399' : util < 80 ? '#fbbf24' : '#f43f5e'
  return (
    <div className="flex items-center gap-3 min-w-[220px]">
      <span className="text-[10px] uppercase tracking-[0.1em] text-fg-faint font-semibold shrink-0">
        5h budget
      </span>
      <div className="flex-1 h-1.5 rounded-full bg-bg-elev overflow-hidden min-w-[120px]">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${Math.min(100, pct)}%`, background: color }}
        />
      </div>
      <span className="font-mono text-[11px] text-fg-dim tabular-nums w-8 text-right">{pct}%</span>
    </div>
  )
}

function Pill({ label, value, detail }: { label: string; value: number; detail?: string }) {
  const dim = value === 0
  return (
    <div className="flex items-baseline gap-2">
      <span
        className={[
          'text-[10px] uppercase tracking-[0.1em] font-semibold',
          dim ? 'text-fg-faint' : 'text-fg-dim',
        ].join(' ')}
      >
        {label}
      </span>
      <span
        className={[
          'font-mono text-[14px] tabular-nums',
          dim ? 'text-fg-faint' : 'text-fg',
        ].join(' ')}
      >
        {value}
      </span>
      {!dim && detail && (
        <span className="text-[11px] font-mono text-fg-faint truncate max-w-[180px]">
          {detail}
        </span>
      )}
    </div>
  )
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return <div className="text-[12px] text-fg-faint italic">{children}</div>
}

