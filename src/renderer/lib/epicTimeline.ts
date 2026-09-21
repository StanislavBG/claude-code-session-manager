import type { ChatTurn } from '../state/chat'
import type { PromptSessionEvent } from '../state/promptSessions'
import { visibleFeedTurns } from '../components/ChatTranscriptTurn'
import { splitStopSignal } from './stopSignal'
import { filterTurnsByVerbosity, type ChatVerbosity } from './chatVerbosity'

export type ValidationVerdict = 'unvalidated' | 'validating' | 'verified' | 'refuted'
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
    }
  | { kind: 'event'; at: number; event: TimelineEvent }

export interface EpicTimeline {
  visibleTurns: ChatTurn[]
  hiddenCount: number
  revealLevel: ReturnType<typeof filterTurnsByVerbosity>['revealLevel']
  latestValidationBySlug: Map<string, ValidationVerdict>
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

  // Later events overwrite earlier ones for the same slug.
  const latestValidationBySlug = new Map<string, ValidationVerdict>()
  const eventItems: TimelineItem[] = []
  for (const e of sessionEvents) {
    if (e.kind === 'response' && e.prdSlug && e.validation) latestValidationBySlug.set(e.prdSlug, e.validation)
    if (e.kind === 'prd_created' || e.kind === 'closed' || (e.kind === 'response' && !isDuplicateResponseEvent(e))) {
      eventItems.push({ kind: 'event', at: Date.parse(e.at), event: e as TimelineEvent })
    }
  }

  const timeline = [...turnItems, ...eventItems].sort((a, b) => a.at - b.at)
  return { visibleTurns, hiddenCount, revealLevel, latestValidationBySlug, timeline, lastAssistantIndex }
}
