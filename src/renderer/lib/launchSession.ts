/**
 * Mint -> approve -> send: the plain (non-React) path that creates and starts
 * the Session a macro press stands for. Shared by the desktop hook and, later,
 * the phone remote, so both start sessions through the same code.
 * Throws on bad input or store failure; callers own any toasting.
 */
import { usePromptSessions } from '../state/promptSessions'
import { useChat } from '../state/chat'
import { composeEpicIntake } from './epicIntake'
import type { EpicTag } from './tagLibrary'

export interface LaunchSessionInput {
  cwd: string
  agentName: string
  tag: EpicTag
  title: string
  goal: string
  agentDescription?: string
  source: string
}

export async function launchSession(input: LaunchSessionInput): Promise<{ epicId: string; claudeSessionId: string }> {
  const { cwd, agentName, tag, title, goal, agentDescription, source } = input
  if (!cwd) throw new Error('launchSession: cwd is required')
  if (!agentName) throw new Error('launchSession: agentName is required')
  if (!title) throw new Error('launchSession: title is required')
  if (!goal) throw new Error('launchSession: goal is required')

  const { goalText, openingPrompt, sections } = composeEpicIntake({ title, goal, tag, agentName, agentDescription })
  const session = await usePromptSessions
    .getState()
    .createPromptSession(cwd, goalText, tag, source, agentName, openingPrompt, sections)
  usePromptSessions.getState().approveProposed(session.id, source)
  useChat.getState().send({
    tabId: session.id,
    sessionId: session.claudeSessionId,
    cwd,
    prompt: openingPrompt,
  })
  return { epicId: session.id, claudeSessionId: session.claudeSessionId }
}
