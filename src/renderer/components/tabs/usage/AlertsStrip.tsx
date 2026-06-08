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
    <div className="px-[22px] pt-3.5 pb-5 space-y-2.5 border-t border-line">
      <div className="text-[11px] font-bold tracking-[0.7px] uppercase text-fg-faint mb-2.5">
        Behavioral alerts
      </div>
      {items.map((a, i) => (
        <div
          key={`${a.tabId}:${a.code}:${i}`}
          className={`flex items-start gap-2.5 rounded-xl px-3.5 py-3 border ${
            a.level === 'warn' ? 'bg-honey/10 border-honey/30' : 'bg-bg-elev border-line'
          }`}
        >
          <span
            className={`w-5 h-5 rounded-full flex items-center justify-center text-[13px] font-bold text-white shrink-0 mt-0.5 ${
              a.level === 'warn' ? 'bg-honey' : 'bg-fg-faint'
            }`}
          >
            !
          </span>
          <div>
            <div className="text-[13px] font-semibold text-fg mb-px">{a.workspace}</div>
            <div
              className={`text-[13px] leading-snug ${
                a.level === 'warn' ? 'text-honey-dark' : 'text-fg-dim'
              }`}
            >
              {a.message}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
