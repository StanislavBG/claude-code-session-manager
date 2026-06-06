import type { BillingData, UsageWindow } from '../../../../preload/api'

/**
 * UsageMeters — a faithful, compact rendering of what `claude /usage` prints:
 * the subscription's rolling-window consumption. One horizontal meter per
 * window (Session 5h, Weekly all-models, Weekly Opus, Weekly Sonnet, OAuth
 * apps) plus pay-as-you-go extra credits. Each meter shows the percentage, a
 * color-graded bar, and the reset as BOTH a relative countdown and an absolute
 * Pacific-time stamp — the two framings `/usage` and claude.ai surface.
 *
 * Only windows the API actually returns are shown; nulls collapse so a Pro
 * plan (no per-model weekly) and a Max plan (Opus/Sonnet split) both read clean.
 */

function prettyPlan(s: string | null): string | null {
  if (!s) return null
  // "max" → "Max", "pro" → "Pro", "max_20x" → "Max 20x"
  return s
    .split('_')
    .map((p) => (/^\d/.test(p) ? p : p.charAt(0).toUpperCase() + p.slice(1)))
    .join(' ')
}

function barColor(util: number): string {
  if (util >= 90) return 'bg-red-400'
  if (util >= 70) return 'bg-yellow-400'
  return 'bg-emerald-400'
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
  // Within a day → a clock time; multi-day weekly windows → weekday + time.
  const abs =
    days >= 1
      ? t.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', hour: 'numeric', minute: '2-digit' })
      : t.toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit' })
  return { rel, abs: `${abs} PT` }
}

function Meter({ label, sub, window: w }: { label: string; sub?: string; window: UsageWindow | null }) {
  if (!w) return null
  const util = w.utilization
  const pct = Math.max(0, Math.min(100, util))
  const over = util > 100
  const reset = formatReset(w.resets_at)
  return (
    <div className="py-2">
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <span className="text-xs text-fg">{label}</span>
          {sub && <span className="ml-1.5 text-[10px] text-fg-faint">{sub}</span>}
        </div>
        <span className={`text-sm font-mono tabular-nums ${over ? 'text-red-400' : 'text-fg'}`}>
          {util.toFixed(0)}%
        </span>
      </div>
      <div className="mt-1 h-2 bg-bg rounded overflow-hidden">
        <div className={`h-full ${barColor(util)} transition-[width] duration-500`} style={{ width: `${pct}%` }} />
      </div>
      {reset && (
        <div className="mt-1 text-[11px] text-fg-faint">
          resets in {reset.rel}
          {reset.abs && <span className="text-fg-dim"> · {reset.abs}</span>}
        </div>
      )}
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
    <section className="border border-line rounded-lg bg-bg-elev px-4 py-3">
      <div className="flex items-baseline justify-between mb-1">
        <div className="flex items-baseline gap-2">
          <h3 className="text-xs uppercase tracking-wider text-fg-faint">Usage</h3>
          {plan && <span className="text-xs text-fg-dim font-mono">{plan}</span>}
          {data.rateLimitTier && <span className="text-[10px] text-fg-faint font-mono">{data.rateLimitTier}</span>}
        </div>
        {updatedLabel && <span className="text-[10px] text-fg-faint">updated {updatedLabel}</span>}
      </div>

      <div className="divide-y divide-line/60">
        <Meter label="Session" sub="5-hour" window={u.five_hour} />
        <Meter label="Weekly" sub="all models" window={u.seven_day} />
        <Meter label="Weekly" sub="Opus" window={u.seven_day_opus} />
        <Meter label="Weekly" sub="Sonnet" window={u.seven_day_sonnet} />
        <Meter label="Weekly" sub="OAuth apps" window={u.seven_day_oauth_apps} />
      </div>

      {extra?.is_enabled && (
        <div className="mt-2 pt-2 border-t border-line flex items-baseline justify-between text-[11px]">
          <span className="text-fg-dim">
            Extra usage
            {extra.utilization != null && <span className="text-fg-faint"> · {extra.utilization.toFixed(0)}%</span>}
          </span>
          <span className="font-mono text-fg-dim tabular-nums">
            {(extra.used_credits ?? 0).toFixed(2)} / {(extra.monthly_limit ?? 0).toFixed(2)} {extra.currency ?? ''}
          </span>
        </div>
      )}
    </section>
  )
}
