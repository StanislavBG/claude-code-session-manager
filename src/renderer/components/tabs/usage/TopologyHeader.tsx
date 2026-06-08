import type { UsageMatrixSnapshot } from '../../../../preload/api'

/**
 * Macro overview strip — renders as the top stat row inside the Almanac
 * topology card. Shows cross-workspace totals from the per-tab matrix.
 */
export function TopologyHeader({ snap }: { snap: UsageMatrixSnapshot | null }) {
  const t = snap?.totals
  if (!t || t.activeSessions === 0) return null

  return (
    <div className="grid grid-cols-4 border-b border-line">
      <TopStat label="Active sessions" value={String(t.activeSessions)} />
      <TopStat
        label="Subagents"
        value={
          t.subagentsActive > 0
            ? `${t.subagentsActive} active · ${t.subagentsSpawned} total`
            : `${t.subagentsSpawned} total`
        }
      />
      <TopStat
        label="Combined burn"
        value={t.combinedTokensPerMin > 0 ? `${formatRate(t.combinedTokensPerMin)}/min` : '—'}
        mono
      />
      <TopStat label="Tokens today" value={formatTokens(t.tokensTotal)} mono last />
    </div>
  )
}

function TopStat({
  label,
  value,
  mono,
  last,
}: {
  label: string
  value: string
  mono?: boolean
  last?: boolean
}) {
  return (
    <div className={`px-5 py-4 ${!last ? 'border-r border-line' : ''}`}>
      <div className="text-[11px] font-bold tracking-[0.6px] uppercase text-fg-faint mb-1.5">
        {label}
      </div>
      <div
        className={`text-xl font-semibold text-fg ${mono ? 'font-mono tabular-nums tracking-tight' : ''}`}
      >
        {value}
      </div>
    </div>
  )
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`
  return String(n)
}

function formatRate(n: number): string {
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}
