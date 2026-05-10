import { useEffect, useRef, useState } from 'react'
import { Panel } from '../ui/Panel'
import { EmptyState } from '../ui/EmptyState'
import { useHomeDir } from '../../lib/useHomeDir'
import { useSessions } from '../../state/sessions'
import { BillingStatusOverlay, UsageBars } from '../ui/BillingStatusBanner'
import type { BillingFetchResult } from '../../../preload/api'

interface Counts {
  projects: number
  sessions: number
  skills: number
  agents: number
  mcpServers: number
  plugins: number
  settingsExists: boolean
  claudeMdExists: boolean
}

const BILLING_REFRESH_MS = 60_000

export function Overview() {
  const home = useHomeDir()
  const tabs = useSessions((s) => s.tabs)
  const [counts, setCounts] = useState<Counts | null>(null)
  const [billing, setBilling] = useState<BillingFetchResult | null>(null)
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
    if (!home) return
    let cancelled = false
    ;(async () => {
      try {
        const [projects, skills, agents, plugins, settingsExists, claudeMdExists, claudeJson] =
          await Promise.all([
            window.api.config.listDir(`${home}/.claude/projects`, { dirsOnly: true }),
            window.api.config.listDir(`${home}/.claude/skills`, { dirsOnly: true }),
            window.api.config.listDir(`${home}/.claude/agents`, { filesOnly: true }),
            window.api.config.listDir(`${home}/.claude/plugins`, { dirsOnly: true }),
            window.api.config.exists(`${home}/.claude/settings.json`),
            window.api.config.exists(`${home}/.claude/CLAUDE.md`),
            window.api.config.readJson(`${home}/.claude.json`),
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
        if (!cancelled) {
          setCounts({
            projects: projects.entries.length,
            sessions: sessionCount,
            skills: skills.entries.length,
            agents: agents.entries.filter((f) => f.name.endsWith('.md')).length,
            mcpServers,
            plugins: plugins.entries.length,
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
    >
      <div className="p-6 max-w-4xl space-y-6">
        <BillingSection billing={billing} onRetry={tickRef.current} />
        {!counts ? (
          <EmptyState title="scanning ~/.claude…" />
        ) : (
          <>
          <section>
            <h3 className="text-xs uppercase tracking-wider text-fg mb-3">User Configuration</h3>
            <div className="grid grid-cols-2 gap-3">
              <Card
                label="settings.json"
                value={counts.settingsExists ? 'exists' : 'not created'}
                dim={!counts.settingsExists}
              />
              <Card
                label="CLAUDE.md"
                value={counts.claudeMdExists ? 'exists' : 'not created'}
                dim={!counts.claudeMdExists}
              />
              <Card label="skills" value={counts.skills.toString()} />
              <Card label="subagents" value={counts.agents.toString()} />
              <Card label="MCP servers" value={counts.mcpServers.toString()} />
              <Card label="plugins" value={counts.plugins.toString()} />
            </div>
          </section>
          <section>
            <h3 className="text-xs uppercase tracking-wider text-fg mb-3">Session History</h3>
            <div className="grid grid-cols-2 gap-3">
              <Card label="projects with history" value={counts.projects.toString()} />
              <Card label="total transcripts" value={counts.sessions.toString()} />
            </div>
          </section>
          </>
        )}
      </div>
    </Panel>
  )
}

function Card({ label, value, dim }: { label: string; value: string; dim?: boolean }) {
  return (
    <div className="border border-line rounded p-3 bg-bg-elev">
      <div className="text-xs text-fg-faint uppercase tracking-wider mb-1">{label}</div>
      <div className={`text-base font-mono ${dim ? 'text-fg-faint' : 'text-fg'}`}>{value}</div>
    </div>
  )
}

function BillingSection({ billing, onRetry }: { billing: BillingFetchResult | null; onRetry: () => void }) {
  if (!billing) {
    return (
      <section>
        <h3 className="text-xs uppercase tracking-wider text-fg mb-3">Plan &amp; Usage</h3>
        <div className="text-xs text-fg-faint">loading usage…</div>
      </section>
    )
  }

  return (
    <section>
      <h3 className="text-xs uppercase tracking-wider text-fg mb-3">Plan &amp; Usage</h3>
      <BillingStatusOverlay result={billing} onRetry={onRetry} />
      {(billing.kind === 'ok' || billing.kind === 'ok-stale') && (
        <UsageBars data={billing.data} />
      )}
      {billing.kind === 'auth' && billing.cached && (
        <UsageBars data={billing.cached} dimmed />
      )}
      {(billing.kind === 'transient' || billing.kind === 'config') && !('cached' in billing && billing.cached) && null}
    </section>
  )
}
