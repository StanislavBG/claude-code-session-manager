import { Button } from '../../ui/Button'
import type { OrchestratorTask } from '../../../state/orchestrator'

/**
 * Live grid for a running Orchestrate dispatch — one panel per tab showing
 * its latest transcript digest + status, with pause/resume/nudge/stop. Driven
 * by props; the store wiring lives in DispatchLive. (Extracted from the
 * retired OrchestratorModal during the Dispatch→Subagents consolidation.)
 */
export function OrchestratorRunView({
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
