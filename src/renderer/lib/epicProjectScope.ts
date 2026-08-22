import { normalizeCwd } from './knownProjectAggregate'

/**
 * A PROJECT IS A TAB'S CWD (see CLAUDE.md's TAB/EPIC domain model).
 *
 * `useKnownProjects()` is derived from `~/.claude/projects/`, which is a store
 * of TRANSCRIPTS, not a registry of projects (lib/knownProjectAggregate.ts): a
 * folder only appears there once the CLI has actually written a session for
 * that cwd. So a project opened for the FIRST time — the exact moment someone
 * presses "New Session" in it — is legitimately absent from that list.
 *
 * Treating the transcript-derived list as the authority is what made the New
 * Session card fall through to `knownCwds[0]` and silently open the session
 * against a DIFFERENT project, which then had to be migrated by hand. The tab
 * IS the answer; nothing may override it and there is nothing to select.
 */
export function resolveEpicProject(input: {
  picked?: string | null
  activeTabCwd?: string | null
  knownCwds: string[]
}): { cwd: string; showSelector: boolean } {
  const active = input.activeTabCwd ? normalizeCwd(input.activeTabCwd) : ''
  if (active) return { cwd: active, showSelector: false }
  const picked = input.picked ? normalizeCwd(input.picked) : ''
  return { cwd: picked || input.knownCwds[0] || '', showSelector: true }
}

/**
 * Every cwd whose Epics a workspace must hydrate/watch: the transcript-derived
 * projects PLUS the cwd currently on screen, for the same reason as above — a
 * brand-new project's Epics would otherwise never load off disk.
 */
export function epicProjectCwds(knownCwds: string[], activeCwd?: string | null): string[] {
  const out = knownCwds.map(normalizeCwd).filter(Boolean)
  const active = activeCwd ? normalizeCwd(activeCwd) : ''
  if (active && !out.includes(active)) out.push(active)
  return out
}
