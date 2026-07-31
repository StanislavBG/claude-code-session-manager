import { describe, it, expect } from 'vitest'
import { activeSessionRows, recentSessionEpicTitle } from '../homeSessionRows'

describe('activeSessionRows', () => {
  it('joins a scheduler-job holder to its running job and Epic', () => {
    const holders = [{ owner: 'scheduler:828-epic-queue-controls', at: '2026-07-31T20:00:00.000Z' }]
    const jobs = [{ slug: '828-epic-queue-controls', cwd: '/home/bilko/Projects/session-manager', sourcePromptId: 'epic-1' }]
    const sessions = { 'epic-1': { cwd: '/home/bilko/Projects/session-manager', goalText: 'Contextual chat per Epic' } }
    const rows = activeSessionRows(holders, jobs, {}, sessions)
    expect(rows).toEqual([
      {
        owner: 'scheduler:828-epic-queue-controls',
        kind: 'scheduler job',
        at: '2026-07-31T20:00:00.000Z',
        project: 'session-manager',
        epicTitle: 'Contextual chat per Epic',
        openTarget: 'scheduler',
        epicId: null,
      },
    ])
  })

  it('joins a chat-run holder to its running chat and Epic', () => {
    const holders = [{ owner: 'chat:epic-2', at: '2026-07-31T20:00:00.000Z' }]
    const chats = { 'epic-2': { running: true } }
    const sessions = { 'epic-2': { cwd: '/home/bilko/Projects/sigma', goalText: 'Signal scoring pass' } }
    const rows = activeSessionRows(holders, [], chats, sessions)
    expect(rows).toEqual([
      {
        owner: 'chat:epic-2',
        kind: 'chat run',
        at: '2026-07-31T20:00:00.000Z',
        project: 'sigma',
        epicTitle: 'Signal scoring pass',
        openTarget: 'terminal',
        epicId: 'epic-2',
      },
    ])
  })

  it('renders a scheduler holder with no matching job as unresolved', () => {
    const holders = [{ owner: 'scheduler:missing-slug', at: 't' }]
    const rows = activeSessionRows(holders, [], {}, {})
    expect(rows).toEqual([
      { owner: 'scheduler:missing-slug', kind: 'session', at: 't', project: null, epicTitle: null, openTarget: null, epicId: null },
    ])
  })

  it('renders a chat holder whose chat is no longer running as unresolved', () => {
    const holders = [{ owner: 'chat:epic-3', at: 't' }]
    const chats = { 'epic-3': { running: false } }
    const sessions = { 'epic-3': { cwd: '/x', goalText: 'y' } }
    const rows = activeSessionRows(holders, [], chats, sessions)
    expect(rows[0]).toEqual({ owner: 'chat:epic-3', kind: 'session', at: 't', project: null, epicTitle: null, openTarget: null, epicId: null })
  })

  it('renders a holder whose owner matches no known prefix as unresolved', () => {
    const holders = [{ owner: 'unknown-owner', at: 't' }]
    const rows = activeSessionRows(holders, [], {}, {})
    expect(rows[0].kind).toBe('session')
    expect(rows[0].openTarget).toBeNull()
  })

  it('handles zero holders', () => {
    expect(activeSessionRows([], [], {}, {})).toEqual([])
  })
})

describe('recentSessionEpicTitle', () => {
  it('matches a session by claudeSessionId', () => {
    const sessions = {
      'epic-1': { cwd: '/x', goalText: 'Contextual chat per Epic', claudeSessionId: 'bc70f290-aaaa' },
    }
    expect(recentSessionEpicTitle('bc70f290-aaaa', sessions)).toBe('Contextual chat per Epic')
  })

  it('returns null when no Epic matches', () => {
    const sessions = { 'epic-1': { cwd: '/x', goalText: 'y', claudeSessionId: 'other' } }
    expect(recentSessionEpicTitle('bc70f290-aaaa', sessions)).toBeNull()
  })

  it('handles zero sessions', () => {
    expect(recentSessionEpicTitle('bc70f290-aaaa', {})).toBeNull()
  })
})
