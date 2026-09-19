/**
 * Single fetch of session-manager-operations/project-pages/home.html for the
 * active project, shaped as the `ProjectPagesOutput` the (pre-rewrite) Project
 * Home UI still consumes — shared by ProjectHome.tsx and ProjectPagesSection.tsx
 * so there is one IPC call and one source of truth. Subscribes to the main
 * process's per-cwd watcher ('project-pages:changed') so a fresh write updates
 * live. A cwd the main process can't watch resolves `{ok:false}` — silently
 * no-op. TEMPORARY adapter: the renderer rewrite (ph-simplify-02) replaces it.
 */
import { useEffect, useState } from 'react'
import { toast } from '../../state/toast'
import type { ProjectPagesGetResult } from '../../../preload/api'

export interface ProjectPagesOutput {
  home: string
  marketing?: string
  feature?: string
  architecture?: string
  brief?: string
  generatedAt: string | null
  isDefault: boolean
}

function toOutput(res: ProjectPagesGetResult): ProjectPagesOutput | null {
  if (res.html === null) return null
  return {
    home: res.html,
    generatedAt: res.mtimeMs === null ? null : new Date(res.mtimeMs).toISOString(),
    isDefault: false,
  }
}

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
        setOutput(toOutput(res))
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
      setOutput(toOutput(payload))
      setLoaded(true)
    })
    return () => {
      unsubscribe()
      void window.api.projectPages.unwatch(cwd)
    }
  }, [cwd])

  return { output, loaded }
}
