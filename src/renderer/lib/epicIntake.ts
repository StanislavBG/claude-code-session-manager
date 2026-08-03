/**
 * epicIntake — turns the New Epic form's fields into the two strings a new
 * Epic needs, from one source so they can never disagree:
 *
 *   - `goalText`      — the Epic's stored identity (what the queue, Scheduler
 *                       chips and composer header display).
 *   - `openingPrompt` — the first message sent into the Epic's claude session
 *                       automatically at creation, so the Epic opens already
 *                       waiting on the agent instead of on the user retyping
 *                       what they just entered.
 *
 * The title is the session's GOAL; the sub-header (goal field) is the FIRST
 * INSTRUCTION. References are appended as trailing lines to both.
 */

import { agentTagDef } from './agentTagDefs'
import { CONTEXT_INJECTIONS } from './contextInjections'
import type { TicketTag } from './ticketDisplay'

export interface EpicIntakeFields {
  /** Epic title — optional; becomes the session's goal line. */
  title: string
  /** The objective / first instruction. Required (the form gates on it). */
  goal: string
  /** Absolute paths of attached references. */
  referencePaths?: string[]
  /**
   * The Epic's single mission tag. When given, its `initialPromptTemplate`
   * (agentTagDefs.ts) is prepended to `openingPrompt` only — `goalText`
   * stays the pure user objective, since that's what's displayed as the
   * Epic's identity in Scheduler chips / the composer header.
   */
  tag?: TicketTag
  /** Name of the Agent Library persona (`~/.claude/agents/<name>.md`) chosen
   *  to run this Epic, distinct from `tag` above. When given along with
   *  `agentDescription`, a framing line names the persona before the tag's
   *  mission template — the persona is the "who", the tag is the "what". */
  agentName?: string
  /** The persona's one-line description (AgentPersona.description), shown
   *  alongside `agentName` in the framing line. Omitted from the framing
   *  line entirely when either is absent. */
  agentDescription?: string
  /**
   * AIM's "Input" axis, stated explicitly: one line naming what's grounding
   * this session (System/Project/Local CLAUDE.md, skills, mcp servers, etc.),
   * from `groundingBoard.ts`'s `summarizeGroundingBoard`. Placed after the
   * Actor line and before the Mission template — who, then what they're
   * standing on, then what they're here to do. Omitted entirely when absent
   * (e.g. callers that never computed a grounding board, like EpicQueue's
   * scripted 'build' Epic).
   */
  inputSummary?: string
  /**
   * Context Injections (contextInjections.ts) — Session-Manager-authored
   * text, independent of Actor/Input/Mission, each an explicit on/off toggle
   * in the New Epic card's advanced grounding board. `true` includes that
   * key's `text` right after the Actor line (extends "who's acting" with
   * "how they generally behave" before Input/Mission). Defaults to omitted
   * (no injection) for callers that don't pass it — e.g. EpicQueue's
   * scripted 'build' Epic.
   */
  contextInjections?: Partial<Record<keyof typeof CONTEXT_INJECTIONS, boolean>>
}

/**
 * One labeled slice of the opening prompt, in emission order — the same data
 * composeEpicIntake already has in hand while concatenating, kept around
 * instead of discarded so callers can render a structured AIM briefing card
 * instead of re-parsing the flat `openingPrompt` string. `source` names the
 * thing that produced this section's text (persona name / injection key /
 * tag / reference path) where one exists, for a card subtitle.
 */
export interface EpicIntakeSection {
  kind: 'actor' | 'injection' | 'input' | 'mission' | 'goal' | 'reference'
  label: string
  text: string
  source?: string
}

export interface EpicIntake {
  goalText: string
  openingPrompt: string
  /** Same six kinds composeEpicIntake already concatenates, emitted in that
   *  same order: actor, injection(s), input, mission, goal, reference(s).
   *  Each input is independently optional, so a caller supplying none of
   *  agentName/agentDescription/inputSummary/tag/contextInjections still
   *  gets a valid (shorter) array — never an error. */
  sections: EpicIntakeSection[]
}

/** File names are user/filesystem controlled and can contain newlines — strip
 *  them so a crafted name can't forge an extra structural line. */
function singleLine(s: string): string {
  return s.replace(/\r?\n/g, ' ')
}

function withReferences(body: string, referencePaths: string[]): string {
  const lines = referencePaths.map((p) => `Reference: ${singleLine(p)}`)
  return lines.length ? `${body}\n\n${lines.join('\n')}` : body
}

/**
 * Re-joins the emitted sections back into the exact flat string
 * composeEpicIntake produced before sections existed. Every boundary is a
 * blank line ('\n\n') EXCEPT between two consecutive `reference` sections,
 * which join with a single '\n' — reference lines were always one visual
 * block (`withReferences`' `lines.join('\n')`), never separated. This is the
 * only special case; recovering it here (rather than a generic '\n\n' join)
 * is what makes byte-identity with the pre-sections output structural
 * instead of merely tested.
 */
function joinSections(sections: EpicIntakeSection[]): string {
  return sections.reduce((out, s, i) => {
    if (i === 0) return s.text
    const prev = sections[i - 1]
    const sep = s.kind === 'reference' && prev.kind === 'reference' ? '\n' : '\n\n'
    return out + sep + s.text
  }, '')
}

/**
 * Compose an Epic's stored `goalText` and its auto-sent opening prompt.
 *
 * Complexity: O(n) in the number of references.
 */
export function composeEpicIntake({
  title,
  goal,
  referencePaths = [],
  tag,
  agentName,
  agentDescription,
  inputSummary,
  contextInjections,
}: EpicIntakeFields): EpicIntake {
  const trimmedTitle = singleLine(title.trim())
  const trimmedGoal = goal.trim()

  const body = trimmedTitle ? `${trimmedTitle}\n\n${trimmedGoal}` : trimmedGoal
  // The opening prompt names the title as the goal explicitly, so the agent
  // reads it as the objective rather than as the first line of the request.
  const promptBody = trimmedTitle ? `Goal: ${trimmedTitle}\n\n${trimmedGoal}` : trimmedGoal

  // AIM order: Actor, then Context Injections (extending "who's acting" with
  // "how they generally behave"), then Input, then Mission, then the human's
  // own goal, then any attached references — who is running this Epic, what
  // it's standing on, what it's here to do, what it opened with.
  const sections: EpicIntakeSection[] = []

  if (agentName && agentDescription) {
    sections.push({
      kind: 'actor',
      label: 'Actor',
      text: `You are acting as the "${singleLine(agentName)}" agent: ${singleLine(agentDescription)}`,
      source: agentName,
    })
  }

  // Each enabled injection is its own section, in CONTEXT_INJECTIONS' own key
  // order — not the order the caller happened to list them in.
  for (const key of Object.keys(CONTEXT_INJECTIONS) as (keyof typeof CONTEXT_INJECTIONS)[]) {
    if (!contextInjections?.[key]) continue
    const def = CONTEXT_INJECTIONS[key]
    sections.push({ kind: 'injection', label: def.label, text: def.text, source: key })
  }

  if (inputSummary) {
    sections.push({ kind: 'input', label: 'Input', text: singleLine(inputSummary) })
  }

  if (tag) {
    sections.push({ kind: 'mission', label: 'Mission', text: agentTagDef(tag).initialPromptTemplate, source: tag })
  }

  // Always present — goalText/openingPrompt's pure-objective floor, same as
  // pre-sections composeEpicIntake always contributing `promptBody`.
  sections.push({ kind: 'goal', label: 'Goal', text: promptBody })

  for (const p of referencePaths) {
    sections.push({ kind: 'reference', label: 'Reference', text: `Reference: ${singleLine(p)}`, source: p })
  }

  return {
    goalText: withReferences(body, referencePaths),
    openingPrompt: joinSections(sections),
    sections,
  }
}
