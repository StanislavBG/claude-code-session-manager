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

/**
 * Folds the per-transcript-folder rows into one row per unique cwd.
 *
 * - A row with no resolved cwd (`enriched[encoded].cwd` missing/null/empty) is
 *   dropped — see the module header for why we never fall back to a guess.
 * - Folders sharing a cwd merge: counts and bytes sum, `lastSession` takes the
 *   max, and the folder with the newest activity becomes the representative
 *   (its `encoded` and enrichment details are the ones surfaced).
 * - Output is sorted most-recently-active first, matching the scan order.
 */
export function aggregateProjectsByCwd(
  rows: ProjectRow[],
  enriched: Record<string, EnrichmentState | undefined>,
): ProjectAggregate[] {
  const byCwd = new Map<string, ProjectAggregate>()

  for (const row of rows) {
    const raw = enriched[row.encoded]?.cwd
    if (typeof raw !== 'string' || raw.trim() === '') continue
    const cwd = normalizeCwd(raw)
    if (!cwd) continue

    const details = detailsOf(enriched[row.encoded])
    const existing = byCwd.get(cwd)
    if (!existing) {
      byCwd.set(cwd, {
        cwd,
        name: projectNameFromCwd(cwd),
        encoded: row.encoded,
        encodedIds: [row.encoded],
        sessionCount: row.sessionCount,
        sizeBytes: row.sizeBytes,
        lastSession: row.lastSession,
        details,
      })
      continue
    }

    existing.encodedIds.push(row.encoded)
    existing.sessionCount += row.sessionCount
    existing.sizeBytes += row.sizeBytes
    // Representative = newest folder, so `details`/`encoded` describe live state.
    if (row.lastSession > existing.lastSession) {
      existing.encoded = row.encoded
      existing.details = details
    }
    existing.lastSession = Math.max(existing.lastSession, row.lastSession)
  }

  return [...byCwd.values()].sort((a, b) => b.lastSession - a.lastSession)
}

function detailsOf(state: EnrichmentState | undefined): ProjectDetails {
  if (!state) return {}
  const { cwd: _cwd, ...details } = state
  return details
}
