import { describe, it, expect } from 'vitest'
import { buildNeedsYouRows, QUARANTINE_ESCALATE_MS } from '../homeNeedsYou'

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

  it('surfaces a quarantined job with an adopt action, never Retry, not escalated when fresh', () => {
    const now = Date.parse('2026-08-08T12:00:00.000Z')
    const jobs = [{
      slug: '821-ops-feedback-guard-silent-green',
      title: 'Ops feedback guard',
      cwd: '/home/bilko/Projects/burrow',
      status: 'quarantined',
      error: null,
      statusHistory: [{ to: 'quarantined', at: new Date(now - 60 * 60 * 1000).toISOString() }],
    }]
    const rows = buildNeedsYouRows({}, {}, jobs, now)
    expect(rows).toEqual([
      {
        id: 'job:821-ops-feedback-guard-silent-green',
        kind: 'job-quarantined',
        label: 'Scheduler PRD quarantined',
        detail: 'Ops feedback guard',
        meta: 'No createdVia provenance for 1h — adopt it to run, or archive from the Scheduler tab.',
        project: 'burrow',
        epicId: null,
        jobSlug: '821-ops-feedback-guard-silent-green',
        escalated: false,
      },
    ])
  })

  it('escalates a quarantined job once it has sat un-adopted past QUARANTINE_ESCALATE_MS, not before', () => {
    const now = Date.parse('2026-08-08T12:00:00.000Z')
    const justUnder = [{
      slug: 'fresh',
      title: 't',
      cwd: '/p',
      status: 'quarantined',
      error: null,
      statusHistory: [{ to: 'quarantined', at: new Date(now - (QUARANTINE_ESCALATE_MS - 1)).toISOString() }],
    }]
    expect(buildNeedsYouRows({}, {}, justUnder, now)[0].escalated).toBe(false)

    const atThreshold = [{
      slug: 'stale',
      title: 't',
      cwd: '/p',
      status: 'quarantined',
      error: null,
      statusHistory: [{ to: 'quarantined', at: new Date(now - QUARANTINE_ESCALATE_MS).toISOString() }],
    }]
    const row = buildNeedsYouRows({}, {}, atThreshold, now)[0]
    expect(row.escalated).toBe(true)
    expect(row.label).toBe('Quarantined PRD — stale, needs adoption')
  })

  it('surfaces a quarantined job with no recorded timestamp as non-escalated (never guessed)', () => {
    const jobs = [{ slug: 'no-history', title: 't', cwd: '/p', status: 'quarantined', error: null }]
    const row = buildNeedsYouRows({}, {}, jobs)[0]
    expect(row.escalated).toBe(false)
    expect(row.meta).toBe('No createdVia provenance. Adopt it to run, or archive from the Scheduler tab.')
  })

  it('surfaces a running job stamped with overrun', () => {
    const jobs = [{
      slug: '900-slow-thing',
      title: 'The slow thing',
      cwd: '/home/bilko/Projects/starry-night-ships',
      status: 'running',
      error: null,
      overrun: { ratio: 4.9, ranMs: 108 * 60_000, estimateMinutes: 22, at: '2026-09-11T00:00:00.000Z' },
    }]
    const rows = buildNeedsYouRows({}, {}, jobs)
    expect(rows).toEqual([
      {
        id: 'job:900-slow-thing',
        kind: 'job-overrunning',
        label: 'Scheduler job running over its own estimate',
        detail: 'The slow thing',
        meta: 'Ran 108m vs 22m estimate (4.9x). Check the run log, then let it finish or cancel it via scheduler_cancel_job.',
        project: 'starry-night-ships',
        epicId: null,
        jobSlug: '900-slow-thing',
      },
    ])
  })

  it('ignores an unstamped running job', () => {
    const jobs = [{ slug: '901-ok', title: 't', cwd: '/p', status: 'running', error: null }]
    expect(buildNeedsYouRows({}, {}, jobs)).toEqual([])
  })

  it('ignores a completed job with a stale overrun field', () => {
    const jobs = [{
      slug: '902-done',
      title: 't',
      cwd: '/p',
      status: 'completed',
      error: null,
      overrun: { ratio: 5, ranMs: 100_000, estimateMinutes: 10, at: '2026-09-11T00:00:00.000Z' },
    }]
    expect(buildNeedsYouRows({}, {}, jobs)).toEqual([])
  })
})
