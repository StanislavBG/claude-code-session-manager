import { useEffect, useState } from 'react'
import type { BuildTarget } from '../../preload/api'

export interface BuildTargetState {
  /** The resolved target, or null once the lookup has answered "none". */
  target: BuildTarget | null
  /** True until the lookup answers. `target: null, resolving: true` is "not
   *  known yet"; `target: null, resolving: false` is "no build target
   *  configured" — see `lib/buildAction.ts` for why that difference matters
   *  (one shows a neutral button, the other offers to set the project up). */
  resolving: boolean
}

/**
 * Resolves the active project's publish target for the Epic Queue's Build
 * toolbar button (buildTarget.cjs, main process).
 *
 * A `null` target does NOT mean "this project can't be built" — it means no
 * `session-manager-operations/architecture/build-target.json` exists and no
 * publishable `package.json` was auto-discovered, i.e. **not configured yet**.
 * The resolver stays deliberately dumb (npm auto-discovery only); the button
 * turns that null into a "Set Up Build" bootstrap Epic rather than a disabled
 * control.
 */
export function useBuildTarget(cwd: string | null): BuildTargetState {
  const [state, setState] = useState<BuildTargetState>({ target: null, resolving: Boolean(cwd) })
  useEffect(() => {
    if (!cwd) {
      setState({ target: null, resolving: false })
      return
    }
    let cancelled = false
    const resolve = window.api?.app?.resolveBuildTarget
    if (!resolve) {
      setState({ target: null, resolving: false })
      return
    }
    setState({ target: null, resolving: true })
    resolve(cwd)
      .then((v) => {
        if (!cancelled) setState({ target: v ?? null, resolving: false })
      })
      .catch(() => {
        if (!cancelled) setState({ target: null, resolving: false })
      })
    return () => {
      cancelled = true
    }
  }, [cwd])
  return state
}
