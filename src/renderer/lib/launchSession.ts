/**
 * Mint -> approve -> send: the plain (non-React) path that creates and starts
 * the Session a macro press stands for. Shared by the desktop hook and, later,
 * the phone remote, so both start sessions through the same code.
 * Throws on bad input or store failure; callers own any toasting.
 */
import { usePromptSessions, awaitApprovePersisted } from '../state/promptSessions'
import { useChat } from '../state/chat'
import { composeEpicIntake } from './epicIntake'
import { defaultContextInjectionsForTag, resolveContextInjections } from './contextInjections'
import type { EpicTag } from './tagLibrary'
import type { EpicIntakeFields } from './epicIntake'
import type { PromptSessionsCreateEpicPayload } from '../../preload/api'

export interface LaunchSessionInput {
  cwd: string
  /** Persona to act as; absent = no agent (like the New Session card's default with no agent picked). */
  agentName?: string
  tag: EpicTag
  title: string
  goal: string
  agentDescription?: string
  source: string
  /** The macro whose press launched this session; stamped on the Epic's source. */
  macroId?: string
  /** An outside app's own id for this Epic; stamped on the Epic's source. */
  externalRef?: string
  /** 'job' queues the build via macros.dispatchJob instead of sending a chat turn. */
  run?: 'chat' | 'job'
  extraInstructions?: string
  /** run 'job' only: the press's {{name}} input values, forwarded to macros.dispatchJob. */
  inputValues?: Record<string, string>
  /** Per-launch effort chosen in the high-effort cost dialog; omitted keeps the persona's. */
  effort?: string
  /** Default true. false = mint only: the Epic stays proposed (no approve, no opening prompt, no job). */
  approve?: boolean
  /** 'external' = a script-typed opening prompt: never recorded as a verified human quote. Absent = 'human'. */
  origin?: 'external'
  /** A predecessor Epic's handoff note; becomes the opening prompt's Handoff input entry. */
  handoff?: EpicIntakeFields['handoff']
  /** Per-Epic model override; omitted keeps the persona's / Settings default. */
  model?: string
  /** Context packs loaded each turn (PromptSession.packs). */
  packs?: string[]
  /** Agent CLI for the Epic; absent = Claude Code. */
  agentCli?: PromptSessionsCreateEpicPayload['agentCli']
  /** Model for a non-Claude agent CLI. */
  agentCliModel?: string
  /** false = no PRDs for this Epic; absent/true keeps the default. */
  developLoop?: boolean
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
  const { cwd, agentName, tag, title, goal, agentDescription, source, macroId, externalRef, run, extraInstructions, inputValues, effort, approve = true, origin, handoff, model, packs, agentCli, agentCliModel, developLoop } = input
  if (!cwd) throw new Error('launchSession: cwd is required')
  // Absent = launch with no agent; an explicit empty name is a caller bug.
  if (agentName !== undefined && !agentName) throw new Error('launchSession: agentName must not be empty')
  if (!title) throw new Error('launchSession: title is required')
  if (!goal) throw new Error('launchSession: goal is required')

  const persona = agentName ? await resolvePersonaBody(cwd, agentName) : null
  const { goalText, openingPrompt, sections } = composeEpicIntake({
    title,
    goal,
    tag,
    ...(agentName ? { agentName, agentDescription } : {}),
    // No agent: the New Session card's agentless rule, not the per-tag default.
    contextInjections: agentName
      ? defaultContextInjectionsForTag(tag)
      : resolveContextInjections({ tag, agentless: true, developLoop: developLoop !== false }),
    ...(handoff ? { handoff } : {}),
    ...(persona ? { agentBody: persona.text, agentPath: persona.path } : {}),
  })
  const runtime = {
    ...(macroId ? { macroId } : {}),
    ...(typeof externalRef === 'string' && externalRef ? { externalRef } : {}),
    ...(effort ? { effort } : {}),
    ...(model ? { model } : {}),
    ...(packs ? { packs } : {}),
    ...(agentCli ? { agentCli } : {}),
    ...(agentCliModel ? { agentCliModel } : {}),
    ...(developLoop === false ? { developLoop: false } : {}),
  }
  const session = await usePromptSessions
    .getState()
    .createPromptSession(cwd, goalText, tag, source, agentName, openingPrompt, sections, ...(Object.keys(runtime).length ? [runtime] as const : []))
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
    const res = await window.api.macros.dispatchJob({ cwd, macroId, epicId: session.id, extraInstructions, ...(effort ? { effort } : {}), ...(inputValues ? { inputValues } : {}) })
    if (!res.ok) throw new Error(`"${title}" session was created but its build was not queued: ${res.error} — press it again to retry.`)
    return { epicId: session.id, claudeSessionId: session.claudeSessionId }
  }
  useChat.getState().send({
    tabId: session.id,
    sessionId: session.claudeSessionId,
    cwd,
    prompt: openingPrompt,
    ...(origin ? { origin } : {}),
  })
  return { epicId: session.id, claudeSessionId: session.claudeSessionId }
}
