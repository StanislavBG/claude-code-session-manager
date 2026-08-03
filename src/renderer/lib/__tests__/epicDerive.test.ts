import { describe, it, expect } from 'vitest'
import { epicDisplayStatus, epicPrds, epicQueuedDetail, epicStats, type EpicSnapshots } from '../epicDerive'
import type { PromptSession, PromptSessionEvent } from '../../state/promptSessions'
import type { TabChat } from '../../state/chat'
import type { ScheduleJob, PrdListItem } from '../../../preload/api'

function makeSession(overrides: Partial<PromptSession> = {}): PromptSession {
  return {
    id: 'epic-1',
    cwd: '/proj',
    goalText: 'Ship it',
    claudeSessionId: 'sess-1',
    status: 'active',
    createdAt: '2026-07-31T00:00:00.000Z',
    completedAt: null,
    ...overrides,
  }
}

function makeChat(overrides: Partial<TabChat> = {}): TabChat {
  return {
    turns: [],
    running: false,
    queuedPosition: 0,
    started: false,
    stream: '',
    liveToolUses: [],
    queue: [],
    activeTicket: null,
    ticketHistory: [],
    ...overrides,
  }
}

function makeJob(overrides: Partial<ScheduleJob> = {}): ScheduleJob {
  return {
    slug: '100-widget',
    title: 'Widget',
    cwd: '/proj',
    parallelGroup: 1,
    estimateMinutes: 10,
    bodyPreview: '',
    status: 'pending',
    runId: null,
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    error: null,
    sourcePromptId: 'epic-1',
    ...overrides,
  }
}

function makeSnapshots(overrides: Partial<EpicSnapshots> = {}): EpicSnapshots {
  return {
    sessions: {},
    chats: {},
    jobs: [],
    prds: [],
    ...overrides,
  }
}

function makeResponseEvent(overrides: Partial<PromptSessionEvent> = {}): PromptSessionEvent {
  return {
    id: 'evt-1',
    promptSessionId: 'epic-1',
    kind: 'response',
    causedByEventId: null,
    at: '2026-07-31T00:00:00.000Z',
    ...overrides,
  }
}

describe('epicDerive.epicDisplayStatus', () => {
  it('returns completed when the session is archived, even if a stray job/chat says otherwise', () => {
    const snapshots = makeSnapshots({
      sessions: { 'epic-1': makeSession({ status: 'completed' }) },
      chats: { 'epic-1': makeChat({ running: true }) },
      jobs: [makeJob({ status: 'running' })],
    })
    expect(epicDisplayStatus('epic-1', snapshots)).toBe('completed')
  })

  it('returns needs when there is a pending needs-input ticket in chat history', () => {
    const snapshots = makeSnapshots({
      sessions: { 'epic-1': makeSession() },
      chats: {
        'epic-1': makeChat({
          ticketHistory: [
            { id: 't1', tabId: 'epic-1', sessionId: 's', cwd: '/proj', text: 'q', status: 'needs-input', createdAt: 0 },
          ],
        }),
      },
    })
    expect(epicDisplayStatus('epic-1', snapshots)).toBe('needs')
  })

  it('returns running when chat.running is true with no queue position', () => {
    const snapshots = makeSnapshots({
      sessions: { 'epic-1': makeSession() },
      chats: { 'epic-1': makeChat({ running: true, queuedPosition: 0 }) },
    })
    expect(epicDisplayStatus('epic-1', snapshots)).toBe('running')
  })

  it('returns running when a scheduler job for this epic is running', () => {
    const snapshots = makeSnapshots({
      sessions: { 'epic-1': makeSession() },
      jobs: [makeJob({ status: 'running' })],
    })
    expect(epicDisplayStatus('epic-1', snapshots)).toBe('running')
  })

  it('returns queued when chat.running is true with a nonzero queue position', () => {
    const snapshots = makeSnapshots({
      sessions: { 'epic-1': makeSession() },
      chats: { 'epic-1': makeChat({ running: true, queuedPosition: 2 }) },
    })
    expect(epicDisplayStatus('epic-1', snapshots)).toBe('queued')
  })

  it('returns queued when a scheduler job for this epic is pending', () => {
    const snapshots = makeSnapshots({
      sessions: { 'epic-1': makeSession() },
      jobs: [makeJob({ status: 'pending' })],
    })
    expect(epicDisplayStatus('epic-1', snapshots)).toBe('queued')
  })

  it('returns failed when a job has status failed', () => {
    const snapshots = makeSnapshots({
      sessions: { 'epic-1': makeSession() },
      jobs: [makeJob({ status: 'failed' })],
    })
    expect(epicDisplayStatus('epic-1', snapshots)).toBe('failed')
  })

  it('returns attention when a job has status needs_review', () => {
    const snapshots = makeSnapshots({
      sessions: { 'epic-1': makeSession() },
      jobs: [makeJob({ status: 'needs_review' })],
    })
    expect(epicDisplayStatus('epic-1', snapshots)).toBe('attention')
  })

  it('CORE (PRD 987): returns refuted when a response event validation is refuted, ranked above failed', () => {
    const snapshots = makeSnapshots({
      sessions: { 'epic-1': makeSession() },
      jobs: [makeJob({ slug: '100-broke', status: 'failed' })],
      events: { 'epic-1': [makeResponseEvent({ prdSlug: '972-claimed', outcome: 'completed', validation: 'refuted' })] },
    })
    expect(epicDisplayStatus('epic-1', snapshots)).toBe('refuted')
  })

  it('refuted outranks a concurrently running job too', () => {
    const snapshots = makeSnapshots({
      sessions: { 'epic-1': makeSession() },
      jobs: [makeJob({ slug: '101-inflight', status: 'running' })],
      events: { 'epic-1': [makeResponseEvent({ prdSlug: '972-claimed', outcome: 'completed', validation: 'refuted' })] },
    })
    expect(epicDisplayStatus('epic-1', snapshots)).toBe('refuted')
  })

  it('an unvalidated (claimed) response event does not trigger refuted', () => {
    const snapshots = makeSnapshots({
      sessions: { 'epic-1': makeSession() },
      jobs: [],
      events: { 'epic-1': [makeResponseEvent({ prdSlug: '972-claimed', outcome: 'completed', validation: 'unvalidated' })] },
    })
    expect(epicDisplayStatus('epic-1', snapshots)).toBe('active')
  })

  it('prefers failed over a concurrently running job (a broken PRD outranks an in-flight one)', () => {
    const snapshots = makeSnapshots({
      sessions: { 'epic-1': makeSession() },
      jobs: [makeJob({ slug: '100-broke', status: 'failed' }), makeJob({ slug: '101-inflight', status: 'running' })],
    })
    expect(epicDisplayStatus('epic-1', snapshots)).toBe('failed')
  })

  it('prefers needs (chat needs-input) over a failed job', () => {
    const snapshots = makeSnapshots({
      sessions: { 'epic-1': makeSession() },
      chats: {
        'epic-1': makeChat({
          ticketHistory: [
            { id: 't1', tabId: 'epic-1', sessionId: 's', cwd: '/proj', text: 'q', status: 'needs-input', createdAt: 0 },
          ],
        }),
      },
      jobs: [makeJob({ status: 'failed' })],
    })
    expect(epicDisplayStatus('epic-1', snapshots)).toBe('needs')
  })

  it('prefers completed (archived session) over a failed job', () => {
    const snapshots = makeSnapshots({
      sessions: { 'epic-1': makeSession({ status: 'completed' }) },
      jobs: [makeJob({ status: 'failed' })],
    })
    expect(epicDisplayStatus('epic-1', snapshots)).toBe('completed')
  })
})

describe('epicDerive.epicQueuedDetail', () => {
  it('names the session-slot pool when the chat run is queued behind it, with position', () => {
    const snapshots = makeSnapshots({
      chats: { 'epic-1': makeChat({ running: true, queuedPosition: 2 }) },
    })
    expect(epicQueuedDetail('epic-1', snapshots)).toBe('queued — waiting on a session slot (position 2)')
  })

  it('names the scheduler when a PRD job is pending with no chat queue position', () => {
    const snapshots = makeSnapshots({
      jobs: [makeJob({ status: 'pending' })],
    })
    expect(epicQueuedDetail('epic-1', snapshots)).toBe('queued — waiting for the scheduler')
  })

  it('names the failed PRD slug', () => {
    const snapshots = makeSnapshots({
      jobs: [makeJob({ slug: '964-epic-detail-agent-readout', status: 'failed' })],
    })
    expect(epicQueuedDetail('epic-1', snapshots)).toBe('failed — PRD 964-epic-detail-agent-readout did not complete')
  })

  it('names the needs_review PRD slug', () => {
    const snapshots = makeSnapshots({
      jobs: [makeJob({ slug: '964-epic-detail-agent-readout', status: 'needs_review' })],
    })
    expect(epicQueuedDetail('epic-1', snapshots)).toBe(
      'needs review — PRD 964-epic-detail-agent-readout is asking a question',
    )
  })

  it('returns undefined when nothing is queued', () => {
    const snapshots = makeSnapshots({
      chats: { 'epic-1': makeChat({ running: true, queuedPosition: 0 }) },
    })
    expect(epicQueuedDetail('epic-1', snapshots)).toBeUndefined()
  })

  // An idle active Epic reports its REAL state. It used to report 'draft',
  // a label for an Epic state that does not exist.
  it('returns active when active with no runs/PRDs/needs-input', () => {
    const snapshots = makeSnapshots({ sessions: { 'epic-1': makeSession() } })
    expect(epicDisplayStatus('epic-1', snapshots)).toBe('active')
  })

  it('ignores jobs/chats belonging to a different epic', () => {
    const snapshots = makeSnapshots({
      sessions: { 'epic-1': makeSession() },
      chats: { 'epic-2': makeChat({ running: true }) },
      jobs: [makeJob({ sourcePromptId: 'epic-2', status: 'running' })],
    })
    expect(epicDisplayStatus('epic-1', snapshots)).toBe('active')
  })
})

describe('epicDerive.epicPrds', () => {
  it('joins listPrds entries with schedule jobs on sourcePromptId, defaulting to draft with no job row', () => {
    const prdWithJob: PrdListItem = {
      slug: '100-widget',
      parallelGroup: 1,
      title: 'Widget',
      cwd: '/proj',
      estimateMinutes: 10,
      mtimeMs: 123,
      sourcePromptId: 'epic-1',
    }
    const prdWithoutJob: PrdListItem = {
      slug: '101-gadget',
      parallelGroup: 1,
      title: 'Gadget',
      cwd: '/proj',
      estimateMinutes: 5,
      mtimeMs: 456,
      sourcePromptId: 'epic-1',
    }
    const otherEpicPrd: PrdListItem = {
      slug: '102-other',
      parallelGroup: 1,
      title: 'Other',
      cwd: '/proj',
      estimateMinutes: 5,
      mtimeMs: 789,
      sourcePromptId: 'epic-2',
    }
    const snapshots = makeSnapshots({
      prds: [prdWithJob, prdWithoutJob, otherEpicPrd],
      jobs: [makeJob({ slug: '100-widget', status: 'completed' })],
    })
    const result = epicPrds('epic-1', snapshots)
    expect(result).toHaveLength(2)
    expect(result.find((p) => p.slug === '100-widget')?.status).toBe('completed')
    expect(result.find((p) => p.slug === '101-gadget')?.status).toBe('draft')
    expect(result.find((p) => p.slug === '101-gadget')?.job).toBeNull()
  })

  it('reports an archived PRD\'s resolved status instead of draft when its job row is gone', () => {
    const archivedCompleted: PrdListItem = {
      slug: '200-shipped',
      parallelGroup: 1,
      title: 'Shipped',
      cwd: '/proj',
      estimateMinutes: 10,
      mtimeMs: 123,
      sourcePromptId: 'epic-1',
      archived: true,
      archivedStatus: 'completed',
    }
    const archivedFailed: PrdListItem = {
      slug: '201-broke',
      parallelGroup: 1,
      title: 'Broke',
      cwd: '/proj',
      estimateMinutes: 10,
      mtimeMs: 124,
      sourcePromptId: 'epic-1',
      archived: true,
      archivedStatus: 'failed',
    }
    // No job rows for either slug — the whole point: an archived PRD's job
    // row can have already aged out of queue.json into history.jsonl.
    const snapshots = makeSnapshots({ prds: [archivedCompleted, archivedFailed], jobs: [] })
    const result = epicPrds('epic-1', snapshots)
    expect(result).toHaveLength(2)
    const shipped = result.find((p) => p.slug === '200-shipped')
    expect(shipped?.status).toBe('completed')
    expect(shipped?.archived).toBe(true)
    const broke = result.find((p) => p.slug === '201-broke')
    expect(broke?.status).toBe('failed')
    expect(broke?.archived).toBe(true)
  })
})

describe('epicDerive.epicStats', () => {
  it('returns null when the chat key has not been hydrated', () => {
    const snapshots = makeSnapshots()
    expect(epicStats('epic-1', snapshots)).toBeNull()
  })

  it('counts turns and summed tool uses when hydrated', () => {
    const snapshots = makeSnapshots({
      chats: {
        'epic-1': makeChat({
          turns: [
            { id: 't1', role: 'user', text: 'hi', at: 0 },
            { id: 't2', role: 'assistant', text: 'ok', at: 1, toolUses: [{ id: 'u1', kind: 'tool', label: 'Read' }, { id: 'u2', kind: 'tool', label: 'Edit' }] },
            { id: 't3', role: 'assistant', text: 'done', at: 2, toolUses: [{ id: 'u3', kind: 'tool', label: 'Bash' }] },
          ],
        }),
      },
    })
    expect(epicStats('epic-1', snapshots)).toEqual({ turns: 3, toolCalls: 3, tokens: null })
  })

  it('formats tokens as k/M and omits them when no usage is recorded', () => {
    const withUsage = makeSnapshots({
      chats: { 'epic-1': makeChat({ turns: [{ id: 't1', role: 'user', text: 'hi', at: 0 }] }) },
      usage: { 'epic-1': { inputTokens: 900_000, outputTokens: 300_000 } },
    })
    expect(epicStats('epic-1', withUsage)?.tokens).toBe('1.2M')

    const withoutUsage = makeSnapshots({
      chats: { 'epic-1': makeChat({ turns: [{ id: 't1', role: 'user', text: 'hi', at: 0 }] }) },
    })
    expect(epicStats('epic-1', withoutUsage)?.tokens).toBeNull()
  })
})
