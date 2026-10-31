/**
 * Full AIM opening prompt for an auto-started inbound Epic. The stored opening
 * prompt of a cross-project proposal carries input/goal/reference only (its
 * agentType sets model + effort, nothing else), so an auto-start would never
 * tell the architect to act as one. Composed here through composeEpicIntake.
 * Deliberately does not import launchSession.ts (import cycle via state/chat).
 */
import type { PromptSession } from '../state/promptSessions'
import { composeEpicIntake, type EpicIntakeSection } from './epicIntake'
import { defaultContextInjectionsForTag } from './contextInjections'

export interface InboundOpening {
  openingPrompt: string
  sections: EpicIntakeSection[]
}

/** Never throws; null when there is nothing stored to compose from or any lookup fails. */
export async function composeInboundOpening(epic: PromptSession): Promise<InboundOpening | null> {
  try {
    const stored = epic.sections
    if (!stored || stored.length === 0) return null
    const goal = stored.find((s) => s.kind === 'goal')?.text
    if (!goal) return null
    const inputSummary = stored.find((s) => s.kind === 'input')?.text
    const referencePaths = stored
      .filter((s) => s.kind === 'reference')
      .map((s) => s.source ?? s.text.replace(/^Reference:\s*/, ''))

    let agentName: string | undefined
    let agentDescription: string | undefined
    let agentBody: string | undefined
    let agentPath: string | undefined
    if (epic.agentType) {
      const personas = await window.api.agents.listPersonas()
      const persona = personas.find((p) => p.name === epic.agentType)
      if (persona?.description) {
        agentName = persona.name
        agentDescription = persona.description
      }
      const body = await window.api.agents.getPersonaBody({ cwd: epic.cwd, name: epic.agentType })
      if (body) {
        agentBody = body.text
        agentPath = body.path
      }
    }

    const intake = composeEpicIntake({
      title: '',
      goal,
      referencePaths,
      tag: epic.tag,
      agentName,
      agentDescription,
      agentBody,
      agentPath,
      inputSummary,
      contextInjections: epic.tag ? defaultContextInjectionsForTag(epic.tag) : undefined,
    })
    return { openingPrompt: intake.openingPrompt, sections: intake.sections }
  } catch {
    return null
  }
}
