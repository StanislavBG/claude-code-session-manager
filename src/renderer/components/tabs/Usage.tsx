import { useEffect, useMemo, useRef, useState } from 'react'
import { Panel } from '../ui/Panel'
import { EmptyState } from '../ui/EmptyState'
import { UsageDial } from '../ui/UsageDial'
import { useActiveTab } from '../../lib/useActiveTab'
import { useBilling, refreshBilling } from '../../state/billing'
import { BillingStatusOverlay } from '../ui/BillingStatusBanner'
import type { BillingData, BillingFetchResult, UsageWindow, DayProjectRow, HistoryAggregateResult } from '../../../preload/api'

/**
 * Usage tab — mirrors what `claude /usage` shows: the live billing meter from
 * ~/.claude/.credentials.json (5h + 7d windows, extra credits). Previously
 * this tab estimated cost from JSONL transcript tokens × a hand-edited price
 * table, which had nothing to do with the user's actual quota state.
 *
 * Data comes from the singleton `useBilling` store (state/billing.ts) — no
 * per-component poll loop here.
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

      <AnalyticsSection />
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

/* ---------- AnalyticsSection -------------------------------------------- */

type RangeDays = 7 | 30 | 90

interface DailyTotals {
  date: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  sessions: number
  prompts: number
  cost: number
}

interface ProjectTotals {
  projectCwd: string
  sessions: number
  prompts: number
  totalTokens: number
  cost: number
}

function shortDate(iso: string): string {
  // iso is yyyy-mm-dd; render m/d local
  const [y, m, d] = iso.split('-').map((n) => Number(n))
  if (!y || !m || !d) return iso
  return `${m}/${d}`
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toFixed(0)
}

function isoDaysAgo(days: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - days)
  return d.toISOString().slice(0, 10)
}

function shortProject(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean)
  if (parts.length >= 2) return parts.slice(-2).join('/')
  return parts[parts.length - 1] || cwd
}

function AnalyticsSection() {
  const [range, setRange] = useState<RangeDays>(() => {
    const saved = localStorage.getItem('sm:usageAnalyticsRange')
    const n = saved ? Number(saved) : 30
    return (n === 7 || n === 30 || n === 90 ? n : 30) as RangeDays
  })
  const [result, setResult] = useState<HistoryAggregateResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    // Fetch a 90-day window once; slice client-side per range so toggling is instant.
    window.api.history.aggregate({ fromDate: isoDaysAgo(90), toDate: isoDaysAgo(0) })
      .then((r) => { if (!cancelled) { setResult(r); setLoading(false) } })
      .catch((e: unknown) => { if (!cancelled) { setError(String(e)); setLoading(false) } })
    return () => { cancelled = true }
  }, [])

  const persistRange = (r: RangeDays) => {
    setRange(r)
    try { localStorage.setItem('sm:usageAnalyticsRange', String(r)) } catch { /* ignore */ }
  }

  // Filter rows to the active window. O(rows).
  const windowedRows = useMemo<DayProjectRow[]>(() => {
    if (!result) return []
    const cutoff = isoDaysAgo(range)
    return result.rows.filter((r) => r.date >= cutoff)
  }, [result, range])

  // Build per-day totals, indexed by date for O(1) lookup during bar rendering.
  const daily = useMemo<DailyTotals[]>(() => {
    const byDate = new Map<string, DailyTotals>()
    // Seed every day in the window so the bar chart has a stable x-axis.
    for (let i = range - 1; i >= 0; i--) {
      const d = isoDaysAgo(i)
      byDate.set(d, {
        date: d,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        sessions: 0,
        prompts: 0,
        cost: 0,
      })
    }
    for (const r of windowedRows) {
      const entry = byDate.get(r.date)
      if (!entry) continue
      entry.inputTokens += r.inputTokens
      entry.outputTokens += r.outputTokens
      entry.totalTokens += r.inputTokens + r.outputTokens
      entry.sessions += r.sessionCount
      entry.prompts += r.promptCount
      entry.cost += r.estimatedCostUsd
    }
    return Array.from(byDate.values())
  }, [windowedRows, range])

  // Per-project totals for top-N bar list. O(rows + projects log projects).
  const projects = useMemo<ProjectTotals[]>(() => {
    const m = new Map<string, ProjectTotals>()
    for (const r of windowedRows) {
      let cur = m.get(r.projectCwd)
      if (!cur) {
        cur = { projectCwd: r.projectCwd, sessions: 0, prompts: 0, totalTokens: 0, cost: 0 }
        m.set(r.projectCwd, cur)
      }
      cur.sessions += r.sessionCount
      cur.prompts += r.promptCount
      cur.totalTokens += r.inputTokens + r.outputTokens
      cur.cost += r.estimatedCostUsd
    }
    return Array.from(m.values()).sort((a, b) => b.sessions - a.sessions)
  }, [windowedRows])

  const totals = useMemo(() => {
    let input = 0, output = 0, sessions = 0, prompts = 0, cost = 0
    for (const d of daily) {
      input += d.inputTokens
      output += d.outputTokens
      sessions += d.sessions
      prompts += d.prompts
      cost += d.cost
    }
    return { input, output, total: input + output, sessions, prompts, cost }
  }, [daily])

  // Week-over-week token trend: recent 7 days vs prior 7 days within the loaded 90d window.
  const wowChange = useMemo<number | null>(() => {
    if (!result) return null
    const cutoffRecent = isoDaysAgo(7)
    const cutoffPrev = isoDaysAgo(14)
    let recent = 0, prev = 0
    for (const r of result.rows) {
      const tokens = r.inputTokens + r.outputTokens
      if (r.date >= cutoffRecent) recent += tokens
      else if (r.date >= cutoffPrev) prev += tokens
    }
    if (prev === 0) return null
    return ((recent - prev) / prev) * 100
  }, [result])

  const maxDailyTokens = useMemo(
    () => daily.reduce((m, d) => Math.max(m, d.totalTokens), 1),
    [daily]
  )
  const maxDailySessions = useMemo(
    () => daily.reduce((m, d) => Math.max(m, d.sessions), 1),
    [daily]
  )
  const maxProjectSessions = projects[0]?.sessions ?? 1

  return (
    <div className="border-t border-line">
      <div className="px-6 py-3 border-b border-line bg-bg-elev flex items-center gap-3 text-xs">
        <h2 className="uppercase tracking-wider text-fg">Analytics</h2>
        <span className="text-fg-faint">historical usage across all projects</span>
        <div className="flex-1" />
        <div className="flex items-center border border-line rounded overflow-hidden">
          {([7, 30, 90] as RangeDays[]).map((r) => (
            <button
              key={r}
              onClick={() => persistRange(r)}
              className={`px-3 py-1 ${range === r ? 'bg-bg-hi text-fg' : 'text-fg-faint hover:text-fg'} ${r !== 7 ? 'border-l border-line' : ''}`}
            >
              {r}d
            </button>
          ))}
        </div>
      </div>

      <div className="p-6 space-y-6 max-w-5xl">
        {loading && <EmptyState title="scanning transcripts…" />}
        {error && <EmptyState title="scan failed" hint={error} />}
        {!loading && !error && result && (
          <>
            {result.partial && (
              <div className="text-xs text-yellow-400 border border-yellow-800 bg-yellow-950/30 rounded px-3 py-2">
                Scan took longer than expected — showing partial results.
              </div>
            )}

            {/* Top-line stats */}
            <section className="grid grid-cols-4 gap-3">
              <Stat label={`tokens · ${range}d`} value={formatTokens(totals.total)} />
              <Stat label="sessions" value={totals.sessions.toLocaleString()} />
              <Stat label="prompts" value={totals.prompts.toLocaleString()} />
              <Stat
                label="week-over-week"
                value={
                  wowChange === null
                    ? '—'
                    : `${wowChange >= 0 ? '+' : ''}${wowChange.toFixed(1)}%`
                }
                highlight={wowChange !== null && wowChange !== 0}
              />
            </section>

            {/* Sessions over time */}
            <section className="border border-line rounded bg-bg-elev p-4">
              <div className="flex items-baseline justify-between mb-3">
                <h3 className="text-xs uppercase tracking-wider text-fg">Sessions over time</h3>
                <span className="text-xs text-fg-faint">last {range} days</span>
              </div>
              <div className="flex items-end gap-px h-24">
                {daily.map((d) => {
                  const h = d.sessions > 0 ? Math.max((d.sessions / maxDailySessions) * 100, 4) : 2
                  return (
                    <div
                      key={d.date}
                      className="flex-1 group relative"
                      title={`${d.date} · ${d.sessions} sessions · ${d.prompts} prompts`}
                    >
                      <div
                        className={`w-full rounded-sm ${d.sessions > 0 ? 'bg-accent/70 group-hover:bg-accent' : 'bg-bg-hi'}`}
                        style={{ height: `${(h / 100) * 96}px` }}
                      />
                    </div>
                  )
                })}
              </div>
              <div className="flex justify-between mt-2 text-[10px] text-fg-faint">
                <span>{shortDate(daily[0]?.date ?? '')}</span>
                <span>today</span>
              </div>
            </section>

            {/* Tokens over time — stacked input/output */}
            <section className="border border-line rounded bg-bg-elev p-4">
              <div className="flex items-baseline justify-between mb-3">
                <h3 className="text-xs uppercase tracking-wider text-fg">Tokens over time</h3>
                <div className="flex items-center gap-3 text-[10px] text-fg-faint">
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-cyan-500/70" />input</span>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-purple-500/70" />output</span>
                </div>
              </div>
              <div className="flex items-end gap-px h-32">
                {daily.map((d) => {
                  const inH = (d.inputTokens / maxDailyTokens) * 100
                  const outH = (d.outputTokens / maxDailyTokens) * 100
                  return (
                    <div
                      key={d.date}
                      className="flex-1 flex flex-col justify-end gap-px"
                      title={`${d.date} · in ${formatTokens(d.inputTokens)} · out ${formatTokens(d.outputTokens)} · $${d.cost.toFixed(4)}`}
                    >
                      <div
                        className="w-full bg-purple-500/70 rounded-t-sm"
                        style={{ height: `${outH}%`, minHeight: d.outputTokens > 0 ? 2 : 0 }}
                      />
                      <div
                        className="w-full bg-cyan-500/70 rounded-b-sm"
                        style={{ height: `${inH}%`, minHeight: d.inputTokens > 0 ? 2 : 0 }}
                      />
                    </div>
                  )
                })}
              </div>
              <div className="flex justify-between mt-2 text-[10px] text-fg-faint">
                <span>in {formatTokens(totals.input)}</span>
                <span>out {formatTokens(totals.output)}</span>
                <span>est. cost ${totals.cost.toFixed(2)}</span>
              </div>
            </section>

            {/* By-project session count — top 10 */}
            <section className="border border-line rounded bg-bg-elev p-4">
              <div className="flex items-baseline justify-between mb-3">
                <h3 className="text-xs uppercase tracking-wider text-fg">Top projects by sessions</h3>
                <span className="text-xs text-fg-faint">{projects.length} active</span>
              </div>
              {projects.length === 0 ? (
                <div className="text-xs text-fg-faint">no project activity in this window.</div>
              ) : (
                <div className="space-y-2">
                  {projects.slice(0, 10).map((p) => {
                    const pct = (p.sessions / maxProjectSessions) * 100
                    return (
                      <div key={p.projectCwd} className="flex items-center gap-3 text-xs">
                        <span
                          className="font-mono text-fg-dim truncate w-64"
                          title={p.projectCwd}
                        >
                          {shortProject(p.projectCwd)}
                        </span>
                        <div className="flex-1 h-2 bg-bg-hi rounded-sm overflow-hidden">
                          <div
                            className="h-full bg-accent/70 rounded-sm"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span className="w-16 text-right text-fg-dim tabular-nums">
                          {p.sessions} ses
                        </span>
                        <span className="w-20 text-right text-fg-faint tabular-nums">
                          {formatTokens(p.totalTokens)} tok
                        </span>
                      </div>
                    )
                  })}
                </div>
              )}
            </section>

            <div className="text-xs text-fg-faint space-y-1">
              <p>
                By-model breakdown is not shown here — our history aggregator does not
                track per-event model. See the
                {' '}
                <span className="text-fg-dim">History → Dashboard</span> tab for per-project tables
                and a selectable daily metric.
              </p>
              <p>
                Sessions from today may be excluded by the aggregator until they close.
                Cost estimate uses Sonnet-4.6 flat rate ($3/$15 per MTok).
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function Stat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="border border-line rounded p-3 bg-bg-elev">
      <div className="text-xs text-fg-faint uppercase tracking-wider mb-1">{label}</div>
      <div className={`text-lg font-mono ${highlight ? "text-accent" : "text-fg"}`}>{value}</div>
    </div>
  )
}
