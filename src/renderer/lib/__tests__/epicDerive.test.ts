import { describe, it, expect } from 'vitest'
import { epicDisplayStatus, epicPrds, epicQueuedDetail, epicStats, type EpicSnapshots } from '../epicDerive'
import type { PromptSession } from '../../state/promptSessions'
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

  it('returns undefined when nothing is queued', () => {
    const snapshots = makeSnapshots({
      chats: { 'epic-1': makeChat({ running: true, queuedPosition: 0 }) },
    })
    expect(epicQueuedDetail('epic-1', snapshots)).toBeUndefined()
  })

  it('returns draft when active with no runs/PRDs/needs-input', () => {
    const snapshots = makeSnapshots({ sessions: { 'epic-1': makeSession() } })
    expect(epicDisplayStatus('epic-1', snapshots)).toBe('draft')
  })

  it('ignores jobs/chats belonging to a different epic', () => {
    const snapshots = makeSnapshots({
      sessions: { 'epic-1': makeSession() },
      chats: { 'epic-2': makeChat({ running: true }) },
      jobs: [makeJob({ sourcePromptId: 'epic-2', status: 'running' })],
    })
    expect(epicDisplayStatus('epic-1', snapshots)).toBe('draft')
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
