/**
 * ASR repetition-collapse backstop.
 *
 * Reproduces the dictation bug where Moonshine's decoder looped and emitted a
 * phrase ~100× verbatim, and locks in that the collapser folds it while leaving
 * normal speech (and legitimate short repeats) intact.
 *
 * Source: src/renderer/lib/transcriptSanitize.ts.
 */
import { describe, it, expect } from 'vitest'
import { collapseRepetition } from '../../src/renderer/lib/transcriptSanitize'

describe('collapseRepetition', () => {
  it('collapses the real failure: a phrase repeated ~100×', () => {
    const phrase = 'So that we can create a web connection.'
    const looped = Array(100).fill(phrase).join(' ')
    const out = collapseRepetition(looped)
    expect(out).toBe(phrase)
  })

  it('collapses a single word repeated many times', () => {
    expect(collapseRepetition('the the the the the the the')).toBe('the')
  })

  it('collapses a repeated multi-word phrase to one copy (longest unit wins)', () => {
    expect(collapseRepetition('a b a b a b a b a b')).toBe('a b')
  })

  it('preserves legitimate short repeats (≤ maxRepeats)', () => {
    expect(collapseRepetition('no no no')).toBe('no no no')
    expect(collapseRepetition('very very good')).toBe('very very good')
  })

  it('leaves normal speech untouched', () => {
    const s = 'connect the web app to the local session manager after you sign in'
    expect(collapseRepetition(s)).toBe(s)
  })

  it('folds only the looping tail, keeping the real prefix', () => {
    const out = collapseRepetition('please open the scheduler tab tab tab tab tab tab')
    expect(out).toBe('please open the scheduler tab')
  })

  it('handles empty / short input without throwing', () => {
    expect(collapseRepetition('')).toBe('')
    expect(collapseRepetition('hello')).toBe('hello')
    expect(collapseRepetition('hi hi')).toBe('hi hi')
  })

  it('respects a custom maxRepeats threshold', () => {
    // default keeps ≤3; with maxRepeats:1 even a double folds
    expect(collapseRepetition('go go', { maxRepeats: 1 })).toBe('go')
  })
})
