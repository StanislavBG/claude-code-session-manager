// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import type { ChatTurn, ChatTurnRole } from '../../state/chat'
import type { PromptSessionEvent } from '../../state/promptSessions'
import { visibleFeedTurns, nearestPrecedingUserPrompt } from '../../components/ChatTranscriptTurn'
import { filterTurnsByVerbosity, type ChatVerbosity } from '../chatVerbosity'
import { splitStopSignal } from '../stopSignal'
import { buildEpicTimeline } from '../epicTimeline'

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
    if (e.kind === 'response' && e.prdSlug && e.validation) latest.set(e.prdSlug, e.validation)
  }
  const timeline = [
    ...visibleTurns.map((t) => ({ kind: 'turn' as const, at: t.at, turn: t })),
    ...sessionEvents
      .filter((e) => e.kind === 'prd_created' || e.kind === 'closed' || (e.kind === 'response' && !isDup(e)))
      .map((e) => ({ kind: 'event' as const, at: Date.parse(e.at), event: e })),
  ].sort((a, b) => a.at - b.at)
  const items = timeline.map((item) => {
    if (item.kind !== 'turn') return item
    const index = visibleTurns.indexOf(item.turn)
    return { ...item, index, precedingUserPrompt: nearestPrecedingUserPrompt(visibleTurns, index) }
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

  it('handles empty input', () => {
    const got = buildEpicTimeline([], [], 'standard')
    expect(got.timeline).toEqual([])
    expect(got.lastAssistantIndex).toBe(-1)
  })
})
