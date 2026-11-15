import { describe, it, expect } from 'vitest'
import { reviewRuns, reviewRunStatus, REVIEW_MD_NETWORK_MACRO_ID } from '../mdReviewRuns'
import type { EpicSnapshots } from '../epicDerive'
import type { PromptSession, PromptSessionEvent } from '../../state/promptSessions'
import type { TabChat } from '../../state/chat'
import type { PrdListItem, ScheduleJob } from '../../../preload/api'

const CWD = '/p/alpha'

function epic(id: string, over: Partial<PromptSession> = {}): PromptSession {
  return {
    id,
    cwd: CWD,
    goalText: id,
    claudeSessionId: id,
    status: 'active',
    createdAt: '2026-11-14T10:00:00.000Z',
    completedAt: null,
    source: { producer: 'new-epic-ui', macroId: REVIEW_MD_NETWORK_MACRO_ID },
    ...over,
  } as PromptSession
}

const prd = (slug: string, epicId: string, over: Partial<PrdListItem> = {}): PrdListItem =>
  ({ slug, parallelGroup: 1, title: slug, cwd: CWD, estimateMinutes: null, mtimeMs: 0, sourcePromptId: epicId, ...over }) as PrdListItem
const job = (slug: string, epicId: string, status: ScheduleJob['status']): ScheduleJob =>
  ({ slug, title: slug, cwd: CWD, parallelGroup: 1, status, sourcePromptId: epicId }) as ScheduleJob

function snap(over: Partial<EpicSnapshots> = {}): EpicSnapshots {
  return { sessions: { e1: epic('e1') }, chats: {}, jobs: [], prds: [], events: {}, ...over }
}

describe('reviewRuns', () => {
  it('keeps only this project\'s Review MD network Epics, newest first', () => {
    const sessions = {
      a: epic('a', { createdAt: '2026-11-10T00:00:00.000Z' }),
      b: epic('b', { createdAt: '2026-11-12T00:00:00.000Z' }),
      c: epic('c', { createdAt: '2026-11-11T00:00:00.000Z' }),
      other: epic('other', { source: { producer: 'new-epic-ui', macroId: 'sweep' } }),
      none: epic('none', { source: undefined }),
      elsewhere: epic('elsewhere', { cwd: '/p/beta' }),
    }
    expect(reviewRuns(sessions, CWD).map((s) => s.id)).toEqual(['b', 'c', 'a'])
    expect(reviewRuns(sessions, null)).toEqual([])
  })
})

describe('reviewRunStatus', () => {
  it('proposed', () => {
    expect(reviewRunStatus('e1', snap({ sessions: { e1: epic('e1', { status: 'proposed' }) } }), ['v.md'])).toBe('proposed')
  })

  it('reporting while the chat runs with no PRDs', () => {
    expect(reviewRunStatus('e1', snap({ chats: { e1: { running: true } as TabChat } }), [])).toBe('reporting')
  })

  it('reported when idle with no PRDs', () => {
    expect(reviewRunStatus('e1', snap(), undefined)).toBe('reported')
    expect(reviewRunStatus('e1', snap({ chats: { e1: { running: false } as TabChat } }), [])).toBe('reported')
  })

  it('PRDs queued n/m done from epicPrds (job rows and archived files)', () => {
    const s = snap({
      prds: [prd('p1', 'e1'), prd('p2', 'e1'), prd('p3', 'e1', { archived: true, archivedStatus: 'completed' } as Partial<PrdListItem>), prd('x', 'e2')],
      jobs: [job('p1', 'e1', 'completed'), job('p2', 'e1', 'running')],
      chats: { e1: { running: true } as TabChat },
    })
    expect(reviewRunStatus('e1', s, [])).toBe('PRDs queued 2/3 done')
  })

  it('validated when validation files exist and nothing is refuted', () => {
    const events = { e1: [{ kind: 'response', validation: 'verified' } as PromptSessionEvent] }
    expect(reviewRunStatus('e1', snap({ events, prds: [prd('p1', 'e1')] }), ['v.md'])).toBe('validated')
  })

  it('refuted outranks validation files', () => {
    const events = { e1: [{ kind: 'response', validation: 'refuted' } as PromptSessionEvent] }
    expect(reviewRunStatus('e1', snap({ events }), ['v.md'])).toBe('refuted')
    expect(reviewRunStatus('e1', snap({ events: { e1: [{ kind: 'prompt', validation: 'refuted' } as PromptSessionEvent] } }), [])).toBe('reported')
  })

  it('completed when archived with no validation', () => {
    expect(reviewRunStatus('e1', snap({ sessions: { e1: epic('e1', { status: 'completed' }) } }), [])).toBe('completed')
  })
})
