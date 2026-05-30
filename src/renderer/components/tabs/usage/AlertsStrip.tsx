import type { UsageMatrixSnapshot } from '../../../../preload/api'

/**
 * Behavioral alerts row — collects per-tab alerts from the matrix and
 * renders them under the matrix. Alerts are de-duplicated by code per tab
 * (the aggregator never emits the same code twice for the same tab) but
 * shown verbatim across tabs.
 */
export function AlertsStrip({ snap }: { snap: UsageMatrixSnapshot | null }) {
  const items = (snap?.tabs ?? []).flatMap((t) =>
    t.alerts.map((a) => ({
      workspace: t.workspace,
      tabId: t.tabId,
      ...a,
    })),
  )
  if (items.length === 0) return null
  return (
    <div className="px-6 py-3 border-b border-line space-y-1.5">
      <div className="text-[10px] uppercase tracking-wider text-fg-faint">
        Behavioral alerts
      </div>
      {items.map((a, i) => (
        <div
          key={`${a.tabId}:${a.code}:${i}`}
          className={`flex items-baseline gap-2 text-xs ${levelClass(a.level)}`}
        >
          <span className="font-mono text-fg-faint shrink-0">{a.workspace}</span>
          <span className="font-mono text-[10px] opacity-60 shrink-0">{icon(a.code)}</span>
          <span>{a.message}</span>
        </div>
      ))}
    </div>
  )
}

function levelClass(level: 'info' | 'warn'): string {
  return level === 'warn' ? 'text-yellow-200' : 'text-fg-dim'
}

function icon(code: string): string {
  switch (code) {
    case 'geometric-growth':
      return '⚠'
    case 'long-session':
      return '↗'
    case 'cache-cold-start':
      return '❄'
    case 'cache-cold':
      return '❄'
    case 'subagent-fanout':
      return '⊕'
    default:
      return '•'
  }
}
