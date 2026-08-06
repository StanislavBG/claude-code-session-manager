/**
 * AlmanacFooter — paper-warm window footer that replaces StatusBar.
 * One 30px strip: connected dot · 5h window state · prompts/cost · branch · version.
 *
 * Click handlers route through props rather than navigate-directly so the
 * App owns routing — clicking the 5h pill opens Home (where the billing
 * meters live), branch opens nothing (informational), connected dot opens
 * Settings.
 */

import { forwardRef, useEffect, useRef, useState } from 'react'
import { Z } from '../../lib/zLayers'
import { useSessions } from '../../state/sessions'
import { useLiveTab } from '../../state/live'
import type { TodoItem } from '../../state/live'
import { useBilling, getBillingData } from '../../state/billing'
import { useScheduleState } from '../../state/scheduleState'
import { useBranch } from '../../lib/useBranch'
import type { NavKey } from '../LeftNav'

interface AlmanacFooterProps {
  onNavigate?: (k: NavKey) => void
}

export function AlmanacFooter({ onNavigate }: AlmanacFooterProps) {
  const tabs = useSessions((s) => s.tabs)
  const activeTabId = useSessions((s) => s.activeTabId)
  const tab = tabs.find((t) => t.id === activeTabId) ?? null
  const live = useLiveTab(tab)
  const lastEventAt = live?.lastEventAt ?? 0
  const billing = useBilling((s) => s.data)
  const schedPaused = useScheduleState((s) => s.snapshot?.paused ?? null)
  const branch = useBranch(tab?.cwd ?? null)
  // Force re-render every 60s so the "X min ago" + remaining tick.
  const [, tick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 60_000)
    return () => clearInterval(id)
  }, [])

  const todos = live?.todos ?? []
  const [todosOpen, setTodosOpen] = useState(false)
  const todoRef = useRef<HTMLDivElement>(null)
  // Close todos popover on outside click.
  useEffect(() => {
    if (!todosOpen) return
    const handler = (e: MouseEvent) => {
      if (todoRef.current && !todoRef.current.contains(e.target as Node)) setTodosOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [todosOpen])
  // Collapse the popover when there's nothing to show (e.g. session switch).
  useEffect(() => { if (todos.length === 0) setTodosOpen(false) }, [todos.length])

  const data = getBillingData(billing)
  const fiveHour = data?.usage.five_hour ?? null
  const util = fiveHour ? Math.round(fiveHour.utilization) : null
  const isConnected = billing?.kind === 'ok' || billing?.kind === 'ok-stale'

  const lastTxt = lastEventAt > 0 ? relSeconds(Date.now() - lastEventAt) : '—'

  return (
    <div
      className="h-[30px] shrink-0 bg-bg-elev border-t border-line flex items-center gap-4 px-[18px] font-mono text-[11.5px] text-fg-dim"
      data-testid="tour-statusbar"
    >
      <button
        onClick={() => onNavigate?.('settings')}
        className="flex items-center gap-1.5 hover:text-fg transition-colors"
        title={isConnected ? 'Connected to Anthropic' : 'Disconnected'}
      >
        <span className={`w-1.5 h-1.5 rounded-full ${isConnected ? 'bg-sage' : 'bg-fg-faint'}`} />
        <span>{isConnected ? 'connected' : 'offline'}</span>
      </button>

      <button
        onClick={() => onNavigate?.('overview')}
        className="hover:text-fg transition-colors"
        title="Open Home"
      >
        {util != null ? `${util}% of 5h window used` : '5h —'}
      </button>

      {schedPaused && (
        <button
          onClick={() => onNavigate?.('scheduler')}
          title="Scheduler is paused — click to open Scheduler"
          className={`flex items-center gap-1 px-1.5 py-0.5 rounded border font-mono text-[10.5px] transition-colors ${
            schedPaused.reason === 'auth' || schedPaused.reason === 'network'
              ? 'border-red-700/60 text-red-300 hover:bg-red-900/20'
              : 'border-amber-700/60 text-amber-300 hover:bg-amber-900/20'
          }`}
        >
          <span className="w-1.5 h-1.5 rounded-full bg-current opacity-80" />
          Scheduler paused · {schedPaused.reason}
        </button>
      )}

      {tab && (
        <span className="text-fg-faint" title={tab.cwd}>
          {tab.label}
          {branch && <span className="text-fg-dim"> · ⌥{branch}</span>}
        </span>
      )}

      <span className="text-fg-faint">last activity: <span className="text-fg-dim">{lastTxt}</span></span>

      {todos.length > 0 && (
        <TodoChip
          ref={todoRef}
          todos={todos}
          open={todosOpen}
          onToggle={() => setTodosOpen((v) => !v)}
        />
      )}

      <span className="flex-1" />

      <span className="text-fg-faint">v{__APP_VERSION__}</span>
    </div>
  )
}

/**
 * TodoChip — the live TodoWrite checklist for the active session, surfaced in
 * the footer (replaces the standalone Tasks tab). Shows a done/active/pending
 * count; click to expand the full list in a popover anchored above the footer.
 */
const TodoChip = forwardRef<HTMLDivElement, {
  todos: TodoItem[]
  open: boolean
  onToggle: () => void
}>(function TodoChip({ todos, open, onToggle }, ref) {
  const counts = {
    completed: todos.filter((t) => t.status === 'completed').length,
    in_progress: todos.filter((t) => t.status === 'in_progress').length,
    pending: todos.filter((t) => t.status === 'pending').length,
  }
  return (
    <div ref={ref} className="relative">
      <button
        onClick={onToggle}
        className="flex items-center gap-1.5 hover:text-fg transition-colors"
        title="Live to-dos for this session"
        data-testid="footer-todos"
      >
        <span className="text-green-400">✓{counts.completed}</span>
        <span className="text-accent">●{counts.in_progress}</span>
        <span className="text-fg-dim">○{counts.pending}</span>
        <span className="text-fg-faint">todos {open ? '▾' : '▴'}</span>
      </button>
      {open && (
        <div
          className={`absolute bottom-full left-0 mb-1.5 w-80 max-h-72 overflow-auto bg-bg-elev border border-line rounded shadow-xl p-2 ${Z.dialog}`}
          data-testid="footer-todos-popover"
        >
          <ul className="space-y-0.5">
            {todos.map((t, i) => (
              <li key={i} className={`flex items-start gap-2 py-1 px-1.5 rounded ${t.status === 'in_progress' ? 'bg-bg-hi' : ''}`}>
                <StatusGlyph status={t.status} />
                <span className={
                  t.status === 'completed' ? 'text-fg-faint line-through'
                    : t.status === 'in_progress' ? 'text-fg'
                    : 'text-fg-dim'
                }>
                  {t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
})

function StatusGlyph({ status }: { status: TodoItem['status'] }) {
  if (status === 'completed') return <span className="text-green-400 w-3 shrink-0">✓</span>
  if (status === 'in_progress') return <span className="w-3 shrink-0"><span className="inline-block w-1.5 h-1.5 rounded-full bg-accent animate-pulse" /></span>
  return <span className="text-fg-faint w-3 shrink-0">○</span>
}

function relSeconds(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  return `${h}h ago`
}
