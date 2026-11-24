/**
 * Single fetch of session-manager-operations/project-pages/home.html for the
 * active project as `{html, mtimeMs}` (null until the file exists), plus
 * whether demo-video/index.html exists (`{path, mtimeMs}` — path only, so its
 * HTML never crosses IPC; load it via smfile://). Subscribes to the main
 * process's per-cwd watcher ('project-pages:changed') so a fresh write
 * updates live. A cwd the main process can't watch resolves `{ok:false}` —
 * silently no-op. `personaName` is the saved project persona's name (videos/_character), null
 * when there is none; `outcomes` are the library read's video outcomes (empty when none).
 */
import { useCallback, useEffect, useState } from 'react'
import { toast } from '../../state/toast'
import type {
  ProjectPagesGetResult,
  ProjectLibraryEntry,
  ProjectPageMeta,
  ProjectVideoMeta,
  ProjectVideoOutcome,
} from '../../../preload/api'

export interface ProjectPagesOutput {
  html: string
  mtimeMs: number | null
}

export type ProjectKnowledgeEntry = ProjectLibraryEntry<ProjectPageMeta>
export type ProjectVideoEntry = ProjectLibraryEntry<ProjectVideoMeta>

const NO_KNOWLEDGE: ProjectKnowledgeEntry[] = []
const NO_VIDEOS: ProjectVideoEntry[] = []
const NO_OUTCOMES: ProjectVideoOutcome[] = []

export type ProjectPagesDemoVideo = { path: string; mtimeMs: number } | null

function personaNameOf(res: ProjectPagesGetResult): string | null {
  const name = res.persona?.name
  return typeof name === 'string' && name.trim() !== '' ? name : null
}

function toOutput(res: ProjectPagesGetResult): ProjectPagesOutput | null {
  return res.html === null ? null : { html: res.html, mtimeMs: res.mtimeMs }
}

export function useProjectPagesOutput(
  cwd: string | null,
): {
  output: ProjectPagesOutput | null
  demoVideo: ProjectPagesDemoVideo
  knowledge: ProjectKnowledgeEntry[]
  videos: ProjectVideoEntry[]
  personaName: string | null
  /** Video runs that ended without a video by design (season-complete), newest first. */
  outcomes: ProjectVideoOutcome[]
  loaded: boolean
  error: string | null
  reload: () => void
} {
  const [output, setOutput] = useState<ProjectPagesOutput | null>(null)
  const [demoVideo, setDemoVideo] = useState<ProjectPagesDemoVideo>(null)
  const [knowledge, setKnowledge] = useState<ProjectKnowledgeEntry[]>(NO_KNOWLEDGE)
  const [videos, setVideos] = useState<ProjectVideoEntry[]>(NO_VIDEOS)
  const [personaName, setPersonaName] = useState<string | null>(null)
  const [outcomes, setOutcomes] = useState<ProjectVideoOutcome[]>(NO_OUTCOMES)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reloadTick, setReloadTick] = useState(0)
  const reload = useCallback(() => setReloadTick((n) => n + 1), [])

  useEffect(() => {
    if (!cwd) return
    let cancelled = false
    setLoaded(false)
    setError(null)
    window.api.projectPages
      .get(cwd)
      .then((res) => {
        if (cancelled) return
        setOutput(toOutput(res))
        setDemoVideo(res.demoVideo)
        setKnowledge(Array.isArray(res.knowledge) ? res.knowledge : NO_KNOWLEDGE)
        setVideos(Array.isArray(res.videos) ? res.videos : NO_VIDEOS)
        setPersonaName(personaNameOf(res))
        setOutcomes(Array.isArray(res.outcomes) ? res.outcomes : NO_OUTCOMES)
        setError(null)
        setLoaded(true)
      })
      .catch((err) => {
        if (cancelled) return
        const msg = err instanceof Error ? err.message : String(err)
        setError(msg || 'Unknown error')
        setLoaded(true)
        toast.error(`Could not load Project Pages: ${msg}`)
      })
    return () => {
      cancelled = true
    }
  }, [cwd, reloadTick])

  useEffect(() => {
    if (!cwd) return
    void window.api.projectPages.watch(cwd)
    const unsubscribe = window.api.projectPages.onChanged((payload) => {
      if (payload.cwd !== cwd) return
      setOutput(toOutput(payload))
      setDemoVideo(payload.demoVideo)
      setKnowledge(Array.isArray(payload.knowledge) ? payload.knowledge : NO_KNOWLEDGE)
      setVideos(Array.isArray(payload.videos) ? payload.videos : NO_VIDEOS)
      setPersonaName(personaNameOf(payload))
      setOutcomes(Array.isArray(payload.outcomes) ? payload.outcomes : NO_OUTCOMES)
      setError(null)
      setLoaded(true)
    })
    return () => {
      unsubscribe()
      void window.api.projectPages.unwatch(cwd)
    }
  }, [cwd])

  return { output, demoVideo, knowledge, videos, personaName, outcomes, loaded, error, reload }
}
