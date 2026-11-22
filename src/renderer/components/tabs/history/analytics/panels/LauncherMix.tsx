import type { HistoryLauncher } from '../../../../../lib/historyLauncher'
import { HISTORY_LAUNCHERS } from '../../../../../lib/historyLauncher'
import type { LauncherBucket } from '../../../../../lib/historyProjectFold'
import { usd } from '../../../../../lib/analyticsFormat'
import { projectColorFor } from '../../../../../lib/projectColor'
import { CARD, SectionHead } from '../analytics-primitives'

interface Props {
  byLauncherTotals: Partial<Record<HistoryLauncher, LauncherBucket>>
}

const LAUNCHER_LABELS: Record<HistoryLauncher, string> = {
  epic: 'Epic sessions',
  job: 'Scheduler jobs',
  other: 'Other sessions',
}

/** Cost in view split by who launched the session — Epic chat, scheduled job, or anything else. */
export function LauncherMix({ byLauncherTotals }: Props) {
  const entries = HISTORY_LAUNCHERS.map((l) => [l, byLauncherTotals[l]?.costUsd ?? 0] as const)
  const total = entries.reduce((sum, [, cost]) => sum + cost, 0)

  return (
    <div className={`${CARD} p-4`}>
      <SectionHead kicker="07 · composition" title="Launcher mix" right={<span className="text-xs font-mono text-fg-faint">{usd(total)} total</span>} />
      {total <= 0 ? (
        <div className="text-xs text-fg-faint">no usage in range</div>
      ) : (
        <div className="space-y-2">
          {entries.map(([launcher, cost]) => {
            const pct = (cost / total) * 100
            const color = projectColorFor(launcher)
            return (
              <div key={launcher} data-testid={`history-launcher-${launcher}`}>
                <div className="flex items-center justify-between text-xs mb-0.5">
                  <span className="flex items-center gap-1.5 font-mono text-fg-dim truncate">
                    <span className="w-2 h-2 rounded-sm shrink-0" style={{ backgroundColor: color }} />
                    {LAUNCHER_LABELS[launcher]}
                  </span>
                  <span className="text-fg-faint whitespace-nowrap ml-2">{usd(cost)} · {pct.toFixed(0)}%</span>
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
