import { useEffect, useMemo } from 'react'
import { useConfig } from '../state/config'
import { useSessions } from '../state/sessions'
import { useHomeDir } from './useHomeDir'
import { SETTINGS_SCOPES, type Scope } from './scopes'
import { mergeScopes, getAtPath, type EffectiveNode } from './mergeScopes'
import { parseScopedJson } from './parseScopedJson'

const SETTINGS_REFRESH_MS = 30_000

/**
 * Returns the merged-scope view of user/project/local settings.json with
 * a 30s self-refresh + chokidar watch on each scope path. Chokidar
 * watchers are refcounted, so it's safe to mount this alongside the
 * Settings tab (which watches the same paths).
 */
export function useEffectiveSettings() {
  const home = useHomeDir()
  const tabs = useSessions((s) => s.tabs)
  const activeTabId = useSessions((s) => s.activeTabId)
  const cwd = tabs.find((t) => t.id === activeTabId)?.cwd ?? null

  const scopePaths = useMemo(() => {
    if (!home) return {}
    const out: Partial<Record<Scope, string>> = {}
    for (const s of SETTINGS_SCOPES.scopes) {
      const p = SETTINGS_SCOPES.resolve(s, home, cwd)
      if (p) out[s] = p
    }
    return out
  }, [home, cwd])

  const files = useConfig((s) => s.files)
  const loadJson = useConfig((s) => s.loadJson)
  const watchFile = useConfig((s) => s.watchFile)
  const unwatchFile = useConfig((s) => s.unwatchFile)

  useEffect(() => {
    const paths = Object.values(scopePaths).filter(Boolean) as string[]
    paths.forEach((p) => {
      if (!files[p]) loadJson(p)
      watchFile(p)
    })
    const timer = window.setInterval(() => {
      paths.forEach((p) => loadJson(p))
    }, SETTINGS_REFRESH_MS)
    return () => {
      clearInterval(timer)
      paths.forEach((p) => unwatchFile(p))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(scopePaths)])

  return useMemo(
    () => mergeScopes(parseScopedJson(files, scopePaths)),
    [files, scopePaths]
  )
}

/** Read a leaf string from an EffectiveNode at the given path. */
export function readLeafString(
  node: EffectiveNode,
  path: string[]
): string | null {
  const leaf = getAtPath(node, path)
  if (!leaf || leaf.kind !== 'leaf') return null
  return typeof leaf.value === 'string' ? leaf.value : null
}

/**
 * Read a leaf string with its winning scope. When `source` is null, no scope
 * defined this key — the pill should render "default" rather than an empty
 * dash, so cross-machine config drift (e.g. model set on Mac, unset on Linux)
 * is self-explanatory instead of looking like a render bug.
 */
export function readLeafWithSource(
  node: EffectiveNode,
  path: string[]
): { value: string | null; source: Scope | null } {
  const leaf = getAtPath(node, path)
  if (!leaf || leaf.kind !== 'leaf') return { value: null, source: null }
  return {
    value: typeof leaf.value === 'string' ? leaf.value : null,
    source: leaf.winner,
  }
}
