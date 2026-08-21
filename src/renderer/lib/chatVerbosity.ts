import type { ChatTurn } from '../state/chat'
import { isToolFamilyKind } from './chatSignals'

/**
 * chatVerbosity.ts — the density dial for an Epic's Discussion feed.
 *
 * Context: chatRunner.cjs streams SIX broadcast channels into state/chat.ts
 * (output / tool-use / complete / needs-input / error / notice), and
 * attachTranscriptFeed additionally ingests EVERY line of the session's own
 * JSONL as `role:'event'` turns (thinking blocks, tool_result payloads,
 * attachment deltas, mode switches, usage rollups, …). ChatTranscriptTurn.tsx
 * renders all of it — deliberately, since its router is documented as "a
 * router, never a filter". The result is a faithful but very loud feed.
 *
 * This module is the ONE place that decides how much of that feed a human
 * sees. It is a pure display filter over an unchanged store: nothing is
 * dropped from `chat.turns`, so raising the level always brings the full
 * record back, byte for byte, with no re-fetch.
 *
 * ── Five levels, numbered LOUDEST-FIRST for humans ─────────────────────────
 * The user-facing numbering runs 1 = most verbose … 5 = quietest, which is
 * the inverse of this module's internal rank (low rank = quiet). `levelNumber`
 * is the only place that inversion is expressed; everything else compares
 * ranks. The ladder:
 *
 *   1 raw       everything, including transcript plumbing — usage rollups,
 *               last-prompt/ai-title echoes, mode switches, attachment deltas,
 *               and chatRunner's injected prompt preamble shown inline.
 *   2 detail    the agent's work in full — tool_use / tool_result cards,
 *               thinking blocks — without the plumbing.
 *   3 standard  what CHANGED, not how — file diffs, queue operations,
 *               snapshots. NO tool cards.
 *   4 brief     conversation only, replies in full.
 *   5 summary   conversation only, replies clamped to a lead excerpt behind a
 *               per-turn "Show full message".
 *
 * Tool cards live at 2 and 1 ONLY. At 3–5 the feed answers "what happened to
 * my code", not "which tools ran".
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

export type ChatVerbosity = 'summary' | 'brief' | 'standard' | 'detail' | 'raw'

export const CHAT_VERBOSITY_DEFAULT: ChatVerbosity = 'standard'

/** Ordered quietest → loudest. Index doubles as the internal comparison rank. */
export const CHAT_VERBOSITY_ORDER: ChatVerbosity[] = ['summary', 'brief', 'standard', 'detail', 'raw']

/** Display order for the dial, matching the human numbering (1 … 5). */
export const CHAT_VERBOSITY_DISPLAY_ORDER: ChatVerbosity[] = [...CHAT_VERBOSITY_ORDER].reverse()

export const CHAT_VERBOSITY_META: Record<ChatVerbosity, { label: string; hint: string }> = {
  raw: {
    label: 'Raw',
    hint: 'Everything — tool cards, thinking, usage/mode plumbing, and the injected prompt preamble inline.',
  },
  detail: {
    label: 'Detail',
    hint: 'The agent’s work in full — tool calls, tool results, thinking. No transcript plumbing.',
  },
  standard: {
    label: 'Standard',
    hint: 'What changed, not how — file diffs, queue operations, snapshots. No tool cards.',
  },
  brief: {
    label: 'Brief',
    hint: 'Conversation only, replies in full.',
  },
  summary: {
    label: 'Summary',
    hint: 'Conversation only, replies clamped to a lead excerpt.',
  },
}

export function verbosityRank(level: ChatVerbosity): number {
  const i = CHAT_VERBOSITY_ORDER.indexOf(level)
  // An unknown/corrupt persisted value reads as the loudest level rather than
  // the quietest — a bad pref must never silently swallow the feed.
  return i === -1 ? CHAT_VERBOSITY_ORDER.length - 1 : i
}

/** The human-facing number: 1 is the LOUDEST level, 5 the quietest. */
export function levelNumber(level: ChatVerbosity): number {
  return CHAT_VERBOSITY_ORDER.length - verbosityRank(level)
}

export function isChatVerbosity(v: unknown): v is ChatVerbosity {
  return typeof v === 'string' && (CHAT_VERBOSITY_ORDER as string[]).includes(v)
}

/** Roles that carry a human-facing ask or failure — exempt from the dial. */
const ALWAYS_VISIBLE_ROLES = new Set<ChatTurn['role']>(['user', 'assistant', 'question', 'notice', 'error'])

/**
 * `role:'event'` kinds that report a CHANGE to the project (what happened),
 * as opposed to how the agent got there. Visible from 'standard' up.
 */
const STANDARD_EVENT_KINDS = new Set(['queue-operation', 'file-history-snapshot'])

/** Attachment subtypes that report a change rather than context plumbing. */
const STANDARD_ATTACHMENT_SUBTYPES = new Set(['edited_text_file', 'queued_command'])

/**
 * `role:'event'` kinds that are the agent's own WORKING TRACE — the tool
 * cards the user asked to see only at the two loudest levels, plus thinking.
 * `isToolFamilyKind` (tool_use and friends) is folded in here too.
 */
const DETAIL_EVENT_KINDS = new Set(['tool_result', 'content_thinking'])

/**
 * The LOWEST (quietest) verbosity level at which this turn renders.
 *
 * Pure and total: every turn maps to exactly one level, so the feed's
 * composition at a given level is fully determined by the turns array.
 * Unknown/future event kinds land at 'raw' — never dropped, and one click
 * away at all times, where ChatTranscriptTurn's generic-Signal-card fallback
 * still renders them.
 */
export function turnMinVerbosity(turn: ChatTurn): ChatVerbosity {
  if (ALWAYS_VISIBLE_ROLES.has(turn.role)) return 'summary'
  // role === 'event' from here down.
  const kind = turn.kind
  if (isToolFamilyKind(kind)) return 'detail'
  if (kind && DETAIL_EVENT_KINDS.has(kind)) return 'detail'
  if (kind && STANDARD_EVENT_KINDS.has(kind)) return 'standard'
  if (kind === 'attachment') {
    const subtype = turn.signal?.subtype
    if (subtype && STANDARD_ATTACHMENT_SUBTYPES.has(subtype)) return 'standard'
  }
  return 'raw'
}

export interface VerbosityFilterResult {
  visible: ChatTurn[]
  /** How many turns the current level is holding back (0 at 'raw'). */
  hiddenCount: number
  /** Hidden turns bucketed by the level that would reveal them. */
  hiddenByLevel: Record<ChatVerbosity, number>
  /** Quietest level that would reveal EVERY currently-hidden turn; null when
   *  nothing is hidden. Drives the in-feed reveal button. */
  revealLevel: ChatVerbosity | null
}

/**
 * Split an already-deduplicated feed (i.e. the output of `visibleFeedTurns`)
 * into what the chosen level shows and what it holds. Never mutates the input
 * and never reorders it.
 */
export function filterTurnsByVerbosity(turns: ChatTurn[], level: ChatVerbosity): VerbosityFilterResult {
  const max = verbosityRank(level)
  const visible: ChatTurn[] = []
  const hiddenByLevel: Record<ChatVerbosity, number> = {
    summary: 0,
    brief: 0,
    standard: 0,
    detail: 0,
    raw: 0,
  }
  let hiddenCount = 0
  let maxHiddenRank = -1
  for (const t of turns) {
    const need = turnMinVerbosity(t)
    const rank = verbosityRank(need)
    if (rank <= max) {
      visible.push(t)
    } else {
      hiddenCount++
      hiddenByLevel[need]++
      if (rank > maxHiddenRank) maxHiddenRank = rank
    }
  }
  return {
    visible,
    hiddenCount,
    hiddenByLevel,
    revealLevel: maxHiddenRank === -1 ? null : CHAT_VERBOSITY_ORDER[maxHiddenRank],
  }
}

/**
 * Character budget for an assistant bubble's body at each level. `null` =
 * render in full. Only assistant prose is ever clamped — see the
 * ALWAYS_VISIBLE_ROLES note above for why questions/notices/errors are not.
 */
export const ASSISTANT_CLAMP_CHARS: Record<ChatVerbosity, number | null> = {
  summary: 420,
  brief: null,
  standard: null,
  detail: null,
  raw: null,
}

/**
 * Whether a COMPLETED assistant turn's tool-use strip (and the Edit/Write
 * diff cards riding on it) renders at this level. Tool cards are a level-1/2
 * affordance; at 'standard' file changes still surface via the separate
 * `attachment/edited_text_file` event turns, which carry their own DiffCard.
 *
 * Does NOT apply to the in-flight bubble: while a run is streaming, its strip
 * ("working · N tools") is the only progress signal there is, so EpicDetail
 * keeps it visible at every level. Same reasoning as ALWAYS_VISIBLE_ROLES —
 * the dial governs the record of what happened, never live interaction.
 */
export function showsToolStrip(level: ChatVerbosity): boolean {
  return verbosityRank(level) >= verbosityRank('detail')
}

/** chatRunner's injected prompt preamble (lib/promptPreamble.ts) renders
 *  inline only at the single loudest level — the one that means "show me the
 *  raw record". Everywhere else it collapses behind its ≡ glyph. */
export function showsInjectedPreamble(level: ChatVerbosity): boolean {
  return level === 'raw'
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

/**
 * Character budget for the Epic's FIRST user turn — its opening prompt.
 *
 * That turn is not ordinary chat: it is the whole AIM briefing plus the
 * human's own goal text, which routinely runs to thousands of words. Rendered
 * in full it pushes every actual reply off-screen and makes the Session
 * details view unusable, so it collapses to a thin expandable line (Turn's
 * existing `clampBodyChars` + "Show full message" toggle) at every level
 * except `raw`, which is the byte-exact record by definition.
 *
 * Distinct from ASSISTANT_CLAMP_CHARS above: this one is role- and
 * position-scoped (first user turn) rather than verbosity-scoped.
 */
export const OPENING_PROMPT_CLAMP_CHARS = 400

export function openingPromptClamp(level: ChatVerbosity): number | null {
  return level === 'raw' ? null : OPENING_PROMPT_CLAMP_CHARS
}
