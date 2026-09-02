/**
 * Single fetch of session-manager-operations/project-pages/output/*.html for
 * the active project — shared by ProjectHome.tsx (the hosted `home` document
 * + provenance line) and ProjectPagesSection.tsx (the marketing/feature/
 * architecture/brief lens tabs), so there is one IPC call and one source of
 * truth for `output` rather than two divergent fetch effects.
 *
 * Also subscribes to the main process's per-cwd output-dir watcher
 * (projectPages.cjs's watchOutput/onChanged 'project-pages:changed') so a
 * builder Epic finishing (or a hand-edit landing) updates `output` live —
 * no tab switch or app restart needed. `watch`/`unwatch` are refcounted in
 * main, so mounting this hook twice for the same cwd (ProjectHome +
 * ProjectPagesSection both read it via one shared call site today) is safe;
 * watch/unwatch are still paired 1:1 per mount here. A cwd the main process
 * can't watch (worktree/tmpdir root) resolves `{ok:false}` — silently no-op,
 * not a toast, since a stale/ephemeral cwd has no user-actionable fix here.
 */
import { useEffect, useState } from 'react'
import { toast } from '../../state/toast'
import type { ProjectPagesOutput } from '../../../preload/api'

export function useProjectPagesOutput(cwd: string | null): { output: ProjectPagesOutput | null; loaded: boolean } {
  const [output, setOutput] = useState<ProjectPagesOutput | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!cwd) return
    let cancelled = false
    setLoaded(false)
    window.api.projectPages
      .get(cwd)
      .then((res) => {
        if (cancelled) return
        setOutput(res.output)
        setLoaded(true)
      })
      .catch((err) => {
        if (cancelled) return
        setLoaded(true)
        toast.error(`Could not load Project Pages: ${err instanceof Error ? err.message : String(err)}`)
      })
    return () => {
      cancelled = true
    }
  }, [cwd])

  useEffect(() => {
    if (!cwd) return
    void window.api.projectPages.watch(cwd)
    const unsubscribe = window.api.projectPages.onChanged((payload) => {
      if (payload.cwd !== cwd) return
      setOutput(payload.output)
      setLoaded(true)
    })
    return () => {
      unsubscribe()
      void window.api.projectPages.unwatch(cwd)
    }
  }, [cwd])

  return { output, loaded }
}
