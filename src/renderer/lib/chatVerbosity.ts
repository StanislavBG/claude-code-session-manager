import type { ChatTurn } from '../state/chat'
import { isToolFamilyKind } from './chatSignals'

/**
 * chatVerbosity.ts — the density dial for an Epic's Discussion feed.
 *
 * Context: chatRunner.cjs streams SIX broadcast channels into state/chat.ts
 * (output / tool-use / complete / needs-input / error / notice), and
 * attachTranscriptFeed additionally ingests EVERY line of the session's own
 * JSONL as `role:'event'` turns (thinking blocks, tool_result payloads,
 * attachment deltas, mode switches, …). ChatTranscriptTurn.tsx renders all of
 * it — deliberately, since its router is documented as "a router, never a
 * filter". The result is a faithful but very loud feed.
 *
 * This module is the ONE place that decides how much of that feed a human
 * sees. It is a pure display filter over an unchanged store: nothing is
 * dropped from `chat.turns`, so raising the level always brings the full
 * record back, byte for byte, with no re-fetch.
 *
 * ── The three levels ───────────────────────────────────────────────────────
 *   summary   conversation only — your prompts, Claude's replies (clamped to
 *             a lead paragraph with a per-turn "Show full message"), and
 *             anything that needs you. No machinery.
 *   standard  + the work: tool/skill/MCP strips, edit diffs, tool results.
 *   verbose   + every raw transcript event: thinking, attachment deltas,
 *             mode switches, unknown/future kinds.
 *
 * ── The invariant that outranks the dial (`ALWAYS_VISIBLE_ROLES`) ──────────
 * A turn that is ASKING THE HUMAN SOMETHING is never hidden and never
 * clamped, at any level. That covers `question` (the `<<<SM_NEEDS_INPUT>>>`
 * stop-signal protocol and its inline answer buttons), `notice` (MCP consent
 * denials with their Grant-consent widget, kill-ceiling warnings), and
 * `error`. Hiding one of those would silently strand a run waiting on an
 * answer the user can no longer see — so verbosity is a filter over
 * *reporting*, never over *interaction*.
 */

export type ChatVerbosity = 'summary' | 'standard' | 'verbose'

export const CHAT_VERBOSITY_DEFAULT: ChatVerbosity = 'standard'

/** Ordered low → high. Index doubles as the comparison rank. */
export const CHAT_VERBOSITY_ORDER: ChatVerbosity[] = ['summary', 'standard', 'verbose']

export const CHAT_VERBOSITY_META: Record<ChatVerbosity, { label: string; hint: string }> = {
  summary: {
    label: 'Summary',
    hint: 'Conversation only — prompts, replies (clamped), and anything needing you.',
  },
  standard: {
    label: 'Standard',
    hint: 'Conversation plus the work — tool calls, diffs, tool results.',
  },
  verbose: {
    label: 'Verbose',
    hint: 'Everything — raw transcript events, thinking, attachment deltas.',
  },
}

export function verbosityRank(level: ChatVerbosity): number {
  const i = CHAT_VERBOSITY_ORDER.indexOf(level)
  // An unknown/corrupt persisted value reads as the loudest level rather than
  // the quietest — a bad pref must never silently swallow the feed.
  return i === -1 ? CHAT_VERBOSITY_ORDER.length - 1 : i
}

export function isChatVerbosity(v: unknown): v is ChatVerbosity {
  return typeof v === 'string' && (CHAT_VERBOSITY_ORDER as string[]).includes(v)
}

/** Roles that carry a human-facing ask or failure — exempt from the dial. */
const ALWAYS_VISIBLE_ROLES = new Set<ChatTurn['role']>(['user', 'assistant', 'question', 'notice', 'error'])

/**
 * `role:'event'` kinds that represent REAL WORK (what the agent did) rather
 * than transcript plumbing. These surface from 'standard' up; everything else
 * — including any kind this table has never heard of — is 'verbose'-only.
 *
 * Defaulting unknown kinds to 'verbose' is safe precisely because nothing is
 * deleted: a future CLI event kind is one click away at all times, and
 * ChatTranscriptTurn's generic-Signal-card fallback still renders it there.
 */
const STANDARD_EVENT_KINDS = new Set(['tool_result', 'queue-operation', 'file-history-snapshot'])

/** Attachment subtypes that are real work rather than context plumbing. */
const STANDARD_ATTACHMENT_SUBTYPES = new Set(['edited_text_file', 'queued_command'])

/**
 * The LOWEST verbosity level at which this turn renders.
 *
 * Pure and total: every turn maps to exactly one level, so the feed's
 * composition at a given level is fully determined by the turns array.
 */
export function turnMinVerbosity(turn: ChatTurn): ChatVerbosity {
  if (ALWAYS_VISIBLE_ROLES.has(turn.role)) return 'summary'
  // role === 'event' from here down.
  const kind = turn.kind
  if (isToolFamilyKind(kind)) return 'standard'
  if (kind && STANDARD_EVENT_KINDS.has(kind)) return 'standard'
  if (kind === 'attachment') {
    const subtype = turn.signal?.subtype
    if (subtype && STANDARD_ATTACHMENT_SUBTYPES.has(subtype)) return 'standard'
  }
  return 'verbose'
}

export interface VerbosityFilterResult {
  visible: ChatTurn[]
  /** How many turns the current level is holding back (0 at 'verbose'). */
  hiddenCount: number
  /** Hidden turns bucketed by the level that would reveal them. */
  hiddenByLevel: Record<ChatVerbosity, number>
}

/**
 * Split an already-deduplicated feed (i.e. the output of
 * `visibleFeedTurns`) into what the chosen level shows and what it holds.
 * Never mutates the input and never reorders it.
 */
export function filterTurnsByVerbosity(turns: ChatTurn[], level: ChatVerbosity): VerbosityFilterResult {
  const max = verbosityRank(level)
  const visible: ChatTurn[] = []
  const hiddenByLevel: Record<ChatVerbosity, number> = { summary: 0, standard: 0, verbose: 0 }
  let hiddenCount = 0
  for (const t of turns) {
    const need = turnMinVerbosity(t)
    if (verbosityRank(need) <= max) {
      visible.push(t)
    } else {
      hiddenCount++
      hiddenByLevel[need]++
    }
  }
  return { visible, hiddenCount, hiddenByLevel }
}

/**
 * Character budget for an assistant bubble's body at each level. `null` =
 * render in full. Only assistant prose is ever clamped — see the
 * ALWAYS_VISIBLE_ROLES note above for why questions/notices/errors are not.
 */
export const ASSISTANT_CLAMP_CHARS: Record<ChatVerbosity, number | null> = {
  summary: 420,
  standard: null,
  verbose: null,
}

export interface ClampedText {
  body: string
  truncated: boolean
  /** Characters withheld — 0 when not truncated. */
  hiddenChars: number
}

/**
 * Clamp assistant prose to a lead excerpt, preferring a paragraph boundary so
 * the excerpt reads as a complete thought rather than a mid-sentence cut.
 *
 * Rules, in order:
 *   1. `max` null/<=0, or text already within budget → returned untouched.
 *   2. If the first blank-line-separated paragraph fits, use exactly that.
 *   3. Otherwise cut at `max`, backing up to the last sentence end or space
 *      inside the final quarter of the budget so we don't split a word.
 */
export function clampTurnText(text: string, max: number | null): ClampedText {
  if (max === null || max <= 0 || text.length <= max) {
    return { body: text, truncated: false, hiddenChars: 0 }
  }
  const firstBreak = text.indexOf('\n\n')
  if (firstBreak > 0 && firstBreak <= max) {
    const body = text.slice(0, firstBreak).trimEnd()
    return { body, truncated: true, hiddenChars: text.length - body.length }
  }
  let cut = max
  const window = text.slice(0, max)
  const floor = Math.floor(max * 0.75)
  const sentence = Math.max(window.lastIndexOf('. '), window.lastIndexOf('\n'))
  if (sentence >= floor) {
    cut = sentence + 1
  } else {
    const space = window.lastIndexOf(' ')
    if (space >= floor) cut = space
  }
  const body = text.slice(0, cut).trimEnd()
  return { body, truncated: true, hiddenChars: text.length - body.length }
}
