import { useCallback, useEffect, useMemo, useState } from 'react'
import type { TaskSummary, TaskListQuery, TaskSwitchBy } from '../../../../preload/api.d'
import { useToast } from '../../../state/toast'
import { usd } from '../../../lib/analyticsFormat'
import { TaskDetail } from './TaskDetail'

/**
 * Tasks sub-view of the Scheduler page — this project's Task ledger
 * (window.api.tasks, main/lib/tasks/taskIpc.cjs), grouped by caller pipeline
 * then run, newest first. Data is local component state (no zustand store).
 * The list is the one scroller under the Scheduler bands; clicking a row opens
 * a sibling TaskDetail panel (its own column scroller, never nested).
 */

const POLL_MS = 15_000
const LIMIT = 200
const UNGROUPED = 'Ungrouped'
const NO_RUN = '(no run)'

type FilterKey = 'pipeline' | 'step' | 'agent' | 'status'
type Filters = Partial<Record<FilterKey, string>>
const FILTER_KEYS: readonly FilterKey[] = ['pipeline', 'step', 'agent', 'status']

interface RunGroup { runId: string; rows: TaskSummary[] }
interface PipelineGroup { pipeline: string; runs: RunGroup[] }

function rowValue(t: TaskSummary, k: FilterKey): string | undefined {
  if (k === 'pipeline') return t.caller?.pipeline || UNGROUPED
  if (k === 'step') return t.caller?.step || undefined
  if (k === 'agent') return t.agent || undefined
  return t.status || undefined
}

function ts(t: TaskSummary): number {
  const n = t.startedAt ? Date.parse(t.startedAt) : NaN
  return Number.isFinite(n) ? n : 0
}

const TIME_FMT = new Intl.DateTimeFormat(undefined, {
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
})

export function formatTaskStart(iso?: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : TIME_FMT.format(d)
}

export function formatTaskDuration(ms?: number): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const totalSec = Math.round(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m ${String(s).padStart(2, '0')}s`
}

const QUOTE_MAX = 140

/**
 * One line naming who last changed the 'Scripts may run Tasks' switch, or
 * null when the store recorded no writer. `enabled` is the switch's current
 * state — the value that last write set.
 */
export function describeSwitchBy(by: TaskSwitchBy | null | undefined, changedAt: string | null | undefined, enabled: boolean): string | null {
  if (!by) return null
  const at = formatTaskStart(changedAt ?? undefined)
  if (by.via === 'ui') return `Changed in Session Manager · ${at}`
  if (by.via === 'agent') {
    const q = by.quote.length > QUOTE_MAX ? `${by.quote.slice(0, QUOTE_MAX)}…` : by.quote
    return `Turned ${enabled ? 'on' : 'off'} by an agent · ${at} · on your words: “${q}”`
  }
  return `Changed outside Session Manager · ${at} — who changed it was not recorded`
}

/** Group rows by pipeline → runId; groups, runs and rows all newest first. */
export function groupTasks(rows: TaskSummary[]): PipelineGroup[] {
  const byPipe = new Map<string, Map<string, TaskSummary[]>>()
  for (const t of rows) {
    const p = t.caller?.pipeline || UNGROUPED
    const r = t.caller?.runId || NO_RUN
    let runs = byPipe.get(p)
    if (!runs) { runs = new Map(); byPipe.set(p, runs) }
    const list = runs.get(r)
    if (list) list.push(t)
    else runs.set(r, [t])
  }
  const newest = (list: TaskSummary[]) => list.reduce((m, t) => Math.max(m, ts(t)), 0)
  const out: (PipelineGroup & { newest: number })[] = []
  for (const [pipeline, runsMap] of byPipe) {
    const runs: (RunGroup & { newest: number })[] = []
    for (const [runId, list] of runsMap) {
      const sorted = [...list].sort((a, b) => ts(b) - ts(a))
      runs.push({ runId, rows: sorted, newest: newest(sorted) })
    }
    runs.sort((a, b) => b.newest - a.newest)
    out.push({ pipeline, runs, newest: runs[0]?.newest ?? 0 })
  }
  out.sort((a, b) => b.newest - a.newest)
  return out
}

const STATUS_TONE: Record<string, string> = {
  ok: 'text-sage-dark border-sage/50 bg-sage/15',
  running: 'text-accent-dark border-accent/40',
  error: 'text-accent-dark border-accent/40 bg-accent/15',
  spawn_failed: 'text-accent-dark border-accent/40 bg-accent/15',
  timeout: 'text-honey-dark border-honey/50',
  rate_limited: 'text-honey-dark border-honey/50',
  interrupted: 'text-honey-dark border-honey/50',
  caller_gone: 'text-fg-dim border-line',
}

function StatusChip({ t }: { t: TaskSummary }) {
  const parts = [t.status]
  if (typeof t.exitCode === 'number') parts.push(`exit ${t.exitCode}`)
  if (t.quota?.rateLimited) parts.push('quota')
  return (
    <span
      data-testid="tasks-status-chip"
      title={t.error ?? undefined}
      className={`inline-block px-1.5 py-px rounded border text-[11px] font-mono whitespace-nowrap ${STATUS_TONE[t.status] ?? 'text-fg-dim border-line'}`}
    >
      {parts.join(' · ')}
    </span>
  )
}

/** Per-project state resets by remount: Scheduler.tsx keys this view on scopeCwd. */
export interface TasksViewProps {
  scopeCwd: string | null
}

export function TasksView({ scopeCwd }: TasksViewProps) {
  const show = useToast((s) => s.show)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const closeDetail = useCallback(() => setSelectedId(null), [])
  const [rows, setRows] = useState<TaskSummary[]>([])
  const [loaded, setLoaded] = useState(false)
  const [filters, setFilters] = useState<Filters>({})
  // Option values seen across loads for this cwd, so a server-side filter
  // does not shrink its own dropdown to the one selected value.
  const [seen, setSeen] = useState<Record<FilterKey, string[]>>({ pipeline: [], step: [], agent: [], status: [] })
  const [switchOn, setSwitchOn] = useState<boolean | null>(null)
  const [switchMeta, setSwitchMeta] = useState<{ changedAt: string | null; by: TaskSwitchBy | null }>({ changedAt: null, by: null })

  const load = useCallback(async (cwd: string, f: Filters, isLive: () => boolean) => {
    const q: TaskListQuery = { cwd }
    for (const k of FILTER_KEYS) {
      const v = f[k]
      // 'Ungrouped' is a view label, not a ledger value — filter it client-side only.
      if (v && !(k === 'pipeline' && v === UNGROUPED)) q[k] = v
    }
    q.limit = LIMIT
    try {
      const res = await window.api.tasks.list(q)
      if (!isLive()) return
      if (!res.ok) { show('error', `Tasks: ${res.error}`); return }
      setRows(res.tasks)
      setLoaded(true)
      setSeen((prev) => {
        const next = { ...prev }
        let changed = false
        for (const k of FILTER_KEYS) {
          const set = new Set(prev[k])
          for (const t of res.tasks) { const v = rowValue(t, k); if (v) set.add(v) }
          if (set.size !== prev[k].length) { next[k] = [...set].sort(); changed = true }
        }
        return changed ? next : prev
      })
    } catch (e) {
      if (isLive()) show('error', `Tasks: ${e instanceof Error ? e.message : String(e)}`)
    }
  }, [show])

  useEffect(() => {
    if (!scopeCwd) return
    let live = true
    const isLive = () => live
    void load(scopeCwd, filters, isLive)
    const id = setInterval(() => { void load(scopeCwd, filters, isLive) }, POLL_MS)
    return () => { live = false; clearInterval(id) }
  }, [scopeCwd, filters, load])

  useEffect(() => {
    if (!scopeCwd) return
    let live = true
    window.api.tasks.getSwitch({ cwd: scopeCwd }).then((res) => {
      if (!live) return
      if (res.ok) {
        setSwitchOn(res.enabled)
        setSwitchMeta({ changedAt: res.changedAt ?? null, by: res.by ?? null })
      } else show('error', `Tasks switch: ${res.error}`)
    }).catch((e: unknown) => {
      if (live) show('error', `Tasks switch: ${e instanceof Error ? e.message : String(e)}`)
    })
    return () => { live = false }
  }, [scopeCwd, show])

  const toggleSwitch = useCallback(async (enabled: boolean) => {
    if (!scopeCwd) return
    try {
      const res = await window.api.tasks.setSwitch({ cwd: scopeCwd, enabled })
      if (res.ok) {
        setSwitchOn(res.enabled)
        setSwitchMeta({ changedAt: res.changedAt, by: { via: 'ui' } })
      } else show('error', `Tasks switch: ${res.error}`)
    } catch (e) {
      show('error', `Tasks switch: ${e instanceof Error ? e.message : String(e)}`)
    }
  }, [scopeCwd, show])

  const options = useMemo(() => {
    const out = {} as Record<FilterKey, string[]>
    for (const k of FILTER_KEYS) {
      const set = new Set(seen[k])
      for (const t of rows) { const v = rowValue(t, k); if (v) set.add(v) }
      const sel = filters[k]
      if (sel) set.add(sel)
      out[k] = [...set].sort()
    }
    return out
  }, [rows, seen, filters])

  // Step + model cells hide while the drill-down is open (both show there), so the narrowed row fits.
  const detailOpen = selectedId !== null

  // Client-side filter too, so the view is exact even if the ledger ignores a key.
  const groups = useMemo(() => {
    const visible = rows.filter((t) => FILTER_KEYS.every((k) => !filters[k] || rowValue(t, k) === filters[k]))
    return groupTasks(visible)
  }, [rows, filters])

  const switchByText = describeSwitchBy(switchMeta.by, switchMeta.changedAt, switchOn === true)

  if (!scopeCwd) {
    return (
      <div className="h-full flex items-center justify-center text-[13px] text-fg-faint" data-testid="tasks-view">
        Open a project to see its Tasks
      </div>
    )
  }

  return (
    <div className="h-full flex min-h-0" data-testid="tasks-view">
    <div className="flex-1 min-w-0 h-full overflow-y-auto px-9 py-4" data-testid="tasks-list">
      <div className="flex flex-col items-start mb-2" data-testid="tasks-header">
        <label className="flex items-center gap-2 text-[12px] text-fg-dim" title="While off, scripts that call the Tasks endpoint get HTTP 403.">
          <input
            type="checkbox"
            data-testid="tasks-switch"
            checked={switchOn === true}
            disabled={switchOn === null}
            onChange={(e) => { void toggleSwitch(e.target.checked) }}
            className="cursor-pointer"
          />
          <span className="text-fg">Scripts may run Tasks</span>
          <span className="text-fg-faint">— while off, scripts get 403.</span>
        </label>
        {switchByText && (
          <div
            className="text-[11px] text-fg-faint mt-0.5"
            data-testid="tasks-switch-by"
            title={switchMeta.by?.via === 'agent' ? switchMeta.by.quote : undefined}
          >
            {switchByText}
          </div>
        )}
      </div>
      <div className="flex items-center gap-3 flex-wrap mb-3" data-testid="tasks-filters">
        {FILTER_KEYS.map((k) => (
          <label key={k} className="flex items-center gap-1 text-[12px] text-fg-dim">
            <span className="capitalize">{k}</span>
            <select
              data-testid={`tasks-filter-${k}`}
              value={filters[k] ?? ''}
              onChange={(e) => {
                const v = e.target.value
                setFilters((prev) => {
                  const next = { ...prev }
                  if (v) next[k] = v
                  else delete next[k]
                  return next
                })
              }}
              className="bg-bg-hi border border-line rounded px-1.5 py-0.5 text-[12px] text-fg"
            >
              <option value="">all</option>
              {options[k].map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </label>
        ))}
      </div>

      {loaded && groups.length === 0 && (
        <div className="text-[13px] text-fg-faint py-6" data-testid="tasks-empty">
          No Tasks yet for this project{FILTER_KEYS.some((k) => filters[k]) ? ' matching these filters' : ''}.
        </div>
      )}

      {groups.map((g) => (
        <section key={g.pipeline} data-testid={`tasks-group-${g.pipeline}`} className="mb-4">
          <h3 className="text-[12px] font-semibold text-fg uppercase tracking-wider mb-1">{g.pipeline}</h3>
          {g.runs.map((r) => (
            <div key={r.runId} className="mb-2 border border-line rounded">
              <div className="px-2 py-1 text-[11px] font-mono text-fg-faint border-b border-line">run {r.runId}</div>
              {r.rows.map((t) => (
                <button
                  key={t.taskId}
                  type="button"
                  data-testid={`tasks-row-${t.taskId}`}
                  onClick={() => setSelectedId(t.taskId)}
                  aria-pressed={selectedId === t.taskId}
                  className={`w-full text-left pl-2 pr-2 py-1 flex items-center gap-3 text-[12px] hover:bg-bg-elev border-b border-line last:border-b-0 ${selectedId === t.taskId ? 'bg-bg-elev' : ''}`}
                >
                  <span className="w-[170px] shrink-0 font-mono text-fg-dim">{formatTaskStart(t.startedAt)}</span>
                  {!detailOpen && (
                    <span data-testid="tasks-cell-step" className="w-[90px] shrink-0 truncate text-fg-faint" title={t.caller?.step}>{t.caller?.step ?? '—'}</span>
                  )}
                  <span className="w-[120px] shrink-0 truncate text-fg">{t.agent ?? '—'}</span>
                  {!detailOpen && (
                    <span data-testid="tasks-cell-model" className="w-[90px] shrink-0 truncate text-fg-dim">{t.model ?? '—'}</span>
                  )}
                  <span className="w-[70px] shrink-0 font-mono text-fg-dim">{formatTaskDuration(t.durationMs)}</span>
                  <span className="w-[70px] shrink-0 font-mono text-fg-dim">{typeof t.costUsd === 'number' ? usd(t.costUsd) : '—'}</span>
                  <span className="flex-1 min-w-0 flex flex-wrap items-center gap-1">
                    <StatusChip t={t} />
                    {t.source === 'direct' && (
                      <span
                        data-testid="tasks-badge-direct"
                        title="Imported: this call ran directly, outside Session Manager's slot cap."
                        className="inline-block px-1.5 py-px rounded border border-honey/50 text-honey-dark text-[11px] whitespace-nowrap"
                      >
                        ran without SM
                      </span>
                    )}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </section>
      ))}
    </div>
      {selectedId && (
        <div className="w-[46%] max-w-[720px] shrink-0 h-full min-h-0">
          <TaskDetail key={selectedId} cwd={scopeCwd} taskId={selectedId} onClose={closeDetail} />
        </div>
      )}
    </div>
  )
}
