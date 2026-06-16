import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Scope } from './scopes'
import { useHomeDir } from './useHomeDir'
import { useActiveTab } from './useActiveTab'
import { toast } from '../state/toast'

export interface AgentDef {
  scope: Scope
  name: string
  path: string
}

export function agentsDir(home: string, cwd: string | null, scope: Scope): string | null {
  if (scope === 'user') return `${home}/.claude/agents`
  if (!cwd) return null
  return `${cwd}/.claude/agents`
}

async function fetchAgents(dir: string, scope: Scope): Promise<AgentDef[]> {
  const r = await window.api.config.listDir(dir, { filesOnly: true })
  return r.entries
    .filter((e) => e.name.endsWith('.md'))
    .map((e) => ({ scope, name: e.name.replace(/\.md$/, ''), path: e.path }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Single source of truth for the on-disk agent list.
 *
 * Returns agents for the given scope from ~/.claude/agents (user) or
 * <cwd>/.claude/agents (project). Also exposes `reload()` for imperative
 * refresh after create/delete operations.
 */
export function useAgentNames(scope: Scope): { agents: AgentDef[]; reload: () => Promise<AgentDef[]> } {
  const home = useHomeDir()
  const activeTab = useActiveTab()
  const cwd = activeTab?.cwd ?? null
  const [agents, setAgents] = useState<AgentDef[]>([])

  const dir = useMemo(() => (home ? agentsDir(home, cwd, scope) : null), [home, cwd, scope])

  useEffect(() => {
    if (!dir) {
      setAgents([])
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const next = await fetchAgents(dir, scope)
        if (!cancelled) setAgents(next)
      } catch (e) {
        if (!cancelled) {
          const msg = e instanceof Error ? e.message : String(e)
          toast.error(`Could not list subagents: ${msg}`)
          setAgents([])
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [dir, scope])

  const reload = useCallback(async (): Promise<AgentDef[]> => {
    if (!dir) return []
    try {
      const next = await fetchAgents(dir, scope)
      setAgents(next)
      return next
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(`Could not list subagents: ${msg}`)
      return []
    }
  }, [dir, scope])

  return { agents, reload }
}
