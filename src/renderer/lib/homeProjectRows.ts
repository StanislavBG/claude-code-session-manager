// Pure row-model for the Global Home Projects card. Joins known-project rows
// against running chats (keyed by Epic id) via each Epic's cwd, so "N live"
// reflects real in-flight work rather than just recency. Kept dependency-free
// (plain shapes, no store imports) so it is unit-testable without mocking
// zustand.
import type { ProjectRow, EnrichmentState } from './useKnownProjects'

export interface ChatSignalLite {
  running: boolean
}

export interface EpicSessionLite {
  cwd: string
}

export interface HomeProjectRow {
  encoded: string
  name: string
  cwd: string
  dotSeed: string
  liveCount: number
  lastActivityMs: number
}

export function projectNameFromCwd(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : cwd
}

/**
 * Builds display rows for the Projects card from `useKnownProjects` rows,
 * enrichment (resolved cwd per encoded project), running chats keyed by Epic
 * id, and Epic sessions keyed by Epic id (for cwd lookup). A project's
 * liveCount is the count of running chats whose Epic's cwd matches.
 */
export function buildHomeProjectRows(
  rows: ProjectRow[],
  enriched: Record<string, EnrichmentState | undefined>,
  chats: Record<string, ChatSignalLite>,
  sessions: Record<string, EpicSessionLite>,
): HomeProjectRow[] {
  const liveByCwd = new Map<string, number>()
  for (const epicId of Object.keys(chats)) {
    if (!chats[epicId]?.running) continue
    const cwd = sessions[epicId]?.cwd
    if (!cwd) continue
    liveByCwd.set(cwd, (liveByCwd.get(cwd) ?? 0) + 1)
  }

  return rows.map((row) => {
    const cwd = enriched[row.encoded]?.cwd ?? row.displayPath
    return {
      encoded: row.encoded,
      name: projectNameFromCwd(cwd),
      cwd,
      dotSeed: cwd,
      liveCount: liveByCwd.get(cwd) ?? 0,
      lastActivityMs: row.lastSession,
    }
  })
}
