/**
 * AlmanacFooter — paper-warm window footer that replaces StatusBar.
 * One 30px strip: connected dot · 5h window state · prompts/cost · branch · version.
 *
 * Click handlers route through props rather than navigate-directly so the
 * App owns routing — clicking the 5h pill opens Usage, branch opens nothing
 * (informational), connected dot opens Settings.
 */

import { useEffect, useState } from 'react'
import { useSessions } from '../../state/sessions'
import { useLiveTab } from '../../state/live'
import { useBilling, getBillingData } from '../../state/billing'
import type { NavKey } from '../LeftNav'

interface AlmanacFooterProps {
  onNavigate?: (k: NavKey) => void
}

export function AlmanacFooter({ onNavigate }: AlmanacFooterProps) {
  const tabs = useSessions((s) => s.tabs)
  const activeTabId = useSessions((s) => s.activeTabId)
  const tab = tabs.find((t) => t.id === activeTabId) ?? null
  const live = useLiveTab(tab)
  const lastEventAt = live?.lastEventAt ?? 0
  const billing = useBilling((s) => s.data)
  const [branch, setBranch] = useState<string | null>(null)
  // Force re-render every 60s so the "X min ago" + remaining tick.
  const [, tick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 60_000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    let cancelled = false
    if (!tab?.cwd) { setBranch(null); return }
    window.api.app.gitBranch(tab.cwd)
      .then((v) => { if (!cancelled) setBranch(v) })
      .catch(() => { if (!cancelled) setBranch(null) })
    return () => { cancelled = true }
  }, [tab?.cwd])

  const data = getBillingData(billing)
  const fiveHour = data?.usage.five_hour ?? null
  const util = fiveHour ? Math.round(fiveHour.utilization) : null
  const isConnected = billing?.kind === 'ok' || billing?.kind === 'ok-stale'

  const lastTxt = lastEventAt > 0 ? relSeconds(Date.now() - lastEventAt) : '—'

  return (
    <div
      className="h-[30px] shrink-0 bg-bg-elev border-t border-line flex items-center gap-4 px-[18px] font-mono text-[11.5px] text-fg-dim"
      data-testid="tour-statusbar"
    >
      <button
        onClick={() => onNavigate?.('settings')}
        className="flex items-center gap-1.5 hover:text-fg transition-colors"
        title={isConnected ? 'Connected to Anthropic' : 'Disconnected'}
      >
        <span className={`w-1.5 h-1.5 rounded-full ${isConnected ? 'bg-sage' : 'bg-fg-faint'}`} />
        <span>{isConnected ? 'connected' : 'offline'}</span>
      </button>

      <button
        onClick={() => onNavigate?.('usage')}
        className="hover:text-fg transition-colors"
        title="Open Usage"
      >
        {util != null ? `${util}% of 5h window used` : '5h —'}
      </button>

      {tab && (
        <span className="text-fg-faint" title={tab.cwd}>
          {tab.label}
          {branch && <span className="text-fg-dim"> · ⌥{branch}</span>}
        </span>
      )}

      <span className="text-fg-faint">last activity: <span className="text-fg-dim">{lastTxt}</span></span>

      <span className="flex-1" />

      <span className="text-fg-faint">v{__APP_VERSION__}</span>
    </div>
  )
}

function relSeconds(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  return `${h}h ago`
}
