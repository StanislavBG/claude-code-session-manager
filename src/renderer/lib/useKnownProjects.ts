import { useEffect, useState } from 'react'
import { useSessions } from '../state/sessions'
import { enrichProject, type ProjectDetails } from './projectEnrichment'
import { useHomeDir } from './useHomeDir'
import type { DirEntry } from '../../preload/api'

export interface ProjectRow {
  encoded: string
  displayPath: string
  sessionCount: number
  lastSession: number
  path: string
  sizeBytes: number
}

export interface EnrichmentState extends ProjectDetails {
  cwd: string | null
}

export function candidatePath(encoded: string): string {
  return encoded.replace(/-/g, '/')
}

export async function resolveProjectCwd(projectFolder: string): Promise<string | null> {
  const files = await window.api.config.listDir(projectFolder, { filesOnly: true })
  const jsonl = (files.entries as DirEntry[])
    .filter((f) => f.name.endsWith('.jsonl'))
    .sort((a, b) => a.size - b.size)
  for (const f of jsonl) {
    const r = await window.api.config.readText(f.path)
    if (!r.exists || !r.text) continue
    for (const line of r.text.split('\n')) {
      if (!line.includes('"cwd"')) continue
      try {
        const obj = JSON.parse(line)
        if (typeof obj.cwd === 'string' && obj.cwd.length > 0) return obj.cwd
      } catch {
        // skip malformed line
      }
    }
  }
  return null
}

export function useKnownProjects() {
  const home = useHomeDir()
  const [rows, setRows] = useState<ProjectRow[]>([])
  const [loading, setLoading] = useState(true)
  const [enriched, setEnriched] = useState<Record<string, EnrichmentState>>({})
  const addTab = useSessions((s) => s.addTab)

  useEffect(() => {
    if (!home) return
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const r = await window.api.config.listDir(`${home}/.claude/projects`, { dirsOnly: true })
        if (cancelled) return
        const next: ProjectRow[] = []
        for (const e of r.entries as DirEntry[]) {
          if (cancelled) return
          const files = await window.api.config.listDir(e.path, { filesOnly: true })
          const jsonl = (files.entries as DirEntry[]).filter((f) => f.name.endsWith('.jsonl'))
          const lastSession = jsonl.reduce((m, f) => Math.max(m, f.mtimeMs), 0)
          const sizeBytes = jsonl.reduce((s, f) => s + f.size, 0)
          next.push({
            encoded: e.name,
            displayPath: candidatePath(e.name),
            sessionCount: jsonl.length,
            lastSession,
            path: e.path,
            sizeBytes,
          })
        }
        next.sort((a, b) => b.lastSession - a.lastSession)
        if (!cancelled) {
          setRows(next)
          setEnriched({})
        }
      } catch (err) {
        console.error('[useKnownProjects] scan failed:', err)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [home])

  useEffect(() => {
    if (!rows.length) return
    let cancelled = false
    const queue = rows.slice()
    let inFlight = 0

    const tick = () => {
      while (!cancelled && inFlight < 6 && queue.length) {
        const row = queue.shift()!
        inFlight++
        resolveProjectCwd(row.path)
          .then(async (cwd) => {
            if (cancelled) return
            const details = cwd ? await enrichProject(cwd) : {}
            if (cancelled) return
            setEnriched((prev) => ({ ...prev, [row.encoded]: { cwd: cwd ?? null, ...details } }))
          })
          .catch(() => {
            if (!cancelled) {
              setEnriched((prev) => ({ ...prev, [row.encoded]: { cwd: null } }))
            }
          })
          .finally(() => {
            inFlight--
            if (!cancelled) tick()
          })
      }
    }

    tick()
    return () => { cancelled = true }
  }, [rows])

  const openInSession = async (row: ProjectRow) => {
    let cwd = enriched[row.encoded]?.cwd ?? null
    if (!cwd) cwd = await resolveProjectCwd(row.path)
    if (!cwd) {
      cwd = await window.api.app.pickDirectory()
      if (!cwd) return
    }
    const id = crypto.randomUUID()
    addTab({
      id,
      cwd,
      startupCommand: null,
      presetId: 'projects-tab',
      dormant: true,
    })
  }

  const archiveProject = async (encoded: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      const result = await window.api.app.archiveProject(encoded)
      if (result.ok) {
        setRows((prev) => prev.filter((r) => r.encoded !== encoded))
        setEnriched((prev) => {
          const next = { ...prev }
          delete next[encoded]
          return next
        })
      }
      return result
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : 'Archive failed' }
    }
  }

  return { rows, enriched, loading, openInSession, archiveProject }
}
