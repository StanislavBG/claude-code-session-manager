import type { ChatTurn } from '../state/chat'
import type { PromptSessionEvent } from '../state/promptSessions'
import { visibleFeedTurns } from '../components/ChatTranscriptTurn'
import { splitStopSignal } from './stopSignal'
import { filterTurnsByVerbosity, type ChatVerbosity } from './chatVerbosity'
import { questionCardStates, type QuestionCardState } from './questionCardState'
import { bareSlug } from './depSlugResolve'

export type ValidationVerdict = 'unvalidated' | 'validating' | 'verified' | 'refuted'
export type PrdOutcome = NonNullable<PromptSessionEvent['outcome']>
export type TimelineEvent = PromptSessionEvent & { kind: 'prd_created' | 'closed' | 'response' }

export type TimelineItem =
  | {
      kind: 'turn'
      at: number
      turn: ChatTurn
      /** Index within `visibleTurns`. */
      index: number
      /** Same value nearestPrecedingUserPrompt(visibleTurns, index) yields. */
      precedingUserPrompt: string | undefined
      /** Set on role 'question' turns only — whether the card is still the live ask. */
      questionCardState?: QuestionCardState
    }
  | { kind: 'event'; at: number; event: TimelineEvent }

export interface EpicTimeline {
  visibleTurns: ChatTurn[]
  hiddenCount: number
  revealLevel: ReturnType<typeof filterTurnsByVerbosity>['revealLevel']
  /** Keyed by bareSlug(prdSlug) — look it up the same way. */
  latestValidationBySlug: Map<string, ValidationVerdict>
  /** Keyed by bareSlug(prdSlug): the outcome of the newest response event
   *  carrying both a prdSlug and an outcome — what a PRD finished as, still
   *  known after its queue row is gone. */
  latestOutcomeBySlug: Map<string, PrdOutcome>
  timeline: TimelineItem[]
  /** Index in `visibleTurns` of the last assistant turn, or -1. */
  lastAssistantIndex: number
}

/**
 * Pure derivation of the Epic Discussion timeline (chat turns + audit events).
 * Depends only on `turns`, `sessionEvents`, `verbosity` — never on the live
 * stream — so callers memoize it on those. Time O(n log n) (final sort; the
 * rest is O(n) single passes, including the preceding-user-prompt lookup that
 * was O(n²) via indexOf per turn). Space O(n).
 */
export function buildEpicTimeline(
  turns: ChatTurn[],
  sessionEvents: PromptSessionEvent[],
  verbosity: ChatVerbosity,
): EpicTimeline {
  const { visible: visibleTurns, hiddenCount, revealLevel } = filterTurnsByVerbosity(visibleFeedTurns(turns), verbosity)

  // One forward pass: index, preceding-user-prompt (nearest non-event turn's
  // text when it is a user turn), and the last assistant index.
  // Computed over the unfiltered `turns` so a hidden human reply or newer
  // question still closes an older card.
  const cardStates = questionCardStates(turns)
  const turnItems: TimelineItem[] = new Array(visibleTurns.length)
  let lastAssistantIndex = -1
  let prevNonEvent: ChatTurn | undefined
  for (let i = 0; i < visibleTurns.length; i++) {
    const t = visibleTurns[i]
    turnItems[i] = {
      kind: 'turn',
      at: t.at,
      turn: t,
      index: i,
      precedingUserPrompt: prevNonEvent?.role === 'user' ? prevNonEvent.text : undefined,
      questionCardState: t.role === 'question' ? cardStates.get(t.id) : undefined,
    }
    if (t.role === 'assistant') lastAssistantIndex = i
    if (t.role !== 'event') prevNonEvent = t
  }

  // A completed turn's 'response' event duplicates an already-rendered
  // assistant turn (compared on the stop-signal-stripped text); drop those.
  const assistantTurnTexts = new Set<string>()
  for (const t of turns) {
    if (t.role === 'assistant') assistantTurnTexts.add(splitStopSignal(t.text)?.body ?? t.text)
  }
  const isDuplicateResponseEvent = (e: PromptSessionEvent): boolean => {
    if (!e.text) return false
    if (assistantTurnTexts.has(e.text)) return true
    // appendResponseEvent truncates with a trailing '…' — match the prefix too.
    if (e.text.endsWith('…')) {
      const prefix = e.text.slice(0, -1)
      for (const text of assistantTurnTexts) {
        if (text.startsWith(prefix)) return true
      }
    }
    return false
  }

  // Keyed by bareSlug: a PRD's finish event carries the numbered slug
  // (3309-x) but the validator's verdict carries the bare one (x). Later
  // events overwrite earlier ones for the same PRD.
  const latestValidationBySlug = new Map<string, ValidationVerdict>()
  const latestOutcomeBySlug = new Map<string, PrdOutcome>()
  const eventItems: TimelineItem[] = []
  for (const e of sessionEvents) {
    if (e.kind === 'response' && e.prdSlug && e.validation) latestValidationBySlug.set(bareSlug(e.prdSlug), e.validation)
    if (e.kind === 'response' && e.prdSlug && e.outcome) latestOutcomeBySlug.set(bareSlug(e.prdSlug), e.outcome)
    if (e.kind === 'prd_created' || e.kind === 'closed' || (e.kind === 'response' && !isDuplicateResponseEvent(e))) {
      eventItems.push({ kind: 'event', at: Date.parse(e.at), event: e as TimelineEvent })
    }
  }

  const timeline = [...turnItems, ...eventItems].sort((a, b) => a.at - b.at)
  return { visibleTurns, hiddenCount, revealLevel, latestValidationBySlug, latestOutcomeBySlug, timeline, lastAssistantIndex }
}
