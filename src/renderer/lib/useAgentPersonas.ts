/**
 * useAgentPersonas — all `~/.claude/agents/*.md` personas, read once per mount
 * and re-read on `agents:changed`.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentPersona } from '../../preload/api'

const EMPTY_PERSONAS: AgentPersona[] = []

export interface AgentPersonasState {
  /** null until the first read settles. */
  personas: AgentPersona[] | null
  /** Re-read now (e.g. after the page's own save). Resolves to the list, or null if stale/failed. */
  refresh: () => Promise<AgentPersona[] | null>
}

/** Personas + `refresh()`, kept live against `agents:changed`. A failed read
 *  yields an empty list and calls `onError` (latest closure wins). */
export function useAgentPersonasState(onError?: (e: Error) => void): AgentPersonasState {
  const [personas, setPersonas] = useState<AgentPersona[] | null>(null)
  const mounted = useRef(true)
  // A stale response must never clobber a fresher one.
  const seq = useRef(0)
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  const refresh = useCallback(async (): Promise<AgentPersona[] | null> => {
    const listPersonas = window.api?.agents?.listPersonas
    if (!listPersonas) return null
    const mine = ++seq.current
    try {
      const list = await listPersonas()
      if (!mounted.current || seq.current !== mine) return null
      setPersonas(list)
      return list
    } catch (e) {
      if (!mounted.current || seq.current !== mine) return null
      // Best-effort: a missing/unreadable agents dir means no agent
      // choices, never a broken page.
      setPersonas(EMPTY_PERSONAS)
      onErrorRef.current?.(e as Error)
      return null
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    void refresh()
    const off = window.api?.agents?.onChanged?.(() => { void refresh() })
    return () => {
      mounted.current = false
      off?.()
    }
  }, [refresh])

  return { personas, refresh }
}

/** All personas on disk, kept live against `agents:changed`. Used by the
 *  hot-key Macro strip and editor. */
export function useAgentPersonas(): AgentPersona[] {
  return useAgentPersonasState().personas ?? EMPTY_PERSONAS
}
