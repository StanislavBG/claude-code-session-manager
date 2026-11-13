/**
 * Creates + starts the Session a Macro button stands for. Delegates mint -> approve ->
 * send to launchSession — the one path both SessionActionsBar (Sessions workspace) and
 * Project Home share for pressing a macro. Lifted out of SessionActionsBar.tsx
 * (PRD 1459) so Project Home can press macros through the same authority
 * instead of re-deriving it.
 *
 * Job macros (Project Home background builds) are gated on delegation readiness and a
 * strict missing-persona check, and reuse their active Epic. Job-less macros behave
 * identically on every surface — the same act as New Session (SINGLE-CREATOR LAW: born
 * proposed, approved by the press), always minting a new Epic.
 *
 * A persona at xhigh/max effort needs a window.confirm (macroCostNotice) before
 * minting; cancelling mints nothing.
 */
import { useState } from 'react'
import { usePromptSessions } from '../state/promptSessions'
import { useSessions } from '../state/sessions'
import { toast } from '../state/toast'
import { launchSession } from './launchSession'
import { macroCostNotice } from './macroCost'
import { defaultMacroValues, renderMacroPrompt } from './macroPrompt'
import type { AgentPersona, Macro } from '../../preload/api'

export function useMacroLaunch(
  onSelect: (id: string) => void,
  personas: AgentPersona[],
) {
  const activeTabCwd = useSessions((s) => s.tabs.find((t) => t.id === s.activeTabId)?.cwd ?? null)
  const [launching, setLaunching] = useState<string | null>(null)

  const launch = async (macro: Macro, extraInstructions?: string, inputValues?: Record<string, string>) => {
    if (!activeTabCwd || launching) return

    const findActive = () =>
      Object.values(usePromptSessions.getState().sessions).find(
        (s) => s.cwd === activeTabCwd && s.tag === macro.tag && s.agentType === macro.agentName && s.status === 'active',
      )

    const persona = personas.find((p) => p.name === macro.agentName)
    // Empty list = personas still loading (or none): proceed with a thinner
    // prompt rather than block. Once loaded, a missing agent must not mint.
    // Job macros tighten this: a missing persona blocks even while the list
    // is still empty, since that path must never mint on a guess.
    if (!persona && (personas.length > 0 || !!macro.job)) {
      toast.error(`Agent ${macro.agentName} not found — edit the macro`)
      return
    }

    const notice = macroCostNotice(macro, persona)
    if (notice && !window.confirm(`${notice.message} Continue?`)) return

    const rendered = renderMacroPrompt(macro.prompt, macro.inputs, inputValues ?? defaultMacroValues(macro.inputs))
    if (!rendered.ok) {
      toast.error(`Cannot start "${macro.label}" — ${rendered.error}`)
      return
    }

    setLaunching(macro.id)
    try {
      if (macro.job) {
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
      if (macro.job) {
        // Background build: reuse the macro's active Epic, else mint; never a chat turn, never navigate.
        const existing = findActive()
        if (existing) {
          const res = await window.api.macros.dispatchJob({
            cwd: activeTabCwd,
            macroId: macro.id,
            epicId: existing.id,
            extraInstructions: trimmedExtra || undefined,
          })
          if (!res.ok) throw new Error(res.error)
        } else {
          await launchSession({
            cwd: activeTabCwd,
            agentName: macro.agentName,
            tag: macro.tag,
            title: macro.label,
            goal: rendered.prompt,
            agentDescription: persona?.description ?? undefined,
            source: `SessionActionsBar ${macro.agentName}`,
            macroId: macro.id,
            run: 'job',
            extraInstructions: trimmedExtra || undefined,
          })
        }
        toast.success(`${macro.label} is building in the background`)
        return
      }
      const goal = trimmedExtra ? `${rendered.prompt}\n\nAdditional instructions: ${trimmedExtra}` : rendered.prompt
      const result = await launchSession({
        cwd: activeTabCwd,
        agentName: macro.agentName,
        tag: macro.tag,
        title: macro.label,
        goal,
        agentDescription: persona?.description ?? undefined,
        source: `SessionActionsBar ${macro.agentName}`,
        macroId: macro.id,
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
