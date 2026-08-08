/**
 * useProjectActions — the Agent-Library-backed Action buttons for one project.
 *
 * Reads `~/.claude/agents/*.md` once per mount and re-reads on `agents:changed`
 * (the same broadcast Agent Library and Tag Library already refresh off), so
 * scoping an agent to a project from Agent Library makes its button appear in
 * the Sessions toolbar without a reload. Resolution itself is pure and lives in
 * `lib/projectActions.ts`.
 */

import { useEffect, useMemo, useState } from 'react'
import type { AgentPersona } from '../../preload/api'
import { projectActions, type ProjectAction } from './projectActions'

const EMPTY_PERSONAS: AgentPersona[] = []

/** All personas on disk, kept live against `agents:changed`. Shared by the
 *  Sessions toolbar and Agent Library's project-scope preview. */
export function useAgentPersonas(): AgentPersona[] {
  const [personas, setPersonas] = useState<AgentPersona[]>(EMPTY_PERSONAS)

  useEffect(() => {
    let cancelled = false
    const load = () => {
      const listPersonas = window.api?.agents?.listPersonas
      if (!listPersonas) return
      listPersonas()
        .then((list) => {
          if (!cancelled) setPersonas(list)
        })
        .catch(() => {
          // Best-effort: a missing/unreadable agents dir means no Action
          // buttons, never a broken toolbar.
          if (!cancelled) setPersonas(EMPTY_PERSONAS)
        })
    }
    load()
    const off = window.api?.agents?.onChanged?.(load)
    return () => {
      cancelled = true
      off?.()
    }
  }, [])

  return personas
}

export function useProjectActions(cwd: string | null | undefined): ProjectAction[] {
  const personas = useAgentPersonas()
  return useMemo(() => projectActions(personas, cwd), [personas, cwd])
}
