/**
 * epicDraft — a human draft is just a 'proposed' Epic (no draft state). These
 * pure helpers derive the New Session form fields back out of the Epic's
 * existing fields (goalText + sections), so nothing new is persisted.
 */
import type { PromptSession } from '../state/promptSessions'
import { NO_AGENT } from '../components/epics/AgentPicker'
import { CONTEXT_INJECTION_ORDER, type ContextInjectionKey } from './contextInjections'
import { splitTitleAndGoal } from './epicDerive'
import { inboundFeedbackOrigin } from './epicOrigin'

export interface EpicDraftFields {
  title: string
  goal: string
  referencePaths: string[]
  tag: PromptSession['tag'] | null
  agentName: string
  model: string | undefined
  effort: string | undefined
  developLoop: boolean
  injections: Record<ContextInjectionKey, boolean>
}

/** True only for a proposed Epic a human saved here (cross-project proposals stay on EpicApprovalBar). */
export function isEditableDraft(epic: PromptSession): boolean {
  return epic.status === 'proposed' && inboundFeedbackOrigin(epic) === null
}

/** Reads the form fields back out of a saved Epic. O(n) in goalText + sections. */
export function draftFieldsFromEpic(epic: PromptSession): EpicDraftFields {
  const sections = epic.sections ?? []
  const refSections = sections.filter((s) => s.part === 'reference')
  const referencePaths = refSections.map((s) => s.source ?? '')

  const injectionKeys = new Set(sections.filter((s) => s.part === 'injection').map((s) => s.source))
  const injections = Object.fromEntries(
    CONTEXT_INJECTION_ORDER.map((k) => [k, injectionKeys.has(k)]),
  ) as Record<ContextInjectionKey, boolean>

  // Drop the trailing "Reference: <path>" block composeEpicIntake appended.
  let body = epic.goalText
  if (refSections.length > 0) {
    const tail = '\n\n' + refSections.map((s) => s.text).join('\n')
    if (body.endsWith(tail)) body = body.slice(0, -tail.length)
  }

  // composeEpicIntake prefixes the goal section with "Goal: " only when a title
  // exists; with sections present and no such prefix the whole body is the goal.
  const goalSection = sections.find((s) => s.part === 'goal')
  const hasTitle = !goalSection || goalSection.text.startsWith('Goal: ')
  const { title, goal } = hasTitle ? splitTitleAndGoal(body) : { title: '', goal: body }

  return {
    title,
    goal,
    referencePaths,
    tag: epic.tag ?? null,
    agentName: epic.agentType || NO_AGENT,
    model: epic.model,
    effort: epic.effort,
    developLoop: epic.developLoop !== false,
    injections,
  }
}

/** False when there is nothing worth saving: blank title + goal and no references. */
export function hasDraftContent({ title, goal, referenceCount }: { title: string; goal: string; referenceCount: number }): boolean {
  return title.trim() !== '' || goal.trim() !== '' || referenceCount > 0
}
