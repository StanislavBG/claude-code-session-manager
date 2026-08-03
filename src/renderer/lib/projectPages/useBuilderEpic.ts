/**
 * Shared "Generate My Project Home" mechanism — creates or resumes a single
 * `project-home-builder`-tagged Epic for the active project. Lifted out of
 * ProjectPagesSection.tsx (PRD 932) so ProjectHome.tsx's one primary generate
 * action and ProjectPagesSection's lens viewer both drive the exact same
 * find-or-create path (architecture spec's "resume, don't duplicate" rule)
 * instead of two divergent copies.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePromptSessions, type PromptSession } from '../../state/promptSessions'
import { useChat } from '../../state/chat'
import { composeEpicIntake } from '../epicIntake'
import { setPendingPromptSessionId } from '../promptSessionDeepLink'

export const BUILDER_TAG = 'project-home-builder' as const
export const BUILDER_AGENT_NAME = 'project-home-builder' as const
const GENERATE_GOAL = "Generate this project's Project Pages (Home/Marketing/Feature/Architecture/Brief)."

export function findActiveBuilderEpic(sessions: Record<string, PromptSession>, cwd: string): PromptSession | null {
  for (const session of Object.values(sessions)) {
    if (session.cwd === cwd && session.tag === BUILDER_TAG && session.status === 'active') return session
  }
  return null
}

export function navigateToBuilderEpic(epicId: string): void {
  setPendingPromptSessionId(epicId)
  window.dispatchEvent(new CustomEvent('sm:navigate', { detail: 'terminal' }))
}

export function useBuilderEpic(cwd: string | null) {
  const sessions = usePromptSessions((s) => s.sessions)
  const createPromptSession = usePromptSessions((s) => s.createPromptSession)
  const approveProposed = usePromptSessions((s) => s.approveProposed)

  // The registered Agent Library persona (~/.claude/agents/project-home-builder.md,
  // overlaid by this repo's own .claude/agents/project-home-builder.md) this
  // Epic is bound to — resolved once so the generate action names a real
  // "who" in the opening prompt instead of leaving the Epic on the unnamed
  // default persona.
  const [builderPersona, setBuilderPersona] = useState<{ name: string; description: string | null } | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api.agents
      .listPersonas()
      .then((list) => {
        if (cancelled) return
        const found = list.find((a) => a.name === BUILDER_AGENT_NAME)
        setBuilderPersona(found ? { name: found.name, description: found.description } : null)
      })
      .catch(() => {
        if (!cancelled) setBuilderPersona(null)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const existingBuilderEpic = useMemo(
    () => (cwd ? findActiveBuilderEpic(sessions, cwd) : null),
    [sessions, cwd],
  )

  const generate = useCallback(async () => {
    if (!cwd) return
    if (existingBuilderEpic) {
      navigateToBuilderEpic(existingBuilderEpic.id)
      return
    }
    // Same create-and-start path New Epic uses (NewEpicCard.tsx): goalText
    // and openingPrompt come from the one composer so the Epic's stored
    // identity and what the agent reads can't drift; createPromptSession is
    // born 'proposed' then immediately approved, matching the domain model's
    // single proposed->active transition rather than a second creation kind.
    const { goalText, openingPrompt } = composeEpicIntake({
      title: '',
      goal: GENERATE_GOAL,
      tag: BUILDER_TAG,
      agentName: builderPersona?.name,
      agentDescription: builderPersona?.description ?? undefined,
    })
    const session = builderPersona
      ? await createPromptSession(cwd, goalText, BUILDER_TAG, 'ProjectHome', builderPersona.name)
      : await createPromptSession(cwd, goalText, BUILDER_TAG, 'ProjectHome')
    approveProposed(session.id, 'ProjectHome')
    useChat.getState().send({
      tabId: session.id,
      sessionId: session.claudeSessionId,
      cwd,
      prompt: openingPrompt,
    })
    navigateToBuilderEpic(session.id)
  }, [existingBuilderEpic, createPromptSession, approveProposed, cwd, builderPersona])

  return { existingBuilderEpic, generate }
}
