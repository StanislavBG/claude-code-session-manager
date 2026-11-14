import { beforeEach, describe, expect, it } from 'vitest'
import { questionCardKey, useQuestionDrafts } from '../questionDrafts'

const A = 'tab1:ref:10'
const B = 'tab1:ref:99'

function draft(key: string) {
  return useQuestionDrafts.getState().drafts[key]
}

describe('questionDrafts store', () => {
  beforeEach(() => {
    useQuestionDrafts.setState({ drafts: {} })
  })

  it('setText creates a draft and stores text per question index', () => {
    const s = useQuestionDrafts.getState()
    s.setText(A, 0, 'hello')
    s.setText(A, 2, 'world')
    expect(draft(A)).toEqual({ text: { 0: 'hello', 2: 'world' }, resolved: {} })
  })

  it('resolve commits a resolution for one index', () => {
    const s = useQuestionDrafts.getState()
    s.resolve(A, 1, { kind: 'answer', text: 'yes' })
    s.resolve(A, 0, { kind: 'delegate' })
    expect(draft(A).resolved).toEqual({
      0: { kind: 'delegate' },
      1: { kind: 'answer', text: 'yes' },
    })
  })

  it('reopen deletes resolved[index] but keeps text[index]', () => {
    const s = useQuestionDrafts.getState()
    s.setText(A, 0, 'typed')
    s.resolve(A, 0, { kind: 'answer', text: 'typed' })
    s.resolve(A, 1, { kind: 'delegate' })
    s.reopen(A, 0)
    expect(draft(A).resolved).toEqual({ 1: { kind: 'delegate' } })
    expect(draft(A).text).toEqual({ 0: 'typed' })
  })

  it('markSubmitted records how the reply went out', () => {
    const s = useQuestionDrafts.getState()
    s.markSubmitted(A, 'queued')
    expect(draft(A).submitted).toBe('queued')
    s.markSubmitted(A, 'sent')
    expect(draft(A).submitted).toBe('sent')
  })

  it('clear removes the draft', () => {
    const s = useQuestionDrafts.getState()
    s.setText(A, 0, 'x')
    s.setText(B, 0, 'y')
    s.clear(A)
    expect(draft(A)).toBeUndefined()
    expect(draft(B)).toBeDefined()
  })

  it('resolve and reopen are no-ops once submitted', () => {
    const s = useQuestionDrafts.getState()
    s.resolve(A, 0, { kind: 'answer', text: 'a' })
    s.markSubmitted(A, 'sent')
    const before = draft(A)
    s.resolve(A, 1, { kind: 'delegate' })
    s.reopen(A, 0)
    expect(draft(A)).toBe(before)
    expect(draft(A).resolved).toEqual({ 0: { kind: 'answer', text: 'a' } })
  })

  it('every action keeps reference equality for untouched keys', () => {
    const s = useQuestionDrafts.getState()
    s.setText(B, 0, 'other')
    const b = draft(B)
    s.setText(A, 0, 't')
    expect(draft(B)).toBe(b)
    s.resolve(A, 0, { kind: 'delegate' })
    expect(draft(B)).toBe(b)
    s.reopen(A, 0)
    expect(draft(B)).toBe(b)
    s.markSubmitted(A, 'queued')
    expect(draft(B)).toBe(b)
    s.clear(A)
    expect(draft(B)).toBe(b)
  })

  it('touched draft gets a new object on each action', () => {
    const s = useQuestionDrafts.getState()
    s.setText(A, 0, 't')
    const a1 = draft(A)
    s.resolve(A, 0, { kind: 'delegate' })
    expect(draft(A)).not.toBe(a1)
  })
})

describe('questionCardKey', () => {
  it('uses the transcript byte offset when ref is present', () => {
    expect(questionCardKey('tab1', { id: 'x', ref: { byteOffset: 42 } })).toBe('tab1:ref:42')
  })

  it('falls back to the turn id when ref is absent or null', () => {
    expect(questionCardKey('tab1', { id: 'turn-7' })).toBe('tab1:id:turn-7')
    expect(questionCardKey('tab1', { id: 'turn-7', ref: null })).toBe('tab1:id:turn-7')
  })
})
