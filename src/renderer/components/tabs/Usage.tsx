import { useEffect, useRef, useState } from 'react'
import { Panel } from '../ui/Panel'
import { EmptyState } from '../ui/EmptyState'
import { UsageDial } from '../ui/UsageDial'
import { useActiveTab } from '../../lib/useActiveTab'
import { useBilling, refreshBilling } from '../../state/billing'
import { BillingStatusOverlay } from '../ui/BillingStatusBanner'
import type { BillingData, BillingFetchResult, UsageWindow } from '../../../preload/api'

/**
 * Usage tab — mirrors what `claude /usage` shows: the live billing meter from
 * ~/.claude/.credentials.json (5h + 7d windows, extra credits). Previously
 * this tab estimated cost from JSONL transcript tokens × a hand-edited price
 * table, which had nothing to do with the user's actual quota state.
 *
 * Data comes from the singleton `useBilling` store (state/billing.ts) — no
 * per-component poll loop here.
 *
 * Scope: "Am I about to hit a rate limit?" — billing-derived only. Historical
 * transcript analytics (tokens-over-time, top projects) live in the History
 * tab's Dashboard view, which reads JSONL on disk.
 */
function getBillingData(r: BillingFetchResult | null): BillingData | null {
  if (!r) return null
  if (r.kind === 'ok' || r.kind === 'ok-stale') return r.data
  if (r.kind === 'auth' && r.cached) return r.cached
  return null
}

export function Usage() {
  const activeTab = useActiveTab()
  const billing = useBilling((s) => s.data)
  const data = getBillingData(billing)

  if (!activeTab) {
    return (
      <Panel>
        <EmptyState title="no active session" />
      </Panel>
    )
  }

  const fiveHour = data?.usage.five_hour ?? null
  const sonnet = data?.usage.seven_day_sonnet ?? null
  const opus = data?.usage.seven_day_opus ?? null
  const sevenDay = data?.usage.seven_day ?? null
  const oauthApps = data?.usage.seven_day_oauth_apps ?? null
  const extra = data?.usage.extra_usage ?? null

  return (
    <Panel
      toolbar={
        <>
          <span className="text-fg-faint">session {activeTab.claudeSessionId.slice(0, 8)}</span>
          <div className="flex-1" />
          <ResetCountdown fiveHour={fiveHour} />
          {data && (
            <span className="text-fg-faint text-xs">
              {data.subscriptionType ?? 'unknown plan'}
              {data.rateLimitTier ? ` · ${data.rateLimitTier}` : ''}
            </span>
          )}
        </>
      }
    >
      <BurnRate billing={billing} />
      <div className="p-6 max-w-3xl space-y-4">
        {billing && billing.kind !== 'ok' && billing.kind !== 'ok-stale' && (
          <BillingStatusOverlay result={billing} onRetry={refreshBilling} />
        )}

        {!billing && <div className="text-xs text-fg-faint">loading usage…</div>}

        {data && (
          <>
            <UsageDial label="5-hour window" window={fiveHour} />
            <div className="grid grid-cols-2 gap-3">
              <UsageDial label="7-day · Sonnet" window={sonnet} />
              <UsageDial label="7-day · Opus" window={opus} />
            </div>
            {(sevenDay || oauthApps) && (
              <div className="grid grid-cols-2 gap-3">
                <UsageDial label="7-day · combined" window={sevenDay} />
                <UsageDial label="7-day · oauth apps" window={oauthApps} />
              </div>
            )}
            {extra?.is_enabled && extra.utilization != null && (
              <ExtraCredits extra={extra} />
            )}
          </>
        )}
      </div>
    </Panel>
  )
}

function ExtraCredits({
  extra,
}: {
  extra: NonNullable<BillingData['usage']['extra_usage']>
}) {
  const pct = Math.max(0, Math.min(100, extra.utilization ?? 0))
  const remaining =
    extra.monthly_limit != null && extra.used_credits != null
      ? extra.monthly_limit - extra.used_credits
      : null
  return (
    <div className="border border-line rounded p-3 bg-bg-elev">
      <div className="text-xs uppercase tracking-wider text-fg-faint mb-2">
        Extra credits ({extra.currency ?? '—'})
      </div>
      <div className="flex items-baseline gap-3 text-sm">
        <span className="font-mono text-fg">{pct.toFixed(0)}%</span>
        {remaining != null && (
          <span className="text-fg-dim text-xs">
            {remaining.toFixed(2)} of {extra.monthly_limit?.toFixed(2)} remaining
          </span>
        )}
      </div>
    </div>
  )
}

type BurnLevel = 'ok' | 'warn' | 'critical'

const BURN_LEVEL_ORDER: Record<BurnLevel, number> = { ok: 0, warn: 1, critical: 2 }

const BURN_LEVEL_CLASS: Record<BurnLevel, string> = {
  ok: 'bg-emerald-950/30 border-emerald-900/40 text-emerald-200',
  warn: 'bg-yellow-950/30 border-yellow-900/40 text-yellow-200',
  critical: 'bg-red-950/30 border-red-900/40 text-red-200',
}

function formatPT(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: '2-digit',
    minute: '2-digit',
  })
}

interface BurnRateProps {
  billing: BillingFetchResult | null
}

function BurnRate({ billing }: BurnRateProps) {
  const [now, setNow] = useState(() => Date.now())
  const lastNotifyKey = useRef<string | null>(null)

  // Re-tick `now` once a minute so elapsed/projected stay live without a
  // dedicated poller — the billing data itself comes from useBilling.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])

  const data = getBillingData(billing)
  const five: UsageWindow | null = data?.usage?.five_hour ?? null
  const resetsAt = five?.resets_at ?? null
  const utilization = five?.utilization ?? 0
  const resetsAtMs = resetsAt ? new Date(resetsAt).getTime() : Number.NaN
  const validReset = Number.isFinite(resetsAtMs)
  const windowStartMs = validReset ? resetsAtMs - 5 * 3_600_000 : 0
  const elapsedMin = validReset ? Math.max(0, (now - windowStartMs) / 60_000) : 0
  // Need >=1 min of elapsed time before extrapolation is meaningful.
  const projectable = elapsedMin >= 1 && utilization > 0
  const projected = projectable ? (utilization / elapsedMin) * 300 : utilization
  const level: BurnLevel = projected > 95 ? 'critical' : projected > 80 ? 'warn' : 'ok'

  useEffect(() => {
    if (!resetsAt || level === 'ok') return
    const key = `sm:burnRateLastNotified:${resetsAt}`
    if (lastNotifyKey.current === key) return
    const last = (localStorage.getItem(key) ?? 'ok') as BurnLevel
    if (BURN_LEVEL_ORDER[level] <= BURN_LEVEL_ORDER[last]) return
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      const title =
        level === 'critical'
          ? 'Critical: 5h window projected over 95%'
          : 'Warning: 5h window projected over 80%'
      new Notification(title, { body: `Projected ${projected.toFixed(0)}% by reset.` })
    }
    localStorage.setItem(key, level)
    lastNotifyKey.current = key
  }, [level, resetsAt, projected])

  if (billing && billing.kind !== 'ok' && billing.kind !== 'ok-stale') return null
  if (!billing || !five || !validReset) return null

  const elapsedH = Math.floor(elapsedMin / 60)
  const elapsedM = Math.floor(elapsedMin % 60)
  const elapsedLabel = elapsedH > 0 ? `${elapsedH}h ${elapsedM}m` : `${elapsedM}m`

  let exhaustLabel: string | null = null
  if (projectable && projected > 100) {
    const minsTo100 = (100 / utilization) * elapsedMin
    const exhaustMs = windowStartMs + minsTo100 * 60_000
    if (exhaustMs <= resetsAtMs) exhaustLabel = `${formatPT(exhaustMs)} PT`
  }

  return (
    <div className={`sticky top-0 z-10 border-b px-6 py-3 ${BURN_LEVEL_CLASS[level]}`}>
      {billing.kind === 'ok-stale' && (
        <div className="text-xs opacity-60 mb-1">
          stale data ·{' '}
          <button onClick={refreshBilling} className="underline hover:no-underline">
            Retry
          </button>
        </div>
      )}
      <div className="flex items-baseline justify-between mb-2">
        <h3 className="text-xs uppercase tracking-wider">Burn rate</h3>
        <div className="text-xs opacity-75">elapsed {elapsedLabel} of 5h</div>
      </div>
      <div className="grid grid-cols-3 gap-4 text-xs">
        <BurnStat label="current" value={`${utilization.toFixed(0)}%`} />
        <BurnStat
          label="projected at reset"
          value={projectable ? `${projected.toFixed(0)}%` : '—'}
        />
        <BurnStat label="exhaust by" value={exhaustLabel ?? '—'} />
      </div>
    </div>
  )
}

function BurnStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider opacity-75 mb-0.5">{label}</div>
      <div className="text-lg font-mono tabular-nums">{value}</div>
    </div>
  )
}

/**
 * ResetCountdown — small toolbar chip that ticks every second showing
 * HH:MM:SS until the current 5h quota window resets. When the timer hits
 * zero it hides for ~5s while the billing store refetches, then re-appears
 * with the new window's countdown.
 *
 * Anchored to America/Los_Angeles via formatPT for the absolute time label;
 * the countdown itself is timezone-agnostic (delta between two Date.now()).
 */
function ResetCountdown({ fiveHour }: { fiveHour: UsageWindow | null }) {
  const [now, setNow] = useState(() => Date.now())
  const [hidden, setHidden] = useState(false)

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])

  const resetsAt = fiveHour?.resets_at ?? null
  const resetsAtMs = resetsAt ? new Date(resetsAt).getTime() : Number.NaN
  const validReset = Number.isFinite(resetsAtMs)
  const remainingMs = validReset ? resetsAtMs - now : Number.NaN

  // When the window flips, hide the chip briefly and trigger a billing
  // refetch so the next window's resets_at lands before we render again.
  // useRef would be cleaner but a local effect keyed on the boundary works.
  useEffect(() => {
    if (!validReset) return
    if (remainingMs > 0) {
      if (hidden) setHidden(false)
      return
    }
    if (hidden) return
    setHidden(true)
    refreshBilling()
    const id = window.setTimeout(() => setHidden(false), 5000)
    return () => window.clearTimeout(id)
    // remainingMs ticks every second; we only care about the crossover.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [validReset, remainingMs > 0])

  if (!validReset || hidden) return null
  if (remainingMs <= 0) return null

  const totalSec = Math.floor(remainingMs / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  const label = `${pad(h)}:${pad(m)}:${pad(s)}`

  return (
    <span
      className="text-fg-faint text-xs font-mono tabular-nums border border-line rounded px-2 py-0.5 mr-2"
      title={`5h window resets at ${formatPT(resetsAtMs)} PT`}
    >
      resets in {label}
    </span>
  )
}
