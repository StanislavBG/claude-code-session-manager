import { describe, it, expect } from 'vitest'
import {
  turnMinVerbosity,
  filterTurnsByVerbosity,
  clampTurnText,
  verbosityRank,
  levelNumber,
  isChatVerbosity,
  showsToolStrip,
  showsInjectedPreamble,
  ASSISTANT_CLAMP_CHARS,
  CHAT_VERBOSITY_ORDER,
  CHAT_VERBOSITY_DISPLAY_ORDER,
  type ChatVerbosity,
} from '../chatVerbosity'
import type { ChatTurn } from '../../state/chat'

function turn(partial: Partial<ChatTurn> & Pick<ChatTurn, 'role'>): ChatTurn {
  return { id: Math.random().toString(36).slice(2), text: '', at: 0, ...partial }
}

function ev(kind: string, signal?: ChatTurn['signal']): ChatTurn {
  return turn({ role: 'event', kind, signal })
}

describe('level numbering', () => {
  it('numbers 1 = loudest … 5 = quietest, matching the dial the user reads', () => {
    expect(levelNumber('raw')).toBe(1)
    expect(levelNumber('detail')).toBe(2)
    expect(levelNumber('standard')).toBe(3)
    expect(levelNumber('brief')).toBe(4)
    expect(levelNumber('summary')).toBe(5)
  })

  it('display order runs loudest-first, the inverse of the internal rank order', () => {
    expect(CHAT_VERBOSITY_DISPLAY_ORDER).toEqual([...CHAT_VERBOSITY_ORDER].reverse())
    expect(CHAT_VERBOSITY_DISPLAY_ORDER.map(levelNumber)).toEqual([1, 2, 3, 4, 5])
  })
})

describe('turnMinVerbosity', () => {
  it('keeps every interactive role at the quietest level', () => {
    for (const role of ['user', 'assistant', 'question', 'notice', 'error'] as const) {
      expect(turnMinVerbosity(turn({ role }))).toBe('summary')
    }
  })

  it('CORE: tool cards are level 1-2 only', () => {
    expect(turnMinVerbosity(ev('tool_use'))).toBe('detail')
    expect(turnMinVerbosity(ev('tool_result'))).toBe('detail')
    expect(turnMinVerbosity(ev('content_thinking'))).toBe('detail')
    expect(levelNumber(turnMinVerbosity(ev('tool_use')))).toBe(2)
  })

  it('classifies "what changed" as standard (level 3)', () => {
    expect(turnMinVerbosity(ev('queue-operation'))).toBe('standard')
    expect(turnMinVerbosity(ev('file-history-snapshot'))).toBe('standard')
    expect(turnMinVerbosity(ev('attachment', { subtype: 'edited_text_file' } as ChatTurn['signal']))).toBe('standard')
  })

  it('classifies transcript plumbing as raw (level 1)', () => {
    expect(turnMinVerbosity(ev('usage'))).toBe('raw')
    expect(turnMinVerbosity(ev('last-prompt'))).toBe('raw')
    expect(turnMinVerbosity(ev('mode'))).toBe('raw')
    expect(turnMinVerbosity(ev('attachment', { subtype: 'task_reminder' } as ChatTurn['signal']))).toBe('raw')
  })

  it('defaults an unknown/future event kind to raw rather than dropping it', () => {
    expect(turnMinVerbosity(ev('some-kind-invented-in-2027'))).toBe('raw')
    expect(turnMinVerbosity(turn({ role: 'event' }))).toBe('raw')
  })
})

describe('filterTurnsByVerbosity', () => {
  const feed: ChatTurn[] = [
    turn({ role: 'user', text: 'go' }),
    ev('tool_use'),
    ev('tool_result'),
    ev('attachment', { subtype: 'edited_text_file' } as ChatTurn['signal']),
    turn({ role: 'assistant', text: 'done' }),
    ev('usage'),
    turn({ role: 'question', questions: ['Ship it?'], text: 'Ship it?' }),
  ]

  it('CORE: levels 3, 4 and 5 hide every tool card', () => {
    for (const level of ['standard', 'brief', 'summary'] as ChatVerbosity[]) {
      const { visible } = filterTurnsByVerbosity(feed, level)
      expect(visible.some((t) => t.kind === 'tool_use')).toBe(false)
      expect(visible.some((t) => t.kind === 'tool_result')).toBe(false)
    }
  })

  it('CORE: levels 1 and 2 show tool cards', () => {
    for (const level of ['detail', 'raw'] as ChatVerbosity[]) {
      const { visible } = filterTurnsByVerbosity(feed, level)
      expect(visible.some((t) => t.kind === 'tool_use')).toBe(true)
      expect(visible.some((t) => t.kind === 'tool_result')).toBe(true)
    }
  })

  it('level 3 keeps the file-change event but not the tool trace', () => {
    const { visible, hiddenCount } = filterTurnsByVerbosity(feed, 'standard')
    expect(visible.map((t) => t.role)).toEqual(['user', 'event', 'assistant', 'question'])
    expect(visible[1].signal?.subtype).toBe('edited_text_file')
    expect(hiddenCount).toBe(3) // tool_use, tool_result, usage
  })

  it('levels 4 and 5 are conversation-only', () => {
    for (const level of ['brief', 'summary'] as ChatVerbosity[]) {
      const { visible } = filterTurnsByVerbosity(feed, level)
      expect(visible.every((t) => t.role !== 'event')).toBe(true)
    }
  })

  it('level 1 hides nothing and preserves order', () => {
    const { visible, hiddenCount, revealLevel } = filterTurnsByVerbosity(feed, 'raw')
    expect(visible).toEqual(feed)
    expect(hiddenCount).toBe(0)
    expect(revealLevel).toBe(null)
  })

  it('revealLevel is the quietest level that would show everything hidden', () => {
    // At 'standard' a raw-only turn (usage) is hidden → must jump to 'raw'.
    expect(filterTurnsByVerbosity(feed, 'standard').revealLevel).toBe('raw')
    // Drop the raw-only turn: the loudest thing left is tool traces.
    const noPlumbing = feed.filter((t) => t.kind !== 'usage')
    expect(filterTurnsByVerbosity(noPlumbing, 'standard').revealLevel).toBe('detail')
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

  it('is monotone: a louder level never shows fewer turns', () => {
    let previous = -1
    for (const level of CHAT_VERBOSITY_ORDER) {
      const { visible } = filterTurnsByVerbosity(feed, level)
      expect(visible.length).toBeGreaterThanOrEqual(previous)
      previous = visible.length
    }
  })

  it('does not mutate the input array', () => {
    const input = [...feed]
    filterTurnsByVerbosity(input, 'summary')
    expect(input).toEqual(feed)
  })
})

describe('per-level affordances', () => {
  it('CORE: the assistant tool strip follows the same 1-2 rule as tool event cards', () => {
    expect(showsToolStrip('raw')).toBe(true)
    expect(showsToolStrip('detail')).toBe(true)
    expect(showsToolStrip('standard')).toBe(false)
    expect(showsToolStrip('brief')).toBe(false)
    expect(showsToolStrip('summary')).toBe(false)
  })

  it('the injected prompt preamble renders inline at level 1 only', () => {
    expect(showsInjectedPreamble('raw')).toBe(true)
    for (const level of ['detail', 'standard', 'brief', 'summary'] as ChatVerbosity[]) {
      expect(showsInjectedPreamble(level)).toBe(false)
    }
  })

  it('only level 5 clamps assistant prose', () => {
    expect(ASSISTANT_CLAMP_CHARS.summary).toBeGreaterThan(0)
    for (const level of ['brief', 'standard', 'detail', 'raw'] as ChatVerbosity[]) {
      expect(ASSISTANT_CLAMP_CHARS[level]).toBe(null)
    }
  })
})

describe('verbosityRank / isChatVerbosity', () => {
  it('orders quiet → loud', () => {
    expect(verbosityRank('summary')).toBeLessThan(verbosityRank('brief'))
    expect(verbosityRank('brief')).toBeLessThan(verbosityRank('standard'))
    expect(verbosityRank('standard')).toBeLessThan(verbosityRank('detail'))
    expect(verbosityRank('detail')).toBeLessThan(verbosityRank('raw'))
  })

  it('treats a corrupt persisted value as the loudest level, never the quietest', () => {
    expect(verbosityRank('garbage' as ChatVerbosity)).toBe(verbosityRank('raw'))
    expect(isChatVerbosity('garbage')).toBe(false)
    // The retired 3-level name is no longer a valid level (chatPrefs migrates it).
    expect(isChatVerbosity('verbose')).toBe(false)
    expect(isChatVerbosity('summary')).toBe(true)
  })
})

describe('clampTurnText', () => {
  it('returns short text untouched', () => {
    const r = clampTurnText('hello', 100)
    expect(r).toEqual({ body: 'hello', truncated: false, hiddenChars: 0 })
  })

  it('is a no-op when max is null', () => {
    const long = 'x'.repeat(5000)
    expect(clampTurnText(long, null).truncated).toBe(false)
    expect(clampTurnText(long, ASSISTANT_CLAMP_CHARS.raw).body).toBe(long)
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
