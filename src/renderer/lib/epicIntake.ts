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
 * INSTRUCTION. References are appended as trailing lines to `goalText`; in the
 * opening prompt they sit in the Input slot. The opening prompt is AIM: Actor,
 * Input, Mission.
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
   * The persona markdown file's raw text (frontmatter included — this
   * function strips it) — the persona's operating rules, which Claude Code
   * only loads when the file runs as a subagent, never for an Epic's main
   * loop. Without this, only `agentDescription`'s one-liner ever reaches the
   * session, so a persona's central rules (e.g. "never implement inline,
   * queue via /develop") are written down and delivered nowhere. Becomes the
   * Actor entry's text (after a one-line 'acting as' intro; the frontmatter
   * description is not restated), with its YAML frontmatter block stripped and whitespace trimmed, capped at 6000
   * characters with an explicit truncation notice. Omitted entirely when the
   * stripped/trimmed body is empty.
   */
  agentBody?: string
  /** Absolute path of the persona `.md` file `agentBody` was read from — named
   *  in the truncation notice when the body exceeds the 6000-char cap, so the
   *  reader knows which file to open for the untruncated rules. Unused when
   *  `agentBody` is absent or under the cap. */
  agentPath?: string
  /**
   * AIM's "Input" axis, stated explicitly: one line naming what's grounding
   * this session (System/Project/Local CLAUDE.md, skills, mcp servers, etc.),
   * from `groundingBoard.ts`'s `summarizeGroundingBoard`. First entry of
   * the Input slot, ahead of Context Injections and references. Omitted entirely when absent
   * (e.g. callers that never computed a grounding board, e.g. resumed
   * Epics). Also omitted when there is neither an Actor (persona) nor a
   * Mission tag: no AIM framing means no Input line.
   */
  inputSummary?: string
  /**
   * Context Injections (contextInjections.ts) — Session-Manager-authored
   * text, independent of Actor/Input/Mission, each an explicit on/off toggle
   * in the New Epic card's advanced grounding board. `true` adds that
   * key's `text` to the Input slot, after the grounding line. Defaults to omitted
   * (no injection) for callers that don't pass it — e.g. hot-key
   * macro launches (SessionActionsBar).
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
export type AimSlot = 'actor' | 'input' | 'mission'
export const AIM_SLOT_ORDER: readonly AimSlot[] = ['actor', 'input', 'mission']
export type AimPart = 'persona' | 'grounding' | 'injection' | 'reference' | 'job-type' | 'goal'

export interface EpicIntakeSection {
  /** New Epics emit kind = AIM slot plus `part`. 'persona-body' | 'injection' |
   *  'goal' | 'reference' (and actor/input/mission without a part) are the
   *  pre-AIM shape still stored by existing Epics — read-only, always read
   *  through toAimSections. */
  kind: 'actor' | 'persona-body' | 'injection' | 'input' | 'mission' | 'goal' | 'reference'
  /** Which part of its AIM slot this entry is. Absent on pre-AIM records. */
  part?: AimPart
  label: string
  text: string
  source?: string
}

export type AimSection = EpicIntakeSection & { kind: AimSlot; part: AimPart }

const LEGACY_KIND: Record<EpicIntakeSection['kind'], { kind: AimSlot; part: AimPart }> = {
  actor: { kind: 'actor', part: 'persona' },
  'persona-body': { kind: 'actor', part: 'persona' },
  injection: { kind: 'input', part: 'injection' },
  input: { kind: 'input', part: 'grounding' },
  reference: { kind: 'input', part: 'reference' },
  mission: { kind: 'mission', part: 'job-type' },
  goal: { kind: 'mission', part: 'goal' },
}

const PART_SLOT: Record<AimPart, AimSlot> = {
  persona: 'actor',
  grounding: 'input',
  injection: 'input',
  reference: 'input',
  'job-type': 'mission',
  goal: 'mission',
}

const has = (o: object, k: unknown): boolean =>
  typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k)

/** Normalize stored sections (legacy 7-kind or AIM) into exactly AIM's three
 *  slots, each entry tagged with its part, stably ordered by slot. Never throws. */
export function toAimSections(sections: readonly EpicIntakeSection[] | null | undefined): AimSection[] {
  if (!Array.isArray(sections)) return []
  const out: AimSection[] = []
  for (const entry of sections) {
    if (!entry || typeof entry !== 'object') continue
    if (has(PART_SLOT, entry.part)) {
      out.push({ ...entry, kind: PART_SLOT[entry.part as AimPart], part: entry.part as AimPart })
    } else if (entry.part === undefined && has(LEGACY_KIND, entry.kind)) {
      out.push({ ...entry, ...LEGACY_KIND[entry.kind as EpicIntakeSection['kind']] })
    }
  }
  return out.sort((a, b) => AIM_SLOT_ORDER.indexOf(a.kind) - AIM_SLOT_ORDER.indexOf(b.kind))
}

export interface EpicIntake {
  goalText: string
  openingPrompt: string
  /** AIM slots in order — Actor (persona), Input (grounding, injections,
   *  references), Mission (job type, goal) — each entry carrying its `part`.
   *  Every input is independently optional; only the goal entry is always
   *  present, so the array is never empty. */
  sections: AimSection[]
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

/** Cap on the persona body forwarded into the opening prompt — a runaway
 *  persona file must not be able to dominate it. */
const AGENT_BODY_CHAR_CAP = 6000

/** Strips a leading YAML frontmatter block (`---\n...\n---`), no-op when the
 *  text doesn't open with one. Mirrors the detection rule in
 *  `src/main/lib/prd/prdFrontmatter.cjs`'s `splitFrontmatter` (main can't import
 *  this renderer module — no ES modules in main — so the same small rule is
 *  duplicated here rather than shared). */
function stripFrontmatter(raw: string): string {
  if (!raw.startsWith('---\n')) return raw
  const end = raw.indexOf('\n---', 4)
  if (end === -1) return raw
  return raw.slice(end + 4).replace(/^\n/, '')
}

/** Builds the `persona-body` section text: frontmatter-stripped, trimmed,
 *  capped at `AGENT_BODY_CHAR_CAP` with a trailing truncation notice naming
 *  `agentPath`. Returns null when the stripped/trimmed body is empty. */
function buildPersonaBodyText(agentBody: string, agentPath: string | undefined): string | null {
  const body = stripFrontmatter(agentBody).trim()
  if (!body) return null
  if (body.length <= AGENT_BODY_CHAR_CAP) return body
  const truncated = body.slice(0, AGENT_BODY_CHAR_CAP)
  const pathLabel = agentPath ? singleLine(agentPath) : 'the persona file'
  return `${truncated}\n\n[Truncated — ${pathLabel} exceeds ${AGENT_BODY_CHAR_CAP} characters; see the file for the full body.]`
}

/**
 * Re-joins the emitted sections back into the exact flat string
 * composeEpicIntake produced before sections existed. Every boundary is a
 * blank line ('\n\n') EXCEPT between two consecutive `reference` parts,
 * which join with a single '\n' — reference lines were always one visual
 * block (`withReferences`' `lines.join('\n')`), never separated. This is the
 * only special case; recovering it here (rather than a generic '\n\n' join)
 * is what makes byte-identity with the pre-sections output structural
 * instead of merely tested.
 */
export function joinSections(sections: readonly EpicIntakeSection[]): string {
  return sections.reduce((out, s, i) => {
    if (i === 0) return s.text
    const prev = sections[i - 1]
    const sep = s.part === 'reference' && prev.part === 'reference' ? '\n' : '\n\n'
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
  agentBody,
  agentPath,
  inputSummary,
  contextInjections,
}: EpicIntakeFields): EpicIntake {
  const trimmedTitle = singleLine(title.trim())
  const trimmedGoal = goal.trim()

  const body = trimmedTitle ? `${trimmedTitle}\n\n${trimmedGoal}` : trimmedGoal
  // The opening prompt names the title as the goal explicitly, so the agent
  // reads it as the objective rather than as the first line of the request.
  const promptBody = trimmedTitle ? `Goal: ${trimmedTitle}\n\n${trimmedGoal}` : trimmedGoal

  // AIM slots, in order: Actor (the persona), Input (grounding, Context
  // Injections, references), Mission (the job type, then the human's goal).
  const actor: AimSection[] = []
  const input: AimSection[] = []
  const mission: AimSection[] = []

  const personaBody = agentBody ? buildPersonaBodyText(agentBody, agentPath) : null
  if (personaBody) {
    actor.push({
      kind: 'actor',
      part: 'persona',
      label: 'Actor',
      text: (agentName ? `You are acting as the "${singleLine(agentName)}" agent.\n\n` : '') + personaBody,
      source: agentName,
    })
  } else if (agentName && agentDescription) {
    actor.push({
      kind: 'actor',
      part: 'persona',
      label: 'Actor',
      text: `You are acting as the "${singleLine(agentName)}" agent: ${singleLine(agentDescription)}`,
      source: agentName,
    })
  }

  // No Actor and no Mission tag = no AIM framing, so no grounding line
  // (plain-claude composition).
  if (inputSummary && (actor.length > 0 || tag)) {
    input.push({ kind: 'input', part: 'grounding', label: 'Grounding', text: singleLine(inputSummary) })
  }

  // Each enabled injection is its own entry, in CONTEXT_INJECTIONS' own key
  // order — not the order the caller happened to list them in.
  for (const key of Object.keys(CONTEXT_INJECTIONS) as (keyof typeof CONTEXT_INJECTIONS)[]) {
    if (!contextInjections?.[key]) continue
    const def = CONTEXT_INJECTIONS[key]
    input.push({ kind: 'input', part: 'injection', label: def.label, text: def.text, source: key })
  }

  for (const p of referencePaths) {
    input.push({ kind: 'input', part: 'reference', label: 'Reference', text: `Reference: ${singleLine(p)}`, source: p })
  }

  if (tag) {
    mission.push({
      kind: 'mission',
      part: 'job-type',
      label: 'Job type',
      text: agentTagDef(tag).initialPromptTemplate,
      source: tag,
    })
  }
  // Always present — goalText/openingPrompt's pure-objective floor.
  mission.push({ kind: 'mission', part: 'goal', label: 'Goal', text: promptBody })

  const sections: AimSection[] = [...actor, ...input, ...mission]

  return {
    goalText: withReferences(body, referencePaths),
    openingPrompt: joinSections(sections),
    sections,
  }
}
