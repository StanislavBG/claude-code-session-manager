/**
 * useAgentPersonas — all `~/.claude/agents/*.md` personas, read once per mount
 * and re-read on `agents:changed`.
 */

import { useEffect, useState } from 'react'
import type { AgentPersona } from '../../preload/api'

const EMPTY_PERSONAS: AgentPersona[] = []

/** All personas on disk, kept live against `agents:changed`. Used by the
 *  hot-key Macro strip and editor. */
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
          // Best-effort: a missing/unreadable agents dir means no agent
          // choices, never a broken toolbar.
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
