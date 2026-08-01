import { describe, expect, it } from 'vitest'
import { epicIdCandidates, resolveEpicRef, shortEpicId } from './epicProvenance'
import type { PromptSession } from '../state/promptSessions'

function session(id: string, goalText: string): PromptSession {
  return {
    id,
    cwd: '/p',
    goalText,
    claudeSessionId: `cs-${id}`,
    status: 'active',
    createdAt: '2026-07-31T00:00:00.000Z',
    completedAt: null,
  } as PromptSession
}

const SESSIONS: Record<string, PromptSession> = {
  'epic-real-abc12345': session('epic-real-abc12345', 'Scope the scheduler nav dot'),
  'epic-other-def67890': session('epic-other-def67890', 'Something else'),
}

describe('epicIdCandidates', () => {
  it('orders epicId first, then sourcePromptId, then sourceTabId', () => {
    expect(epicIdCandidates({ epicId: 'a', sourcePromptId: 'b', sourceTabId: 'c' })).toEqual(['a', 'b', 'c'])
  })

  it('drops nullish/empty ids and dedupes', () => {
    expect(epicIdCandidates({ epicId: null, sourcePromptId: 'b', sourceTabId: 'b' })).toEqual(['b'])
    expect(epicIdCandidates({ epicId: '', sourcePromptId: undefined, sourceTabId: null })).toEqual([])
    expect(epicIdCandidates(null)).toEqual([])
  })
})

describe('resolveEpicRef', () => {
  it('returns an unlinked ref when the row carries no Epic linkage at all', () => {
    expect(resolveEpicRef({}, SESSIONS)).toEqual({ epicId: null, label: null, known: false })
  })

  it('prefers the dir-derived epicId over frontmatter intent', () => {
    const ref = resolveEpicRef(
      { epicId: 'epic-real-abc12345', sourcePromptId: 'epic-other-def67890' },
      SESSIONS,
    )
    expect(ref).toEqual({ epicId: 'epic-real-abc12345', label: 'Scope the scheduler nav dot', known: true })
  })

  // The live queue.json case: sourcePromptId is a stale id nothing resolves to,
  // while sourceTabId is the real Epic dir. A first-candidate-wins resolver
  // would show a bare id here.
  it('falls through to a later candidate when an earlier one does not resolve', () => {
    const ref = resolveEpicRef(
      { sourcePromptId: 'psess-ms9x7241-9', sourceTabId: 'epic-real-abc12345' },
      SESSIONS,
    )
    expect(ref.known).toBe(true)
    expect(ref.epicId).toBe('epic-real-abc12345')
    expect(ref.label).toBe('Scope the scheduler nav dot')
  })

  it('keeps the first candidate id (unlabelled) when no candidate is loaded', () => {
    const ref = resolveEpicRef({ epicId: 'epic-archived-999', sourceTabId: 'nope' }, SESSIONS)
    expect(ref).toEqual({ epicId: 'epic-archived-999', label: null, known: false })
  })

  it('falls back to the id when a loaded Epic has an empty goalText', () => {
    const ref = resolveEpicRef({ epicId: 'blank' }, { blank: session('blank', '') })
    expect(ref).toEqual({ epicId: 'blank', label: 'blank', known: true })
  })

  it('resolves a queue job and its PRD to the same Epic', () => {
    const job = { epicId: 'epic-real-abc12345', sourceTabId: 'epic-other-def67890' }
    const prd = { epicId: 'epic-real-abc12345', sourcePromptId: null }
    expect(resolveEpicRef(job, SESSIONS).epicId).toBe(resolveEpicRef(prd, SESSIONS).epicId)
  })
})

describe('shortEpicId', () => {
  it('truncates only long ids', () => {
    expect(shortEpicId('short')).toBe('short')
    expect(shortEpicId('epic-really-long-identifier')).toBe('epic-really-…')
  })
})
