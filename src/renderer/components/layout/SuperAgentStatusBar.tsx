import { useEffect, useState } from 'react'
import { useSessions } from '../../state/sessions'
import { useSuperAgent } from '../../state/superagent'
import { toast } from '../../state/toast'
import { formatElapsedClock } from '../../lib/formatTime'

/**
 * SuperAgentStatusBar — a slim banner under the Header that surfaces an
 * active SuperAgent run on the current tab. Mirrors the RecordingStatus
 * pattern: mounted at the App level so it stays visible across screen
 * changes, but only paints when the active tab has a `running` run.
 *
 * Visual shape (lifted from Unleashed's collapsed status, simplified):
 *   [🤖 SuperAgent · running] [task]   N specialists · depth   ⏱ 0:42   Stop
 *
 * No transcript-pattern parsing here yet — specialists/progress come from
 * the store, which a future cycle can populate by hooking into live.ts's
 * message ingest path (looking for `[SUPERAGENT] specialists:` etc).
 */
export function SuperAgentStatusBar() {
  const activeTabId = useSessions((s) => s.activeTabId)
  const tabState = useSuperAgent((s) => (activeTabId ? s.tabs[activeTabId] : undefined))
  const run = tabState?.run
  const specialists = tabState?.specialists ?? []
  const progress = tabState?.progress ?? 0

  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (run?.status !== 'running') return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [run?.status])

  if (!run || run.status !== 'running' || !activeTabId) return null

  const elapsedLabel = formatElapsedClock(run.startedAt ? now - run.startedAt : 0)

  const doneCount = specialists.filter((s) => s.state === 'done').length
  const pct = Math.round(progress * 100)

  const handleStop = async () => {
    try {
      await window.api.superagent.stop(activeTabId)
      toast.info('SuperAgent stopped. (Claude in the terminal continues until you Ctrl-C it.)')
    } catch (e: unknown) {
      toast.error(`Stop failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return (
    <div
      data-testid="superagent-status-bar"
      role="status"
      aria-live="polite"
      className="shrink-0 h-7 px-3 flex items-center gap-3 bg-bg-elev border-b border-line text-xs"
    >
      <span className="flex items-center gap-1.5 text-accent shrink-0">
        <span aria-hidden="true">🤖</span>
        <span className="font-medium">SuperAgent</span>
        <span className="text-fg-faint">running</span>
      </span>

      <span className="truncate text-fg-dim min-w-0 flex-1" title={run.prompt}>
        {run.prompt}
      </span>

      <span className="text-fg-faint shrink-0">
        {doneCount}/{run.specialistCount} specialists · {run.depth}
      </span>

      <div className="w-24 h-1.5 bg-bg rounded overflow-hidden shrink-0" aria-label="progress">
        <div
          className="h-full bg-accent transition-[width] duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>

      <span className="font-mono text-fg-dim shrink-0">{elapsedLabel}</span>

      <button
        type="button"
        onClick={handleStop}
        className="shrink-0 px-2 py-0.5 rounded border border-line text-fg-dim hover:text-red-300 hover:border-red-400/60 transition-colors"
        data-testid="superagent-stop-bar"
      >
        Stop
      </button>
    </div>
  )
}
