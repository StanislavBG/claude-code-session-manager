import type { BillingFetchResult } from '../../../preload/api'

function formatStaleDuration(since: number): string {
  const ms = Date.now() - since
  if (ms < 60_000) return 'just now'
  const m = Math.floor(ms / 60_000)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m ago`
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

export function MeterRateLimitedChip({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex items-center justify-between border border-yellow-800/40 rounded px-3 py-1.5 bg-yellow-950/20 text-xs text-yellow-300">
      <span>usage meter is rate-limited — showing last known values</span>
      <button onClick={onRetry} className="ml-3 underline hover:no-underline">Retry</button>
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
    case 'meter_rate_limited':
      return <MeterRateLimitedChip onRetry={onRetry} />
    case 'config':
      return <ConfigBanner message={result.message} />
  }
}
