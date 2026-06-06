import { describe, it, expect } from 'vitest'
import { parseRunLog } from '../../src/renderer/lib/runLog'

describe('parseRunLog — empty/whitespace input', () => {
  it('empty string returns zero events', () => {
    const r = parseRunLog('')
    expect(r.events).toHaveLength(0)
    expect(r.rawLineCount).toBe(0)
    expect(r.truncated).toBe(false)
    expect(r.errors.count).toBe(0)
  })

  it('whitespace-only input returns zero events', () => {
    const r = parseRunLog('   \n\n  \n')
    expect(r.events).toHaveLength(0)
    expect(r.rawLineCount).toBe(0)
  })
})

describe('parseRunLog — mixed JSON + non-JSON lines', () => {
  const log = [
    '{"type":"system","subtype":"init","session_id":"abc"}',
    'some plain text line',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"Hello there"}]}}',
    'another non-json line',
    '{"type":"result","subtype":"success","result":"done"}',
  ].join('\n')

  it('parses the correct event count', () => {
    const r = parseRunLog(log)
    expect(r.events).toHaveLength(5)
    expect(r.rawLineCount).toBe(5)
  })

  it('classifies JSON lines with correct type', () => {
    const r = parseRunLog(log)
    expect(r.events[0].type).toBe('system')
    expect(r.events[2].type).toBe('assistant')
    expect(r.events[4].type).toBe('result')
  })

  it('classifies non-JSON lines as raw', () => {
    const r = parseRunLog(log)
    expect(r.events[1].type).toBe('raw')
    expect(r.events[3].type).toBe('raw')
  })

  it('raw lines have isError=false', () => {
    const r = parseRunLog(log)
    expect(r.events[1].isError).toBe(false)
    expect(r.events[3].isError).toBe(false)
  })
})

describe('parseRunLog — error detection', () => {
  it('result with non-success subtype is detected as error', () => {
    const log = '{"type":"result","subtype":"error_max_turns","result":"Max turns reached","is_error":true}'
    const r = parseRunLog(log)
    expect(r.events[0].isError).toBe(true)
    expect(r.errors.count).toBe(1)
    expect(r.errors.firstMessage).toBeTruthy()
  })

  it('result with success subtype is NOT an error', () => {
    const log = '{"type":"result","subtype":"success","result":"done"}'
    const r = parseRunLog(log)
    expect(r.events[0].isError).toBe(false)
    expect(r.errors.count).toBe(0)
  })

  it('event with is_error:true field is detected', () => {
    const log = '{"type":"assistant","is_error":true,"text":"something broke"}'
    const r = parseRunLog(log)
    expect(r.events[0].isError).toBe(true)
    expect(r.errors.count).toBe(1)
  })

  it('event with non-null error field is detected', () => {
    const log = '{"type":"system","error":"connection refused"}'
    const r = parseRunLog(log)
    expect(r.events[0].isError).toBe(true)
    expect(r.errors.count).toBe(1)
    expect(r.errors.firstMessage).toContain('connection refused')
  })

  it('firstMessage is the first error encountered', () => {
    const log = [
      '{"type":"result","subtype":"error_max_turns","result":"first error"}',
      '{"type":"result","subtype":"error_quota","result":"second error"}',
    ].join('\n')
    const r = parseRunLog(log)
    expect(r.errors.count).toBe(2)
    expect(r.errors.firstMessage).toContain('first error')
  })

  it('no errors → firstMessage is null', () => {
    const log = '{"type":"result","subtype":"success","result":"done"}'
    const r = parseRunLog(log)
    expect(r.errors.count).toBe(0)
    expect(r.errors.firstMessage).toBeNull()
  })
})

describe('parseRunLog — malformed lines never throw', () => {
  it('handles truncated JSON gracefully as raw line', () => {
    const log = '{"type":"assistant","message":{"content":'
    expect(() => parseRunLog(log)).not.toThrow()
    const r = parseRunLog(log)
    expect(r.events[0].type).toBe('raw')
  })

  it('handles JSON array (no type field) as raw line', () => {
    const log = '[1,2,3]'
    const r = parseRunLog(log)
    expect(r.events[0].type).toBe('raw')
  })

  it('handles JSON null as raw line', () => {
    const log = 'null'
    const r = parseRunLog(log)
    expect(r.events[0].type).toBe('raw')
  })

  it('handles JSON string as raw line', () => {
    const log = '"just a string"'
    const r = parseRunLog(log)
    expect(r.events[0].type).toBe('raw')
  })

  it('handles mixed malformed and valid lines', () => {
    const log = [
      '{broken json',
      '{"type":"result","subtype":"success","result":"ok"}',
      'plain text',
    ].join('\n')
    expect(() => parseRunLog(log)).not.toThrow()
    const r = parseRunLog(log)
    expect(r.events).toHaveLength(3)
    expect(r.events[0].type).toBe('raw')
    expect(r.events[1].type).toBe('result')
    expect(r.events[2].type).toBe('raw')
  })
})

describe('parseRunLog — 2000-event cap', () => {
  it('returns exactly 2000 events when rawLineCount > 2000', () => {
    const lines = Array.from({ length: 2500 }, (_, i) =>
      JSON.stringify({ type: 'assistant', text: `msg ${i}` }),
    )
    const r = parseRunLog(lines.join('\n'))
    expect(r.events).toHaveLength(2000)
    expect(r.rawLineCount).toBe(2500)
    expect(r.truncated).toBe(true)
  })

  it('truncated is false when rawLineCount <= 2000', () => {
    const lines = Array.from({ length: 10 }, (_, i) =>
      JSON.stringify({ type: 'assistant', text: `msg ${i}` }),
    )
    const r = parseRunLog(lines.join('\n'))
    expect(r.truncated).toBe(false)
    expect(r.events).toHaveLength(10)
  })

  it('truncated is false for exactly 2000 lines', () => {
    const lines = Array.from({ length: 2000 }, (_, i) =>
      JSON.stringify({ type: 'system', text: `line ${i}` }),
    )
    const r = parseRunLog(lines.join('\n'))
    expect(r.truncated).toBe(false)
    expect(r.events).toHaveLength(2000)
  })
})
