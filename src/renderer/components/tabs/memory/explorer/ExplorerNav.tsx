import { memo, useEffect, useRef, useState } from 'react'
import { Z } from '../../../../lib/zLayers'
import type { MemoryAgent, MemoryIndexHealth } from '../../../../../preload/api'
import type { ClusterInfo, ExplorerScope, ExplorerView } from './model'

interface Props {
  scope: ExplorerScope
  agents: MemoryAgent[]
  agentCounts: Record<string, number>
  workspaceName: string
  workspacePath: string
  workspaceCount: number
  onScope: (s: ExplorerScope) => void
  view: ExplorerView
  onView: (v: ExplorerView) => void
  counts: { all: number; stale: number; broken: number; recent: number; unindexed: number }
  clusters: ClusterInfo[]
  clusterCounts: Record<string, number>
  unclusteredCount: number
  archivedCount: number
  index?: MemoryIndexHealth
}

const SCOPE_NOTE: Record<'user' | 'project' | 'local', string> = {
  user: 'user — all projects',
  project: 'project — shared via git',
  local: 'local — this machine only',
}

const LABEL = 'text-[10px] tracking-[.08em] font-semibold text-fg-faint'
const ROW = 'flex items-center gap-2 h-7 px-2.5 rounded-[5px] text-[13px] cursor-pointer hover:bg-bg-muteband text-left w-full'

function agentCount(a: MemoryAgent, counts: Record<string, number>): string {
  return a.memoryScope === null ? 'off' : String(counts[a.name] ?? 0)
}

interface RowProps {
  id: string
  label: string
  count?: number
  dot: string
  active: boolean
  mono?: boolean
  onClick: () => void
  check?: boolean
}

function NavRow({ id, label, count, dot, active, mono, onClick, check }: RowProps) {
  return (
    <button
      type="button"
      data-testid={`mx-nav-${id}`}
      onClick={onClick}
      className={`${ROW} ${active ? 'bg-bg font-semibold text-fg' : 'text-fg-dim'}`}
    >
      {dot && <span className={`w-[7px] h-[7px] rounded-sm shrink-0 ${dot}`} />}
      <span className={`flex-1 min-w-0 truncate ${mono ? 'font-mono text-xs' : ''}`}>{label}</span>
      {count !== undefined && (
        <span className={`font-mono text-[11px] ${check && count === 0 ? 'text-sage-dark' : 'text-fg-faint'}`}>
          {check && count === 0 ? '✓' : count}
        </span>
      )}
    </button>
  )
}

function Meter({ label, value, max, tone }: { label: string; value: number; max: number; tone: string }) {
  const pct = Math.min(100, Math.round((value / Math.max(1, max)) * 100))
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-mono text-[10px] text-fg-faint">{label} {value}/{max}</span>
      <div className="h-1 rounded-full bg-bg-muteband overflow-hidden">
        <div className={`h-full ${tone}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

export const ExplorerNav = memo(function ExplorerNav(p: Props) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const isAgent = p.scope.kind === 'agent'

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [open])

  const pick = (s: ExplorerScope) => { setOpen(false); p.onScope(s) }
  const row = (id: ExplorerView, label: string, dot: string, count?: number, check?: boolean) => (
    <NavRow id={id} label={label} dot={dot} count={count} check={check} active={p.view === id} onClick={() => p.onView(id)} />
  )

  const agent = p.scope.kind === 'agent' ? p.scope.agent : null
  const tone = p.index?.overBudget ? 'bg-accent' : p.index?.nearBudget ? 'bg-honey' : 'bg-sage-dark'

  return (
    <nav data-testid="mx-nav" className="w-[232px] shrink-0 flex flex-col gap-4 bg-bg-elev border-r border-rule-structural px-2.5 py-3.5 overflow-y-auto">
      <div ref={wrap} className="relative">
        <button
          type="button"
          data-testid="mx-scope-card"
          onClick={() => setOpen((o) => !o)}
          className="w-full flex flex-col gap-0.5 px-2.5 py-2 border border-rule-structural rounded-md bg-bg cursor-pointer text-left hover:border-fg-faint"
        >
          <span className={LABEL}>{agent ? 'SUBAGENT' : 'WORKSPACE'}</span>
          <span className="flex items-center gap-1.5">
            <span className="font-mono text-xs text-fg flex-1 min-w-0 truncate">{agent ? agent.name : p.workspaceName}</span>
            <span className="text-[10px] text-fg-faint">▾</span>
          </span>
          <span className="font-mono text-[10px] text-fg-faint truncate">{agent ? agent.agentFile : p.workspacePath}</span>
          {agent && agent.memoryScope && (
            <span className="text-[10.5px] text-fg-faint">{SCOPE_NOTE[agent.memoryScope]}</span>
          )}
        </button>
        {open && (
          <div
            data-testid="mx-scope-menu"
            className={`absolute left-0 right-0 top-full mt-1 ${Z.dialog} bg-bg-hi border border-rule-structural rounded-[7px] shadow-lg p-1 flex flex-col`}
          >
            <button
              type="button"
              onClick={() => pick({ kind: 'workspace' })}
              className="flex items-center gap-2 px-2 py-1.5 rounded-[5px] text-left hover:bg-bg-elev"
            >
              <span className="w-3 text-[11px] text-sage-dark">{!agent ? '✓' : ''}</span>
              <span className="flex flex-col flex-1 min-w-0">
                <span className="font-mono text-xs text-fg truncate">{p.workspaceName}</span>
                <span className="text-[10.5px] text-fg-faint">workspace</span>
              </span>
              <span className="font-mono text-[11px] text-fg-faint">{p.workspaceCount}</span>
            </button>
            {p.agents.map((a) => (
              <button
                key={a.name}
                type="button"
                onClick={() => pick({ kind: 'agent', agent: a })}
                className="flex items-center gap-2 px-2 py-1.5 rounded-[5px] text-left hover:bg-bg-elev"
              >
                <span className="w-3 text-[11px] text-sage-dark">{agent?.name === a.name ? '✓' : ''}</span>
                <span className="flex flex-col flex-1 min-w-0">
                  <span className="font-mono text-xs text-fg truncate">{a.name}</span>
                  <span className="text-[10.5px] text-fg-faint">subagent{a.memoryScope ? ` · ${a.memoryScope}` : ''}</span>
                </span>
                <span className="font-mono text-[11px] text-fg-faint">{agentCount(a, p.agentCounts)}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-px">
        <div className={`px-2.5 pb-1.5 ${LABEL}`}>BROWSE</div>
        {row('all', 'All memories', 'bg-fg-dim', p.counts.all)}
        {row('ask', 'Ask', 'bg-accent')}
        {row('clusters', 'Clusters', 'bg-sage-dark', p.clusters.length)}
      </div>

      <div className="flex flex-col gap-px">
        <div className={`px-2.5 pb-1.5 ${LABEL}`}>REVIEW</div>
        {row('stale', 'Stale', 'bg-honey', p.counts.stale, true)}
        {row('broken', 'Broken references', 'bg-accent', p.counts.broken, true)}
        {row('recent', 'Changed this week', 'bg-sage-dark', p.counts.recent)}
        {row('unindexed', 'Not in index', 'bg-fg-faint', p.counts.unindexed, true)}
        {p.archivedCount > 0 && row('archived', 'Archived', 'bg-fg-faint', p.archivedCount)}
      </div>

      {!isAgent && (
        <div className="flex flex-col gap-px">
          <div className={`px-2.5 pb-1.5 ${LABEL}`}>CLUSTERS</div>
          {p.clusters.map((c) => (
            <NavRow
              key={c.id}
              id={`cluster:${c.id}`}
              label={c.name}
              dot={c.dotClass}
              count={p.clusterCounts[c.id] ?? 0}
              active={p.view === `cluster:${c.id}`}
              onClick={() => p.onView(`cluster:${c.id}`)}
            />
          ))}
          {p.unclusteredCount > 0 && (
            <NavRow
              id="cluster:unclustered"
              label="Unclustered"
              dot="bg-rule"
              count={p.unclusteredCount}
              active={p.view === 'cluster:unclustered'}
              onClick={() => p.onView('cluster:unclustered')}
            />
          )}
        </div>
      )}

      {p.agents.length > 0 && (
        <div className="flex flex-col gap-px">
          <div className={`px-2.5 pb-1.5 ${LABEL}`}>SUBAGENT SCOPES</div>
          {p.agents.map((a) => (
            <button
              key={a.name}
              type="button"
              data-testid={`mx-nav-agent:${a.name}`}
              onClick={() => p.onScope({ kind: 'agent', agent: a })}
              className={`${ROW} text-fg-dim ${agent?.name === a.name ? 'bg-bg font-semibold' : ''}`}
            >
              <span className="font-mono text-xs flex-1 truncate">{a.name}</span>
              <span className="font-mono text-[11px] text-fg-faint">{agentCount(a, p.agentCounts)}</span>
            </button>
          ))}
        </div>
      )}

      {p.index && (
        <div data-testid="mx-index-footer" className="mt-auto flex flex-col gap-1.5 pt-3 border-t border-rule-inner">
          <span className={LABEL}>MEMORY.md</span>
          <Meter label="lines" value={p.index.lines} max={p.index.maxLines} tone={tone} />
          <Meter label="KB" value={Math.round(p.index.bytes / 1024)} max={Math.round(p.index.maxBytes / 1024)} tone={tone} />
          {p.index.dangling.length > 0 && (
            <span className="text-[10.5px] text-accent-dark">
              {p.index.dangling.length} index lines point at missing files
            </span>
          )}
        </div>
      )}
    </nav>
  )
})
