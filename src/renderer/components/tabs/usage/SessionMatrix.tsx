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
      <div className="px-6 py-3 text-xs text-fg-faint border-b border-line">
        No active sessions tracked yet — start a Claude tab to populate the matrix.
      </div>
    )
  }
  return (
    <div className="px-6 py-3 border-b border-line">
      <div className="text-[10px] uppercase tracking-wider text-fg-faint mb-2">
        Active session matrix
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs tabular-nums">
          <thead>
            <tr className="text-left text-fg-faint">
              <th className="font-normal pr-3 pb-1">workspace</th>
              <th className="font-normal pr-3 pb-1">state</th>
              <th className="font-normal pr-3 pb-1 text-right">turns</th>
              <th className="font-normal pr-3 pb-1 text-right">avg/turn</th>
              <th className="font-normal pr-3 pb-1 text-right">tokens/min</th>
              <th className="font-normal pr-3 pb-1">cache</th>
              <th className="font-normal pr-3 pb-1 text-right">subagents</th>
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
    <tr className="border-t border-line/50">
      <td
        className="pr-3 py-1.5 text-fg truncate max-w-[16ch]"
        title={r.cwd}
      >
        {r.workspace}
      </td>
      <td className="pr-3 py-1.5">
        <StatePill state={r.state} />
      </td>
      <td className="pr-3 py-1.5 text-right">
        {r.turns}
        {r.geometricGrowth && (
          <span className="ml-1 text-yellow-300" title="Geometric context growth detected">
            ↗
          </span>
        )}
      </td>
      <td className="pr-3 py-1.5 text-right text-fg-dim">{formatK(r.avgTokensPerTurn)}</td>
      <td className={`pr-3 py-1.5 text-right ${intensityColor(r.intensity)}`}>
        {r.tokensPerMin > 0 ? formatK(r.tokensPerMin) : '—'}
      </td>
      <td className="pr-3 py-1.5">
        <CachePill state={r.cacheState} ageMs={r.cacheAgeMs} />
      </td>
      <td className="pr-3 py-1.5 text-right text-fg-dim">
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
    idle: 'bg-bg-elev text-fg-faint border-line',
    executing: 'bg-emerald-950/40 border-emerald-900/40 text-emerald-200',
    plan: 'bg-blue-950/40 border-blue-900/40 text-blue-200',
    background: 'bg-purple-950/40 border-purple-900/40 text-purple-200',
  }[state]
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded border text-[10px] uppercase tracking-wider ${cls}`}>
      {state}
    </span>
  )
}

function CachePill({ state, ageMs }: { state: UsageMatrixTab['cacheState']; ageMs: number | null }) {
  if (ageMs == null) return <span className="text-fg-faint">—</span>
  const label = formatAge(ageMs)
  const cls = {
    warm: 'text-emerald-200',
    expiring: 'text-yellow-200',
    cold: 'text-red-200',
  }[state]
  return <span className={cls}>{label}</span>
}

function intensityColor(i: UsageMatrixTab['intensity']): string {
  return {
    idle: 'text-fg-faint',
    low: 'text-fg-dim',
    medium: 'text-yellow-200',
    critical: 'text-red-200',
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
