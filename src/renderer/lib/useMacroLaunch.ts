/**
 * Creates + starts the Session a Macro button stands for. Delegates mint -> approve ->
 * send to launchSession — the one path both SessionActionsBar (Sessions workspace) and
 * Project Home share for pressing a macro. Lifted out of SessionActionsBar.tsx
 * (PRD 1459) so Project Home can press macros through the same authority
 * instead of re-deriving it.
 *
 * Two opt-in behaviours, ported from the old Project Home "Generate" action
 * (useBuilderEpic.ts, removed by project-home-macro-buttons):
 *   - `resumeActive` — resume an already-active Epic for the same
 *     (cwd, agentName, tag) instead of minting a duplicate.
 *   - `requireReadiness` — refuse to mint when the persona is missing or
 *     `window.api.app.delegationReadiness` reports not-ready.
 * Both default off, so SessionActionsBar's own byte-for-byte behaviour is
 * unaffected by their existence.
 */
import { useState } from 'react'
import { usePromptSessions } from '../state/promptSessions'
import { useSessions } from '../state/sessions'
import { toast } from '../state/toast'
import { launchSession } from './launchSession'
import type { AgentPersona, Macro } from '../../preload/api'

export function useMacroLaunch(
  onSelect: (id: string) => void,
  personas: AgentPersona[],
  opts?: { resumeActive?: boolean; requireReadiness?: boolean },
) {
  const activeTabCwd = useSessions((s) => s.tabs.find((t) => t.id === s.activeTabId)?.cwd ?? null)
  const [launching, setLaunching] = useState<string | null>(null)

  const launch = async (macro: Macro, extraInstructions?: string) => {
    if (!activeTabCwd || launching) return

    if (opts?.resumeActive) {
      const sessions = usePromptSessions.getState().sessions
      const existing = Object.values(sessions).find(
        (s) => s.cwd === activeTabCwd && s.tag === macro.tag && s.agentType === macro.agentName && s.status === 'active',
      )
      if (existing) {
        onSelect(existing.id)
        return
      }
    }

    const persona = personas.find((p) => p.name === macro.agentName)
    // Empty list = personas still loading (or none): proceed with a thinner
    // prompt rather than block. Once loaded, a missing agent must not mint.
    // requireReadiness tightens this: a missing persona blocks even while
    // the list is still empty, since that path must never mint on a guess.
    if (!persona && (personas.length > 0 || opts?.requireReadiness)) {
      toast.error(`Agent ${macro.agentName} not found — edit the macro`)
      return
    }

    setLaunching(macro.id)
    try {
      if (opts?.requireReadiness) {
        let readiness: Awaited<ReturnType<typeof window.api.app.delegationReadiness>>
        try {
          readiness = await window.api.app.delegationReadiness(activeTabCwd)
        } catch (err) {
          toast.error(
            `Cannot start "${macro.label}" — could not check delegation readiness: ${err instanceof Error ? err.message : String(err)}`,
          )
          return
        }
        if (!readiness.ok) {
          const reasons = readiness.checks
            .filter((c) => !c.ok)
            .map((c) => c.label)
            .join('; ')
          toast.error(`Cannot start "${macro.label}" — delegation isn't ready (${reasons || 'unknown reason'}).`)
          return
        }
      }

      const trimmedExtra = extraInstructions?.trim()
      const goal = trimmedExtra ? `${macro.prompt}\n\nAdditional instructions: ${trimmedExtra}` : macro.prompt
      const result = await launchSession({
        cwd: activeTabCwd,
        agentName: macro.agentName,
        tag: macro.tag,
        title: macro.label,
        goal,
        agentDescription: persona?.description ?? undefined,
        source: `SessionActionsBar ${macro.agentName}`,
      })
      onSelect(result.epicId)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setLaunching(null)
    }
  }

  return { launch, launching, cwd: activeTabCwd }
}
