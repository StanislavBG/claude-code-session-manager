/**
 * Continue an Epic in a fresh session: a new Session with the same agent,
 * Mission, model, effort, packs and goal, whose opening prompt carries a short
 * handoff (epicHandoff.ts) instead of the old session's whole history.
 * Created through launchSession -> window.api.promptSessions.create, the
 * normal New Session path, on a human press. The old Epic is left untouched.
 * Throws when the Epic is not in the store; callers own any toasting.
 */
import { usePromptSessions, emitAuditEvent } from '../state/promptSessions'
import { launchSession } from './launchSession'
import { buildEpicHandoff, summarizePrdOutcomes } from './epicHandoff'
import { splitTitleAndGoal } from './epicDerive'
import type { EpicTag } from './tagLibrary'
import type { LaunchSessionInput } from './launchSession'

async function readLastAssistantText(cwd: string, epicId: string): Promise<string | null> {
  try {
    const { turns } = await window.api.promptSessionTranscript.read(cwd, epicId)
    for (let i = (turns?.length ?? 0) - 1; i >= 0; i--) {
      const t = turns[i]
      if (t?.role === 'assistant' && typeof t.text === 'string' && t.text.trim()) return t.text
    }
    return null
  } catch (err) {
    console.warn(`continueEpicFresh: transcript unreadable for ${epicId}`, err)
    return null
  }
}

export async function continueEpicFresh(epicId: string, source: string): Promise<string> {
  const state = usePromptSessions.getState()
  const epic = state.sessions[epicId]
  if (!epic) throw new Error(`Cannot continue: no session with id "${epicId}" is loaded.`)

  if (!epic.agentType) {
    throw new Error(`Cannot continue session "${epicId}": it has no agent saved, so there is no agent to start the new session with.`)
  }
  const { title, goal: splitGoal } = splitTitleAndGoal(epic.goalText)
  // Older Epics have no blank line in goalText: the whole text is the title,
  // and launchSession needs a goal, so the title stands in for it.
  const goal = splitGoal.trim() ? splitGoal : title
  const lastAssistantText = await readLastAssistantText(epic.cwd, epicId)
  const handoff = buildEpicHandoff({
    fromEpicId: epicId,
    title,
    lastAssistantText,
    outcomes: summarizePrdOutcomes(state.events[epicId]),
  })

  const { epicId: newId } = await launchSession({
    cwd: epic.cwd,
    agentName: epic.agentType,
    tag: epic.tag as EpicTag,
    title,
    goal,
    source,
    handoff: { fromEpicId: epicId, text: handoff },
    ...(epic.model ? { model: epic.model } : {}),
    ...(epic.effort ? { effort: epic.effort } : {}),
    ...(epic.packs ? { packs: epic.packs } : {}),
    ...(epic.agentCli ? { agentCli: epic.agentCli as LaunchSessionInput['agentCli'] } : {}),
    ...(epic.agentCliModel ? { agentCliModel: epic.agentCliModel } : {}),
    ...(epic.developLoop === false ? { developLoop: false } : {}),
  })
  emitAuditEvent('epic_continue', { cwd: epic.cwd, epicId: newId, fromEpicId: epicId, source })
  return newId
}
