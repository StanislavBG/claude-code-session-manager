import { useEffect, useMemo, useRef, useState } from 'react'
import { Panel } from '../ui/Panel'
import { EmptyState } from '../ui/EmptyState'
import { InstrumentTile } from '../ui/InstrumentTile'
import { StatusDot } from '../ui/StatusDot'
import { TeamsCard } from '../ui/TeamsCard'
import { UsageDial } from '../ui/UsageDial'
import { useHomeDir } from '../../lib/useHomeDir'
import { checkForUpdate, type UpdateCheckResult } from '../../lib/updateCheck'
import { useSessions } from '../../state/sessions'
import { useLive } from '../../state/live'
import { BillingStatusOverlay } from '../ui/BillingStatusBanner'
import type {
  BillingFetchResult,
  ScheduleStateSnapshot,
  UsageWindow,
} from '../../../preload/api'
import type { NavKey } from '../LeftNav'

interface Counts {
  projects: number
  sessions: number
  skills: number
  agents: number
  mcpServers: number
  plugins: number
  hooks: number
  permsAllow: number
  permsDeny: number
  settingsExists: boolean
  claudeMdExists: boolean
}

const BILLING_REFRESH_MS = 60_000
const HEARTBEAT_REFRESH_MS = 10_000

// User has CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 per synthesis; Bundle B
// replaces TeamsCard + drives this from settings.
const teamsEnabled = true

interface OverviewProps {
  onNavigate?: (k: NavKey) => void
}

export function Overview({ onNavigate }: OverviewProps) {
  const home = useHomeDir()
  const tabs = useSessions((s) => s.tabs)
  const liveTabs = useLive((s) => s.tabs)
  const [counts, setCounts] = useState<Counts | null>(null)
  const [billing, setBilling] = useState<BillingFetchResult | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [schedSnap, setSchedSnap] = useState<ScheduleStateSnapshot | null>(null)
  const [lastPollAt, setLastPollAt] = useState<number | null>(null)
  const [nowTick, setNowTick] = useState<number>(() => Date.now())
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResult | null>(null)
  const lastKindRef = useRef<string | null>(null)
  const tickRef = useRef<() => void>(() => {})

  useEffect(() => {
    let cancelled = false
    let timer: number | null = null
    const tick = async () => {
      if (timer !== null) { clearTimeout(timer); timer = null }
      setRefreshing(true)
      const r = await window.api.billing.fetch()
      if (cancelled) return
      setBilling(r)
      setRefreshing(false)
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
    return () => { cancelled = true; if (timer !== null) clearTimeout(timer) }
  }, [])

  useEffect(() => {
    let cancelled = false
    let offState: (() => void) | null = null
    ;(async () => {
      try {
        const snap = await window.api.schedule.state()
        if (cancelled) return
        setSchedSnap(snap)
      } catch (e) {
        console.warn('[Overview] schedule.state failed:', e)
      }
      offState = window.api.schedule.onState((s) => {
        if (!cancelled) setSchedSnap(s)
      })
    })()
    return () => {
      cancelled = true
      if (offState) offState()
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      try {
        const h = await window.api.schedule.health()
        if (!cancelled) setLastPollAt(h.lastPollAt)
      } catch { /* swallow — best effort freshness widget */ }
    }
    poll()
    const id = window.setInterval(poll, HEARTBEAT_REFRESH_MS)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  useEffect(() => {
    const id = window.setInterval(() => setNowTick(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  // One-shot npm registry check on mount. localStorage cache (in updateCheck.ts)
  // prevents repeated network hits if the user navigates back into Overview today.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const result = await checkForUpdate(__APP_VERSION__)
      if (!cancelled && result) setUpdateInfo(result)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!home) return
    let cancelled = false
    ;(async () => {
      try {
        const [
          projects,
          skills,
          agents,
          plugins,
          settingsExists,
          claudeMdExists,
          claudeJson,
          settingsJson,
        ] = await Promise.all([
          window.api.config.listDir(`${home}/.claude/projects`, { dirsOnly: true }),
          window.api.config.listDir(`${home}/.claude/skills`, { dirsOnly: true }),
          window.api.config.listDir(`${home}/.claude/agents`, { filesOnly: true }),
          window.api.config.listDir(`${home}/.claude/plugins`, { dirsOnly: true }),
          window.api.config.exists(`${home}/.claude/settings.json`),
          window.api.config.exists(`${home}/.claude/CLAUDE.md`),
          window.api.config.readJson(`${home}/.claude.json`),
          window.api.config.readJson(`${home}/.claude/settings.json`),
        ])
        let sessionCount = 0
        for (const p of projects.entries) {
          if (cancelled) return
          const files = await window.api.config.listDir(p.path, { filesOnly: true })
          sessionCount += files.entries.filter((f) => f.name.endsWith('.jsonl')).length
        }
        const mcpServers =
          claudeJson.data && typeof claudeJson.data === 'object' && 'mcpServers' in claudeJson.data
            ? Object.keys((claudeJson.data as { mcpServers: object }).mcpServers ?? {}).length
            : 0

        let hooks = 0
        let permsAllow = 0
        let permsDeny = 0
        const sData = settingsJson.data
        if (sData && typeof sData === 'object') {
          const hooksObj = (sData as { hooks?: Record<string, unknown[]> }).hooks
          if (hooksObj && typeof hooksObj === 'object') {
            for (const arr of Object.values(hooksObj)) {
              if (Array.isArray(arr)) hooks += arr.length
            }
          }
          const perms = (sData as { permissions?: { allow?: unknown[]; deny?: unknown[] } }).permissions
          if (perms && typeof perms === 'object') {
            permsAllow = Array.isArray(perms.allow) ? perms.allow.length : 0
            permsDeny = Array.isArray(perms.deny) ? perms.deny.length : 0
          }
        }

        if (!cancelled) {
          setCounts({
            projects: projects.entries.length,
            sessions: sessionCount,
            skills: skills.entries.length,
            agents: agents.entries.filter((f) => f.name.endsWith('.md')).length,
            mcpServers,
            plugins: plugins.entries.length,
            hooks,
            permsAllow,
            permsDeny,
            settingsExists,
            claudeMdExists,
          })
        }
      } catch (e) {
        console.error('[Overview] scan failed:', e)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [home])

  const liveAggregates = useMemo(() => {
    let todos = 0
    let plans = 0
    let agents = 0
    for (const lt of Object.values(liveTabs)) {
      todos += lt.todos.filter((t) => t.status !== 'completed').length
      plans += lt.plans.length
      agents += lt.agents.length
    }
    return { todos, plans, agents }
  }, [liveTabs])

  const schedulerCounts = useMemo(() => {
    if (!schedSnap) return { running: 0, pending: 0, paused: false }
    let running = 0
    let pending = 0
    for (const j of schedSnap.jobs) {
      if (j.status === 'running') running++
      else if (j.status === 'pending') pending++
    }
    return { running, pending, paused: !!schedSnap.paused }
  }, [schedSnap])

  if (!home) return <EmptyState title="loading…" />

  return (
    <Panel
      toolbar={
        <>
          <span className="text-fg-faint">home</span>
          <span className="ml-2 text-fg-dim font-mono truncate">{home}</span>
          <div className="flex-1" />
          <span className="text-fg-faint">{tabs.length} open tabs</span>
        </>
      }
      footer={<QuickActions onNavigate={onNavigate} />}
    >
      <div className="p-6 max-w-5xl space-y-5">
        <CockpitStrip
          billing={billing}
          onRetry={tickRef.current}
          refreshing={refreshing}
          tabCount={tabs.length}
          updateInfo={updateInfo}
        />

        {!counts ? (
          <EmptyState title="scanning ~/.claude…" />
        ) : (
          <>
            <InstrumentGrid
              counts={counts}
              live={liveAggregates}
              scheduler={schedulerCounts}
              onNavigate={onNavigate}
            />

            {teamsEnabled && <TeamsCard />}

            <SystemRow
              counts={counts}
              supervisorOn={!!schedSnap?.config?.supervisor?.enabled}
              lastPollAt={lastPollAt}
              now={nowTick}
            />
          </>
        )}
      </div>
    </Panel>
  )
}

/* ---------------------------------------------------------- Cockpit strip */

function CockpitStrip({
  billing,
  onRetry,
  refreshing,
  tabCount,
  updateInfo,
}: {
  billing: BillingFetchResult | null
  onRetry: () => void
  refreshing: boolean
  tabCount: number
  updateInfo: UpdateCheckResult | null
}) {
  const hasUsage = billing && (billing.kind === 'ok' || billing.kind === 'ok-stale')
  const data = hasUsage ? billing.data : null
  const fiveHour = data?.usage.five_hour ?? null
  const sonnet = data?.usage.seven_day_sonnet ?? null
  const opus = data?.usage.seven_day_opus ?? null
  const showDial = !!fiveHour && fiveHour.utilization >= 50

  return (
    <section className="border border-line rounded bg-bg-elev p-4">
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <StatusDot kind="live" className="animate-pulse" />
        <span className="text-sm text-fg">Session Manager</span>
        <span className="text-xs text-fg-dim font-mono">v{__APP_VERSION__}</span>
        {updateInfo?.isNewer && (
          <button
            type="button"
            onClick={() => window.open('https://www.npmjs.com/package/claude-code-session-manager', '_blank')}
            title={`Update available: v${updateInfo.latest} on npm`}
            className="text-xs text-accent hover:underline font-mono"
          >
            ↑ v{updateInfo.latest}
          </button>
        )}
        <span className="text-fg-faint">·</span>
        <span className="text-xs text-fg-dim">{tabCount} open {tabCount === 1 ? 'tab' : 'tabs'}</span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onRetry}
          disabled={refreshing}
          className="text-xs text-fg-dim hover:text-fg border border-line rounded px-2 py-0.5 disabled:opacity-50"
        >
          {refreshing ? 'refreshing…' : 'refresh'}
        </button>
      </div>

      {billing && billing.kind !== 'ok' && (
        <div className="mb-3">
          <BillingStatusOverlay result={billing} onRetry={onRetry} />
        </div>
      )}

      {!billing && <div className="text-xs text-fg-faint">loading usage…</div>}

      {hasUsage && (
        <div className="space-y-2">
          {showDial ? (
            <UsageDial label="5-hour window" window={fiveHour} />
          ) : (
            <CompactBar label="5h" window={fiveHour} />
          )}
          <div className="grid grid-cols-2 gap-2">
            <CompactBar label="7d · Sonnet" window={sonnet} />
            <CompactBar label="7d · Opus" window={opus} />
          </div>
        </div>
      )}
    </section>
  )
}

function compactBarColor(util: number): string {
  if (util >= 90) return 'bg-red-400'
  if (util >= 70) return 'bg-yellow-400'
  return 'bg-emerald-400'
}

function CompactBar({ label, window: w }: { label: string; window: UsageWindow | null }) {
  if (!w) {
    return (
      <div className="flex items-center gap-2 text-xs">
        <span className="text-fg-faint w-16 shrink-0">{label}</span>
        <span className="text-fg-faint">—</span>
      </div>
    )
  }
  const pct = Math.max(0, Math.min(100, w.utilization))
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-fg-faint w-16 shrink-0">{label}</span>
      <div className="flex-1 h-1.5 bg-bg rounded overflow-hidden">
        <div className={`h-full ${compactBarColor(pct)}`} style={{ width: `${pct}%`, transition: 'width 600ms ease-out' }} />
      </div>
      <span className="text-fg font-mono tabular-nums w-10 text-right">{pct.toFixed(0)}%</span>
    </div>
  )
}

/* -------------------------------------------------------- Instrument grid */

function InstrumentGrid({
  counts,
  live,
  scheduler,
  onNavigate,
}: {
  counts: Counts
  live: { todos: number; plans: number; agents: number }
  scheduler: { running: number; pending: number; paused: boolean }
  onNavigate?: (k: NavKey) => void
}) {
  const schedValue =
    scheduler.running + scheduler.pending === 0 && !scheduler.paused
      ? 'idle'
      : `${scheduler.running}↻ ${scheduler.pending}⏳`
  const schedSub = scheduler.paused
    ? 'paused'
    : scheduler.running > 0
    ? `${scheduler.running} running`
    : scheduler.pending > 0
    ? `${scheduler.pending} pending`
    : 'no work queued'

  const tiles: {
    label: string
    value: string | number
    subFact?: string
    linkTo?: NavKey
    attention?: boolean
  }[] = [
    {
      label: 'Sessions',
      value: counts.sessions,
      subFact: `${counts.projects} projects`,
      linkTo: 'projects',
    },
    {
      label: 'Skills',
      value: counts.skills,
      subFact: counts.skills === 0 ? 'none yet' : 'available',
      linkTo: 'skills',
    },
    {
      label: 'Subagents',
      value: counts.agents,
      subFact: live.agents > 0 ? `${live.agents} spawned live` : 'configured',
      linkTo: 'subagents',
    },
    {
      label: 'MCP servers',
      value: counts.mcpServers,
      subFact: counts.mcpServers === 0 ? 'none configured' : 'configured',
      linkTo: 'mcp',
    },
    {
      label: 'Plugins',
      value: counts.plugins,
      subFact: counts.plugins === 0 ? 'none installed' : 'installed',
      linkTo: 'plugins',
    },
    {
      label: 'Hooks',
      value: counts.hooks,
      subFact: counts.hooks === 0 ? 'no hooks set' : 'configured',
      linkTo: 'hooks',
    },
    {
      label: 'Tasks',
      value: live.todos,
      subFact: live.todos === 0 ? 'all clear' : 'in flight',
      linkTo: 'tasks',
    },
    {
      label: 'Plans',
      value: live.plans,
      subFact: live.plans === 0 ? 'no plans' : 'revisions tracked',
      linkTo: 'plans',
    },
    {
      label: 'Scheduler',
      value: schedValue,
      subFact: schedSub,
      attention: scheduler.paused,
    },
    {
      label: 'History',
      value: counts.projects,
      subFact: `${counts.sessions} transcripts`,
      linkTo: 'history',
    },
  ]

  return (
    <section>
      <h3 className="text-xs uppercase tracking-wider text-fg mb-3">Instrument Cluster</h3>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {tiles.map((t) => (
          <InstrumentTile
            key={t.label}
            label={t.label}
            value={t.value}
            subFact={t.subFact}
            linkTo={t.linkTo}
            attention={t.attention}
            onNavigate={onNavigate}
          />
        ))}
      </div>
    </section>
  )
}

/* -------------------------------------------------------------- System row */

function formatAgoSec(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  return `${h}h ago`
}

function SystemRow({
  counts,
  supervisorOn,
  lastPollAt,
  now,
}: {
  counts: Counts
  supervisorOn: boolean
  lastPollAt: number | null
  now: number
}) {
  const heartbeatLabel = lastPollAt ? `scheduler last tick ${formatAgoSec(now - lastPollAt)}` : 'scheduler idle'
  return (
    <section className="border border-line rounded p-3 bg-bg-elev/40">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-fg-dim">
        <span className="flex items-center gap-1.5">
          <StatusDot kind={counts.settingsExists ? 'on' : 'off'} />
          <span className="font-mono">settings.json</span>
        </span>
        <span className="flex items-center gap-1.5">
          <StatusDot kind={counts.claudeMdExists ? 'on' : 'off'} />
          <span className="font-mono">CLAUDE.md</span>
        </span>
        <span>
          permissions: <span className="text-fg font-mono">{counts.permsAllow}/{counts.permsDeny}</span>
        </span>
        <span>
          supervisor: <span className={`font-mono ${supervisorOn ? 'text-fg' : 'text-fg-faint'}`}>{supervisorOn ? 'ON' : 'OFF'}</span>
        </span>
        <span className="text-fg-faint">{heartbeatLabel}</span>
      </div>
    </section>
  )
}

/* ---------------------------------------------------------- Quick actions */

function QuickActions({ onNavigate }: { onNavigate?: (k: NavKey) => void }) {
  const handleNewSession = async () => {
    try {
      const cwd = await window.api.app.pickDirectory()
      if (!cwd) return
      const id = crypto.randomUUID()
      // Mirrors App.tsx's createPickedSession to keep the same preset + flags.
      const { addTab } = (await import('../../state/sessions')).useSessions.getState()
      addTab({
        id,
        cwd,
        startupCommand: `claude --dangerously-skip-permissions --session-id '${id}'`,
        presetId: 'pick-dangerous',
      })
    } catch (e) {
      console.error('[Overview] new session failed:', e)
    }
  }

  const buttons: { label: string; onClick: () => void; title?: string }[] = [
    { label: '+ new session', onClick: handleNewSession },
    {
      label: 'Open Scheduler',
      onClick: () => { /* Scheduler is a left-nav section, not a tab — left as no-op */ },
      title: 'Scheduler lives in the left nav (no separate tab)',
    },
    {
      label: 'Open Settings',
      onClick: () => onNavigate?.('settings'),
      title: onNavigate ? undefined : 'opens in N/A — wire MainPane.tsx',
    },
    {
      label: 'Run a Skill',
      onClick: () => onNavigate?.('skills'),
      title: onNavigate ? undefined : 'opens in N/A — wire MainPane.tsx',
    },
  ]

  return (
    <div className="flex items-center gap-2 px-3 py-2 text-xs">
      {buttons.map((b) => (
        <button
          key={b.label}
          type="button"
          onClick={b.onClick}
          title={b.title}
          className="px-2.5 py-1 border border-line rounded text-fg-dim hover:text-fg hover:border-fg-faint transition-colors"
        >
          {b.label}
        </button>
      ))}
    </div>
  )
}
