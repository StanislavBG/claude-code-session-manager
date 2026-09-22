import { useHomeDir } from './useHomeDir'
import { useConfigDirWatch } from './useConfigDirWatch'

/**
 * Shared by AgentLibrary.tsx and TagLibrary.tsx — both list personas from
 * ~/.claude/agents but only ever hear about an EXTERNAL edit to that
 * directory via this watch: agents:changed (window.api.agents.onChanged) is
 * a write-echo of this app's OWN save/delete only. `activeCwd` is optional —
 * AgentLibrary passes the active project's overlay dir; TagLibrary (a
 * Home-face, machine-wide-only screen, per its own docblock) passes null.
 */
export function useAgentsDirWatch(activeCwd: string | null, onChange: () => void) {
  const home = useHomeDir()
  useConfigDirWatch(
    [home ? `${home}/.claude/agents` : null, activeCwd ? `${activeCwd}/.claude/agents` : null],
    onChange,
  )
}
