import type { PromptSessionEvent } from '../state/promptSessions'

/**
 * Pure builders for the short handoff text that carries a long session's
 * thread into a fresh one: where the old session stopped, and what became of
 * its PRDs. No React, no store — callers pass plain data. Never throws.
 */

export const HANDOFF_MAX_CHARS = 6000
export const HANDOFF_ANSWER_MAX_CHARS = 4000
export const HANDOFF_SLUGS_PER_KIND = 20

const HEADER_MAX_CHARS = 300
const PRD_LINE_MAX_CHARS = 1200
const SLUG_MAX_CHARS = 120

export interface PrdOutcomes {
  verified: string[]
  refuted: string[]
  unvalidated: string[]
}

export interface EpicHandoffInput {
  fromEpicId: string
  title: string
  lastAssistantText?: string | null
  outcomes: PrdOutcomes
}

const NO_ANSWER = 'No earlier answer was found.'
const CLOSING =
  'The earlier history is not loaded. Ask for anything you need from it, and do not start new work until the next instruction.'

/**
 * Decides each PRD slug by its newest event (last in list order) that carries
 * a validation — same last-event-wins rule as epicTimeline's
 * latestValidationBySlug. 'unvalidated' counts only when that event's outcome
 * is 'completed'; 'validating' (or an unvalidated non-completed job) counts as
 * none of the three. Slugs keep first-seen order. O(n).
 */
export function summarizePrdOutcomes(events: readonly PromptSessionEvent[] | null | undefined): PrdOutcomes {
  const latest = new Map<string, { validation: string; outcome: unknown }>()
  if (Array.isArray(events)) {
    for (const e of events) {
      if (!e || typeof e !== 'object') continue
      const { prdSlug, validation, outcome } = e as Partial<PromptSessionEvent>
      if (typeof prdSlug !== 'string' || prdSlug === '' || typeof validation !== 'string') continue
      latest.set(prdSlug, { validation, outcome })
    }
  }
  const out: PrdOutcomes = { verified: [], refuted: [], unvalidated: [] }
  for (const [slug, { validation, outcome }] of latest) {
    if (validation === 'verified') out.verified.push(slug)
    else if (validation === 'refuted') out.refuted.push(slug)
    else if (validation === 'unvalidated' && outcome === 'completed') out.unvalidated.push(slug)
  }
  return out
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function cap(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`
}

function slugList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []
}

function listSlugs(label: string, slugs: string[]): string {
  if (slugs.length === 0) return ''
  const shown = slugs.slice(0, HANDOFF_SLUGS_PER_KIND).map((s) => cap(s, SLUG_MAX_CHARS))
  const more = slugs.length - shown.length
  return ` ${label}: ${shown.join(', ')}${more > 0 ? ` (+${more} more)` : ''}.`
}

/**
 * Builds the handoff text: header line, 'Where it stopped' block, one PRD
 * line, closing line. Each part has its own budget so the whole is always
 * within HANDOFF_MAX_CHARS while the closing line is never dropped.
 */
export function buildEpicHandoff(input: EpicHandoffInput | null | undefined): string {
  const src = (input && typeof input === 'object' ? input : {}) as Partial<EpicHandoffInput>
  const id = str(src.fromEpicId).trim() || 'unknown'
  const title = str(src.title).trim() || 'Untitled'
  const header = cap(`Continued from session ${id} — ${title}`.replace(/\s*\n\s*/g, ' '), HEADER_MAX_CHARS)

  const answer = str(src.lastAssistantText).trim()
  let stopBody: string
  if (!answer) {
    stopBody = NO_ANSWER
  } else if (answer.length > HANDOFF_ANSWER_MAX_CHARS) {
    stopBody = `${answer.slice(0, HANDOFF_ANSWER_MAX_CHARS)}\n(The answer was cut to its first ${HANDOFF_ANSWER_MAX_CHARS} of ${answer.length} characters.)`
  } else {
    stopBody = answer
  }

  const o = (src.outcomes && typeof src.outcomes === 'object' ? src.outcomes : {}) as Partial<PrdOutcomes>
  const verified = slugList(o.verified)
  const refuted = slugList(o.refuted)
  const unvalidated = slugList(o.unvalidated)
  const prdLine = cap(
    `PRDs: ${verified.length} verified, ${refuted.length} refuted, ${unvalidated.length} unvalidated.` +
      listSlugs('Refuted', refuted) +
      listSlugs('Unvalidated', unvalidated),
    PRD_LINE_MAX_CHARS,
  )

  const text = [header, '', 'Where it stopped:', stopBody, '', prdLine, '', CLOSING].join('\n')
  if (text.length <= HANDOFF_MAX_CHARS) return text
  // Unreachable with the budgets above; kept so the cap holds if they change.
  const tail = `\n\n${prdLine}\n\n${CLOSING}`
  return `${text.slice(0, Math.max(0, HANDOFF_MAX_CHARS - tail.length))}${tail}`.slice(-HANDOFF_MAX_CHARS)
}
