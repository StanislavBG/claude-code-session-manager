import { useHomeDir } from './useHomeDir'
import { useConfigDirWatch } from './useConfigDirWatch'

/**
 * Shared by AgentLibrary.tsx and TagLibrary.tsx — both list personas from
 * ~/.claude/agents but only ever hear about an EXTERNAL edit to that
 * directory via this watch: agents:changed (window.api.agents.onChanged) is
 * a write-echo of this app's OWN save/delete only. Always watches
 * `~/.claude/agents`, plus `<cwd>/.claude/agents` for each of `projectCwds`:
 * AgentLibrary passes every open project's cwd (any of them can carry an
 * overlay it lists and edits); TagLibrary (a Home-face, machine-wide-only
 * screen, per its own docblock) passes `[]`. useConfigDirWatch keys on the
 * path set's content, so a rebuilt array with the same cwds never re-watches.
 */
export function useAgentsDirWatch(projectCwds: readonly string[], onChange: () => void) {
  const home = useHomeDir()
  useConfigDirWatch(
    [home ? `${home}/.claude/agents` : null, ...projectCwds.map((cwd) => `${cwd}/.claude/agents`)],
    onChange,
  )
}
