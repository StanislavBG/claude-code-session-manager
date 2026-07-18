import { useEffect, useRef, useState } from 'react'
import { Panel } from '../ui/Panel'
import { EmptyState } from '../ui/EmptyState'
import { UsageMeters } from './usage/UsageMeters'
import { tierTone } from './usage/usage-primitives'
import { useActiveTab } from '../../lib/useActiveTab'
import { useBilling, refreshBilling, getBillingData } from '../../state/billing'
import { useUsageMatrix, useStartUsageMatrix } from '../../state/usageMatrix'
import { BillingStatusOverlay } from '../ui/BillingStatusBanner'
import { TopologyHeader } from './usage/TopologyHeader'
import { SessionMatrix } from './usage/SessionMatrix'
import { AlertsStrip } from './usage/AlertsStrip'
import { AlmanacIcon } from '../layout/AlmanacIcon'
import type { BillingFetchResult, UsageWindow } from '../../../preload/api'

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
export function Usage() {
  const activeTab = useActiveTab()
  const billing = useBilling((s) => s.data)
  const data = getBillingData(billing)
  useStartUsageMatrix()
  const matrix = useUsageMatrix((s) => s.snapshot)
  const [topologyOpen, setTopologyOpen] = useState(true)

  if (!activeTab) {
    return (
      <Panel>
        <EmptyState title="no active session" />
      </Panel>
    )
  }

  const fiveHour = data?.usage.five_hour ?? null

  return (
    <Panel
      toolbar={
        <>
          <span className="text-fg-faint">session {activeTab.claudeSessionId.slice(0, 8)}</span>
          <div className="flex-1" />
          <ResetCountdown fiveHour={fiveHour} />
          <button
            onClick={refreshBilling}
            className="text-fg-faint hover:text-fg text-xs border border-line rounded px-2 py-0.5"
            title="Refetch /usage from the billing API"
          >
            Refresh
          </button>
        </>
      }
    >
      <div className="px-6 pt-7 pb-6 max-w-2xl space-y-4">
        {billing && billing.kind !== 'ok' && billing.kind !== 'ok-stale' && (
          <BillingStatusOverlay result={billing} onRetry={refreshBilling} />
        )}

        {!billing && <div className="text-xs text-fg-faint">loading usage…</div>}

        {/* 5h-window burn-rate projection — Almanac light card. */}
        <BurnRate billing={billing} />

        {/* The /usage core: subscription window consumption. */}
        {data && <UsageMeters data={data} updatedAt={data.fetchedAt} />}
      </div>

      {/* Secondary — live session topology across all open tabs (not part of
          /usage; the cross-session analytics layer). */}
      {matrix && (
        <div className="px-6 pb-6 max-w-3xl">
          <button
            onClick={() => setTopologyOpen((o) => !o)}
            aria-expanded={topologyOpen}
            className="flex items-center gap-2.5 mb-3.5 cursor-pointer appearance-none border-0 bg-transparent p-0 w-full text-left"
          >
            <span
              className={`text-fg-faint inline-flex transition-transform duration-150 ${topologyOpen ? 'rotate-90' : ''}`}
              aria-hidden="true"
            >
              <AlmanacIcon name="chevron" size={15} />
            </span>
            <span className="font-serif text-[19px] font-semibold text-fg">Session topology</span>
            <span className="text-[12.5px] text-fg-faint">
              · live across open tabs · not part of /usage
            </span>
          </button>

          {topologyOpen && (
            <div className="bg-bg-hi border border-line rounded-2xl overflow-hidden">
              <TopologyHeader snap={matrix} />
              <SessionMatrix snap={matrix} />
              <AlertsStrip snap={matrix} />
            </div>
          )}
        </div>
      )}
    </Panel>
  )
}

type BurnLevel = 'ok' | 'warn' | 'critical'

const BURN_LEVEL_ORDER: Record<BurnLevel, number> = { ok: 0, warn: 1, critical: 2 }

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
  // After the guards above, kind is 'ok' or 'ok-stale'; !== 'ok' means stale.
  const isStale = billing.kind !== 'ok'

  const elapsedH = Math.floor(elapsedMin / 60)
  const elapsedM = Math.floor(elapsedMin % 60)
  const elapsedLabel = elapsedH > 0 ? `${elapsedH}h ${elapsedM}m` : `${elapsedM}m`

  let exhaustLabel: string | null = null
  if (projectable && projected > 100) {
    const minsTo100 = (100 / utilization) * elapsedMin
    const exhaustMs = windowStartMs + minsTo100 * 60_000
    if (exhaustMs <= resetsAtMs) exhaustLabel = `${formatPT(exhaustMs)} PT`
  }

  // Trajectory bar widths (0–100, clamped)
  const curPct = Math.min(utilization, 100)
  const projPct = Math.max(0, Math.min(projected, 100) - curPct)

  // Projected tone for the readout label — only meaningful when projectable.
  // Without a projection, the dash placeholder must not inherit a caution/alert color.
  const projTone = projectable ? tierTone(projected) : null

  const onTrack = level === 'ok'
  const pillLabel = onTrack ? 'On track' : 'Trending over'
  const pillClasses = onTrack
    ? 'bg-sage/10 border-sage/30 text-sage'
    : 'bg-accent/10 border-accent/30 text-accent'
  const pillDotClass = onTrack ? 'bg-sage' : 'bg-accent'

  return (
    <div className="bg-bg-hi border border-line rounded-2xl px-6 py-5">
      {/* Header row */}
      <div className="flex items-center justify-between mb-[18px] gap-3">
        <div className="flex items-center gap-2.5">
          <span className="text-sage inline-flex">
            <AlmanacIcon name="usage" size={17} />
          </span>
          <span className="font-serif text-[19px] font-semibold text-fg">Burn rate</span>
          <span className="text-[13px] text-fg-faint">· this 5-hour session</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {isStale && (
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold bg-honey/10 border border-honey/30 text-honey-dark px-2.5 py-1 rounded-full">
              stale ·{' '}
              <button onClick={refreshBilling} className="underline hover:no-underline">
                Retry
              </button>
            </span>
          )}
          <span
            className={`inline-flex items-center gap-1.5 text-[12.5px] font-semibold border px-3 py-1 rounded-full ${pillClasses}`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${pillDotClass}`} />
            {pillLabel}
          </span>
        </div>
      </div>

      {/* Three big readouts */}
      <div className="grid grid-cols-3 gap-2 mb-5">
        <BurnStat label="Current" value={`${utilization.toFixed(0)}%`} />
        <BurnStat
          label="Projected at reset"
          value={projectable ? `${projected.toFixed(0)}%` : '—'}
          tone={projTone?.text}
        />
        <BurnStat
          label="Exhaust by"
          value={exhaustLabel ?? '—'}
          tone={exhaustLabel ? 'text-accent' : 'text-fg-faint'}
          hint={exhaustLabel ? 'estimated' : 'not on track to exhaust'}
        />
      </div>

      {/* Trajectory bar: solid current + striped projected addition */}
      <div className="relative h-3.5 bg-sage/15 rounded-full overflow-hidden">
        <div
          className="absolute left-0 top-0 bottom-0 bg-sage rounded-full"
          style={{ width: `${curPct}%` }}
        />
        <div
          className="absolute top-0 bottom-0 burn-proj-stripe"
          style={{ left: `${curPct}%`, width: `${projPct}%` }}
        />
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between mt-2.5">
        <span className="text-[12.5px] text-fg-dim">
          elapsed <strong className="text-fg font-semibold">{elapsedLabel}</strong> of 5h
        </span>
        <span className="inline-flex items-center gap-3.5 text-xs text-fg-faint">
          <SwatchLabel label="used now" />
          <SwatchLabel striped label="projected" />
        </span>
      </div>
    </div>
  )
}

function BurnStat({
  label,
  value,
  tone,
  hint,
}: {
  label: string
  value: string
  tone?: string
  hint?: string
}) {
  return (
    <div>
      <div className="text-[11px] font-bold tracking-[0.6px] uppercase text-fg-faint mb-1.5">
        {label}
      </div>
      <div className={`font-mono text-[30px] font-semibold leading-none tracking-tight ${tone ?? 'text-fg'}`}>
        {value}
      </div>
      {hint && <div className="text-[11.5px] text-fg-faint mt-1">{hint}</div>}
    </div>
  )
}

function SwatchLabel({ striped, label }: { striped?: boolean; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={`w-3.5 h-2 rounded-sm inline-block ${striped ? 'burn-proj-stripe' : 'bg-sage'}`}
      />
      {label}
    </span>
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
