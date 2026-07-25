import type { ModelBucket } from '../../../../../lib/historyFacet'
import { usd } from '../../../../../lib/analyticsFormat'
import { prettyModel } from '../../../../../lib/prettyModel'
import { projectColorFor } from '../../../../../lib/projectColor'
import { CARD, SectionHead } from '../analytics-primitives'

interface Props {
  byModelTotals: Record<string, ModelBucket>
}

export function ModelMix({ byModelTotals }: Props) {
  const entries = Object.entries(byModelTotals).sort((a, b) => b[1].costUsd - a[1].costUsd)
  const total = entries.reduce((sum, [, b]) => sum + b.costUsd, 0)

  return (
    <div className={`${CARD} p-4`}>
      <SectionHead kicker="05 · composition" title="Model mix" right={<span className="text-xs font-mono text-fg-faint">{usd(total)} total</span>} />
      {entries.length === 0 ? (
        <div className="text-xs text-fg-faint">no model data in range</div>
      ) : (
        <div className="space-y-2">
          {entries.map(([modelId, b]) => {
            const pct = total > 0 ? (b.costUsd / total) * 100 : 0
            const color = projectColorFor(modelId)
            return (
              <div key={modelId}>
                <div className="flex items-center justify-between text-xs mb-0.5">
                  <span className="flex items-center gap-1.5 font-mono text-fg-dim truncate">
                    <span className="w-2 h-2 rounded-sm shrink-0" style={{ backgroundColor: color }} />
                    {prettyModel(modelId)}
                    {b.estimated && <span className="text-fg-faint">(est.)</span>}
                  </span>
                  <span className="text-fg-faint whitespace-nowrap ml-2">{usd(b.costUsd)} · {pct.toFixed(0)}%</span>
                </div>
                <div className="h-1.5 rounded bg-bg-hi overflow-hidden">
                  <div className="h-full" style={{ width: `${Math.max(pct, pct > 0 ? 2 : 0)}%`, backgroundColor: color }} />
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
