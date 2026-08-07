import { useEffect, useMemo, useState } from 'react'
import { useSessions } from '../state/sessions'
import { enrichProject, type ProjectDetails } from './projectEnrichment'
import { useHomeDir } from './useHomeDir'
import { aggregateProjectsByCwd, normalizeCwd, type ProjectAggregate } from './knownProjectAggregate'
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

// A transcript's `cwd` field appears in the very first JSONL record, so
// reading a small prefix is enough to resolve it — reading whole transcripts
// (some multi-MB) just to find that one line is what made the initial scan
// pay ~2000 whole-file reads across the IPC boundary.
export const CWD_RESOLVE_MAX_BYTES = 64 * 1024

export async function resolveProjectCwd(projectFolder: string): Promise<string | null> {
  const files = await window.api.config.listDir(projectFolder, { filesOnly: true })
  const jsonl = (files.entries as DirEntry[])
    .filter((f) => f.name.endsWith('.jsonl'))
    .sort((a, b) => a.size - b.size)
  for (const f of jsonl) {
    const r = await window.api.config.readText(f.path, { maxBytes: CWD_RESOLVE_MAX_BYTES })
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
  /**
   * True while cwd resolution is still in flight. A project row only exists
   * once its cwd is known (see knownProjectAggregate.ts), so callers that
   * render "N projects" must distinguish "none yet" from "none, resolved".
   */
  resolving: boolean
}

let state: KnownProjectsState = { rows: [], enriched: {}, loading: true, resolving: true }
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
  setState({ loading: true, resolving: true })
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
    setState({ rows: next, enriched: {}, loading: false, resolving: true })
    void runEnrichment(next, token)
  } catch (err) {
    console.error('[useKnownProjects] scan failed:', err)
    if (token === scanToken) setState({ loading: false, resolving: false })
  }
}

/**
 * Two-stage, because a project IS a cwd (knownProjectAggregate.ts) and many
 * transcript folders share — or never resolve to — one:
 *
 *   1. Resolve each folder's cwd from transcript content. Folders with no
 *      `.jsonl` at all are skipped outright (nothing to read a cwd from), and
 *      the whole stage publishes once so the UI doesn't thrash a row per file.
 *   2. Enrich the UNIQUE cwds only, then fan each result back out to every
 *      folder that resolved to it. This is the expensive stage (4 file reads
 *      per cwd) and running it per folder meant ~2000 enrichments for ~19 real
 *      projects on this machine.
 */
async function runEnrichment(rows: ProjectRow[], token: number): Promise<void> {
  const cwdByEncoded: Record<string, string | null> = {}
  await mapWithConcurrency(rows, SCAN_CONCURRENCY, async (row) => {
    if (token !== scanToken) return
    // No transcript file ⇒ no cwd to recover; don't pay for a listDir round-trip.
    if (row.sessionCount === 0) { cwdByEncoded[row.encoded] = null; return }
    try {
      const cwd = await resolveProjectCwd(row.path)
      cwdByEncoded[row.encoded] = cwd ? normalizeCwd(cwd) : null
    } catch {
      cwdByEncoded[row.encoded] = null
    }
  })
  if (token !== scanToken) return

  const enriched: Record<string, EnrichmentState> = {}
  for (const row of rows) enriched[row.encoded] = { cwd: cwdByEncoded[row.encoded] ?? null }
  setState({ enriched, resolving: false })

  const uniqueCwds = [...new Set(Object.values(cwdByEncoded).filter((c): c is string => !!c))]
  await mapWithConcurrency(uniqueCwds, SCAN_CONCURRENCY, async (cwd) => {
    if (token !== scanToken) return
    let details: ProjectDetails = {}
    try {
      details = await enrichProject(cwd)
    } catch {
      return
    }
    if (token !== scanToken) return
    const patch = { ...state.enriched }
    for (const [encoded, resolved] of Object.entries(cwdByEncoded)) {
      if (resolved === cwd) patch[encoded] = { cwd, ...details }
    }
    setState({ enriched: patch })
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

  const { rows, enriched, loading, resolving } = state

  // One row per unique cwd — the app's project identity. Every "list the
  // projects" surface consumes THIS, not `rows` (which is one entry per
  // ~/.claude/projects transcript folder and is only useful for folder-level
  // bookkeeping such as archiving).
  const projects = useMemo(() => aggregateProjectsByCwd(rows, enriched), [rows, enriched])

  const openProject = async (cwd: string) => {
    const id = crypto.randomUUID()
    // 'projects-tab' isn't a real entry in presets.ts — see openInSession.
    addTab({ id, cwd, startupCommand: null, presetId: 'projects-tab', dormant: true })
  }

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

  /**
   * Archives every transcript folder that resolved to this cwd — a project is
   * the cwd, so archiving it must not leave a sibling folder behind to
   * resurrect the row on the next scan.
   */
  const archiveProjectByCwd = async (project: ProjectAggregate): Promise<{ ok: boolean; error?: string }> => {
    let last: { ok: boolean; error?: string } = { ok: true }
    for (const encoded of project.encodedIds) {
      last = await archiveProject(encoded)
      if (!last.ok) return last
    }
    return last
  }

  return { rows, enriched, projects, loading, resolving, openProject, openInSession, archiveProject, archiveProjectByCwd }
}
