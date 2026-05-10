import type { BillingData, BillingFetchResult, UsageWindow } from '../../../preload/api'

function formatStaleDuration(since: number): string {
  const ms = Date.now() - since
  if (ms < 60_000) return 'just now'
  const m = Math.floor(ms / 60_000)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m ago`
}

function formatResetAt(iso: string | null): string {
  if (!iso) return '—'
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return '—'
  const diffMs = t.getTime() - Date.now()
  if (diffMs <= 0) return 'now'
  const h = Math.floor(diffMs / 3_600_000)
  const m = Math.floor((diffMs % 3_600_000) / 60_000)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

function barColor(utilization: number): string {
  if (utilization >= 90) return 'bg-red-400'
  if (utilization >= 70) return 'bg-yellow-400'
  return 'bg-emerald-400'
}

export function UsageBar({ label, window: w, dimmed }: { label: string; window: UsageWindow | null; dimmed?: boolean }) {
  if (!w) return null
  const pct = Math.max(0, Math.min(100, w.utilization))
  return (
    <div className={`border border-line rounded p-3 bg-bg-elev ${dimmed ? 'opacity-50' : ''}`}>
      <div className="flex items-baseline justify-between mb-2">
        <div className="text-xs text-fg-faint uppercase tracking-wider">{label}</div>
        <div className="text-xs text-fg-dim">resets in {formatResetAt(w.resets_at)}</div>
      </div>
      <div className="flex items-center gap-3">
        <div className="flex-1 h-2 bg-bg rounded overflow-hidden">
          <div className={`h-full ${barColor(w.utilization)}`} style={{ width: `${pct}%` }} />
        </div>
        <div className="text-sm font-mono text-fg tabular-nums w-14 text-right">
          {w.utilization.toFixed(0)}%
        </div>
      </div>
    </div>
  )
}

export function UsageBars({ data, dimmed }: { data: BillingData; dimmed?: boolean }) {
  const { usage, subscriptionType, rateLimitTier } = data
  return (
    <>
      {(subscriptionType || rateLimitTier) && (
        <div className="flex items-baseline gap-2 mb-3">
          {subscriptionType && <span className="text-xs text-fg-dim font-mono">{subscriptionType}</span>}
          {rateLimitTier && <span className="text-xs text-fg-faint font-mono">{rateLimitTier}</span>}
        </div>
      )}
      <div className="grid grid-cols-1 gap-3">
        <UsageBar label="5-hour window" window={usage.five_hour} dimmed={dimmed} />
        <UsageBar label="Weekly window (all)" window={usage.seven_day} dimmed={dimmed} />
        <UsageBar label="Weekly — Sonnet" window={usage.seven_day_sonnet} dimmed={dimmed} />
        <UsageBar label="Weekly — Opus" window={usage.seven_day_opus} dimmed={dimmed} />
      </div>
      {usage.extra_usage?.is_enabled && (
        <div className={`mt-3 border border-line rounded p-3 bg-bg-elev text-xs text-fg-dim ${dimmed ? 'opacity-50' : ''}`}>
          extra usage enabled · used {usage.extra_usage.used_credits ?? 0} /{' '}
          {usage.extra_usage.monthly_limit ?? '—'} {usage.extra_usage.currency ?? ''}
        </div>
      )}
    </>
  )
}

export function StaleChip({ since, error: _error, onRetry }: { since: number; error: string; onRetry: () => void }) {
  return (
    <div className="flex items-center justify-between mb-3 border border-yellow-800/40 rounded px-3 py-1.5 bg-yellow-950/20 text-xs text-yellow-300">
      <span>stale · last updated {formatStaleDuration(since)}</span>
      <button onClick={onRetry} className="ml-3 underline hover:no-underline">Retry</button>
    </div>
  )
}

export function AuthBanner({ message, expiredAt, onRetry }: { message: string; expiredAt?: number | null; onRetry: () => void }) {
  const tokenExpired = expiredAt != null && expiredAt < Date.now()
  const expiredAtStr = expiredAt
    ? new Date(expiredAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
    : null
  const isHttpError = !tokenExpired && /^HTTP \d+/.test(message)
  return (
    <div className="mb-3 border border-red-800/40 rounded px-3 py-2 bg-red-950/20 text-xs text-red-300">
      <div className="font-medium mb-1">
        {tokenExpired ? `Credentials expired at ${expiredAtStr}` : 'Authentication failed'}
        {isHttpError && <span className="font-normal ml-1 text-red-400/70">({message})</span>}
      </div>
      <div className="text-red-400/80">
        Run <code className="font-mono bg-red-950/40 px-1 rounded">claude</code> in a terminal to refresh, then{' '}
        <button onClick={onRetry} className="underline hover:no-underline">Retry</button>.
      </div>
    </div>
  )
}

export function TransientChip() {
  return (
    <div className="border border-yellow-800/40 rounded px-3 py-1.5 bg-yellow-950/20 text-xs text-yellow-300">
      temporary network error — retrying in 5s
    </div>
  )
}

export function ConfigBanner({ message }: { message: string }) {
  const isMissing = message.includes('not found') || message.includes('ENOENT')
  return (
    <div className="border border-line rounded px-3 py-2 bg-bg-elev text-xs text-fg-dim">
      <div className="font-medium mb-1 text-fg">{isMissing ? 'Not signed in' : 'Cannot read credentials'}</div>
      <div className="text-fg-faint">
        {isMissing
          ? <>Run <code className="font-mono bg-bg px-1 rounded">claude login</code> in a terminal tab to sign in.</>
          : <>Cannot read <code className="font-mono bg-bg px-1 rounded">~/.claude/.credentials.json</code> — {message}</>}
      </div>
    </div>
  )
}

/** Renders the appropriate status chip or banner for the current billing result. Returns null for 'ok'. */
export function BillingStatusOverlay({
  result,
  onRetry,
}: {
  result: BillingFetchResult
  onRetry: () => void
}) {
  switch (result.kind) {
    case 'ok':
      return null
    case 'ok-stale':
      return <StaleChip since={result.staleSince} error={result.lastError} onRetry={onRetry} />
    case 'auth':
      return <AuthBanner message={result.message} expiredAt={result.expiredAt} onRetry={onRetry} />
    case 'transient':
      return <TransientChip />
    case 'config':
      return <ConfigBanner message={result.message} />
  }
}
