import type { HistoryDashboardTotals } from '../../../../../preload/api'
import { usd, tok, int, min } from '../../../../lib/analyticsFormat'
import { measureValue } from '../../../../lib/analyticsViewModel'
import { prettyModel } from '../../../../lib/prettyModel'
import { projectColorFor } from '../../../../lib/projectColor'
import { projectNameFromCwd } from '../../scheduler/sched-primitives'

export interface DrillModelBucket {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  costUsd: number
}

interface Props {
  projectDir: string
  totals: HistoryDashboardTotals
  byModel: Record<string, DrillModelBucket>
  toolBreakdown: Record<string, number>
  onClear: () => void
}

export function ProjectDrill({ projectDir, totals, byModel, toolBreakdown, onClear }: Props) {
  const inTok = measureValue(totals, 'in')
  const outTok = measureValue(totals, 'out')
  const modelEntries = Object.entries(byModel).sort((a, b) => b[1].costUsd - a[1].costUsd)
  const toolEntries = Object.entries(toolBreakdown).sort((a, b) => b[1] - a[1])
  const maxToolCount = toolEntries[0]?.[1] ?? 0

  return (
    <div className="border border-line rounded bg-bg-elev p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs uppercase tracking-wider text-fg flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: projectColorFor(projectDir) }} />
          {projectNameFromCwd(projectDir) ?? projectDir}
        </h3>
        <button onClick={onClear} className="text-[11px] text-fg-faint hover:text-fg">clear ✕</button>
      </div>

      <div className="grid grid-cols-6 gap-3 mb-4">
        <Stat label="prompts" value={int(totals.promptCount)} />
        <Stat label="sessions" value={int(totals.sessionCount)} />
        <Stat label="in tokens" value={tok(inTok)} />
        <Stat label="out tokens" value={tok(outTok)} />
        <Stat label="spend" value={usd(totals.estimatedCostUsd)} />
        <Stat label="time" value={min(totals.activeMinutes)} />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <div className="text-[10px] text-fg-faint uppercase tracking-wider mb-1.5">model mix</div>
          {modelEntries.length === 0 ? (
            <div className="text-xs text-fg-faint">no model data</div>
          ) : (
            <div className="space-y-1">
              {modelEntries.map(([modelId, b]) => (
                <div key={modelId} className="flex items-center justify-between text-[11px] font-mono text-fg-dim">
                  <span>{prettyModel(modelId)}</span>
                  <span className="text-fg-faint">{usd(b.costUsd)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div>
          <div className="text-[10px] text-fg-faint uppercase tracking-wider mb-1.5">tool mix</div>
          {toolEntries.length === 0 ? (
            <div className="text-xs text-fg-faint">no tool data</div>
          ) : (
            <div className="space-y-1">
              {toolEntries.slice(0, 6).map(([tool, cnt]) => (
                <div key={tool} className="flex items-center gap-2 text-[11px]">
                  <span className="w-20 shrink-0 truncate text-fg-dim font-mono">{tool}</span>
                  <div className="flex-1 h-1.5 rounded bg-bg-hi overflow-hidden">
                    <div className="h-full bg-hive-teal" style={{ width: `${maxToolCount > 0 ? (cnt / maxToolCount) * 100 : 0}%` }} />
                  </div>
                  <span className="text-fg-faint font-mono w-8 text-right">{cnt}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] text-fg-faint uppercase tracking-wider">{label}</div>
      <div className="text-sm font-mono text-fg">{value}</div>
    </div>
  )
}
