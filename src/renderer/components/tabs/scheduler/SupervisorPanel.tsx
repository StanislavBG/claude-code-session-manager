import { useState, useEffect } from 'react'
import type { SupervisorLogEntry, SupervisorConfig } from '../../../../preload/api.d'
import { formatRelative } from '../../../lib/formatTime'
import { usePanelFocus } from '../../../lib/panelFocus'

// ─── Supervisor sub-panel ────────────────────────────────────────────────────

export function SupervisorPanel({
  supervisorConfig,
  onSetConfig,
  onBack,
}: {
  supervisorConfig: SupervisorConfig | undefined
  onSetConfig: (partial: Partial<SupervisorConfig>) => void
  onBack: () => void
}) {
  const [log, setLog] = useState<SupervisorLogEntry[]>([])
  const [now, setNow] = useState(() => Date.now())
  const focused = usePanelFocus()

  useEffect(() => {
    if (!focused) return
    window.api.supervisor.getLog().then(setLog).catch(() => {})
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(id)
  }, [focused])

  const cfg: SupervisorConfig = {
    enabled: supervisorConfig?.enabled ?? true,
    intervalMinutes: supervisorConfig?.intervalMinutes ?? 15,
    maxConcurrentProbes: supervisorConfig?.maxConcurrentProbes ?? 2,
    probeStaleThresholdMinutes: supervisorConfig?.probeStaleThresholdMinutes ?? 10,
  }

  return (
    <div className="bg-bg-elev/60">
      {/* Header */}
      <div className="px-3 py-2 flex items-center gap-2 border-b border-line">
        <button
          type="button"
          onClick={onBack}
          className="text-[10px] text-fg-faint hover:text-fg-dim"
          title="Back to queue"
        >
          ← queue
        </button>
        <span className="text-[11px] font-medium text-fg-dim">Supervisor</span>
        <button
          type="button"
          onClick={() => window.api.supervisor.getLog().then(setLog).catch(() => {})}
          className="ml-auto text-[10px] text-fg-faint hover:text-fg-dim underline"
          title="Refresh log"
        >
          refresh
        </button>
      </div>

      {/* Config controls */}
      <div className="px-3 py-2 space-y-1.5 border-b border-line">
        <div className="text-[9px] text-fg-faint uppercase tracking-wider">Config</div>
        <div className="flex items-center gap-3 flex-wrap text-[10px] text-fg-faint">
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={cfg.enabled}
              onChange={(e) => onSetConfig({ enabled: e.target.checked })}
              className="cursor-pointer"
            />
            <span>enabled</span>
          </label>
          <label className="flex items-center gap-1" title="How often to check for wedged jobs (minutes)">
            <span>interval</span>
            <input
              type="number"
              min={5}
              max={60}
              value={cfg.intervalMinutes}
              onChange={(e) => onSetConfig({ intervalMinutes: Number(e.target.value) })}
              className="w-10 bg-bg border border-line rounded px-1 py-0.5 font-mono"
            />
            <span>min</span>
          </label>
          <label className="flex items-center gap-1" title="Max concurrent Opus probes per tick">
            <span>probes</span>
            <input
              type="number"
              min={1}
              max={5}
              value={cfg.maxConcurrentProbes}
              onChange={(e) => onSetConfig({ maxConcurrentProbes: Number(e.target.value) })}
              className="w-8 bg-bg border border-line rounded px-1 py-0.5 font-mono"
            />
          </label>
          <label className="flex items-center gap-1" title="Probe a job only if no JSONL event in this many minutes">
            <span>stale</span>
            <input
              type="number"
              min={5}
              max={30}
              value={cfg.probeStaleThresholdMinutes}
              onChange={(e) => onSetConfig({ probeStaleThresholdMinutes: Number(e.target.value) })}
              className="w-8 bg-bg border border-line rounded px-1 py-0.5 font-mono"
            />
            <span>min</span>
          </label>
        </div>
      </div>

      {/* Log table */}
      <div className="px-3 py-2">
        <div className="text-[9px] text-fg-faint uppercase tracking-wider mb-1">
          Recent probes (last {log.length})
        </div>
        {log.length === 0 ? (
          <div className="text-[10px] text-fg-faint italic">No probes yet.</div>
        ) : (
          <div className="space-y-0.5 max-h-64 overflow-y-auto">
            {log.map((entry, i) => (
              <SupervisorLogRow key={`${entry.ts}-${i}`} entry={entry} now={now} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function SupervisorLogRow({ entry, now }: { entry: SupervisorLogEntry; now: number }) {
  const isAction = entry.action !== 'none'
  const ago = formatRelative(now - entry.ts)
  return (
    <div
      className={`text-[10px] px-1.5 py-1 rounded font-mono ${isAction ? 'bg-red-500/10 border border-red-500/20' : 'bg-bg/40'}`}
      title={entry.reason}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-fg-faint shrink-0">{ago} ago</span>
        <span className={`shrink-0 px-1 rounded ${entry.verdict === 'stuck' ? 'text-red-400 bg-red-500/10' : 'text-green-500/70'}`}>
          {entry.verdict}
        </span>
        <span className="truncate text-fg-dim">{entry.jobSlug}</span>
        {isAction && (
          <span className="shrink-0 text-red-400">{entry.action}{entry.targetPid ? ` pid=${entry.targetPid}` : ''}</span>
        )}
        {entry.costUsd !== null && (
          <span className="shrink-0 text-fg-faint">${entry.costUsd.toFixed(3)}</span>
        )}
      </div>
      <div className="text-fg-faint truncate mt-0.5">{entry.reason}</div>
    </div>
  )
}
