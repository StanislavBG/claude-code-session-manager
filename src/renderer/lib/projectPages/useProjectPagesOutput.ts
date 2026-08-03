/**
 * Single fetch of session-manager-operations/project-pages/output/*.html for
 * the active project — shared by ProjectHome.tsx (the hosted `home` document
 * + provenance line) and ProjectPagesSection.tsx (the marketing/feature/
 * architecture/brief lens tabs), so there is one IPC call and one source of
 * truth for `output` rather than two divergent fetch effects.
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

  return { output, loaded }
}
