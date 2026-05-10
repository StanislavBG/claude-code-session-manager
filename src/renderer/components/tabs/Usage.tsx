import { useEffect, useRef, useState } from 'react'
import { Panel } from '../ui/Panel'
import { EmptyState } from '../ui/EmptyState'
import { useActiveTab } from '../../lib/useActiveTab'
import { useLive } from '../../state/live'
import { BillingStatusOverlay } from '../ui/BillingStatusBanner'
import type { BillingData, BillingFetchResult } from '../../../preload/api'

/**
 * Usage tab — aggregates token counts from the transcript and converts to a
 * rough USD estimate. Prices are user-editable because they drift; defaults
 * reflect Apr 2026 pricing.
 */
const DEFAULT_PRICES: Record<string, { input: number; output: number }> = {
  'opus-4.6': { input: 5, output: 25 },
  'sonnet-4.6': { input: 3, output: 15 },
  'haiku-4.5': { input: 1, output: 5 },
}

const BILLING_REFRESH_MS = 60_000

function getBillingData(r: BillingFetchResult | null): BillingData | null {
  if (!r) return null
  if (r.kind === 'ok' || r.kind === 'ok-stale') return r.data
  if (r.kind === 'auth' && r.cached) return r.cached
  return null
}

export function Usage() {
  const activeTab = useActiveTab()
  const subscribe = useLive((s) => s.subscribe)
  const unsubscribe = useLive((s) => s.unsubscribe)
  const live = useLive((s) => (activeTab ? s.tabs[activeTab.id] : undefined))

  const [model, setModel] = useState<keyof typeof DEFAULT_PRICES>('opus-4.6')
  type PriceTable = Record<string, { input: number; output: number }>
  const [prices, setPrices] = useState<PriceTable>(() => {
    try {
      const saved = localStorage.getItem('sm:pricing')
      if (saved) return { ...DEFAULT_PRICES, ...(JSON.parse(saved) as PriceTable) }
    } catch { /* ignore */ }
    return DEFAULT_PRICES
  })
  const updatePrices = (next: PriceTable) => {
    setPrices(next)
    try { localStorage.setItem('sm:pricing', JSON.stringify(next)) } catch { /* ignore */ }
  }

  useEffect(() => {
    if (!activeTab) return
    subscribe(activeTab.id, activeTab.cwd, activeTab.claudeSessionId)
    return () => unsubscribe(activeTab.id)
  }, [activeTab, subscribe, unsubscribe])

  if (!activeTab) {
    return (
      <Panel>
        <EmptyState title="no active session" />
      </Panel>
    )
  }

  const usage = live?.usage ?? { inputTokens: 0, outputTokens: 0 }
  const p = prices[model]
  const cost =
    (usage.inputTokens * p.input) / 1_000_000 + (usage.outputTokens * p.output) / 1_000_000

  return (
    <Panel
      toolbar={
        <>
          <span className="text-fg-faint">session {activeTab.claudeSessionId.slice(0, 8)}</span>
          <div className="flex-1" />
          <label className="text-fg-faint flex items-center gap-2">
            model
            <select
              value={model}
              onChange={(e) => setModel(e.target.value as keyof typeof DEFAULT_PRICES)}
              className="bg-bg-elev border border-line rounded px-2 py-0.5 text-xs text-fg"
            >
              {Object.keys(prices).map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
        </>
      }
    >
      <BurnRate />
      <div className="p-6 max-w-2xl space-y-6">
        <section className="grid grid-cols-2 gap-4">
          <Stat label="input tokens" value={usage.inputTokens.toLocaleString()} />
          <Stat label="output tokens" value={usage.outputTokens.toLocaleString()} />
          {usage.cacheCreationInputTokens != null && (
            <Stat
              label="cache creation"
              value={usage.cacheCreationInputTokens.toLocaleString()}
            />
          )}
          {usage.cacheReadInputTokens != null && (
            <Stat label="cache read" value={usage.cacheReadInputTokens.toLocaleString()} />
          )}
          <Stat
            label="estimated cost"
            value={`$${cost.toFixed(4)}`}
            highlight
          />
        </section>

        <section>
          <h3 className="text-xs uppercase tracking-wider text-fg mb-2">Pricing ($/MTok)</h3>
          <table className="text-xs">
            <thead className="text-fg-faint">
              <tr>
                <th className="text-left px-2 py-1">model</th>
                <th className="text-left px-2 py-1">input</th>
                <th className="text-left px-2 py-1">output</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(prices).map(([m, pr]) => (
                <tr key={m} className="border-t border-line">
                  <td className="px-2 py-1 text-fg-dim">{m}</td>
                  <td className="px-2 py-1">
                    <input
                      type="number"
                      step="0.1"
                      value={pr.input}
                      onChange={(e) =>
                        updatePrices({
                          ...prices,
                          [m]: { ...pr, input: Number(e.target.value) },
                        })
                      }
                      className="w-16 bg-bg-elev border border-line rounded px-1 py-0.5 text-fg"
                    />
                  </td>
                  <td className="px-2 py-1">
                    <input
                      type="number"
                      step="0.1"
                      value={pr.output}
                      onChange={(e) =>
                        updatePrices({
                          ...prices,
                          [m]: { ...pr, output: Number(e.target.value) },
                        })
                      }
                      className="w-16 bg-bg-elev border border-line rounded px-1 py-0.5 text-fg"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-2 text-fg-faint text-xs">
            edits are saved locally and persist across sessions.
          </div>
        </section>
      </div>
    </Panel>
  )
}

function Stat({
  label,
  value,
  highlight,
}: {
  label: string
  value: string
  highlight?: boolean
}) {
  return (
    <div className="border border-line rounded p-3 bg-bg-elev">
      <div className="text-xs text-fg-faint uppercase tracking-wider mb-1">{label}</div>
      <div
        className={`text-lg font-mono ${highlight ? 'text-accent' : 'text-fg'}`}
      >
        {value}
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

function BurnRate() {
  const [billing, setBilling] = useState<BillingFetchResult | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const lastKindRef = useRef<string | null>(null)
  const tickRef = useRef<() => void>(() => {})

  useEffect(() => {
    let cancelled = false
    let timer: number | null = null
    const tick = async () => {
      if (timer !== null) { clearTimeout(timer); timer = null }
      const r = await window.api.billing.fetch()
      if (cancelled) return
      setBilling(r)
      setNow(Date.now())
      let next: number
      if (r.kind === 'transient') {
        next = lastKindRef.current === 'transient' ? 30_000 : 5_000
      } else if (r.kind === 'auth') {
        next = 30_000
      } else {
        next = BILLING_REFRESH_MS
      }
      lastKindRef.current = r.kind
      timer = window.setTimeout(tick, next)
    }
    tickRef.current = tick
    tick()
    return () => {
      cancelled = true
      if (timer !== null) clearTimeout(timer)
    }
  }, [])

  const data: BillingData | null = getBillingData(billing)
  const five = data?.usage?.five_hour ?? null
  const resetsAt = five?.resets_at ?? null
  const utilization = five?.utilization ?? 0
  const resetsAtMs = resetsAt ? new Date(resetsAt).getTime() : Number.NaN
  const validReset = Number.isFinite(resetsAtMs)
  const windowStartMs = validReset ? resetsAtMs - 5 * 3_600_000 : 0
  const elapsedMin = validReset ? Math.max(0, (now - windowStartMs) / 60_000) : 0
  // Need ≥1 min of elapsed time before extrapolation is meaningful.
  const projectable = elapsedMin >= 1 && utilization > 0
  const projected = projectable ? (utilization / elapsedMin) * 300 : utilization
  const level: BurnLevel = projected > 95 ? 'critical' : projected > 80 ? 'warn' : 'ok'

  useEffect(() => {
    if (!resetsAt || level === 'ok') return
    const key = `sm:burnRateLastNotified:${resetsAt}`
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
  }, [level, resetsAt, projected])

  // Show error status overlay when billing data is unavailable
  if (billing && billing.kind !== 'ok' && billing.kind !== 'ok-stale') {
    return (
      <div className="sticky top-0 z-10 border-b border-line px-6 py-3 bg-bg-elev">
        <BillingStatusOverlay result={billing} onRetry={tickRef.current} />
      </div>
    )
  }

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
    <div
      className={`sticky top-0 z-10 border-b px-6 py-3 ${BURN_LEVEL_CLASS[level]}`}
    >
      {billing.kind === 'ok-stale' && (
        <div className="text-xs opacity-60 mb-1">stale data · <button onClick={tickRef.current} className="underline hover:no-underline">Retry</button></div>
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
