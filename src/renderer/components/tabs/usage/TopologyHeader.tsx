import type { UsageMatrixSnapshot } from '../../../../preload/api'

/**
 * Macro overview strip — sits above the 5h burn-rate banner. Shows
 * cross-workspace totals derived from the per-tab matrix in main.
 */
export function TopologyHeader({ snap }: { snap: UsageMatrixSnapshot | null }) {
  const t = snap?.totals
  if (!t || t.activeSessions === 0) return null

  return (
    <div className="px-6 py-2 border-b border-line bg-bg-elev/50 text-xs grid grid-cols-4 gap-4">
      <Stat label="active sessions" value={String(t.activeSessions)} />
      <Stat
        label="subagents"
        value={
          t.subagentsActive > 0
            ? `${t.subagentsActive} active · ${t.subagentsSpawned} total`
            : `${t.subagentsSpawned} total`
        }
      />
      <Stat
        label="combined burn"
        value={t.combinedTokensPerMin > 0 ? `${formatRate(t.combinedTokensPerMin)}/min` : '—'}
      />
      <Stat label="tokens today" value={formatTokens(t.tokensTotal)} />
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-fg-faint mb-0.5">{label}</div>
      <div className="font-mono tabular-nums text-fg">{value}</div>
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
