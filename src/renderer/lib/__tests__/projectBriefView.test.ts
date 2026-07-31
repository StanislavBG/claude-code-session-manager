import { describe, expect, it } from 'vitest'
import {
  formatSourceChip,
  heatPercent,
  safeList,
  scopeTone,
  synthesizedAgoLabel,
  tokenizeMd,
} from '../projectBriefView'

describe('tokenizeMd', () => {
  it('splits plain text into a single text token', () => {
    expect(tokenizeMd('hello world')).toEqual([{ type: 'text', text: 'hello world' }])
  })

  it('extracts a bold span', () => {
    expect(tokenizeMd('the **Tab** is the unit')).toEqual([
      { type: 'text', text: 'the ' },
      { type: 'bold', text: 'Tab' },
      { type: 'text', text: ' is the unit' },
    ])
  })

  it('extracts a code span', () => {
    expect(tokenizeMd('run `claude -p` here')).toEqual([
      { type: 'text', text: 'run ' },
      { type: 'code', text: 'claude -p' },
      { type: 'text', text: ' here' },
    ])
  })

  it('handles mixed bold and code spans', () => {
    expect(tokenizeMd('**bold** then `code`')).toEqual([
      { type: 'bold', text: 'bold' },
      { type: 'text', text: ' then ' },
      { type: 'code', text: 'code' },
    ])
  })

  it('returns an empty array for empty input', () => {
    expect(tokenizeMd('')).toEqual([])
  })

  it('handles null/undefined without throwing', () => {
    expect(tokenizeMd(null as unknown as string)).toEqual([])
    expect(tokenizeMd(undefined as unknown as string)).toEqual([])
  })
})

describe('scopeTone', () => {
  it('maps added to the delta-good family', () => {
    expect(scopeTone('added')).toEqual({ label: 'added', textClass: 'text-delta-good', borderClass: 'border-delta-good/40' })
  })

  it('maps narrowed to the delta-bad family', () => {
    expect(scopeTone('narrowed').textClass).toBe('text-delta-bad')
  })

  it('maps decided to the honey family', () => {
    expect(scopeTone('decided').textClass).toBe('text-honey-dark')
  })

  it('falls back to a neutral tone for an unknown kind instead of crashing', () => {
    const tone = scopeTone('whatever')
    expect(tone.label).toBe('whatever')
    expect(tone.textClass).toBe('text-fg-faint')
  })
})

describe('formatSourceChip', () => {
  it('passes through label/detail and omits the drift mark when not drifted', () => {
    expect(formatSourceChip({ label: 'CLAUDE.md', detail: '84 lines', drift: false })).toEqual({
      label: 'CLAUDE.md',
      detail: '84 lines',
      drift: false,
      driftMark: null,
    })
  })

  it('adds the "newer than brief" mark when drifted', () => {
    const chip = formatSourceChip({ label: 'CLAUDE.md', detail: '84 lines · changed 2h ago', drift: true })
    expect(chip.drift).toBe(true)
    expect(chip.driftMark).toBe('newer than brief')
  })
})

describe('synthesizedAgoLabel', () => {
  const now = 1_700_000_000_000

  it('formats a recent timestamp as "X ago"', () => {
    expect(synthesizedAgoLabel(new Date(now - 12 * 60_000).toISOString(), now)).toBe('synthesized 12m ago')
  })

  it('falls back when there is no timestamp', () => {
    expect(synthesizedAgoLabel(null, now)).toBe('not synthesized yet')
    expect(synthesizedAgoLabel(undefined, now)).toBe('not synthesized yet')
  })

  it('falls back on an unparseable timestamp', () => {
    expect(synthesizedAgoLabel('not-a-date', now)).toBe('not synthesized yet')
  })
})

describe('heatPercent', () => {
  it('converts a 0-1 fraction to a 0-100 integer', () => {
    expect(heatPercent(0.9)).toBe(90)
    expect(heatPercent(1)).toBe(100)
    expect(heatPercent(0)).toBe(0)
  })

  it('rounds fractional percentages', () => {
    expect(heatPercent(0.555)).toBe(56)
  })

  it('clamps out-of-range values', () => {
    expect(heatPercent(1.5)).toBe(100)
    expect(heatPercent(-0.2)).toBe(0)
  })

  it('defends against NaN/non-number input', () => {
    expect(heatPercent(NaN)).toBe(0)
    expect(heatPercent('0.5' as unknown as number)).toBe(0)
  })
})

describe('safeList', () => {
  it('passes through arrays unchanged', () => {
    const arr = [1, 2, 3]
    expect(safeList(arr)).toBe(arr)
  })

  it('defaults null/undefined/non-array to []', () => {
    expect(safeList(null)).toEqual([])
    expect(safeList(undefined)).toEqual([])
    expect(safeList('not an array' as unknown as string[])).toEqual([])
  })
})
