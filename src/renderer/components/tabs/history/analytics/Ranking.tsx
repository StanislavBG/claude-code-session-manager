import type { ProjectRankRow } from '../../../../lib/analyticsViewModel'
import type { Measure } from '../../../../lib/analyticsViewModel'
import { formatMeasureValue } from './Headline'
import { pct, int } from '../../../../lib/analyticsFormat'
import { projectColorFor } from '../../../../lib/projectColor'
import { projectNameFromCwd } from '../../scheduler/sched-primitives'
import { CARD, SectionHead } from './analytics-primitives'

interface Props {
  rows: ProjectRankRow[]
  measure: Measure
  selected: string | null
  onSelect: (projectDir: string) => void
}

export function Ranking({ rows, measure, selected, onSelect }: Props) {
  if (!rows.length) {
    return (
      <div className={`${CARD} p-4`}>
        <SectionHead kicker="03 · by project" title="Ranking" />
        <div className="text-xs text-fg-faint">no projects in range</div>
      </div>
    )
  }
  return (
    <div className={`${CARD} overflow-hidden`}>
      <div className="p-4 pb-0">
        <SectionHead kicker="03 · by project" title="Ranking" />
      </div>
      <table className="w-full text-xs">
        <thead className="bg-bg-elev">
          <tr>
            {['project', 'share', 'value', 'share %', 'trend', 'sessions', 'top tool'].map((label) => (
              <th key={label} className="text-left px-3 py-2 text-fg-faint uppercase tracking-wider whitespace-nowrap">{label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const color = projectColorFor(row.projectDir)
            const isSelected = selected === row.projectDir
            return (
              <tr
                key={row.projectDir}
                onClick={() => onSelect(row.projectDir)}
                className={`border-t border-line hover:bg-bg-elev cursor-pointer ${isSelected ? 'bg-bg-elev' : ''}`}
              >
                <td className="px-3 py-2 font-mono text-fg-dim">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
                    {projectNameFromCwd(row.projectDir) ?? row.projectDir}
                  </span>
                </td>
                <td className="px-3 py-2 w-32">
                  <div className="h-1.5 rounded bg-bg-hi overflow-hidden">
                    <div className="h-full" style={{ width: `${Math.max(row.sharePct, row.sharePct > 0 ? 2 : 0)}%`, backgroundColor: color }} />
                  </div>
                </td>
                <td className="px-3 py-2 text-fg-faint font-mono">{formatMeasureValue(measure, row.value)}</td>
                <td className="px-3 py-2 text-fg-faint font-mono">{row.sharePct.toFixed(1)}%</td>
                <td className="px-3 py-2 font-mono">
                  {row.trend.pct === null ? (
                    <span className="text-fg-faint">—</span>
                  ) : (
                    <span className={row.trend.direction === 'up' ? 'text-delta-good' : row.trend.direction === 'down' ? 'text-delta-bad' : 'text-fg-faint'}>
                      {row.trend.direction === 'up' ? '▲' : row.trend.direction === 'down' ? '▼' : '·'} {pct(Math.abs(row.trend.pct))}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-fg-faint font-mono">{int(row.sessions)}</td>
                <td className="px-3 py-2 text-fg-faint font-mono">{row.topTool || '—'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
