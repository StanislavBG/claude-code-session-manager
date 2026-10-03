/**
 * useMacros — the machine-local Macro library (`window.api.macros`), live
 * against `macros:changed`. `macrosForProject` is the pure per-project filter.
 */
import { useEffect, useState } from 'react'
import type { Macro } from '../../preload/api'
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

export function useMacros(): Macro[] {
  const [macros, setMacros] = useState<Macro[]>(EMPTY)
  useEffect(() => {
    let cancelled = false
    const load = () => {
      const list = window.api?.macros?.list
      if (!list) return
      list()
        .then((l) => {
          if (!cancelled) setMacros(l)
        })
        .catch(() => {
          if (!cancelled) setMacros(EMPTY)
        })
    }
    load()
    const off = window.api?.macros?.onChanged?.(load)
    return () => {
      cancelled = true
      off?.()
    }
  }, [])
  return macros
}
