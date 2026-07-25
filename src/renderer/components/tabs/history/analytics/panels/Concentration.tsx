import type { ProjectRankRow } from '../../../../../lib/analyticsViewModel'
import { projectColorFor } from '../../../../../lib/projectColor'
import { projectNameFromCwd } from '../../../scheduler/sched-primitives'

interface Props {
  rows: ProjectRankRow[]
}

export function Concentration({ rows }: Props) {
  const top3 = rows.slice(0, 3)
  const top3Share = top3.reduce((sum, r) => sum + r.sharePct, 0)
  const longTail = rows.slice(3)
  const longTailShare = longTail.reduce((sum, r) => sum + r.sharePct, 0)

  return (
    <div className="border border-line rounded bg-bg-elev p-4">
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-xs uppercase tracking-wider text-fg">Concentration</h3>
        <span className="text-xs font-mono text-fg-faint">top 3 = {top3Share.toFixed(0)}%</span>
      </div>
      {rows.length === 0 ? (
        <div className="text-xs text-fg-faint">no projects in range</div>
      ) : (
        <>
          <div className="flex h-3 rounded overflow-hidden mb-2">
            {rows.map((r) => (
              <div
                key={r.projectDir}
                style={{ width: `${Math.max(r.sharePct, 0.5)}%`, backgroundColor: projectColorFor(r.projectDir) }}
                title={`${projectNameFromCwd(r.projectDir) ?? r.projectDir} · ${r.sharePct.toFixed(1)}%`}
              />
            ))}
          </div>
          <div className="space-y-1 mb-2">
            {top3.map((r) => (
              <div key={r.projectDir} className="flex items-center justify-between text-[11px] font-mono">
                <span className="flex items-center gap-1.5 text-fg-dim truncate">
                  <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: projectColorFor(r.projectDir) }} />
                  {projectNameFromCwd(r.projectDir) ?? r.projectDir}
                </span>
                <span className="text-fg-faint">{r.sharePct.toFixed(1)}%</span>
              </div>
            ))}
          </div>
          {longTail.length > 0 && (
            <p className="text-[10px] text-fg-faint">
              {longTail.length} more project{longTail.length === 1 ? '' : 's'} account for {longTailShare.toFixed(1)}% (long tail).
            </p>
          )}
        </>
      )}
    </div>
  )
}
