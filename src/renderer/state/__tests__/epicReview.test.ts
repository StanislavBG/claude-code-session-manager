import { beforeEach, describe, expect, it } from 'vitest'
import { selectEpicComments, selectEpicNote, useEpicReview } from '../epicReview'

const draft = {
  sectionKey: 'session:live',
  sectionLabel: 'Live',
  commit: null,
  path: 'src/a.ts',
  side: 'new' as const,
  startLine: 3,
  endLine: 3,
  lineText: 'const a = 1',
  body: 'rename this',
}

beforeEach(() => {
  useEpicReview.setState({ byEpic: {} })
})

describe('useEpicReview', () => {
  it('adds a comment with a fresh id and createdAt', () => {
    const id = useEpicReview.getState().addComment('e1', draft)
    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)
    const comments = selectEpicComments('e1')(useEpicReview.getState())
    expect(comments).toHaveLength(1)
    expect(comments[0]).toMatchObject({ ...draft, id })
    expect(typeof comments[0].createdAt).toBe('number')
    const id2 = useEpicReview.getState().addComment('e1', draft)
    expect(id2).not.toBe(id)
  })

  it('updates and removes a comment', () => {
    const s = useEpicReview.getState()
    const a = s.addComment('e1', draft)
    const b = s.addComment('e1', { ...draft, body: 'second' })
    useEpicReview.getState().updateComment('e1', a, 'changed')
    let comments = selectEpicComments('e1')(useEpicReview.getState())
    expect(comments.find((c) => c.id === a)?.body).toBe('changed')
    expect(comments.find((c) => c.id === b)?.body).toBe('second')
    useEpicReview.getState().removeComment('e1', a)
    comments = selectEpicComments('e1')(useEpicReview.getState())
    expect(comments.map((c) => c.id)).toEqual([b])
  })

  it('sets the note and clears an Epic', () => {
    const s = useEpicReview.getState()
    s.addComment('e1', draft)
    s.setNote('e1', 'overall')
    expect(selectEpicNote('e1')(useEpicReview.getState())).toBe('overall')
    useEpicReview.getState().clear('e1')
    expect(selectEpicComments('e1')(useEpicReview.getState())).toHaveLength(0)
    expect(selectEpicNote('e1')(useEpicReview.getState())).toBe('')
  })

  it('keeps two Epics isolated', () => {
    const s = useEpicReview.getState()
    const a = s.addComment('e1', draft)
    s.addComment('e2', { ...draft, body: 'other' })
    s.setNote('e2', 'note 2')
    useEpicReview.getState().removeComment('e2', a) // id from e1 — no effect on either
    useEpicReview.getState().clear('e2')
    const st = useEpicReview.getState()
    expect(selectEpicComments('e1')(st).map((c) => c.id)).toEqual([a])
    expect(selectEpicNote('e1')(st)).toBe('')
    expect(selectEpicComments('e2')(st)).toHaveLength(0)
  })

  it('returns stable references for an unknown Epic and unchanged state', () => {
    const st = useEpicReview.getState()
    const first = selectEpicComments('nope')(st)
    const second = selectEpicComments('nope')(useEpicReview.getState())
    expect(first).toBe(second)
    expect(Object.isFrozen(first)).toBe(true)
    expect(selectEpicNote('nope')(st)).toBe('')
    useEpicReview.getState().addComment('e1', draft)
    const s1 = useEpicReview.getState()
    expect(selectEpicComments('e1')(s1)).toBe(selectEpicComments('e1')(s1))
  })
})
