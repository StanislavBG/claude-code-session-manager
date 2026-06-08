import type { UsageMatrixSnapshot, UsageMatrixTab } from '../../../../preload/api'

/**
 * Cross-workspace active-session matrix. One row per attached tab; columns
 * cover the four budget killers (turn count, cache age, burn intensity,
 * subagent fan-out) so the user can spot which workspace is the noisy one.
 */
export function SessionMatrix({ snap }: { snap: UsageMatrixSnapshot | null }) {
  const rows = snap?.tabs ?? []
  if (rows.length === 0) {
    return (
      <div className="px-[22px] py-3 text-[13px] text-fg-faint">
        No active sessions tracked yet — start a Claude tab to populate the matrix.
      </div>
    )
  }
  return (
    <div className="px-[22px] py-4">
      <div className="text-[11px] font-bold tracking-[0.7px] uppercase text-fg-faint mb-2">
        Active sessions
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs tabular-nums">
          <thead>
            <tr className="text-left border-b border-line">
              <th className="font-semibold text-fg-faint pr-3 pb-1.5">workspace</th>
              <th className="font-semibold text-fg-faint pr-3 pb-1.5 w-[110px]">state</th>
              <th className="font-semibold text-fg-faint pr-3 pb-1.5 text-right">turns</th>
              <th className="font-semibold text-fg-faint pr-3 pb-1.5 text-right">avg/turn</th>
              <th className="font-semibold text-fg-faint pr-3 pb-1.5 text-right">tok/min</th>
              <th className="font-semibold text-fg-faint pr-3 pb-1.5">cache</th>
              <th className="font-semibold text-fg-faint pr-3 pb-1.5 text-right">subagents</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Row key={r.tabId} r={r} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Row({ r }: { r: UsageMatrixTab }) {
  return (
    <tr className="border-t border-line">
      <td className="pr-3 py-2.5 max-w-[16ch]" title={r.cwd}>
        <span className="flex items-center gap-2 text-[13.5px] font-semibold text-fg">
          <span className="w-1.5 h-1.5 rounded-full bg-sage shrink-0" />
          <span className="truncate">{r.workspace}</span>
        </span>
      </td>
      <td className="pr-3 py-2.5">
        <StatePill state={r.state} />
      </td>
      <td className="pr-3 py-2.5 text-right font-mono text-[13px] text-fg">
        {r.turns}
        {r.geometricGrowth && (
          <span className="ml-1 text-honey-dark" title="Geometric context growth detected">
            ↗
          </span>
        )}
      </td>
      <td className="pr-3 py-2.5 text-right font-mono text-[13px] text-fg-dim">
        {formatK(r.avgTokensPerTurn)}
      </td>
      <td className={`pr-3 py-2.5 text-right font-mono text-[13px] ${intensityColor(r.intensity)}`}>
        {r.tokensPerMin > 0 ? formatK(r.tokensPerMin) : '—'}
      </td>
      <td className="pr-3 py-2.5">
        <CachePill state={r.cacheState} ageMs={r.cacheAgeMs} />
      </td>
      <td className="pr-3 py-2.5 text-right font-mono text-[13px] text-fg-dim">
        {r.subagentsActive > 0
          ? `${r.subagentsActive} / ${r.subagentsSpawned}`
          : r.subagentsSpawned > 0
          ? `${r.subagentsSpawned}`
          : '—'}
      </td>
    </tr>
  )
}

function StatePill({ state }: { state: UsageMatrixTab['state'] }) {
  const cls = {
    idle: 'bg-bg-elev border-line text-fg-faint',
    executing: 'bg-sage/10 border-sage/30 text-sage',
    plan: 'bg-fg/5 border-line text-fg-dim',
    background: 'bg-fg/5 border-line text-fg-dim',
  }[state]
  const isPulse = state === 'executing'
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full border text-[11.5px] font-semibold ${cls}`}
    >
      {isPulse && <span className="w-1.5 h-1.5 rounded-full bg-sage animate-pulse" />}
      {state}
    </span>
  )
}

function CachePill({
  state,
  ageMs,
}: {
  state: UsageMatrixTab['cacheState']
  ageMs: number | null
}) {
  if (ageMs == null) return <span className="text-fg-faint font-mono text-[13px]">—</span>
  const label = formatAge(ageMs)
  const cls = {
    warm: 'text-sage',
    expiring: 'text-honey-dark',
    cold: 'text-accent',
  }[state]
  return <span className={`font-mono text-[13px] ${cls}`}>{label}</span>
}

function intensityColor(i: UsageMatrixTab['intensity']): string {
  return {
    idle: 'text-fg-faint',
    low: 'text-fg-dim',
    medium: 'text-honey-dark',
    critical: 'text-accent',
  }[i]
}

function formatK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`
  return String(n)
}

function formatAge(ms: number): string {
  const min = Math.floor(ms / 60_000)
  if (min < 1) return 'now'
  if (min < 60) return `${min}m ago`
  const h = Math.floor(min / 60)
  return `${h}h ${min % 60}m ago`
}
