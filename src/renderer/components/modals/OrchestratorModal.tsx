import { useEffect, useMemo, useState } from 'react'
import { Modal } from '../ui/Modal'
import { Button } from '../ui/Button'
import { useSessions, type SessionTab } from '../../state/sessions'
import { useOrchestrator, type OrchestratorTask } from '../../state/orchestrator'
import { toast } from '../../state/toast'

/**
 * Orchestrator modal — port of ClaudeCodeUnleashed's Orchestrator, slimmed.
 *
 * Two phases:
 *   - Idle: user types a parent goal (plan) and a sub-task for each selected
 *     tab (rows of { tab selector, task description }).
 *   - Running: live grid of latest digest lines per tab with status pills,
 *     plus pause/resume/nudgeAll/stop toolbar.
 *
 * Closing the modal mid-run does NOT stop the orchestrator — the
 * OrchestratorStatusPanel keeps surfacing it. Reset explicitly tears down.
 *
 * MVP scope: requires existing running tabs (no auto-spawn). Matches the
 * Race feature's constraint until the spawn-ready handshake lands.
 */
export function OrchestratorModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const status = useOrchestrator((s) => s.status)
  const orchPlan = useOrchestrator((s) => s.plan)
  const tasks = useOrchestrator((s) => s.tasks)
  const startedAt = useOrchestrator((s) => s.startedAt)
  const configure = useOrchestrator((s) => s.configure)
  const start = useOrchestrator((s) => s.start)
  const pause = useOrchestrator((s) => s.pause)
  const resume = useOrchestrator((s) => s.resume)
  const nudgeAll = useOrchestrator((s) => s.nudgeAll)
  const stop = useOrchestrator((s) => s.stop)
  const reset = useOrchestrator((s) => s.reset)

  const allTabs = useSessions((s) => s.tabs)

  const [plan, setPlan] = useState('')
  // Local row editor: a list of { tabId, prompt }. Order is preserved.
  const [rows, setRows] = useState<{ tabId: string; prompt: string }[]>([])

  const runningTabs = useMemo(() => allTabs.filter((t) => t.status === 'running'), [allTabs])
  const isActive = status === 'running' || status === 'paused'

  // Reset local form whenever the modal opens fresh.
  useEffect(() => {
    if (!open) return
    if (status === 'idle' || status === 'stopped') {
      setPlan('')
      setRows([])
    }
  }, [open, status])

  const handleAddRow = () => {
    // Pick the first running tab that isn't already in rows.
    const used = new Set(rows.map((r) => r.tabId))
    const next = runningTabs.find((t) => !used.has(t.id))
    if (!next) {
      toast.warn('All running tabs are already assigned a sub-task.')
      return
    }
    setRows([...rows, { tabId: next.id, prompt: '' }])
  }

  const handleRemoveRow = (i: number) => {
    setRows(rows.filter((_, idx) => idx !== i))
  }

  const handleRowChange = (i: number, patch: Partial<{ tabId: string; prompt: string }>) => {
    setRows(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  }

  const canStart =
    plan.trim().length > 0 &&
    rows.length >= 2 &&
    rows.every((r) => r.prompt.trim().length > 0) &&
    new Set(rows.map((r) => r.tabId)).size === rows.length // no duplicate tabs

  const handleStart = () => {
    if (!canStart) return
    const tabById = new Map(runningTabs.map((t) => [t.id, t]))
    const picks = rows
      .map((r) => {
        const tab = tabById.get(r.tabId)
        if (!tab) return null
        return {
          tabId: tab.id,
          label: tab.label,
          presetId: tab.presetId,
          prompt: r.prompt.trim(),
        }
      })
      .filter((p): p is NonNullable<typeof p> => p !== null)

    if (picks.length < 2) {
      toast.warn('Orchestrator needs at least 2 running tabs with sub-tasks.')
      return
    }

    configure(plan.trim(), picks)
    start()
  }

  const handleStop = () => {
    stop()
    toast.info('Orchestrator stopped. Tabs continue working in their PTYs until Ctrl-C.')
  }

  const handleReset = () => {
    reset()
    setPlan('')
    setRows([])
  }

  return (
    <Modal open={open} onClose={onClose} size="xl" fillHeight noPadding>
      <div className="flex items-center justify-between px-4 py-2 border-b border-line shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-base">🎼</span>
          <h2 className="text-xs uppercase tracking-wider text-fg-dim">
            Orchestrator — fan out sub-tasks across tabs
          </h2>
          {isActive && <OrchestratorTimer startedAt={startedAt} />}
          {status === 'paused' && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300">paused</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {(isActive || status === 'stopped') && (
            <Button variant="default" onClick={handleReset}>Reset</Button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="px-2 py-0.5 text-fg-dim hover:text-fg hover:bg-bg-hi rounded text-base leading-none"
          >
            ✕
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-auto p-4 space-y-4">
        {status === 'idle' || status === 'stopped' ? (
          <IdleForm
            plan={plan}
            setPlan={setPlan}
            rows={rows}
            runningTabs={runningTabs}
            onAddRow={handleAddRow}
            onRemoveRow={handleRemoveRow}
            onRowChange={handleRowChange}
            canStart={canStart}
            onStart={handleStart}
          />
        ) : (
          <RunView
            plan={orchPlan}
            tasks={tasks}
            status={status}
            onPause={pause}
            onResume={resume}
            onNudgeAll={nudgeAll}
            onStop={handleStop}
          />
        )}
      </div>
    </Modal>
  )
}

function IdleForm({
  plan,
  setPlan,
  rows,
  runningTabs,
  onAddRow,
  onRemoveRow,
  onRowChange,
  canStart,
  onStart,
}: {
  plan: string
  setPlan: (s: string) => void
  rows: { tabId: string; prompt: string }[]
  runningTabs: SessionTab[]
  onAddRow: () => void
  onRemoveRow: (i: number) => void
  onRowChange: (i: number, patch: Partial<{ tabId: string; prompt: string }>) => void
  canStart: boolean
  onStart: () => void
}) {
  const enoughTabs = runningTabs.length >= 2

  return (
    <div className="space-y-4">
      <div>
        <label className="text-[10px] uppercase tracking-wider text-fg-faint mb-1 block">
          Plan — the parent goal you are fanning out
        </label>
        <textarea
          value={plan}
          onChange={(e) => setPlan(e.target.value)}
          placeholder="e.g. Build feature X: split UI, API, tests across tabs."
          rows={3}
          className="w-full bg-bg border border-line rounded px-3 py-2 text-sm text-fg placeholder:text-fg-faint focus:outline-none focus:border-accent resize-none font-mono"
        />
      </div>

      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-[10px] uppercase tracking-wider text-fg-faint">
            Sub-tasks — assign one to each tab
          </label>
          <span className="text-[10px] text-fg-faint">
            {rows.length} task{rows.length !== 1 ? 's' : ''} · {runningTabs.length} running tab{runningTabs.length !== 1 ? 's' : ''}
          </span>
        </div>

        {!enoughTabs ? (
          <div className="text-xs text-fg-dim p-3 border border-line rounded bg-bg">
            Orchestrator needs at least 2 running tabs. Open more sessions first.
          </div>
        ) : (
          <div className="space-y-2">
            {rows.map((row, i) => (
              <div key={i} className="flex items-start gap-2 bg-bg border border-line rounded p-2">
                <span className="text-[10px] text-accent font-mono shrink-0 mt-2">T{i + 1}</span>
                <select
                  value={row.tabId}
                  onChange={(e) => onRowChange(i, { tabId: e.target.value })}
                  className="bg-bg border border-line rounded px-2 py-1 text-xs text-fg shrink-0 max-w-[180px]"
                >
                  {runningTabs.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
                </select>
                <textarea
                  value={row.prompt}
                  onChange={(e) => onRowChange(i, { prompt: e.target.value })}
                  placeholder={`Sub-task for ${runningTabs.find((t) => t.id === row.tabId)?.label ?? 'tab'}…`}
                  rows={2}
                  className="flex-1 min-w-0 bg-bg border border-line rounded px-2 py-1 text-xs text-fg placeholder:text-fg-faint focus:outline-none focus:border-accent resize-none font-mono"
                />
                <button
                  type="button"
                  onClick={() => onRemoveRow(i)}
                  aria-label="Remove sub-task"
                  className="text-fg-faint hover:text-red-400 px-1.5 py-0.5 text-sm"
                >
                  ✕
                </button>
              </div>
            ))}

            <Button variant="default" onClick={onAddRow}>+ Add sub-task</Button>
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 pt-2">
        <Button variant="primary" onClick={onStart} disabled={!canStart}>
          Start orchestrator
        </Button>
      </div>
      <p className="text-[10px] text-fg-faint">
        MVP: uses existing tabs only. Plan decomposition (LLM-driven) and spawning new tabs from presets ships in v2.
      </p>
    </div>
  )
}

function RunView({
  plan,
  tasks,
  status,
  onPause,
  onResume,
  onNudgeAll,
  onStop,
}: {
  plan: string
  tasks: OrchestratorTask[]
  status: 'running' | 'paused'
  onPause: () => void
  onResume: () => void
  onNudgeAll: () => void
  onStop: () => void
}) {
  // Pick grid column count: 1 → 1, 2 → 2, 3+ → 3 (wraps).
  const cols = tasks.length <= 1 ? 1 : tasks.length === 2 ? 2 : 3

  return (
    <div className="space-y-4">
      <div className="text-xs bg-bg border border-line rounded px-3 py-2">
        <span className="text-fg-faint mr-2">Plan:</span>
        <span className="text-fg font-mono whitespace-pre-wrap">{plan}</span>
      </div>

      <div className="flex items-center gap-2">
        {status === 'running' ? (
          <Button variant="default" onClick={onPause}>Pause watch</Button>
        ) : (
          <Button variant="primary" onClick={onResume}>Resume watch</Button>
        )}
        <Button variant="default" onClick={onNudgeAll}>Nudge all</Button>
        <div className="flex-1" />
        <Button variant="danger" onClick={onStop}>Stop</Button>
      </div>

      <div
        className="grid gap-3"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
      >
        {tasks.map((t) => (
          <TaskPanel key={t.tabId} task={t} />
        ))}
      </div>
    </div>
  )
}

function TaskPanel({ task }: { task: OrchestratorTask }) {
  const statusBadge =
    task.status === 'done'
      ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/20 text-accent">done</span>
      : task.status === 'working'
        ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-hi text-fg-dim">working…</span>
        : task.status === 'sent'
          ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-hi text-fg-faint">sent</span>
          : <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-hi text-fg-faint">pending</span>

  return (
    <div className="flex flex-col rounded border border-line bg-bg">
      <div className="flex items-center justify-between px-3 py-2 border-b border-line">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-medium text-fg truncate">{task.label}</span>
        </div>
        {statusBadge}
      </div>
      <div className="px-3 py-1.5 border-b border-line text-[10px] text-fg-dim font-mono line-clamp-2">
        {task.prompt}
      </div>
      <div className="flex-1 min-h-32 p-2 font-mono text-[10px] leading-relaxed text-fg-dim overflow-auto">
        {task.outputDigest.length === 0 ? (
          <span className="text-fg-faint">Waiting for activity…</span>
        ) : (
          task.outputDigest.map((line, i) => (
            <div key={i} className="truncate">{line}</div>
          ))
        )}
      </div>
    </div>
  )
}

function OrchestratorTimer({ startedAt }: { startedAt: number | null }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!startedAt) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [startedAt])
  if (!startedAt) return null
  const secs = Math.max(0, Math.floor((now - startedAt) / 1000))
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return (
    <span className="text-xs font-mono text-fg-dim ml-2">
      {m}:{String(s).padStart(2, '0')}
    </span>
  )
}
