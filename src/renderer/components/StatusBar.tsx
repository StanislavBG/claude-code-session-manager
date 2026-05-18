import { useEffect, useState } from 'react'
import { useSessions } from '../state/sessions'
import { useLive } from '../state/live'
import { findPreset } from '../lib/presets'
import type { BillingFetchResult } from '../../preload/api'

const BILLING_TTL_MS = 60_000
const GIT_TTL_MS = 30_000
const TICK_MS = 1_000

const billingCache: { value: BillingFetchResult | null; ts: number } = { value: null, ts: 0 }
const gitCache = new Map<string, { value: string | null; ts: number }>()

function formatCountdown(iso: string | null): string {
  if (!iso) return '—'
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return '—'
  const diff = t - Date.now()
  if (diff <= 0) return '0m'
  const h = Math.floor(diff / 3_600_000)
  const m = Math.floor((diff % 3_600_000) / 60_000)
  return `${h}h ${m}m`
}

export function StatusBar() {
  const tabs = useSessions((s) => s.tabs)
  const activeTabId = useSessions((s) => s.activeTabId)
  const tab = tabs.find((t) => t.id === activeTabId) ?? null
  const lastEventAt = useLive((s) => (activeTabId ? s.tabs[activeTabId]?.lastEventAt ?? 0 : 0))

  const [model, setModel] = useState<string | null>(null)
  const [billing, setBilling] = useState<BillingFetchResult | null>(billingCache.value)
  const [branch, setBranch] = useState<string | null>(null)
  // Force a re-render every TICK_MS so the `last:` and `reset:` fields tick
  // without rebuilding any IPC. Value is unused — only the state change matters.
  const [, setTick] = useState(0)

  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), TICK_MS)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    let cancelled = false
    const presetId = tab?.presetId ?? null
    if (!presetId) { setModel(null); return }
    findPreset(presetId)
      .then((p) => { if (!cancelled) setModel(p?.model ?? null) })
      .catch(() => { if (!cancelled) setModel(null) })
    return () => { cancelled = true }
  }, [tab?.presetId])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const now = Date.now()
      if (billingCache.value && now - billingCache.ts < BILLING_TTL_MS) {
        if (!cancelled) setBilling(billingCache.value)
        return
      }
      try {
        const r = await window.api.billing.fetch()
        if (cancelled) return
        billingCache.value = r
        billingCache.ts = Date.now()
        setBilling(r)
      } catch {
        if (cancelled) return
        billingCache.value = null
        billingCache.ts = Date.now()
        setBilling(null)
      }
    }
    load()
    const id = window.setInterval(load, BILLING_TTL_MS)
    return () => { cancelled = true; window.clearInterval(id) }
  }, [])

  const cwd = tab?.cwd ?? null
  useEffect(() => {
    let cancelled = false
    if (!cwd) { setBranch(null); return }
    const load = async () => {
      const now = Date.now()
      const hit = gitCache.get(cwd)
      if (hit && now - hit.ts < GIT_TTL_MS) {
        if (!cancelled) setBranch(hit.value)
        return
      }
      try {
        const v = await window.api.app.gitBranch(cwd)
        if (cancelled) return
        gitCache.set(cwd, { value: v, ts: Date.now() })
        setBranch(v)
      } catch {
        if (cancelled) return
        gitCache.set(cwd, { value: null, ts: Date.now() })
        setBranch(null)
      }
    }
    load()
    const id = window.setInterval(load, GIT_TTL_MS)
    return () => { cancelled = true; window.clearInterval(id) }
  }, [cwd])

  if (!tab) {
    return (
      <div className="h-6 bg-bg-elev border-t border-line flex items-center px-3 gap-4 text-xs text-fg-faint shrink-0" />
    )
  }

  const billingData = billing?.kind === 'ok' || billing?.kind === 'ok-stale' ? billing.data
    : billing?.kind === 'auth' && billing.cached ? billing.cached : null
  const fiveHour = billingData?.usage.five_hour ?? null
  const utilTxt = fiveHour ? `${Math.round(fiveHour.utilization)}%` : '—'
  const resetTxt = fiveHour ? formatCountdown(fiveHour.resets_at) : '—'
  const modelTxt = model ?? '—'
  const branchTxt = branch ?? '—'
  const lastTxt = lastEventAt > 0
    ? `${Math.max(0, Math.floor((Date.now() - lastEventAt) / 1000))}s`
    : '—'

  return (
    <div className="h-6 bg-bg-elev border-t border-line flex items-center px-3 gap-3 text-xs shrink-0 overflow-x-auto">
      <div className="font-mono text-fg-dim flex items-center gap-1 whitespace-nowrap tabular-nums">
        <Field label="model" value={modelTxt} />
        <Sep />
        <Field label="5h" value={utilTxt} />
        <Sep />
        <Field label="reset" value={resetTxt} />
        <Sep />
        <Field label="branch" value={branchTxt} />
        <Sep />
        <Field label="last" value={lastTxt} />
      </div>
      <div className="flex-1" />
      <span className="truncate max-w-md text-fg-faint">
        cwd: <span className="text-fg-dim font-mono">{tab.cwd}</span>
      </span>
    </div>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <span>
      <span className="text-fg-faint">{label}:</span>
      <span className="text-fg-dim">{value}</span>
    </span>
  )
}

function Sep() {
  return <span className="text-fg-faint">·</span>
}
