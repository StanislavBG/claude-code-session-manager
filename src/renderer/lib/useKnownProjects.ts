import { useEffect, useMemo, useState } from 'react'
import { useSessions } from '../state/sessions'
import { enrichProject, type ProjectDetails } from './projectEnrichment'
import { useHomeDir } from './useHomeDir'
import {
  aggregateProjectsByCwd,
  countUnresolvedWorktreeFolders,
  normalizeCwd,
  ownerCandidateCwds,
  parseManagedWorktreeCwd,
  type ProjectAggregate,
} from './knownProjectAggregate'
import type { DirEntry } from '../../preload/api'

export interface ProjectRow {
  encoded: string
  displayPath: string
  sessionCount: number
  lastSession: number
  path: string
  sizeBytes: number
}

export interface RecentRow {
  sessionId: string
  projectEncoded: string
  path: string
  mtimeMs: number
  sizeBytes: number
}

/** How many newest transcripts the scan keeps for the Dashboard's Recent sessions. */
export const RECENT_SESSIONS_KEEP = 20

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

type JsonlRef = { path: string; size: number }

/** Smallest transcript first; return the first non-empty `cwd` string found in a line. */
async function resolveCwdFromJsonl(jsonl: readonly JsonlRef[]): Promise<string | null> {
  const ordered = [...jsonl].sort((a, b) => a.size - b.size)
  for (const f of ordered) {
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

export async function resolveProjectCwd(projectFolder: string): Promise<string | null> {
  const files = await window.api.config.listDir(projectFolder, { filesOnly: true })
  return resolveCwdFromJsonl((files.entries as DirEntry[]).filter((f) => f.name.endsWith('.jsonl')))
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
  /** Newest transcripts across every folder, taken from the scan's own listings. */
  recentSessions: RecentRow[]
  enriched: Record<string, EnrichmentState>
  loading: boolean
  /**
   * True while cwd resolution is still in flight. A project row only exists
   * once its cwd is known (see knownProjectAggregate.ts), so callers that
   * render "N projects" must distinguish "none yet" from "none, resolved".
   */
  resolving: boolean
}

let state: KnownProjectsState = { rows: [], recentSessions: [], enriched: {}, loading: true, resolving: true }
const subscribers = new Set<() => void>()
let scannedForHome: string | null = null
let scanToken = 0
let inFlight: Promise<void> | null = null
let lastScanFinishedAt = 0
/** encoded folder → resolved cwd; only non-null resolutions (failures live in unresolvedSignature). */
const resolvedCwdByEncoded = new Map<string, string>()
/**
 * encoded folder → `${sessionCount}:${lastSession}` of the scan whose cwd
 * resolution failed (null or threw). A later scan skips resolveProjectCwd
 * while the folder's signature is unchanged and retries once it differs.
 */
const unresolvedSignature = new Map<string, string>()
const signatureOf = (row: ProjectRow) => `${row.sessionCount}:${row.lastSession}`
/** Folders archived while a scan was in flight — dropped from that scan's publishes. */
const archivedDuringScan = new Set<string>()
/** Cwds `enrichProject` succeeded for — a refresh re-enriches them only when a folder of theirs got newer. */
const enrichedCwds = new Set<string>()

/** Unforced `refreshKnownProjects()` calls within this gap of the last finished scan are no-ops. */
export const KNOWN_PROJECTS_REFRESH_MIN_GAP_MS = 30_000

/**
 * A folder whose cached `row.lastSession` is within this window of now is
 * re-listed on every incremental rescan: a folder's directory mtime moves when
 * a transcript is added or removed, not when one is appended to.
 */
export const KNOWN_PROJECTS_ACTIVE_WINDOW_MS = 6 * 60 * 60 * 1000

type ScanMode = 'initial' | 'refresh'
/** 'full' lists every folder; 'incremental' re-lists only new, changed or recently active ones. */
type ListingMode = 'full' | 'incremental'

interface FolderListing {
  /** The folder's mtime from the root listing it was listed under. */
  dirMtimeMs: number
  row: ProjectRow
  /** That folder's newest RECENT_SESSIONS_KEEP transcripts, newest first. */
  recent: RecentRow[]
}
/** encoded folder → its last listing; refilled for every folder a scan lists. */
const folderCache = new Map<string, FolderListing>()
/** `Date.now()` taken before the root listing of the last scan that completed; 0 = none. */
let lastListingStartedAt = 0

function canReuseListing(e: DirEntry, cached: FolderListing | undefined, now: number): cached is FolderListing {
  if (!cached || lastListingStartedAt === 0) return false
  if (typeof e.mtimeMs !== 'number' || !Number.isFinite(e.mtimeMs)) return false
  if (e.mtimeMs >= lastListingStartedAt) return false
  if (now - cached.row.lastSession <= KNOWN_PROJECTS_ACTIVE_WINDOW_MS) return false
  return true
}

function notify() {
  subscribers.forEach((fn) => fn())
}

function setState(patch: Partial<KnownProjectsState>) {
  state = { ...state, ...patch }
  notify()
}

/**
 * Maps `sha1(cwd).hex.slice(0, 16)` → cwd — the same hash the main process uses
 * to name `session-manager-{job,epic}-worktrees/<hash>/` dirs — so a worktree
 * cwd can be folded into the project that owns it.
 */
export async function buildWorktreeOwnerMap(cwds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const enc = new TextEncoder()
  await Promise.all(
    cwds.map(async (cwd) => {
      const digest = await globalThis.crypto.subtle.digest('SHA-1', enc.encode(cwd))
      const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
      out.set(hex.slice(0, 16), cwd)
    }),
  )
  return out
}

// Shared owner map, keyed by the joined candidate list so it is recomputed only
// when the candidates change. Null until the first resolve: worktree rows are
// then absent rather than flashing in.
let ownerMap: ReadonlyMap<string, string> | null = null
let ownerMapKey: string | null = null

function ensureOwnerMap(candidates: string[]): void {
  const key = candidates.join('\n')
  if (key === ownerMapKey) return
  ownerMapKey = key
  void buildWorktreeOwnerMap(candidates)
    .then((map) => {
      if (key !== ownerMapKey) return
      ownerMap = map
      notify()
    })
    .catch((err) => {
      console.error('[useKnownProjects] owner map failed:', err)
    })
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

async function runScan(home: string, mode: ScanMode, listing: ListingMode): Promise<void> {
  const token = ++scanToken
  archivedDuringScan.clear()
  if (mode === 'initial') setState({ loading: true, resolving: true })
  try {
    const startedAt = Date.now()
    const r = await window.api.config.listDir(`${home}/.claude/projects`, { dirsOnly: true })
    if (token !== scanToken) return
    const entries = r.entries as DirEntry[]
    const listed = new Set(entries.map((e) => e.name))
    for (const key of [...folderCache.keys()]) if (!listed.has(key)) folderCache.delete(key)
    const recent: RecentRow[] = []
    // Scan-local: the .jsonl entries of every folder listed in THIS scan, so
    // cwd resolution never lists the same folder a second time.
    const jsonlByEncoded = new Map<string, JsonlRef[]>()
    const next = await mapWithConcurrency(entries, SCAN_CONCURRENCY, async (e): Promise<ProjectRow> => {
      const cached = folderCache.get(e.name)
      if (listing === 'incremental' && canReuseListing(e, cached, startedAt)) {
        recent.push(...cached.recent)
        return cached.row
      }
      const files = await window.api.config.listDir(e.path, { filesOnly: true })
      const jsonl = (files.entries as DirEntry[]).filter((f) => f.name.endsWith('.jsonl'))
      jsonlByEncoded.set(e.name, jsonl.map((f) => ({ path: f.path, size: f.size })))
      const folderRecent: RecentRow[] = jsonl.map((f) => ({
        sessionId: f.name.replace(/\.jsonl$/, ''),
        projectEncoded: e.name,
        path: f.path,
        mtimeMs: f.mtimeMs,
        sizeBytes: f.size,
      }))
      recent.push(...folderRecent)
      const lastSession = jsonl.reduce((m, f) => Math.max(m, f.mtimeMs), 0)
      const sizeBytes = jsonl.reduce((s, f) => s + f.size, 0)
      const row: ProjectRow = {
        encoded: e.name,
        displayPath: candidatePath(e.name),
        sessionCount: jsonl.length,
        lastSession,
        path: e.path,
        sizeBytes,
      }
      folderRecent.sort((a, b) => b.mtimeMs - a.mtimeMs)
      folderCache.set(e.name, { dirMtimeMs: e.mtimeMs, row, recent: folderRecent.slice(0, RECENT_SESSIONS_KEEP) })
      return row
    })
    if (token !== scanToken) return
    const rows = next.filter((row) => !archivedDuringScan.has(row.encoded))
    const recentKept = recent.filter((row) => !archivedDuringScan.has(row.projectEncoded))
    rows.sort((a, b) => b.lastSession - a.lastSession)
    const prevLastSession = new Map(state.rows.map((r) => [r.encoded, r.lastSession]))
    recentKept.sort((a, b) => b.mtimeMs - a.mtimeMs)
    if (mode === 'initial') {
      setState({
        rows,
        recentSessions: recentKept.slice(0, RECENT_SESSIONS_KEEP),
        enriched: {},
        loading: false,
        resolving: true,
      })
    } else {
      // Stale-while-revalidate: carry each still-listed folder's previous
      // enrichment over so resolved projects never blink out mid-rescan.
      const carried: Record<string, EnrichmentState> = {}
      for (const row of rows) {
        const prev = state.enriched[row.encoded]
        if (prev) carried[row.encoded] = prev
      }
      setState({
        rows,
        recentSessions: recentKept.slice(0, RECENT_SESSIONS_KEEP),
        enriched: carried,
        loading: false,
      })
    }
    await runEnrichment(rows, token, mode, prevLastSession, jsonlByEncoded)
    if (token === scanToken) {
      lastScanFinishedAt = Date.now()
      lastListingStartedAt = startedAt
    }
  } catch (err) {
    console.error('[useKnownProjects] scan failed:', err)
    if (mode === 'refresh') throw err
    if (token === scanToken) setState({ loading: false, resolving: false })
  }
}

function withoutArchived<T>(record: Record<string, T>): Record<string, T> {
  if (archivedDuringScan.size === 0) return record
  return Object.fromEntries(Object.entries(record).filter(([k]) => !archivedDuringScan.has(k)))
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
 *      projects on this machine. Managed worktree cwds are never enriched
 *      (their details are discarded by aggregateProjectsByCwd), a refresh
 *      re-enriches only new cwds or ones a folder of which got a newer
 *      transcript, and the stage publishes once after every read settles.
 */
async function runEnrichment(
  rows: ProjectRow[],
  token: number,
  mode: ScanMode,
  prevLastSession: ReadonlyMap<string, number>,
  jsonlByEncoded: ReadonlyMap<string, readonly JsonlRef[]>,
): Promise<void> {
  const cwdByEncoded: Record<string, string | null> = {}
  await mapWithConcurrency(rows, SCAN_CONCURRENCY, async (row) => {
    if (token !== scanToken) return
    // No transcript file ⇒ no cwd to recover; don't pay for a listDir round-trip.
    if (row.sessionCount === 0) { cwdByEncoded[row.encoded] = null; return }
    const cached = resolvedCwdByEncoded.get(row.encoded)
    if (cached) { cwdByEncoded[row.encoded] = cached; return }
    const signature = signatureOf(row)
    if (unresolvedSignature.get(row.encoded) === signature) { cwdByEncoded[row.encoded] = null; return }
    try {
      const listedJsonl = jsonlByEncoded.get(row.encoded)
      const cwd = listedJsonl ? await resolveCwdFromJsonl(listedJsonl) : await resolveProjectCwd(row.path)
      const normalized = cwd ? normalizeCwd(cwd) : null
      cwdByEncoded[row.encoded] = normalized
      if (normalized) {
        resolvedCwdByEncoded.set(row.encoded, normalized)
        unresolvedSignature.delete(row.encoded)
      } else {
        unresolvedSignature.set(row.encoded, signature)
      }
    } catch {
      cwdByEncoded[row.encoded] = null
      unresolvedSignature.set(row.encoded, signature)
    }
  })
  if (token !== scanToken) return

  const enriched: Record<string, EnrichmentState> = {}
  for (const row of rows) {
    const cwd = cwdByEncoded[row.encoded] ?? null
    const prev = mode === 'refresh' ? state.enriched[row.encoded] : undefined
    enriched[row.encoded] = { ...(prev && prev.cwd === cwd ? prev : {}), cwd }
  }
  setState({ enriched: withoutArchived(enriched), resolving: false })

  const uniqueCwds = [...new Set(Object.values(cwdByEncoded).filter((c): c is string => !!c))]
  const grownCwds = new Set<string>()
  for (const row of rows) {
    const cwd = cwdByEncoded[row.encoded]
    if (cwd && row.lastSession > (prevLastSession.get(row.encoded) ?? -1)) grownCwds.add(cwd)
  }
  const candidates = uniqueCwds.filter((cwd) => {
    if (parseManagedWorktreeCwd(cwd)) return false
    if (mode === 'initial') return true
    return !enrichedCwds.has(cwd) || grownCwds.has(cwd)
  })
  if (candidates.length === 0) return

  const detailsByCwd = new Map<string, ProjectDetails>()
  await mapWithConcurrency(candidates, SCAN_CONCURRENCY, async (cwd) => {
    if (token !== scanToken) return
    try {
      detailsByCwd.set(cwd, await enrichProject(cwd))
      enrichedCwds.add(cwd)
    } catch {
      // keep whatever details were carried over
    }
  })
  if (token !== scanToken || detailsByCwd.size === 0) return
  const patch = { ...state.enriched }
  for (const [encoded, cwd] of Object.entries(cwdByEncoded)) {
    const details = cwd ? detailsByCwd.get(cwd) : undefined
    if (cwd && details) patch[encoded] = { cwd, ...details }
  }
  setState({ enriched: withoutArchived(patch) })
}

/**
 * Re-runs the ~/.claude/projects scan as a stale-while-revalidate rescan: the
 * previous data stays published until the new data replaces it. Deduped
 * against any scan in flight; unforced calls within
 * KNOWN_PROJECTS_REFRESH_MIN_GAP_MS of the last finished scan are no-ops.
 * An unforced rescan re-lists only folders that are new, whose directory mtime
 * is at or after the previous listing's start, or that were active within
 * KNOWN_PROJECTS_ACTIVE_WINDOW_MS; the rest reuse `folderCache`. A forced
 * rescan (the Dashboard's Refresh button) re-lists every folder.
 * No-op before the hook has started a first scan. Rejects when the rescan
 * fails, leaving the previous state untouched.
 */
export function refreshKnownProjects(opts: { force?: boolean } = {}): Promise<void> {
  if (!scannedForHome) return Promise.resolve()
  if (inFlight) return inFlight
  if (!opts.force && Date.now() - lastScanFinishedAt < KNOWN_PROJECTS_REFRESH_MIN_GAP_MS) return Promise.resolve()
  inFlight = runScan(scannedForHome, 'refresh', opts.force ? 'full' : 'incremental').finally(() => { inFlight = null })
  return inFlight
}

/** Test-only reset — module state is shared across tests. */
export function __resetKnownProjectsForTests(): void {
  state = { rows: [], recentSessions: [], enriched: {}, loading: true, resolving: true }
  scannedForHome = null
  scanToken += 1
  inFlight = null
  lastScanFinishedAt = 0
  resolvedCwdByEncoded.clear()
  unresolvedSignature.clear()
  archivedDuringScan.clear()
  enrichedCwds.clear()
  folderCache.clear()
  lastListingStartedAt = 0
  ownerMap = null
  ownerMapKey = null
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
    inFlight = runScan(home, 'initial', 'full').finally(() => { inFlight = null })
  }, [home])

  const { rows, recentSessions, enriched, loading, resolving } = state

  // One row per unique cwd — the app's project identity. Every "list the
  // projects" surface consumes THIS, not `rows` (which is one entry per
  // ~/.claude/projects transcript folder and is only useful for folder-level
  // bookkeeping such as archiving).
  const candidates = useMemo(() => ownerCandidateCwds(rows, enriched), [rows, enriched])
  useEffect(() => { ensureOwnerMap(candidates) }, [candidates])
  const ownerByHash = ownerMap ?? new Map<string, string>()
  const projects = useMemo(
    () => aggregateProjectsByCwd(rows, enriched, ownerByHash),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, enriched, ownerMap],
  )
  const unresolvedWorktreeFolders = useMemo(
    () => countUnresolvedWorktreeFolders(rows, enriched, ownerByHash),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, enriched, ownerMap],
  )

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
        if (inFlight) archivedDuringScan.add(encoded)
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

  return { rows, recentSessions, enriched, projects, unresolvedWorktreeFolders, loading, resolving, openProject, openInSession, archiveProject, archiveProjectByCwd }
}
