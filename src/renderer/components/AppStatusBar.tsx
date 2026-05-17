import { useEffect, useMemo, useState } from 'react'
import type { BillingFetchResult } from '../../preload/api'
import { useConfig } from '../state/config'
import { useSessions } from '../state/sessions'
import { useVoice } from '../state/voice'
import { useBilling } from '../state/billing'
import { useTeams } from '../state/teams'
import { useHomeDir } from '../lib/useHomeDir'
import { SETTINGS_SCOPES, type Scope } from '../lib/scopes'
import { mergeScopes, getAtPath } from '../lib/mergeScopes'
import { parseScopedJson } from '../lib/parseScopedJson'
import { StatusDot } from './ui/StatusDot'
import { prettyModel } from '../lib/prettyModel'

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

  // Active teams + billing data are owned by the singleton pollers in
  // state/billing.ts and state/teams.ts (started once in App.tsx).
  const teams = useTeams((s) => s.teams)
  const billing = useBilling((s) => s.data)

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

