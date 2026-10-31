/**
 * Mint -> approve -> send: the plain (non-React) path that creates and starts
 * the Session a macro press stands for. Shared by the desktop hook and, later,
 * the phone remote, so both start sessions through the same code.
 * Throws on bad input or store failure; callers own any toasting.
 */
import { usePromptSessions } from '../state/promptSessions'
import { useChat } from '../state/chat'
import { composeEpicIntake } from './epicIntake'
import { defaultContextInjectionsForTag } from './contextInjections'
import type { EpicTag } from './tagLibrary'

export interface LaunchSessionInput {
  cwd: string
  agentName: string
  tag: EpicTag
  title: string
  goal: string
  agentDescription?: string
  source: string
  /** The macro whose press launched this session; stamped on the Epic's source. */
  macroId?: string
}

/**
 * Resolve the persona body + path for (agentName, cwd) via the same
 * window.api call NewEpicCard uses. Best-effort: any failure warns once and
 * returns null so the caller composes today's prompt without a body section.
 */
export async function resolvePersonaBody(
  cwd: string,
  agentName: string,
): Promise<{ text: string; path: string } | null> {
  try {
    const body = await window.api.agents.getPersonaBody({ cwd, name: agentName })
    return body ? { text: body.text, path: body.path } : null
  } catch (err) {
    console.warn(`launchSession: persona body unreadable for ${agentName}`, err)
    return null
  }
}

export async function launchSession(input: LaunchSessionInput): Promise<{ epicId: string; claudeSessionId: string }> {
  const { cwd, agentName, tag, title, goal, agentDescription, source, macroId } = input
  if (!cwd) throw new Error('launchSession: cwd is required')
  if (!agentName) throw new Error('launchSession: agentName is required')
  if (!title) throw new Error('launchSession: title is required')
  if (!goal) throw new Error('launchSession: goal is required')

  const persona = await resolvePersonaBody(cwd, agentName)
  const { goalText, openingPrompt, sections } = composeEpicIntake({
    title,
    goal,
    tag,
    agentName,
    agentDescription,
    contextInjections: defaultContextInjectionsForTag(tag),
    ...(persona ? { agentBody: persona.text, agentPath: persona.path } : {}),
  })
  const session = await usePromptSessions
    .getState()
    .createPromptSession(cwd, goalText, tag, source, agentName, openingPrompt, sections, ...(macroId ? [{ macroId }] as const : []))
  usePromptSessions.getState().approveProposed(session.id, source)
  useChat.getState().send({
    tabId: session.id,
    sessionId: session.claudeSessionId,
    cwd,
    prompt: openingPrompt,
  })
  return { epicId: session.id, claudeSessionId: session.claudeSessionId }
}
