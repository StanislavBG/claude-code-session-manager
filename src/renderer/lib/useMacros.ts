/**
 * useMacros — the machine-local Macro library (`window.api.macros`), live
 * against `macros:changed`. `macrosForProject` is the pure per-project filter.
 */
import { useEffect, useState } from 'react'
import type { Macro } from '../../preload/api'
import { toast } from '../state/toast'
import { normalizeCwd } from './knownProjectAggregate'

const EMPTY: Macro[] = []

/**
 * Macros shown in `cwd` for `surface` (default `'sessions'`): absolute-cwd match or `'*'`,
 * restricted to macros whose `surface` (missing = `'sessions'`) matches, sorted by label
 * (case-insensitive).
 */
export function macrosForProject(
  macros: readonly Macro[],
  cwd: string | null | undefined,
  surface: 'sessions' | 'project-home' = 'sessions',
): Macro[] {
  if (!cwd) return []
  const here = normalizeCwd(cwd)
  return macros
    .filter((m) => (m.surface ?? 'sessions') === surface)
    .filter((m) => m.projects.some((p) => p === '*' || normalizeCwd(p) === here))
    .sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()))
}

// Last list main handed us. Seeds every mount so a busy main process (slow or
// rejected macros:list) never makes the HOT KEYS strip look empty.
let lastKnown: Macro[] | null = null
let failing = false

export function __resetMacrosCacheForTests(): void {
  lastKnown = null
  failing = false
}

export function useMacros(): { macros: Macro[]; loaded: boolean } {
  const [macros, setMacros] = useState<Macro[]>(lastKnown ?? EMPTY)
  const [loaded, setLoaded] = useState<boolean>(lastKnown !== null)
  useEffect(() => {
    let cancelled = false
    const load = () => {
      const list = window.api?.macros?.list
      if (!list) return
      list()
        .then((l) => {
          lastKnown = l
          failing = false
          if (cancelled) return
          setMacros(l)
          setLoaded(true)
        })
        .catch((err: unknown) => {
          if (failing) return
          failing = true
          toast.error('Could not load hot keys: ' + (err instanceof Error ? err.message : String(err)))
        })
    }
    load()
    const off = window.api?.macros?.onChanged?.(load)
    return () => {
      cancelled = true
      off?.()
    }
  }, [])
  return { macros, loaded }
}
