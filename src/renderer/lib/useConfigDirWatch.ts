import { useEffect, useRef } from 'react'

/**
 * config.cjs's watch() keys its chokidar watchers (and the `path` field on
 * every `config:changed` event) by `path.resolve(expandHome(p))` — a plain
 * `Array.includes` match against the RAW string a caller passed in would
 * silently miss a real event whenever a caller's path carries a trailing or
 * doubled slash (e.g. an un-trimmed tab `cwd`). Collapse + trim the same way
 * here so the renderer-side comparison always agrees with what main echoes
 * back, for paths built by plain string concatenation (no `.`/`..` segments,
 * since every caller here appends a literal suffix to an already-absolute
 * home dir or tab cwd).
 */
function normalizeConfigPath(p: string): string {
  const collapsed = p.replace(/\/{2,}/g, '/')
  return collapsed.length > 1 ? collapsed.replace(/\/+$/, '') : collapsed
}

/**
 * Watches a set of absolute config paths (files or directories — config.cjs's
 * chokidar-backed watch() is capable of both) via `window.api.config.watch`
 * and calls `onChange` whenever a `config:changed` event lands for one of
 * them. Mirrors `useScopedConfigFiles.ts`'s watch-on-mount/unwatch-on-unmount
 * shape, for callers that re-list a directory or re-read a single file
 * (Agent/Tag Library, Skills, Plugins) rather than caching file content in
 * the `useConfig` store.
 */
export function useConfigDirWatch(paths: Array<string | null | undefined>, onChange: () => void) {
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  const resolved = Array.from(new Set(paths.filter((p): p is string => !!p).map(normalizeConfigPath)))
  const key = resolved.slice().sort().join('\u0000')

  useEffect(() => {
    if (resolved.length === 0) return
    window.api.config.watch(resolved)
    const unsubscribe = window.api.config.onChanged((info) => {
      if (resolved.includes(info.path)) onChangeRef.current()
    })
    return () => {
      unsubscribe()
      window.api.config.unwatch(resolved)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
}
