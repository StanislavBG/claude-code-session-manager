import { describe, it, expect } from 'vitest'
import { inFlightCards, openQuestions } from '../projectHomeDerive'
import type { EpicSnapshots } from '../epicDerive'
import type { PromptSession } from '../../state/promptSessions'
import type { TabChat, PromptTicket } from '../../state/chat'

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

function makeTicket(overrides: Partial<PromptTicket> = {}): PromptTicket {
  return {
    id: 't1',
    tabId: 'epic-1',
    sessionId: 's',
    cwd: '/proj',
    text: 'What should I do?',
    status: 'needs-input',
    createdAt: 0,
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

describe('projectHomeDerive.inFlightCards', () => {
  it('returns only active epics for the given cwd, most-recently-active first, capped at 3', () => {
    const snapshots = makeSnapshots({
      sessions: {
        'epic-1': makeSession({ id: 'epic-1', createdAt: '2026-07-31T00:00:00.000Z' }),
        'epic-2': makeSession({ id: 'epic-2', createdAt: '2026-07-31T01:00:00.000Z' }),
        'epic-3': makeSession({ id: 'epic-3', createdAt: '2026-07-31T02:00:00.000Z' }),
        'epic-4': makeSession({ id: 'epic-4', createdAt: '2026-07-31T03:00:00.000Z' }),
        'epic-other-cwd': makeSession({ id: 'epic-other-cwd', cwd: '/other', createdAt: '2026-07-31T05:00:00.000Z' }),
        'epic-archived': makeSession({ id: 'epic-archived', status: 'completed', createdAt: '2026-07-31T06:00:00.000Z' }),
      },
    })
    const cards = inFlightCards('/proj', snapshots)
    expect(cards.map((c) => c.epicId)).toEqual(['epic-4', 'epic-3', 'epic-2'])
  })

  it('sets note text per derived status', () => {
    const snapshots = makeSnapshots({
      sessions: {
        'epic-running': makeSession({ id: 'epic-running', goalText: 'Build the thing', tag: 'feature' }),
        'epic-needs': makeSession({ id: 'epic-needs' }),
        'epic-queued': makeSession({ id: 'epic-queued' }),
      },
      chats: {
        'epic-running': makeChat({ running: true, queuedPosition: 0 }),
        'epic-needs': makeChat({
          ticketHistory: [makeTicket({ id: 't-needs', tabId: 'epic-needs' })],
        }),
        'epic-queued': makeChat({ running: true, queuedPosition: 2 }),
      },
    })
    const cards = inFlightCards('/proj', snapshots)
    const byId = Object.fromEntries(cards.map((c) => [c.epicId, c]))
    expect(byId['epic-running'].status).toBe('running')
    expect(byId['epic-running'].note).toBe('feature · Build the thing')
    expect(byId['epic-needs'].status).toBe('needs')
    expect(byId['epic-needs'].note).toBe('waiting on your answer')
    expect(byId['epic-queued'].status).toBe('queued')
    expect(byId['epic-queued'].note).toBe('ready to run when a slot frees')
  })

  it('sets note text for a draft (no runs/PRDs/needs-input) epic', () => {
    const snapshots = makeSnapshots({ sessions: { 'epic-draft': makeSession({ id: 'epic-draft' }) } })
    const cards = inFlightCards('/proj', snapshots)
    expect(cards).toEqual([{ epicId: 'epic-draft', title: 'Ship it', status: 'draft', note: 'not started' }])
  })

  it('returns an empty list when there are no active epics for the cwd', () => {
    expect(inFlightCards('/proj', makeSnapshots())).toEqual([])
  })
})

describe('projectHomeDerive.openQuestions', () => {
  it('collects pending needs-input tickets across the cwd active epics, resolving question text from the linked turn', () => {
    const sessions: Record<string, PromptSession> = {
      'epic-1': makeSession({ id: 'epic-1', goalText: 'Ship it' }),
      'epic-other-cwd': makeSession({ id: 'epic-other-cwd', cwd: '/other' }),
      'epic-archived': makeSession({ id: 'epic-archived', status: 'completed' }),
    }
    const chats: Record<string, TabChat> = {
      'epic-1': makeChat({
        turns: [{ id: 'turn-1', role: 'question', text: 'Cap usage at 214 days or extrapolate?', at: 0 }],
        ticketHistory: [
          makeTicket({ id: 't1', tabId: 'epic-1', status: 'needs-input', questionTurnId: 'turn-1' }),
          makeTicket({ id: 't2', tabId: 'epic-1', status: 'done' }),
        ],
      }),
    }
    const result = openQuestions('/proj', sessions, chats)
    expect(result).toEqual([
      { epicId: 'epic-1', epicGoalText: 'Ship it', ticketId: 't1', question: 'Cap usage at 214 days or extrapolate?' },
    ])
  })

  it('falls back to the ticket text when the question turn is missing', () => {
    const sessions: Record<string, PromptSession> = { 'epic-1': makeSession() }
    const chats: Record<string, TabChat> = {
      'epic-1': makeChat({
        ticketHistory: [makeTicket({ id: 't1', text: 'raw prompt text', status: 'needs-input', questionTurnId: undefined })],
      }),
    }
    const result = openQuestions('/proj', sessions, chats)
    expect(result).toEqual([{ epicId: 'epic-1', epicGoalText: 'Ship it', ticketId: 't1', question: 'raw prompt text' }])
  })

  it('returns an empty list when there are no pending questions', () => {
    expect(openQuestions('/proj', {}, {})).toEqual([])
  })
})
