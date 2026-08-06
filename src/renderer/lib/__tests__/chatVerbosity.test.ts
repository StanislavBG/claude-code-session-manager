import { describe, it, expect } from 'vitest'
import {
  turnMinVerbosity,
  filterTurnsByVerbosity,
  clampTurnText,
  verbosityRank,
  isChatVerbosity,
  ASSISTANT_CLAMP_CHARS,
  CHAT_VERBOSITY_ORDER,
  type ChatVerbosity,
} from '../chatVerbosity'
import type { ChatTurn } from '../../state/chat'

function turn(partial: Partial<ChatTurn> & Pick<ChatTurn, 'role'>): ChatTurn {
  return { id: Math.random().toString(36).slice(2), text: '', at: 0, ...partial }
}

function ev(kind: string, signal?: ChatTurn['signal']): ChatTurn {
  return turn({ role: 'event', kind, signal })
}

describe('turnMinVerbosity', () => {
  it('keeps every interactive role at the lowest level', () => {
    for (const role of ['user', 'assistant', 'question', 'notice', 'error'] as const) {
      expect(turnMinVerbosity(turn({ role }))).toBe('summary')
    }
  })

  it('classifies real work as standard', () => {
    expect(turnMinVerbosity(ev('tool_use'))).toBe('standard')
    expect(turnMinVerbosity(ev('tool_result'))).toBe('standard')
    expect(turnMinVerbosity(ev('queue-operation'))).toBe('standard')
    expect(turnMinVerbosity(ev('file-history-snapshot'))).toBe('standard')
    expect(turnMinVerbosity(ev('attachment', { subtype: 'edited_text_file' } as ChatTurn['signal']))).toBe('standard')
  })

  it('classifies transcript plumbing as verbose', () => {
    expect(turnMinVerbosity(ev('content_thinking'))).toBe('verbose')
    expect(turnMinVerbosity(ev('mode'))).toBe('verbose')
    expect(turnMinVerbosity(ev('usage'))).toBe('verbose')
    expect(turnMinVerbosity(ev('attachment', { subtype: 'task_reminder' } as ChatTurn['signal']))).toBe('verbose')
  })

  it('defaults an unknown/future event kind to verbose rather than dropping it', () => {
    expect(turnMinVerbosity(ev('some-kind-invented-in-2027'))).toBe('verbose')
    expect(turnMinVerbosity(turn({ role: 'event' }))).toBe('verbose')
  })
})

describe('filterTurnsByVerbosity', () => {
  const feed: ChatTurn[] = [
    turn({ role: 'user', text: 'go' }),
    ev('content_thinking'),
    ev('tool_use'),
    turn({ role: 'assistant', text: 'done' }),
    ev('mode'),
    turn({ role: 'question', questions: ['Ship it?'], text: 'Ship it?' }),
  ]

  it('summary keeps only conversation + asks', () => {
    const { visible, hiddenCount, hiddenByLevel } = filterTurnsByVerbosity(feed, 'summary')
    expect(visible.map((t) => t.role)).toEqual(['user', 'assistant', 'question'])
    expect(hiddenCount).toBe(3)
    expect(hiddenByLevel).toEqual({ summary: 0, standard: 1, verbose: 2 })
  })

  it('standard adds tool activity but still hides plumbing', () => {
    const { visible, hiddenCount } = filterTurnsByVerbosity(feed, 'standard')
    expect(visible).toHaveLength(4)
    expect(visible.some((t) => t.kind === 'tool_use')).toBe(true)
    expect(visible.some((t) => t.kind === 'content_thinking')).toBe(false)
    expect(hiddenCount).toBe(2)
  })

  it('verbose hides nothing and preserves order', () => {
    const { visible, hiddenCount } = filterTurnsByVerbosity(feed, 'verbose')
    expect(visible).toEqual(feed)
    expect(hiddenCount).toBe(0)
  })

  it('never hides a question, notice or error at ANY level — the interaction invariant', () => {
    const asks: ChatTurn[] = [
      turn({ role: 'question', text: 'Approve?' }),
      turn({ role: 'notice', text: 'needs interactive consent for an MCP server' }),
      turn({ role: 'error', text: 'kill ceiling reached' }),
    ]
    for (const level of CHAT_VERBOSITY_ORDER) {
      const { visible, hiddenCount } = filterTurnsByVerbosity(asks, level)
      expect(visible).toHaveLength(3)
      expect(hiddenCount).toBe(0)
    }
  })

  it('does not mutate the input array', () => {
    const input = [...feed]
    filterTurnsByVerbosity(input, 'summary')
    expect(input).toEqual(feed)
  })
})

describe('verbosityRank / isChatVerbosity', () => {
  it('orders low → high', () => {
    expect(verbosityRank('summary')).toBeLessThan(verbosityRank('standard'))
    expect(verbosityRank('standard')).toBeLessThan(verbosityRank('verbose'))
  })

  it('treats a corrupt persisted value as the loudest level, never the quietest', () => {
    expect(verbosityRank('garbage' as ChatVerbosity)).toBe(verbosityRank('verbose'))
    expect(isChatVerbosity('garbage')).toBe(false)
    expect(isChatVerbosity('summary')).toBe(true)
  })
})

describe('clampTurnText', () => {
  it('returns short text untouched', () => {
    const r = clampTurnText('hello', 100)
    expect(r).toEqual({ body: 'hello', truncated: false, hiddenChars: 0 })
  })

  it('is a no-op when max is null (standard/verbose)', () => {
    const long = 'x'.repeat(5000)
    expect(clampTurnText(long, null).truncated).toBe(false)
    expect(clampTurnText(long, ASSISTANT_CLAMP_CHARS.verbose).body).toBe(long)
  })

  it('prefers the first paragraph when it fits the budget', () => {
    // Whole text is over budget; the first paragraph is under it.
    const text = `Lead paragraph.\n\n${'Second paragraph with much more detail. '.repeat(5)}`
    const r = clampTurnText(text, 40)
    expect(r.body).toBe('Lead paragraph.')
    expect(r.truncated).toBe(true)
    expect(r.hiddenChars).toBe(text.length - 'Lead paragraph.'.length)
  })

  it('cuts on a word boundary when no paragraph break fits', () => {
    const text = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet'
    const r = clampTurnText(text, 30)
    expect(r.truncated).toBe(true)
    expect(r.body.length).toBeLessThanOrEqual(30)
    expect(text.startsWith(r.body)).toBe(true)
    expect(r.body.endsWith(' ')).toBe(false)
    // never splits a word
    expect(text[r.body.length]).toBe(' ')
  })

  it('the summary budget actually clamps a long reply', () => {
    const text = 'A'.repeat(2000)
    const r = clampTurnText(text, ASSISTANT_CLAMP_CHARS.summary)
    expect(r.truncated).toBe(true)
    expect(r.hiddenChars).toBeGreaterThan(0)
    expect(r.body.length + r.hiddenChars).toBe(text.length)
  })
})
