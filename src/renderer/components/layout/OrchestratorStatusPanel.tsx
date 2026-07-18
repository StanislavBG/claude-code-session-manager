import { useEffect, useState } from 'react'
import { useOrchestrator } from '../../state/orchestrator'
import { formatElapsedClock } from '../../lib/formatTime'

/**
 * OrchestratorStatusPanel — slim banner under Header surfacing an active
 * orchestrator run. Mirrors SuperAgentStatusBar / RecordingStatus shape:
 * mounted at App level, but only paints when status is running/paused.
 *
 * Click Stop to tear down. Tabs keep working in their PTYs — same caveat
 * as SuperAgent (you Ctrl-C inside the terminal to actually halt Claude).
 */
export function OrchestratorStatusPanel() {
  const status = useOrchestrator((s) => s.status)
  const plan = useOrchestrator((s) => s.plan)
  const tasks = useOrchestrator((s) => s.tasks)
  const startedAt = useOrchestrator((s) => s.startedAt)
  const pause = useOrchestrator((s) => s.pause)
  const resume = useOrchestrator((s) => s.resume)
  const stop = useOrchestrator((s) => s.stop)

  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (status !== 'running') return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [status])

  if (status !== 'running' && status !== 'paused') return null

  const elapsedLabel = formatElapsedClock(startedAt ? now - startedAt : 0)

  const doneCount = tasks.filter((t) => t.status === 'done').length
  const total = tasks.length

  return (
    <div
      data-testid="orchestrator-status-bar"
      role="status"
      aria-live="polite"
      className="shrink-0 h-7 px-3 flex items-center gap-3 bg-bg-elev border-b border-line text-xs"
    >
      <span className="flex items-center gap-1.5 text-accent shrink-0">
        <span aria-hidden="true">🎼</span>
        <span className="font-medium">Orchestrator</span>
        <span className="text-fg-faint">{status === 'paused' ? 'paused' : 'running'}</span>
      </span>

      <span className="truncate text-fg-dim min-w-0 flex-1" title={plan}>
        {plan || '(no plan)'}
      </span>

      <span className="text-fg-faint shrink-0">
        {doneCount}/{total} done
      </span>

      <span className="font-mono text-fg-dim shrink-0">{elapsedLabel}</span>

      {status === 'running' ? (
        <button
          type="button"
          onClick={pause}
          className="shrink-0 px-2 py-0.5 rounded border border-line text-fg-dim hover:text-amber-300 hover:border-amber-400/60 transition-colors"
        >
          Pause
        </button>
      ) : (
        <button
          type="button"
          onClick={resume}
          className="shrink-0 px-2 py-0.5 rounded border border-line text-fg-dim hover:text-fg hover:border-accent/60 transition-colors"
        >
          Resume
        </button>
      )}

      <button
        type="button"
        onClick={stop}
        className="shrink-0 px-2 py-0.5 rounded border border-line text-fg-dim hover:text-red-300 hover:border-red-400/60 transition-colors"
        data-testid="orchestrator-stop-bar"
      >
        Stop
      </button>
    </div>
  )
}
