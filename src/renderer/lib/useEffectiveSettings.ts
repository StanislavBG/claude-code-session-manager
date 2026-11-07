import { useMemo } from 'react'
import { useConfig } from '../state/config'
import { useSessions } from '../state/sessions'
import { useHomeDir } from './useHomeDir'
import { SETTINGS_SCOPES, type Scope } from './scopes'
import { mergeScopes, getAtPath, type EffectiveNode } from './mergeScopes'
import { parseScopedJson } from './parseScopedJson'
import { useScopedConfigFiles } from './useScopedConfigFiles'

/**
 * Returns the merged-scope view of user/project/local settings.json for an
 * explicit `cwd`. Path resolution, load and watch are delegated to
 * `useScopedConfigFiles`; external edits arrive via the config:changed
 * listener (`installConfigChangeListener`) that refreshes the shared store.
 */
export function useEffectiveSettingsFor(cwd: string | null) {
  const home = useHomeDir()
  const files = useConfig((s) => s.files)
  const scopePaths = useScopedConfigFiles(SETTINGS_SCOPES, home, cwd)

  return useMemo(
    () => mergeScopes(parseScopedJson(files, scopePaths)),
    [files, scopePaths]
  )
}

/** `useEffectiveSettingsFor` bound to the currently active tab's cwd. */
export function useEffectiveSettings() {
  const tabs = useSessions((s) => s.tabs)
  const activeTabId = useSessions((s) => s.activeTabId)
  const cwd = tabs.find((t) => t.id === activeTabId)?.cwd ?? null
  return useEffectiveSettingsFor(cwd)
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
