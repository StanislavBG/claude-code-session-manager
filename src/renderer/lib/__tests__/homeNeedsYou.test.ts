import { describe, it, expect } from 'vitest'
import { buildNeedsYouRows } from '../homeNeedsYou'

describe('buildNeedsYouRows', () => {
  it('surfaces a proposed Epic', () => {
    const sessions = { 'epic-1': { id: 'epic-1', cwd: '/home/bilko/Projects/sigma', goalText: 'Score signals', tag: 'feature' } }
    const rows = buildNeedsYouRows(sessions, {}, [])
    expect(rows).toEqual([
      {
        id: 'proposed:epic-1',
        kind: 'proposed-epic',
        label: 'Proposed Epic — awaiting approval',
        detail: 'Score signals',
        meta: 'tag: feature',
        project: 'sigma',
        epicId: 'epic-1',
        jobSlug: null,
      },
    ])
  })

  it('surfaces a chat whose last ticket needs input, ignores an earlier resolved one', () => {
    const chats = {
      'epic-2': {
        ticketHistory: [
          { id: 't1', tabId: 'epic-2', cwd: '/x', status: 'done', text: 'first' },
          { id: 't2', tabId: 'epic-2', cwd: '/x', status: 'needs-input', text: 'which port?' },
        ],
      },
    }
    const rows = buildNeedsYouRows({}, chats, [])
    expect(rows).toEqual([
      {
        id: 'needs-input:t2',
        kind: 'needs-input',
        label: 'Session is asking a question',
        detail: 'which port?',
        meta: 'Stopped mid-run, waiting on your reply.',
        project: 'x',
        epicId: 'epic-2',
        jobSlug: null,
      },
    ])
  })

  it('ignores a chat whose last ticket already resolved', () => {
    const chats = { 'epic-3': { ticketHistory: [{ id: 't1', tabId: 'epic-3', cwd: '/x', status: 'done', text: 'ok' }] } }
    expect(buildNeedsYouRows({}, chats, [])).toEqual([])
  })

  it('surfaces a failed scheduler job with its error', () => {
    const jobs = [{ slug: '828-foo', title: 'Foo PRD', cwd: '/home/bilko/Projects/session-manager', status: 'failed', error: 'exit 1' }]
    const rows = buildNeedsYouRows({}, {}, jobs)
    expect(rows).toEqual([
      {
        id: 'job:828-foo',
        kind: 'job-failed',
        label: 'Scheduler job failed',
        detail: 'Foo PRD',
        meta: 'exit 1',
        project: 'session-manager',
        epicId: null,
        jobSlug: '828-foo',
      },
    ])
  })

  it('ignores jobs in other statuses', () => {
    const jobs = [{ slug: 'a', title: 't', cwd: null, status: 'pending', error: null }]
    expect(buildNeedsYouRows({}, {}, jobs)).toEqual([])
  })
})
