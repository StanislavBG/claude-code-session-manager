import { describe, it, expect } from 'vitest'
import { parseTranscriptTurns, selectNewTurns } from '../terminalHandoffTranscript'

describe('terminalHandoffTranscript.ts', () => {
  describe('parseTranscriptTurns', () => {
    it('extracts user and assistant text turns from raw session JSONL', () => {
      const raw = [
        JSON.stringify({
          type: 'user',
          timestamp: '2026-01-01T00:00:00.000Z',
          message: { role: 'user', content: 'hello there' },
        }),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-01-01T00:00:01.000Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'hi, how can I help?' }] },
        }),
      ].join('\n')

      const turns = parseTranscriptTurns(raw)
      expect(turns).toEqual([
        { role: 'user', text: 'hello there', at: '2026-01-01T00:00:00.000Z' },
        { role: 'assistant', text: 'hi, how can I help?', at: '2026-01-01T00:00:01.000Z' },
      ])
    })

    it('drops tool-only turns with no text content block', () => {
      const raw = JSON.stringify({
        type: 'assistant',
        timestamp: '2026-01-01T00:00:00.000Z',
        message: { role: 'assistant', content: [{ type: 'tool_use', input: {} }] },
      })
      expect(parseTranscriptTurns(raw)).toEqual([])
    })

    it('skips an unparseable/torn line instead of throwing', () => {
      const raw = [
        JSON.stringify({
          type: 'user',
          timestamp: '2026-01-01T00:00:00.000Z',
          message: { role: 'user', content: 'ok turn' },
        }),
        '{"type":"user","message":{"content":"cut off mid',
      ].join('\n')
      expect(() => parseTranscriptTurns(raw)).not.toThrow()
      expect(parseTranscriptTurns(raw)).toEqual([
        { role: 'user', text: 'ok turn', at: '2026-01-01T00:00:00.000Z' },
      ])
    })

    it('joins multiple text blocks in one message', () => {
      const raw = JSON.stringify({
        type: 'assistant',
        timestamp: '2026-01-01T00:00:00.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'part one' }, { type: 'text', text: 'part two' }] },
      })
      expect(parseTranscriptTurns(raw)).toEqual([
        { role: 'assistant', text: 'part one\npart two', at: '2026-01-01T00:00:00.000Z' },
      ])
    })
  })

  describe('selectNewTurns', () => {
    const turns = [
      { role: 'user' as const, text: 'a', at: '2026-01-01T00:00:00.000Z' },
      { role: 'assistant' as const, text: 'b', at: '2026-01-01T00:00:01.000Z' },
      { role: 'user' as const, text: 'c', at: '2026-01-01T00:00:02.000Z' },
    ]

    it('returns every turn when no prior capture exists', () => {
      expect(selectNewTurns(turns, null)).toEqual(turns)
    })

    it('returns only turns strictly after the last captured timestamp', () => {
      expect(selectNewTurns(turns, '2026-01-01T00:00:00.000Z')).toEqual(turns.slice(1))
    })

    it('returns nothing when every turn is at or before the cutoff', () => {
      expect(selectNewTurns(turns, '2026-01-01T00:00:02.000Z')).toEqual([])
    })
  })
})
