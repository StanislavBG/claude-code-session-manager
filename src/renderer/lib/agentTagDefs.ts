import type { TicketTag } from './ticketDisplay'

/**
 * The per-tag "agent" definition: what an Epic's tag actually means for the
 * session it initializes, beyond the display chip. `initialPromptTemplate` is
 * prepended to the Epic's opening prompt by composeEpicIntake (epicIntake.ts)
 * — the tag isn't just a label, it's the first framing instruction the agent
 * reads, before the human's title/goal. An Epic carries exactly one tag, so a
 * session is grounded by exactly one of these.
 */
export interface AgentTagDef {
  description: string
  initialPromptTemplate: string
}

/**
 * Canonical order for every tag-keyed list/table in the UI (this object's
 * own key order, since object key order is insertion order for string keys
 * — NewEpicCard's KIND_OPTIONS and Home's AgentsCard both iterate this via
 * `AGENT_TAG_ORDER = Object.keys(AGENT_TAG_DEFS)`).
 */
export const AGENT_TAG_DEFS: Record<TicketTag, AgentTagDef> = {
  feature: {
    description: 'Builds new functionality end-to-end from the stated objective.',
    initialPromptTemplate:
      'You are building new functionality. Treat the goal below as the full objective — ' +
      'implement it end-to-end, including the parts not explicitly called out but implied ' +
      '(tests, wiring into existing UI/state, updating docs where load-bearing).',
  },
  bug: {
    description: 'Diagnoses a reported failure before proposing a fix — reproduction first.',
    initialPromptTemplate:
      'You are diagnosing a reported bug. If a reference (log, stack trace, repro steps) is ' +
      'attached, read it and reproduce the failure before writing a fix — do not guess at root ' +
      'cause from the description alone. If nothing is attached, reproduce it yourself first.',
  },
  discussion: {
    description: 'Open-ended research/decision conversation — no code changes expected.',
    initialPromptTemplate:
      'You are in an open-ended discussion. The goal is a decision or shared understanding, ' +
      'not a code change — do not start editing files unless the human explicitly asks you to ' +
      'after the discussion lands somewhere.',
  },
}

export const AGENT_TAG_ORDER = Object.keys(AGENT_TAG_DEFS) as TicketTag[]

export function agentTagDef(tag: TicketTag): AgentTagDef {
  return AGENT_TAG_DEFS[tag]
}
