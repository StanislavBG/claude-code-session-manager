/**
 * knownProjectAggregate.ts — the "a PROJECT is a CWD" rule, in one pure place.
 *
 * `~/.claude/projects/` is a directory of *transcript stores*, not a directory
 * of projects: the CLI mints one folder per encoded path it was ever launched
 * from, including throwaway `/tmp` dirs, scratch worktrees and test fixtures,
 * and more than one encoded folder can resolve back to the same working
 * directory. Treating those folders 1:1 as projects is what made Home report
 * "2044 PROJECTS" and list rows named `l2mclS` / `SrR7IF` — those aren't
 * projects, they're the last segment of a *fabricated* path produced by
 * `candidatePath`'s naive `-`→`/` decode of a folder whose real cwd never
 * resolved.
 *
 * So: the project identity is the resolved cwd (CLAUDE.md's TAB = file
 * location = Main Project), and this module is the only thing allowed to
 * decide it. Rows whose cwd could not be resolved from transcript content are
 * DROPPED rather than guessed at — a fabricated path is worse than no row,
 * since every downstream surface (open-in-tab, Epic hydrate, the New-epic
 * picker) would then act on a directory that doesn't exist.
 *
 * Managed worktrees (`.../session-manager-{job,epic}-worktrees/<16-hex>/<key>`)
 * are transcript stores of a scheduler job / Epic run, not projects. Each one
 * folds into its owning main project via a caller-supplied hash→cwd map (the
 * hash is sha1(owner cwd)[0:16], computed by the caller); a worktree whose
 * owner is unknown is dropped, never surfaced as its own row.
 *
 * Kept dependency-free (plain shapes, no store/window imports) so it is
 * unit-testable without mocking zustand or the IPC bridge.
 */
import type { ProjectRow, EnrichmentState } from './useKnownProjects'
import type { ProjectDetails } from './projectEnrichment'

export interface ProjectAggregate {
  /** Resolved working directory — the project's identity. Unique per row. */
  cwd: string
  /**
   * Display name: the cwd's last path segment. Deliberately NOT package.json's
   * `name` (that lives in `details.name`) — the project IS the directory, so
   * the label must stay the thing the user picked in the folder picker.
   */
  name: string
  /** Representative transcript folder (the most recently active one). */
  encoded: string
  /** Every `~/.claude/projects/<encoded>` folder that resolved to this cwd. */
  encodedIds: string[]
  /** Summed across every folder for this cwd. */
  sessionCount: number
  /** Summed across every folder for this cwd. */
  sizeBytes: number
  /** Max across every folder for this cwd. */
  lastSession: number
  /** Enrichment of the representative folder (git remote, branch, CLAUDE.md preview). */
  details: ProjectDetails
}

/**
 * Canonical form of a cwd for identity comparison: collapses repeated slashes
 * and strips trailing ones, so `/a/b`, `/a/b/` and `/a//b` are one project.
 * Root stays `/`.
 */
export function normalizeCwd(cwd: string): string {
  const collapsed = cwd.trim().replace(/\/{2,}/g, '/')
  if (collapsed === '/') return '/'
  return collapsed.replace(/\/+$/, '')
}

export function projectNameFromCwd(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : cwd
}

const MANAGED_WORKTREE_RE = /\/session-manager-(job|epic)-worktrees\/([0-9a-f]{16})\/[^/]+/

/** Recognises a scheduler-job / Epic git-worktree cwd (or any subdirectory of one). */
export function parseManagedWorktreeCwd(cwd: string): { kind: 'job' | 'epic'; hash: string } | null {
  const m = MANAGED_WORKTREE_RE.exec(normalizeCwd(cwd))
  return m ? { kind: m[1] as 'job' | 'epic', hash: m[2] } : null
}

function resolvedCwdOf(row: ProjectRow, enriched: Record<string, EnrichmentState | undefined>): string | null {
  const raw = enriched[row.encoded]?.cwd
  if (typeof raw !== 'string' || raw.trim() === '') return null
  return normalizeCwd(raw) || null
}

/** Number of transcript folders that resolve to a managed worktree with no owner in the map. */
export function countUnresolvedWorktreeFolders(
  rows: ProjectRow[],
  enriched: Record<string, EnrichmentState | undefined>,
  ownerByHash?: ReadonlyMap<string, string>,
): number {
  let n = 0
  for (const row of rows) {
    const cwd = resolvedCwdOf(row, enriched)
    const wt = cwd ? parseManagedWorktreeCwd(cwd) : null
    if (wt && !ownerByHash?.get(wt.hash)) n++
  }
  return n
}

/** Unique normalized resolved cwds that are not managed worktrees — the inputs a caller hashes into `ownerByHash`. */
export function ownerCandidateCwds(
  rows: ProjectRow[],
  enriched: Record<string, EnrichmentState | undefined>,
): string[] {
  const out = new Set<string>()
  for (const row of rows) {
    const cwd = resolvedCwdOf(row, enriched)
    if (cwd && !parseManagedWorktreeCwd(cwd)) out.add(cwd)
  }
  return [...out]
}

/**
 * Folds the per-transcript-folder rows into one row per unique cwd.
 *
 * - A row with no resolved cwd (`enriched[encoded].cwd` missing/null/empty) is
 *   dropped — see the module header for why we never fall back to a guess.
 * - Folders sharing a cwd merge: counts and bytes sum, `lastSession` takes the
 *   max, and the folder with the newest activity becomes the representative
 *   (its `encoded` and enrichment details are the ones surfaced).
 * - Managed-worktree rows fold into `ownerByHash.get(hash)`'s project (counts,
 *   bytes, lastSession, encodedIds) but never become its representative; with
 *   no owner they are dropped. An owner seen only via worktrees gets a row with
 *   `encoded: ''` and empty details.
 * - Output is sorted most-recently-active first, matching the scan order.
 */
export function aggregateProjectsByCwd(
  rows: ProjectRow[],
  enriched: Record<string, EnrichmentState | undefined>,
  ownerByHash?: ReadonlyMap<string, string>,
): ProjectAggregate[] {
  const byCwd = new Map<string, ProjectAggregate>()
  // Newest lastSession among the project's OWN folders (worktrees excluded);
  // absent = the entry exists only via worktree rows.
  const ownLast = new Map<string, number>()

  for (const row of rows) {
    const resolved = resolvedCwdOf(row, enriched)
    if (!resolved) continue

    const wt = parseManagedWorktreeCwd(resolved)
    let cwd = resolved
    if (wt) {
      const owner = ownerByHash?.get(wt.hash)
      if (!owner || !normalizeCwd(owner)) continue
      cwd = normalizeCwd(owner)
    }

    const details = wt ? {} : detailsOf(enriched[row.encoded])
    const existing = byCwd.get(cwd)
    if (!existing) {
      byCwd.set(cwd, {
        cwd,
        name: projectNameFromCwd(cwd),
        encoded: wt ? '' : row.encoded,
        encodedIds: [row.encoded],
        sessionCount: row.sessionCount,
        sizeBytes: row.sizeBytes,
        lastSession: row.lastSession,
        details,
      })
      if (!wt) ownLast.set(cwd, row.lastSession)
      continue
    }

    existing.encodedIds.push(row.encoded)
    existing.sessionCount += row.sessionCount
    existing.sizeBytes += row.sizeBytes
    existing.lastSession = Math.max(existing.lastSession, row.lastSession)
    if (wt) continue
    // Representative = newest OWN folder, so `details`/`encoded` describe live state.
    const prev = ownLast.get(cwd)
    if (prev === undefined || row.lastSession > prev) {
      existing.encoded = row.encoded
      existing.details = details
      ownLast.set(cwd, row.lastSession)
    }
  }

  return [...byCwd.values()].sort((a, b) => b.lastSession - a.lastSession)
}

function detailsOf(state: EnrichmentState | undefined): ProjectDetails {
  if (!state) return {}
  const { cwd: _cwd, ...details } = state
  return details
}
