// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import type { ChatTurn, ChatTurnRole } from '../../state/chat'
import type { PromptSessionEvent } from '../../state/promptSessions'
import { visibleFeedTurns, nearestPrecedingUserPrompt } from '../../components/ChatTranscriptTurn'
import { filterTurnsByVerbosity, type ChatVerbosity } from '../chatVerbosity'
import { splitStopSignal } from '../stopSignal'
import { buildEpicTimeline } from '../epicTimeline'
import { questionCardStates } from '../questionCardState'
import { bareSlug } from '../depSlugResolve'

/** Verbatim copy of the pre-change inline derivation from EpicDetail.tsx. */
function legacy(turns: ChatTurn[], sessionEvents: PromptSessionEvent[], verbosity: ChatVerbosity) {
  const deduped = visibleFeedTurns(turns)
  const { visible: visibleTurns, hiddenCount, revealLevel } = filterTurnsByVerbosity(deduped, verbosity)
  let lastAssistantIndex = -1
  for (let idx = visibleTurns.length - 1; idx >= 0; idx--) {
    if (visibleTurns[idx].role === 'assistant') {
      lastAssistantIndex = idx
      break
    }
  }
  const assistantTurnTexts = new Set(
    turns.filter((t) => t.role === 'assistant').map((t) => splitStopSignal(t.text)?.body ?? t.text),
  )
  const isDup = (e: PromptSessionEvent): boolean => {
    if (!e.text) return false
    if (assistantTurnTexts.has(e.text)) return true
    if (e.text.endsWith('…')) {
      const prefix = e.text.slice(0, -1)
      for (const text of assistantTurnTexts) if (text.startsWith(prefix)) return true
    }
    return false
  }
  const latest = new Map<string, string>()
  for (const e of sessionEvents) {
    if (e.kind === 'response' && e.prdSlug && e.validation) latest.set(bareSlug(e.prdSlug), e.validation)
  }
  const timeline = [
    ...visibleTurns.map((t) => ({ kind: 'turn' as const, at: t.at, turn: t })),
    ...sessionEvents
      .filter((e) => e.kind === 'prd_created' || e.kind === 'closed' || (e.kind === 'response' && !isDup(e)))
      .map((e) => ({ kind: 'event' as const, at: Date.parse(e.at), event: e })),
  ].sort((a, b) => a.at - b.at)
  const cardStates = questionCardStates(turns)
  const items = timeline.map((item) => {
    if (item.kind !== 'turn') return item
    const index = visibleTurns.indexOf(item.turn)
    return {
      ...item,
      index,
      precedingUserPrompt: nearestPrecedingUserPrompt(visibleTurns, index),
      questionCardState: item.turn.role === 'question' ? cardStates.get(item.turn.id) : undefined,
    }
  })
  return { visibleTurns, hiddenCount, revealLevel, latest, items, lastAssistantIndex }
}

const ROLES: ChatTurnRole[] = ['user', 'assistant', 'event', 'assistant', 'event', 'question', 'notice', 'user']
const T0 = Date.parse('2026-09-01T00:00:00Z')

function fixtureTurns(n: number): ChatTurn[] {
  return Array.from({ length: n }, (_, i) => {
    const role = ROLES[i % ROLES.length]
    const t: ChatTurn = { id: `t${i}`, role, text: `${role} text ${i}`, at: T0 + i * 1000 }
    if (role === 'event') {
      t.kind = i % 4 === 2 ? 'ai-title' : 'attachment'
      if (t.kind === 'ai-title') t.signal = { text: i % 8 === 2 ? 'same' : `title ${i}` } as ChatTurn['signal']
    }
    return t
  })
}

function fixtureEvents(turns: ChatTurn[]): PromptSessionEvent[] {
  const ev = (i: number, extra: Partial<PromptSessionEvent>): PromptSessionEvent => ({
    id: `e${i}`,
    promptSessionId: 'p',
    kind: 'response',
    causedByEventId: null,
    at: new Date(T0 + i * 1700 + 500).toISOString(),
    ...extra,
  })
  const out: PromptSessionEvent[] = []
  for (let i = 0; i < 120; i++) {
    if (i % 5 === 0) out.push(ev(i, { kind: 'prd_created', prdSlug: `prd-${i % 7}` }))
    else if (i % 5 === 1) out.push(ev(i, { text: 'out of band reply', prdSlug: `prd-${i % 7}`, validation: i % 2 ? 'verified' : 'refuted' }))
    else if (i % 5 === 2) out.push(ev(i, { text: turns.find((t) => t.role === 'assistant' && t.id === `t${(i * 3) % 500}`)?.text ?? 'assistant text 1' }))
    else if (i % 5 === 3) out.push(ev(i, { text: 'assistant text 1'.slice(0, 10) + '…' }))
    else out.push(ev(i, { kind: 'closed' }))
  }
  return out
}

describe('buildEpicTimeline', () => {
  const turns = fixtureTurns(500)
  const events = fixtureEvents(turns)

  for (const verbosity of ['summary', 'brief', 'standard', 'detail', 'raw'] as ChatVerbosity[]) {
    it(`matches the pre-change inline logic at verbosity=${verbosity}`, () => {
      const got = buildEpicTimeline(turns, events, verbosity)
      const want = legacy(turns, events, verbosity)
      expect(got.visibleTurns).toEqual(want.visibleTurns)
      expect(got.hiddenCount).toBe(want.hiddenCount)
      expect(got.revealLevel).toBe(want.revealLevel)
      expect(got.lastAssistantIndex).toBe(want.lastAssistantIndex)
      expect([...got.latestValidationBySlug]).toEqual([...want.latest])
      expect(got.timeline).toEqual(want.items)
    })
  }

  describe('latestValidationBySlug keyed by bare slug', () => {
    const at = (i: number) => new Date(T0 + i * 1000).toISOString()
    const base = (i: number, extra: Partial<PromptSessionEvent>): PromptSessionEvent => ({
      id: `v${i}`, promptSessionId: 'p', kind: 'response', causedByEventId: null, at: at(i), ...extra,
    })
    const realEvents = (verdict?: 'verified' | 'refuted'): PromptSessionEvent[] => [
      base(0, { kind: 'prd_created', prdSlug: '3309-external-ref-schema' }),
      base(1, { text: 'PRD 3309-external-ref-schema finished: completed. Check Scheduler for details.', prdSlug: '3309-external-ref-schema', outcome: 'completed', validation: 'unvalidated' }),
      ...(verdict ? [base(2, { text: `Validation ${verdict.toUpperCase()}: external-ref-schema`, prdSlug: 'external-ref-schema', outcome: 'completed', validation: verdict })] : []),
    ]

    it('a bare-slug verified verdict overwrites the numbered finish event', () => {
      const m = buildEpicTimeline([], realEvents('verified'), 'standard').latestValidationBySlug
      expect([...m]).toEqual([['external-ref-schema', 'verified']])
      expect(m.get(bareSlug('3309-external-ref-schema'))).toBe('verified')
    })

    it('a bare-slug refuted verdict overwrites the numbered finish event', () => {
      const m = buildEpicTimeline([], realEvents('refuted'), 'standard').latestValidationBySlug
      expect(m.get(bareSlug('3309-external-ref-schema'))).toBe('refuted')
    })

    it('with no verdict event the finish event stays unvalidated', () => {
      const m = buildEpicTimeline([], realEvents(), 'standard').latestValidationBySlug
      expect(m.get(bareSlug('3309-external-ref-schema'))).toBe('unvalidated')
    })
  })

  describe('latestOutcomeBySlug keyed by bare slug', () => {
    const at = (i: number) => new Date(T0 + i * 1000).toISOString()
    const base = (i: number, extra: Partial<PromptSessionEvent>): PromptSessionEvent => ({
      id: `o${i}`, promptSessionId: 'p', kind: 'response', causedByEventId: null, at: at(i), ...extra,
    })

    it('maps a numbered finish event to its outcome under the bare slug', () => {
      const m = buildEpicTimeline([], [
        base(0, { kind: 'prd_created', prdSlug: '3441-validate-continue-in-fresh-session' }),
        base(1, { prdSlug: '3441-validate-continue-in-fresh-session', outcome: 'completed', validation: 'unvalidated' }),
      ], 'standard').latestOutcomeBySlug
      expect([...m]).toEqual([['validate-continue-in-fresh-session', 'completed']])
    })

    it('a later event for the same PRD wins; events without slug or outcome are ignored', () => {
      const m = buildEpicTimeline([], [
        base(0, { prdSlug: '3309-external-ref-schema', outcome: 'failed' }),
        base(1, { prdSlug: '3310-external-ref-schema', outcome: 'needs_review' }),
        base(2, { prdSlug: 'external-ref-schema' }),
        base(3, { outcome: 'completed' }),
        base(4, { kind: 'prd_created', prdSlug: 'external-ref-schema', outcome: 'completed' }),
      ], 'standard').latestOutcomeBySlug
      expect([...m]).toEqual([['external-ref-schema', 'needs_review']])
    })
  })

  it('handles empty input', () => {
    const got = buildEpicTimeline([], [], 'standard')
    expect(got.timeline).toEqual([])
    expect(got.lastAssistantIndex).toBe(-1)
  })

  describe('questionCardState', () => {
    const SCHEDULER_TEXT =
      'IMPORTANT: This turn was started by the scheduler and nobody is watching. ' +
      'Do not ask questions; decide and act, ' +
      'and end with a short report of what you did.' +
      '\n\nPRD 12 finished: completed.'
    const mk = (id: string, role: ChatTurnRole, text: string, i: number): ChatTurn => ({ id, role, text, at: T0 + i * 1000 })
    const stateOf = (turns: ChatTurn[], id: string) => {
      const item = buildEpicTimeline(turns, [], 'standard').timeline.find((x) => x.kind === 'turn' && x.turn.id === id)
      return item?.kind === 'turn' ? item.questionCardState : 'missing'
    }

    it('a question followed by a human user turn is answered', () => {
      const turns = [mk('q', 'question', 'Which option?', 0), mk('u', 'user', 'option B', 1)]
      expect(stateOf(turns, 'q')).toBe('answered')
      expect(stateOf(turns, 'u')).toBeUndefined()
    })

    it('a question followed only by a scheduler check-in stays open', () => {
      const turns = [mk('q', 'question', 'Which option?', 0), mk('s', 'user', SCHEDULER_TEXT, 1)]
      expect(stateOf(turns, 'q')).toBe('open')
    })

    it('an older question followed by a newer one is superseded', () => {
      const turns = [mk('q1', 'question', 'First?', 0), mk('a', 'assistant', 'hm', 1), mk('q2', 'question', 'Second?', 2)]
      expect(stateOf(turns, 'q1')).toBe('superseded')
      expect(stateOf(turns, 'q2')).toBe('open')
    })
  })
})
