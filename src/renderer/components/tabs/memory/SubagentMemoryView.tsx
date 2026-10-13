/**
 * SubagentMemoryView — Claude Code's native subagent memory, the "Subagent" scope
 * of the Memory tab. An agent whose frontmatter sets `memory: user|project|local`
 * gets the shared MemoryStoreView over its native dir; agents without the field
 * are listed with a hint on how to enable it.
 */

import { useEffect, useState } from 'react'
import { EmptyState } from '../../ui/EmptyState'
import { useActiveTab } from '../../../lib/useActiveTab'
import { MemoryStoreView } from './MemoryStoreView'
import type { MemoryAgent } from '../../../../preload/api'

const SCOPE_NOTE: Record<NonNullable<MemoryAgent['memoryScope']>, string> = {
  user: 'user — all projects',
  project: 'project — shared via git',
  local: 'local — this machine, not committed',
}

const agentKey = (a: MemoryAgent) => `${a.origin}:${a.name}`

export function SubagentMemoryView() {
  const activeTab = useActiveTab()
  const cwd = activeTab?.cwd ?? null

  const [agents, setAgents] = useState<MemoryAgent[]>([])
  const [loaded, setLoaded] = useState(false)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api.memory
      .agents(cwd ?? undefined)
      .then((r) => {
        if (cancelled) return
        setAgents(r.agents)
        setLoaded(true)
        setSelectedKey((prev) =>
          prev && r.agents.some((a) => agentKey(a) === prev) ? prev : r.agents[0] ? agentKey(r.agents[0]) : null,
        )
      })
      .catch(() => {
        if (cancelled) return
        setAgents([])
        setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [cwd])

  const selected = agents.find((a) => agentKey(a) === selectedKey) ?? null

  const picker = (
    <>
      <span className="text-fg-faint">Agent</span>
      <select
        value={selectedKey ?? ''}
        onChange={(e) => setSelectedKey(e.target.value || null)}
        className="bg-bg border border-line rounded px-2 py-0.5 text-xs text-fg max-w-[16rem]"
      >
        {agents.length === 0 && <option value="">(no agents found)</option>}
        {agents.map((a) => (
          <option key={agentKey(a)} value={agentKey(a)}>
            {a.name} · {a.origin}
          </option>
        ))}
      </select>
    </>
  )

  if (!loaded) return <EmptyState title="loading…" />

  if (!selected) {
    return (
      <EmptyState
        title="no agents found"
        hint="Create an agent in the Agent Library; add `memory: project` to its frontmatter to give it persistent memory."
      />
    )
  }

  if (!selected.memoryScope) {
    return (
      <div className="h-full flex flex-col">
        <div className="shrink-0 px-3 py-1.5 border-b border-line flex items-center gap-2 text-xs">{picker}</div>
        <div className="flex-1 min-h-0">
          <EmptyState
            title={`${selected.name} has no persistent memory`}
            hint="Add `memory: project` (or `user` / `local`) to its frontmatter in the Agent Library to enable it."
          />
        </div>
      </div>
    )
  }

  return (
    <MemoryStoreView
      target={{ cwd: cwd ?? undefined, agent: { name: selected.name, scope: selected.memoryScope } }}
      cwd={cwd}
      toolbarExtra={
        <>
          {picker}
          <span className="mx-2 text-fg-faint">·</span>
          <span className="text-fg-faint">{SCOPE_NOTE[selected.memoryScope]}</span>
        </>
      }
    />
  )
}
