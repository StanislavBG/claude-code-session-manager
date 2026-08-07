// Pure row-model for the Global Home Projects card. Joins the unique-per-cwd
// project aggregates (lib/knownProjectAggregate.ts — one row per real working
// directory, never per ~/.claude/projects transcript folder) against running
// chats keyed by Epic id, via each Epic's cwd, so "N live" reflects real
// in-flight work rather than just recency. Kept dependency-free (plain shapes,
// no store imports) so it is unit-testable without mocking zustand.
import { normalizeCwd, type ProjectAggregate } from './knownProjectAggregate'

export { projectNameFromCwd } from './knownProjectAggregate'

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

/**
 * Builds display rows for the Projects card from the project aggregates,
 * running chats keyed by Epic id, and Epic sessions keyed by Epic id (for cwd
 * lookup). A project's liveCount is the count of running chats whose Epic's
 * cwd matches — compared on the normalized cwd so a stored trailing slash
 * doesn't silently drop the count.
 */
export function buildHomeProjectRows(
  projects: ProjectAggregate[],
  chats: Record<string, ChatSignalLite>,
  sessions: Record<string, EpicSessionLite>,
): HomeProjectRow[] {
  const liveByCwd = new Map<string, number>()
  for (const epicId of Object.keys(chats)) {
    if (!chats[epicId]?.running) continue
    const cwd = sessions[epicId]?.cwd
    if (!cwd) continue
    const key = normalizeCwd(cwd)
    liveByCwd.set(key, (liveByCwd.get(key) ?? 0) + 1)
  }

  return projects.map((p) => ({
    encoded: p.encoded,
    name: p.name,
    cwd: p.cwd,
    dotSeed: p.cwd,
    liveCount: liveByCwd.get(p.cwd) ?? 0,
    lastActivityMs: p.lastSession,
  }))
}
