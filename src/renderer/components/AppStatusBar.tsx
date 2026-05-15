import { useEffect, useMemo, useRef, useState } from 'react'
import type { BillingFetchResult, TeamInfo } from '../../preload/api'
import { useConfig } from '../state/config'
import { useSessions } from '../state/sessions'
import { useVoice } from '../state/voice'
import { useHomeDir } from '../lib/useHomeDir'
import { SETTINGS_SCOPES, type Scope } from '../lib/scopes'
import { mergeScopes, getAtPath } from '../lib/mergeScopes'
import { parseScopedJson } from '../lib/parseScopedJson'
import { StatusDot } from './ui/StatusDot'
import { toast } from '../state/toast'

/**
 * App-level 28px status bar mounted between RecordingStatus and TabBar.
 * Surfaces model / effort / team / voice / 5h-usage as clickable pills.
 *
 * Data sources:
 *   - model & effortLevel: mergeScopes over user/project/local settings.json
 *   - team flag: same merged settings, env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
 *   - active teams: window.api.teams.list() (polled every 30s)
 *   - 5h usage: window.api.billing.fetch() (polled every 60s — billing.cjs
 *     has its own cache, duplicate fetches with Overview are cheap)
 *
 * Click semantics:
 *   - model / effort → navigate to Settings (Guided view is default)
 *   - team → navigate to Overview (TeamsCard lives there)
 *
 * Privacy invariant: this bar is mounted BELOW RecordingStatus in App.tsx, so
 * the recording banner remains the topmost element while isRecording === true.
 */

const SETTINGS_REFRESH_MS = 30_000
const BILLING_REFRESH_MS = 60_000

interface Props {
  onNavigate: (key: 'settings' | 'overview') => void
}

export function AppStatusBar({ onNavigate }: Props) {
  const home = useHomeDir()
  const tabs = useSessions((s) => s.tabs)
  const activeTabId = useSessions((s) => s.activeTabId)
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null
  const cwd = activeTab?.cwd ?? null

  const isRecording = useVoice((s) => s.isRecording)
  const statusPill = useVoice((s) => s.statusPill)

  // Scope paths for settings.json (user / project / local).
  const scopePaths = useMemo(() => {
    if (!home) return {}
    const out: Partial<Record<Scope, string>> = {}
    for (const s of SETTINGS_SCOPES.scopes) {
      const p = SETTINGS_SCOPES.resolve(s, home, cwd)
      if (p) out[s] = p
    }
    return out
  }, [home, cwd])

  const files = useConfig((s) => s.files)
  const loadJson = useConfig((s) => s.loadJson)
  const watchFile = useConfig((s) => s.watchFile)
  const unwatchFile = useConfig((s) => s.unwatchFile)

  // Self-fetch every 30s. Watch each scope path so external edits propagate
  // through the shared useConfig store (Settings.tsx watches the same paths
  // when open — chokidar refcounts make this safe).
  useEffect(() => {
    const paths = Object.values(scopePaths).filter(Boolean) as string[]
    paths.forEach((p) => {
      if (!files[p]) loadJson(p)
      watchFile(p)
    })
    const timer = window.setInterval(() => {
      paths.forEach((p) => loadJson(p))
    }, SETTINGS_REFRESH_MS)
    return () => {
      clearInterval(timer)
      paths.forEach((p) => unwatchFile(p))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(scopePaths)])

  const effective = useMemo(
    () => mergeScopes(parseScopedJson(files, scopePaths)),
    [files, scopePaths]
  )

  const modelName = readLeafString(effective, ['model']) ?? '—'
  const effortLevel = readLeafString(effective, ['effortLevel']) ?? '—'
  const teamsEnabled =
    readLeafString(effective, ['env', 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS']) === '1'

  // Active teams count — even when feature flag is OFF, we report what's
  // present on disk so toggling the flag back ON is obvious.
  const [teams, setTeams] = useState<TeamInfo[]>([])
  useEffect(() => {
    let cancelled = false
    let timer: number | null = null
    const tick = async () => {
      try {
        const r = await window.api.teams.list()
        if (!cancelled) setTeams(r.teams)
      } catch { /* swallow */ }
      timer = window.setTimeout(tick, SETTINGS_REFRESH_MS)
    }
    tick()
    return () => {
      cancelled = true
      if (timer !== null) clearTimeout(timer)
    }
  }, [])

  // Billing usage — 60s tick. billing.cjs caches; duplicate fetches with
  // Overview are cheap and ensure the bar stays live even when Overview
  // isn't mounted. Surface the FIRST failure as a toast so users learn why
  // the 5h pill is missing; subsequent failures stay silent to avoid spam.
  const [billing, setBilling] = useState<BillingFetchResult | null>(null)
  const billingToastedRef = useRef(false)
  useEffect(() => {
    let cancelled = false
    let timer: number | null = null
    const tick = async () => {
      try {
        const r = await window.api.billing.fetch()
        if (!cancelled) setBilling(r)
      } catch (e) {
        if (!billingToastedRef.current) {
          billingToastedRef.current = true
          const msg = e instanceof Error ? e.message : String(e)
          toast.warn(`Billing usage fetch failed: ${msg}`)
        }
      }
      timer = window.setTimeout(tick, BILLING_REFRESH_MS)
    }
    tick()
    return () => {
      cancelled = true
      if (timer !== null) clearTimeout(timer)
    }
  }, [])

  const fivePct = readFiveHourPct(billing)
  const voiceDotKind = isRecording
    ? 'live'
    : statusPill === 'listening'
      ? 'live'
      : 'idle'

  const voiceLabel = `voice ${isRecording ? 'live' : statusPill}`
  return (
    <div
      data-testid="app-status-bar"
      role="toolbar"
      aria-label="Session manager status"
      className="h-7 shrink-0 border-b border-line bg-bg-elev flex items-center gap-2 px-3 text-xs text-fg-dim"
    >
      <Pill
        label="model"
        value={prettyModel(modelName)}
        title={`Current model: ${modelName} — click to edit in Settings`}
        ariaLabel={`Current model: ${modelName}, click to edit in Settings`}
        onClick={() => onNavigate('settings')}
      />
      <Pill
        label="effort"
        value={effortLevel}
        title={`Thinking effort: ${effortLevel} — click to edit in Settings`}
        ariaLabel={`Thinking effort: ${effortLevel}, click to edit in Settings`}
        onClick={() => onNavigate('settings')}
      />
      <Pill
        label="team"
        value={`${teamsEnabled ? 'ON' : 'OFF'} · ${teams.length}`}
        title={
          teamsEnabled
            ? `Agent teams enabled — ${teams.length} configured. Click to view roster.`
            : `Agent teams disabled. Set env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS="1" in settings.`
        }
        ariaLabel={
          teamsEnabled
            ? `Agent teams enabled, ${teams.length} configured. Click to view roster.`
            : 'Agent teams disabled. Click to view roster.'
        }
        onClick={() => onNavigate('overview')}
      />

      <div className="flex-1" />

      <div
        className="flex items-center gap-1.5"
        title={`voice: ${statusPill}`}
        aria-live="polite"
        aria-label={voiceLabel}
      >
        <StatusDot kind={voiceDotKind} aria-label={voiceLabel} />
        <span className="text-fg-faint" aria-hidden="true">voice {isRecording ? 'live' : statusPill}</span>
      </div>

      {fivePct !== null && (
        <div
          className="flex items-center gap-1.5 font-mono tabular-nums"
          title={`5h window: ${fivePct.toFixed(0)}% utilized`}
          aria-label={`5-hour usage ${fivePct.toFixed(0)} percent`}
          role="status"
        >
          <span
            className={`inline-block w-1.5 h-1.5 rounded-full ${fiveHourDotColor(fivePct)}`}
            aria-hidden="true"
          />
          <span className={fiveHourTextColor(fivePct)} aria-hidden="true">5h: {fivePct.toFixed(0)}%</span>
        </div>
      )}
    </div>
  )
}

function Pill({
  label,
  value,
  onClick,
  title,
  ariaLabel,
}: {
  label: string
  value: string
  onClick: () => void
  title: string
  ariaLabel: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={ariaLabel}
      data-pill={label}
      className="flex items-center gap-1 px-2 py-0.5 rounded border border-line/70 hover:border-line hover:bg-bg text-fg-dim hover:text-fg transition-colors"
    >
      <span className="text-fg-faint" aria-hidden="true">{label}:</span>
      <span className="font-mono text-fg" aria-hidden="true">{value}</span>
      <span className="text-fg-faint" aria-hidden="true">▾</span>
    </button>
  )
}

// --- helpers ---

/** Read a leaf string from an EffectiveNode at the given path. */
function readLeafString(
  node: ReturnType<typeof mergeScopes>,
  path: string[]
): string | null {
  const leaf = getAtPath(node, path)
  if (!leaf || leaf.kind !== 'leaf') return null
  return typeof leaf.value === 'string' ? leaf.value : null
}

/** Extract the five-hour utilization percent from a billing result, or null. */
function readFiveHourPct(b: BillingFetchResult | null): number | null {
  if (!b) return null
  if (b.kind === 'ok' || b.kind === 'ok-stale') {
    const u = b.data.usage.five_hour?.utilization
    return typeof u === 'number' ? u : null
  }
  if (b.kind === 'auth' && b.cached) {
    const u = b.cached.usage.five_hour?.utilization
    return typeof u === 'number' ? u : null
  }
  return null
}

/** Matches barColor() thresholds in BillingStatusBanner.tsx (50/70/90). */
function fiveHourDotColor(pct: number): string {
  if (pct >= 90) return 'bg-red-400'
  if (pct >= 70) return 'bg-yellow-400'
  if (pct >= 50) return 'bg-emerald-400'
  return 'bg-fg-faint/50'
}

function fiveHourTextColor(pct: number): string {
  if (pct >= 90) return 'text-red-400'
  if (pct >= 70) return 'text-yellow-400'
  return 'text-fg-dim'
}

/** Compress long model identifiers for pill display. */
function prettyModel(model: string): string {
  if (!model || model === '—') return model
  // claude-opus-4-7[1m] → Opus 4.7 1m. claude-sonnet-4-6-20250514 → Sonnet 4.6.
  const ctx = /\[(\dm)\]/.exec(model)
  const m = /(opus|sonnet|haiku)[-_](\d+)[-_.]?(\d+)?/i.exec(model)
  if (!m) return model
  const fam = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase()
  const ver = m[3] ? `${m[2]}.${m[3]}` : m[2]
  return ctx ? `${fam} ${ver} ${ctx[1]}` : `${fam} ${ver}`
}
