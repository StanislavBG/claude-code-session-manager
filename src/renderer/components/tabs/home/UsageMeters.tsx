import type { BillingData, UsageWindow } from '../../../../preload/api'
import { tierTone } from './usage-primitives'

function prettyPlan(s: string | null): string | null {
  if (!s) return null
  return s
    .split('_')
    .map((p) => (/^\d/.test(p) ? p : p.charAt(0).toUpperCase() + p.slice(1)))
    .join(' ')
}

/** Reset as { rel: "2h 14m" / "4d 3h", abs: "3:00 PM PT" / "Tue 3:00 PM PT" }. */
function formatReset(iso: string | null): { rel: string; abs: string } | null {
  if (!iso) return null
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return null
  const diff = t.getTime() - Date.now()
  if (diff <= 0) return { rel: 'now', abs: '' }
  const days = Math.floor(diff / 86_400_000)
  const h = Math.floor((diff % 86_400_000) / 3_600_000)
  const m = Math.floor((diff % 3_600_000) / 60_000)
  const rel = days > 0 ? `${days}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`
  const abs =
    days >= 1
      ? t.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', hour: 'numeric', minute: '2-digit' })
      : t.toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit' })
  return { rel, abs: `${abs} PT` }
}

function Meter({
  label,
  sub,
  window: w,
  big = false,
}: {
  label: string
  sub?: string
  window: UsageWindow | null
  big?: boolean
}) {
  if (!w) return null
  const util = w.utilization
  const pct = Math.max(0, Math.min(100, util))
  const over = util > 100
  const reset = formatReset(w.resets_at)
  const tone = tierTone(util)

  return (
    <div className={big ? 'py-[18px]' : 'py-[15px]'}>
      <div className="flex items-baseline justify-between gap-3 mb-2.5">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className={`w-[9px] h-[9px] rounded-full shrink-0 ${tone.dot}`} />
          <span className={`font-semibold text-fg ${big ? 'text-base' : 'text-[15px]'}`}>{label}</span>
          {sub && (
            <span className="font-mono text-[11.5px] text-fg-faint bg-bg border border-line px-2 py-px rounded-full whitespace-nowrap">
              {sub}
            </span>
          )}
        </div>
        <span
          className={`font-mono font-semibold leading-none tracking-tight shrink-0 ${big ? 'text-2xl' : 'text-xl'} ${over ? 'text-accent' : tone.text}`}
        >
          {Math.round(util)}%
        </span>
      </div>

      <div className={`rounded-full overflow-hidden ${big ? 'h-3' : 'h-2.5'} ${tone.track}`}>
        <div
          className={`h-full rounded-full transition-[width] duration-500 ${tone.bar}`}
          style={{ width: `${pct}%` }}
        />
      </div>

      {reset && (
        <div className="flex items-center justify-between mt-2.5 gap-3">
          <span className="text-[12.5px] text-fg-dim">
            resets in{' '}
            <strong className="text-fg font-semibold">{reset.rel}</strong>
            {reset.abs && (
              <>
                <span className="text-fg-faint"> · </span>
                <span className="font-mono text-xs text-fg-faint">{reset.abs}</span>
              </>
            )}
          </span>
          {over && <span className="text-[11.5px] font-semibold text-accent">over limit</span>}
        </div>
      )}
    </div>
  )
}

type ExtraUsageData = NonNullable<BillingData['usage']['extra_usage']>

function ExtraUsageRow({ extra }: { extra: ExtraUsageData }) {
  const utilPct = extra.utilization ?? 0
  const over = utilPct > 100
  const tone = tierTone(utilPct)
  return (
    <div className="border-t border-line pt-[15px] pb-[15px]">
      <div className="flex items-baseline justify-between mb-2.5">
        <div className="flex items-center gap-2.5">
          <span className={`w-[9px] h-[9px] rounded-full shrink-0 ${tone.dot}`} />
          <span className="text-[15px] font-semibold text-fg">Extra usage</span>
          <span className="font-mono text-[11.5px] text-fg-faint bg-bg border border-line px-2 py-px rounded-full whitespace-nowrap">
            pay-as-you-go
          </span>
        </div>
        <span className={`font-mono text-base font-semibold tabular-nums ${over ? 'text-accent' : 'text-fg'}`}>
          {(extra.used_credits ?? 0).toFixed(2)}{' '}
          <span className="text-fg-faint font-normal">
            / {(extra.monthly_limit ?? 0).toFixed(2)} {extra.currency ?? ''}
          </span>
        </span>
      </div>
      <div className={`h-2.5 rounded-full overflow-hidden ${tone.track}`}>
        <div
          className={`h-full rounded-full transition-[width] duration-500 ${tone.bar}`}
          style={{ width: `${Math.min(utilPct, 100)}%` }}
        />
      </div>
      <div className="flex items-center justify-between mt-2.5 gap-3">
        <span className="text-[12.5px] text-fg-dim">
          monthly credit limit · resets{' '}
          <span className="font-mono text-xs text-fg-faint">1st of month</span>
        </span>
        {over && <span className="text-[11.5px] font-semibold text-accent">over limit</span>}
      </div>
    </div>
  )
}

export function UsageMeters({ data, updatedAt }: { data: BillingData; updatedAt?: number }) {
  const u = data.usage
  const plan = prettyPlan(data.subscriptionType)
  const extra = u.extra_usage
  const updatedLabel =
    updatedAt != null ? `${Math.max(0, Math.round((Date.now() - updatedAt) / 1000))}s ago` : null

  return (
    <section className="bg-bg-hi border border-line rounded-2xl px-6 py-1.5">
      {(plan || data.rateLimitTier || updatedLabel) && (
        <div className="flex items-baseline justify-between pt-3 pb-1 mb-1">
          <div className="flex items-baseline gap-2">
            {plan && <span className="text-xs text-fg-dim font-mono">{plan}</span>}
            {data.rateLimitTier && (
              <span className="text-[10px] text-fg-faint font-mono">{data.rateLimitTier}</span>
            )}
          </div>
          {updatedLabel && <span className="text-[10px] text-fg-faint">updated {updatedLabel}</span>}
        </div>
      )}

      <div className="divide-y divide-line">
        <Meter label="Session" sub="5-hour" window={u.five_hour} big />
        <Meter label="Weekly" sub="all models" window={u.seven_day} />
        <Meter label="Weekly" sub="Opus" window={u.seven_day_opus} />
        <Meter label="Weekly" sub="Sonnet" window={u.seven_day_sonnet} />
        <Meter label="Weekly" sub="OAuth apps" window={u.seven_day_oauth_apps} />
      </div>

      {extra?.is_enabled && <ExtraUsageRow extra={extra} />}
    </section>
  )
}
