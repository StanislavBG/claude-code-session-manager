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
    description: 'Plans new functionality from the stated objective, then delegates the build to /develop.',
    initialPromptTemplate:
      'You are planning new functionality. Treat the goal below as the full objective — ' +
      'establish scope, then decompose and queue the work as scheduled PRDs via the /develop ' +
      'skill, rather than editing files inline in this conversation: this interactive session ' +
      'is a planner-tier model and the headless claude -p executor does the typing.',
  },
  bug: {
    description: 'Diagnoses a reported failure before queuing a fix via /develop — reproduction first.',
    initialPromptTemplate:
      'You are diagnosing a reported bug. If a reference (log, stack trace, repro steps) is ' +
      'attached, read it and reproduce the failure before writing a fix — do not guess at root ' +
      'cause from the description alone. If nothing is attached, reproduce it yourself first. ' +
      'Once root cause is established, queue the fix as a scheduled PRD via the /develop skill ' +
      'rather than typing it inline: this interactive session is a planner-tier model and the ' +
      'headless claude -p executor does the typing.',
  },
  discussion: {
    description: 'Open-ended research/decision conversation — no code changes expected.',
    initialPromptTemplate:
      'You are in an open-ended discussion. The goal is a decision or shared understanding, ' +
      'not a code change — do not start editing files unless the human explicitly asks you to ' +
      'after the discussion lands somewhere.',
  },
  build: {
    description: "Prepares and publishes a release build to this project's configured registry.",
    initialPromptTemplate:
      'You are preparing a release build. Treat the goal below as the full objective — verify ' +
      "the project's build target configuration before publishing.",
  },
  'project-home-builder': {
    description:
      "Generates this project's 4 static Project Page HTML files (Home/Marketing/Feature/Architecture) from the saved component library and a computed project summary.",
    initialPromptTemplate:
      'You are generating this project\'s Project Pages. Read ' +
      '`session-manager-operations/architecture/project-pages-pipeline.md` first — it is the ' +
      'source of truth for the schema, file paths and non-negotiables (static HTML output only, ' +
      'never a live React recomposition; never fabricate summary content). Then follow ' +
      '`.claude/agents/project-home-builder.md` as your operating protocol. The component library ' +
      'to select from is at ' +
      '`session-manager-operations/design-mocks/project-pages-component-library/` — read its ' +
      'README before choosing any component. If the pipeline infrastructure described in the spec ' +
      "doesn't exist in this repo yet, treat building it as this Epic's first PRD chain via " +
      '/develop rather than hand-rolling a one-off script.',
  },
  'bilko-host-publisher': {
    description:
      "Publishes this project's generated Marketing Project Page to bilko.run as a static-path listing via the bilko-host MCP's gated publish pipeline.",
    initialPromptTemplate:
      'You are publishing this project to bilko.run. Read ' +
      '`session-manager-operations/architecture/bilko-host-integration.md` first — it is the ' +
      'source of truth for the pipeline, the bundle path, and the non-negotiables (ship the ' +
      'Marketing Project Page verbatim; never bypass a failing gate on your own initiative; treat ' +
      'a `content-grade` remote push failure from the bilko-host tool as expected noise, not a ' +
      'publish failure). Call `bilko-host__get_host_contract` and read ' +
      '`~/Projects/Bilko/mcp-host-server/src/gates/*.ts` live before publishing — never assume a ' +
      "cached understanding of the gates, they can change independently of this app's release " +
      'cycle. Then follow `.claude/agents/bilko-host-publisher.md` as your operating protocol.',
  },
}

/**
 * Display order for tag-keyed UI (NewEpicCard's KIND_OPTIONS, Home's
 * AgentsCard) — deliberately NOT `Object.keys(AGENT_TAG_DEFS)`. 'build' has
 * no UI surface to create Epics of that tag yet, so it's left out. NewEpicCard's
 * KIND_OPTIONS is a hardcoded {tag, label} array (which tags it exposes is a
 * deliberate 3-of-5 subset, not derived from this list), so
 * 'project-home-builder' appearing here only surfaces it in Home's read-only
 * AgentsCard reference — it is never hand-picked in the New Epic form. The
 * actual Epic-creation call for this tag lives in Project Home's "Generate
 * Now"/"Regenerate" buttons (ProjectPagesSection.tsx), which pass the tag
 * directly, not via this list. What KIND_OPTIONS never hardcodes twice is the
 * MISSION TEXT itself — its Mission-column blurb reads `agentTagDef(tag)
 * .description` from this file at render time, the same one composeEpicIntake
 * (epicIntake.ts) grounds the opening prompt with, so the "what a tag means"
 * wording has exactly one source no matter how many UI surfaces show it.
 */
export const AGENT_TAG_ORDER: TicketTag[] = ['feature', 'bug', 'discussion', 'project-home-builder']

export function agentTagDef(tag: TicketTag): AgentTagDef {
  return AGENT_TAG_DEFS[tag]
}
