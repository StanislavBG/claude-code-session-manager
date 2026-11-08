/**
 * Mint -> approve -> send: the plain (non-React) path that creates and starts
 * the Session a macro press stands for. Shared by the desktop hook and, later,
 * the phone remote, so both start sessions through the same code.
 * Throws on bad input or store failure; callers own any toasting.
 */
import { usePromptSessions, awaitApprovePersisted } from '../state/promptSessions'
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
  /** 'job' queues the build via macros.dispatchJob instead of sending a chat turn. */
  run?: 'chat' | 'job'
  extraInstructions?: string
  /** Default true. false = mint only: the Epic stays proposed (no approve, no opening prompt, no job). */
  approve?: boolean
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
  const { cwd, agentName, tag, title, goal, agentDescription, source, macroId, run, extraInstructions, approve = true } = input
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
  if (!approve) return { epicId: session.id, claudeSessionId: session.claudeSessionId }
  usePromptSessions.getState().approveProposed(session.id, source)
  if (run === 'job') {
    if (!macroId) throw new Error("launchSession: run 'job' requires macroId")
    // main's dispatch-job checks active-index.json; dispatching before the
    // approve write lands is refused ("not an active session"), so wait for it.
    try {
      await awaitApprovePersisted(session.id)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`"${title}" session was created but its build was not queued (approval not saved: ${msg}) — press it again to retry.`)
    }
    const res = await window.api.macros.dispatchJob({ cwd, macroId, epicId: session.id, extraInstructions })
    if (!res.ok) throw new Error(`"${title}" session was created but its build was not queued: ${res.error} — press it again to retry.`)
    return { epicId: session.id, claudeSessionId: session.claudeSessionId }
  }
  useChat.getState().send({
    tabId: session.id,
    sessionId: session.claudeSessionId,
    cwd,
    prompt: openingPrompt,
  })
  return { epicId: session.id, claudeSessionId: session.claudeSessionId }
}
