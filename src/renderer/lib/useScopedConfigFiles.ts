import { useEffect, useMemo } from 'react'
import { useConfig } from '../state/config'
import type { Scope, ScopeSpec } from './scopes'

/**
 * Resolves every scope path for a ScopeSpec, then loads + watches each
 * resolvable path via the config store for the component's lifetime.
 * Shared by Settings/Permissions/Hooks — each independently reimplemented
 * this exact scopePaths+load+watch block before extraction.
 */
export function useScopedConfigFiles(
  spec: ScopeSpec,
  home: string | null,
  cwd: string | null,
): Partial<Record<Scope, string>> {
  const files = useConfig((s) => s.files)
  const loadJson = useConfig((s) => s.loadJson)
  const watchFile = useConfig((s) => s.watchFile)
  const unwatchFile = useConfig((s) => s.unwatchFile)

  const scopePaths = useMemo(() => {
    const out: Partial<Record<Scope, string>> = {}
    for (const s of spec.scopes) {
      const p = spec.resolve(s, home ?? '', cwd)
      if (p) out[s] = p
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec, home, cwd])

  useEffect(() => {
    const paths = Object.values(scopePaths).filter(Boolean) as string[]
    paths.forEach((p) => {
      if (!files[p]) loadJson(p)
      watchFile(p)
    })
    return () => {
      paths.forEach((p) => unwatchFile(p))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(scopePaths)])

  return scopePaths
}
