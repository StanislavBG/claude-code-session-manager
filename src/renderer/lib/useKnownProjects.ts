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

// Module-level cache, shared by every mount site (Home renders this hook
// TWICE, EpicsWorkspace remounts it on every dormant-tab switch since v0.51's
// Epics redesign). Without sharing, each mount re-walked `~/.claude/projects`
// from scratch — one sequential listDir per directory, then a concurrency-6
// pass reading + parsing jsonl content for every project — which is fine for
// a handful of projects but pathological for a machine with hundreds of
// entries accumulated over time (measured: 575 dirs / 2.3GB here), and it's
// exactly what made tab-switching and initial load feel like a memory leak
// in v51: the same expensive scan re-running on every switch, not a leak.
// Mirrors useHomeDir.ts's cached-singleton-with-subscribers shape.
interface KnownProjectsState {
  rows: ProjectRow[]
  enriched: Record<string, EnrichmentState>
  loading: boolean
}

let state: KnownProjectsState = { rows: [], enriched: {}, loading: true }
const subscribers = new Set<() => void>()
let scannedForHome: string | null = null
let scanToken = 0

function notify() {
  subscribers.forEach((fn) => fn())
}

function setState(patch: Partial<KnownProjectsState>) {
  state = { ...state, ...patch }
  notify()
}

const SCAN_CONCURRENCY = 6

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++
      if (i >= items.length) return
      results[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return results
}

async function runScan(home: string): Promise<void> {
  const token = ++scanToken
  setState({ loading: true })
  try {
    const r = await window.api.config.listDir(`${home}/.claude/projects`, { dirsOnly: true })
    if (token !== scanToken) return
    const entries = r.entries as DirEntry[]
    const next = await mapWithConcurrency(entries, SCAN_CONCURRENCY, async (e): Promise<ProjectRow> => {
      const files = await window.api.config.listDir(e.path, { filesOnly: true })
      const jsonl = (files.entries as DirEntry[]).filter((f) => f.name.endsWith('.jsonl'))
      const lastSession = jsonl.reduce((m, f) => Math.max(m, f.mtimeMs), 0)
      const sizeBytes = jsonl.reduce((s, f) => s + f.size, 0)
      return {
        encoded: e.name,
        displayPath: candidatePath(e.name),
        sessionCount: jsonl.length,
        lastSession,
        path: e.path,
        sizeBytes,
      }
    })
    if (token !== scanToken) return
    next.sort((a, b) => b.lastSession - a.lastSession)
    setState({ rows: next, enriched: {}, loading: false })
    runEnrichment(next, token)
  } catch (err) {
    console.error('[useKnownProjects] scan failed:', err)
    if (token === scanToken) setState({ loading: false })
  }
}

function runEnrichment(rows: ProjectRow[], token: number): void {
  void mapWithConcurrency(rows, SCAN_CONCURRENCY, async (row) => {
    if (token !== scanToken) return
    try {
      const cwd = await resolveProjectCwd(row.path)
      if (token !== scanToken) return
      const details = cwd ? await enrichProject(cwd) : {}
      if (token !== scanToken) return
      setState({ enriched: { ...state.enriched, [row.encoded]: { cwd: cwd ?? null, ...details } } })
    } catch {
      if (token === scanToken) {
        setState({ enriched: { ...state.enriched, [row.encoded]: { cwd: null } } })
      }
    }
  })
}

/** Forces a fresh scan next tick — used after an out-of-band change (e.g. archive) that the cache can't infer on its own. */
export function refreshKnownProjects(): void {
  scannedForHome = null
}

export function useKnownProjects() {
  const home = useHomeDir()
  const [, forceRender] = useState(0)
  const addTab = useSessions((s) => s.addTab)

  useEffect(() => {
    const fn = () => forceRender((n) => n + 1)
    subscribers.add(fn)
    return () => { subscribers.delete(fn) }
  }, [])

  useEffect(() => {
    if (!home) return
    if (scannedForHome === home) return
    scannedForHome = home
    void runScan(home)
  }, [home])

  const { rows, enriched, loading } = state

  const openInSession = async (row: ProjectRow) => {
    let cwd = enriched[row.encoded]?.cwd ?? null
    if (!cwd) cwd = await resolveProjectCwd(row.path)
    if (!cwd) {
      cwd = await window.api.app.pickDirectory()
      if (!cwd) return
    }
    const id = crypto.randomUUID()
    // 'projects-tab' isn't a real entry in presets.ts, so restartTab's
    // findPreset lookup always misses and falls back to the plain
    // `claude --dangerously-skip-permissions --session-id <uuid>` command —
    // which is the correct restart behavior for these tabs anyway.
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
        setState({
          rows: state.rows.filter((r) => r.encoded !== encoded),
          enriched: Object.fromEntries(Object.entries(state.enriched).filter(([k]) => k !== encoded)),
        })
      }
      return result
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : 'Archive failed' }
    }
  }

  return { rows, enriched, loading, openInSession, archiveProject }
}
