import { useEffect, useState } from 'react'

/**
 * Cached git-branch lookup, shared by AlmanacSidebar's ProjectCaption and
 * AlmanacFooter — both display the active tab's branch and previously ran
 * independent, uncached `window.api.app.gitBranch` calls that could drift
 * (one had a 30s TTL cache, the other refetched on every cwd change).
 */
const branchCache = new Map<string, { value: string | null; ts: number }>()
const BRANCH_TTL_MS = 30_000

export function useBranch(cwd: string | null): string | null {
  const [branch, setBranch] = useState<string | null>(() => (cwd ? branchCache.get(cwd)?.value ?? null : null))
  useEffect(() => {
    if (!cwd) { setBranch(null); return }
    let cancelled = false
    const load = async () => {
      const hit = branchCache.get(cwd)
      if (hit && Date.now() - hit.ts < BRANCH_TTL_MS) {
        if (!cancelled) setBranch(hit.value)
        return
      }
      try {
        const v = await window.api.app.gitBranch(cwd)
        if (cancelled) return
        branchCache.set(cwd, { value: v, ts: Date.now() })
        setBranch(v)
      } catch {
        if (cancelled) return
        branchCache.set(cwd, { value: null, ts: Date.now() })
        setBranch(null)
      }
    }
    load()
    return () => { cancelled = true }
  }, [cwd])
  return branch
}
