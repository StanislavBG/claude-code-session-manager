import { describe, expect, it } from 'vitest'
import { applySpanEdit } from '../applySpanEdit'

describe('applySpanEdit', () => {
  it('replaces the unique occurrence of before with after', () => {
    const buffer = 'Intro.\n\nOld sentence here.\n\nOutro.'
    const r = applySpanEdit(buffer, 'Old sentence here.', 'New sentence here.')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.next).toBe('Intro.\n\nNew sentence here.\n\nOutro.')
  })

  it('returns not-found when the span occurs zero times', () => {
    const buffer = 'Intro.\n\nSomething else entirely.\n\nOutro.'
    const r = applySpanEdit(buffer, 'Old sentence here.', 'New sentence here.')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('not-found')
  })

  it('returns ambiguous when the span occurs 2+ times', () => {
    const buffer = 'Repeat this. Then repeat this again: Repeat this.'
    const r = applySpanEdit(buffer, 'Repeat this.', 'Changed.')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('ambiguous')
  })

  it('falls back to a whitespace-normalized match when the rendered selection collapses newlines to spaces', () => {
    const buffer = 'Intro.\n\nFoo\nbar\nbaz.\n\nOutro.'
    // The rendered selection joins wrapped source lines with single spaces.
    const r = applySpanEdit(buffer, 'Foo bar baz.', 'Rewritten line.')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.next).toBe('Intro.\n\nRewritten line.\n\nOutro.')
  })

  it('maps the whitespace-normalized match back to the correct original offsets', () => {
    const buffer = 'A\n\nHead   line\n\nB'
    const r = applySpanEdit(buffer, 'Head line', 'Fixed')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.next).toBe('A\n\nFixed\n\nB')
  })

  it('returns not-found when even the whitespace-normalized match fails', () => {
    const buffer = 'Intro.\n\nSomething else entirely.\n\nOutro.'
    const r = applySpanEdit(buffer, 'Foo bar baz.', 'Rewritten.')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('not-found')
  })
})
