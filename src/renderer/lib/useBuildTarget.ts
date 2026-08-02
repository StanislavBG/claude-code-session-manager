import { useEffect, useState } from 'react'
import type { BuildTarget } from '../../preload/api'

/**
 * Resolves the active project's publish target for the Epic Queue's Build
 * toolbar button (buildTarget.cjs, main process). `null` means the button
 * should be disabled — no explicit build-target.json and no auto-discoverable
 * publishable package.json.
 */
export function useBuildTarget(cwd: string | null): BuildTarget | null {
  const [target, setTarget] = useState<BuildTarget | null>(null)
  useEffect(() => {
    if (!cwd) {
      setTarget(null)
      return
    }
    let cancelled = false
    const resolve = window.api?.app?.resolveBuildTarget
    if (!resolve) {
      setTarget(null)
      return
    }
    resolve(cwd)
      .then((v) => {
        if (!cancelled) setTarget(v)
      })
      .catch(() => {
        if (!cancelled) setTarget(null)
      })
    return () => {
      cancelled = true
    }
  }, [cwd])
  return target
}
