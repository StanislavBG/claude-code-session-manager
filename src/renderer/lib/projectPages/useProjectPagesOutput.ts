/**
 * Single fetch of session-manager-operations/project-pages/home.html for the
 * active project as `{html, mtimeMs}` (null until the file exists), plus
 * whether demo-video/index.html exists (`{path, mtimeMs}` — path only, so its
 * HTML never crosses IPC; load it via smfile://). Subscribes to the main
 * process's per-cwd watcher ('project-pages:changed') so a fresh write
 * updates live. A cwd the main process can't watch resolves `{ok:false}` —
 * silently no-op.
 */
import { useEffect, useState } from 'react'
import { toast } from '../../state/toast'
import type { ProjectPagesGetResult } from '../../../preload/api'

export interface ProjectPagesOutput {
  html: string
  mtimeMs: number | null
}

export type ProjectPagesDemoVideo = { path: string; mtimeMs: number } | null

function toOutput(res: ProjectPagesGetResult): ProjectPagesOutput | null {
  return res.html === null ? null : { html: res.html, mtimeMs: res.mtimeMs }
}

export function useProjectPagesOutput(
  cwd: string | null,
): { output: ProjectPagesOutput | null; demoVideo: ProjectPagesDemoVideo; loaded: boolean } {
  const [output, setOutput] = useState<ProjectPagesOutput | null>(null)
  const [demoVideo, setDemoVideo] = useState<ProjectPagesDemoVideo>(null)
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
        setDemoVideo(res.demoVideo)
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
      setDemoVideo(payload.demoVideo)
      setLoaded(true)
    })
    return () => {
      unsubscribe()
      void window.api.projectPages.unwatch(cwd)
    }
  }, [cwd])

  return { output, demoVideo, loaded }
}
