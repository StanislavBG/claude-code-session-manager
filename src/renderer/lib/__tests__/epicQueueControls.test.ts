import { describe, it, expect } from 'vitest'
import type { PromptSession, PromptSessionEvent } from '../../state/promptSessions'
import type { EpicSnapshots } from '../epicDerive'
import type { TabChat } from '../../state/chat'
import {
  epicCounts,
  filterEpics,
  sortEpics,
  groupEpics,
  visibleOrder,
  matchesSearch,
  PAGE,
} from '../epicQueueControls'

const NOW = Date.parse('2026-07-31T12:00:00.000Z')

function makeEpic(overrides: Partial<PromptSession>): PromptSession {
  return {
    id: overrides.id ?? 'epic-1',
    cwd: '/proj',
    goalText: 'A test epic',
    claudeSessionId: 'claude-1',
    status: 'active',
    createdAt: new Date(NOW - 60_000).toISOString(),
    completedAt: null,
    tag: 'feature',
    ...overrides,
  }
}

function emptySnapshots(overrides: Partial<EpicSnapshots> = {}): EpicSnapshots {
  return { sessions: {}, chats: {}, jobs: [], prds: [], ...overrides }
}

describe('epicCounts', () => {
  it('derives open/needs/running/pinned/all from full unfiltered epics', () => {
    const epics = [
      makeEpic({ id: 'e-completed', status: 'completed' }),
      makeEpic({ id: 'e-running' }),
      makeEpic({ id: 'e-needs' }),
      makeEpic({ id: 'e-draft' }),
    ]
    const chats: Record<string, TabChat> = {
      'e-needs': { turns: [], running: false, queuedPosition: 0, ticketHistory: [{ status: 'needs-input' }] } as unknown as TabChat,
      'e-running': { turns: [], running: true, queuedPosition: 0 } as unknown as TabChat,
    }
    const snapshots = emptySnapshots({ sessions: Object.fromEntries(epics.map((e) => [e.id, e])), chats })
    const counts = epicCounts(epics, snapshots, new Set(['e-draft']))
    expect(counts).toEqual({ open: 3, needs: 1, running: 1, pinned: 1, all: 4 })
  })
})

describe('matchesSearch / filterEpics', () => {
  it('matches on title (goalText) + kind, case-insensitively', () => {
    const epic = makeEpic({ goalText: 'Retire the global chat pane', tag: 'bug' })
    expect(matchesSearch(epic, 'global')).toBe(true)
    expect(matchesSearch(epic, 'BUG')).toBe(true)
    expect(matchesSearch(epic, 'nope')).toBe(false)
    expect(matchesSearch(epic, '')).toBe(true)
  })

  it('search yields empty result when nothing matches', () => {
    const epics = [makeEpic({ id: 'e-a', goalText: 'alpha' }), makeEpic({ id: 'e-b', goalText: 'beta' })]
    const snapshots = emptySnapshots({ sessions: Object.fromEntries(epics.map((e) => [e.id, e])) })
    const result = filterEpics(epics, snapshots, 'all', new Set(), 'zzz-nomatch')
    expect(result).toHaveLength(0)
  })

  it('composes filter + search: needs-you filter with a search term', () => {
    const epics = [
      makeEpic({ id: 'e-needs-match', goalText: 'fix the flaky test' }),
      makeEpic({ id: 'e-needs-nomatch', goalText: 'other thing' }),
      makeEpic({ id: 'e-running-match', goalText: 'fix the flaky build' }),
    ]
    const chats: Record<string, TabChat> = {
      'e-needs-match': { turns: [], running: false, queuedPosition: 0, ticketHistory: [{ status: 'needs-input' }] } as unknown as TabChat,
      'e-needs-nomatch': { turns: [], running: false, queuedPosition: 0, ticketHistory: [{ status: 'needs-input' }] } as unknown as TabChat,
      'e-running-match': { turns: [], running: true, queuedPosition: 0 } as unknown as TabChat,
    }
    const snapshots = emptySnapshots({ sessions: Object.fromEntries(epics.map((e) => [e.id, e])), chats })
    const result = filterEpics(epics, snapshots, 'needs', new Set(), 'flaky')
    expect(result.map((e) => e.id)).toEqual(['e-needs-match'])
  })

  it('pinned filter shows only pinned rows regardless of status', () => {
    const epics = [makeEpic({ id: 'e-a', status: 'completed' }), makeEpic({ id: 'e-b' })]
    const snapshots = emptySnapshots({ sessions: Object.fromEntries(epics.map((e) => [e.id, e])) })
    const result = filterEpics(epics, snapshots, 'pinned', new Set(['e-a']), '')
    expect(result.map((e) => e.id)).toEqual(['e-a'])
  })
})

describe('sortEpics', () => {
  const events: Record<string, PromptSessionEvent[]> = {}

  it('sorts by title alphabetically', () => {
    const epics = [makeEpic({ id: 'e-b', goalText: 'Bravo' }), makeEpic({ id: 'e-a', goalText: 'Alpha' })]
    const snapshots = emptySnapshots({ sessions: Object.fromEntries(epics.map((e) => [e.id, e])) })
    const sorted = sortEpics(epics, 'title', snapshots, events)
    expect(sorted.map((e) => e.id)).toEqual(['e-a', 'e-b'])
  })

  it('sorts by prdCount descending', () => {
    const epics = [makeEpic({ id: 'e-few' }), makeEpic({ id: 'e-many' })]
    const snapshots = emptySnapshots({
      sessions: Object.fromEntries(epics.map((e) => [e.id, e])),
      prds: [
        { slug: 'p1', title: 'p1', cwd: '/proj', mtimeMs: 0, estimateMinutes: null, parallelGroup: 0, sourcePromptId: 'e-many' },
        { slug: 'p2', title: 'p2', cwd: '/proj', mtimeMs: 0, estimateMinutes: null, parallelGroup: 0, sourcePromptId: 'e-many' },
      ] as EpicSnapshots['prds'],
    })
    const sorted = sortEpics(epics, 'prdCount', snapshots, events)
    expect(sorted.map((e) => e.id)).toEqual(['e-many', 'e-few'])
  })

  it('sorts by tokens descending', () => {
    const epics = [makeEpic({ id: 'e-few' }), makeEpic({ id: 'e-many' })]
    const snapshots = emptySnapshots({
      sessions: Object.fromEntries(epics.map((e) => [e.id, e])),
      usage: {
        'e-few': { inputTokens: 100, outputTokens: 0 },
        'e-many': { inputTokens: 900_000, outputTokens: 300_000 },
      },
    })
    const sorted = sortEpics(epics, 'tokens', snapshots, events)
    expect(sorted.map((e) => e.id)).toEqual(['e-many', 'e-few'])
  })

  it('sorts by turns descending', () => {
    const epics = [makeEpic({ id: 'e-few' }), makeEpic({ id: 'e-many' })]
    const snapshots = emptySnapshots({
      sessions: Object.fromEntries(epics.map((e) => [e.id, e])),
      chats: {
        'e-few': { turns: [{ id: 't1', role: 'user', text: 'hi', at: 0 }], running: false, queuedPosition: 0 } as unknown as TabChat,
        'e-many': {
          turns: [
            { id: 't1', role: 'user', text: 'hi', at: 0 },
            { id: 't2', role: 'assistant', text: 'ok', at: 1 },
            { id: 't3', role: 'user', text: 'more', at: 2 },
          ],
          running: false,
          queuedPosition: 0,
        } as unknown as TabChat,
      },
    })
    const sorted = sortEpics(epics, 'turns', snapshots, events)
    expect(sorted.map((e) => e.id)).toEqual(['e-many', 'e-few'])
  })

  it('sorts by recent activity, most recent first', () => {
    const epics = [
      makeEpic({ id: 'e-old', createdAt: new Date(NOW - 100_000).toISOString() }),
      makeEpic({ id: 'e-new', createdAt: new Date(NOW - 10_000).toISOString() }),
    ]
    const snapshots = emptySnapshots({ sessions: Object.fromEntries(epics.map((e) => [e.id, e])) })
    const sorted = sortEpics(epics, 'recent', snapshots, events)
    expect(sorted.map((e) => e.id)).toEqual(['e-new', 'e-old'])
  })
})

describe('groupEpics', () => {
  it('groups by tag in Feature/Bug/Discussion order, omitting empty buckets', () => {
    const epics = [
      makeEpic({ id: 'e-bug', tag: 'bug' }),
      makeEpic({ id: 'e-feature', tag: 'feature' }),
    ]
    const snapshots = emptySnapshots({ sessions: Object.fromEntries(epics.map((e) => [e.id, e])) })
    const groups = groupEpics(epics, 'tag', snapshots, {}, NOW)
    expect(groups.map((g) => g.key)).toEqual(['feature', 'bug'])
  })

  it('groups by recency buckets', () => {
    const epics = [
      makeEpic({ id: 'e-today', createdAt: new Date(NOW - 60_000).toISOString() }),
      makeEpic({ id: 'e-older', createdAt: new Date(NOW - 40 * 24 * 3_600_000).toISOString() }),
    ]
    const snapshots = emptySnapshots({ sessions: Object.fromEntries(epics.map((e) => [e.id, e])) })
    const groups = groupEpics(epics, 'recency', snapshots, {}, NOW)
    expect(groups.map((g) => g.key)).toEqual(['Today', 'Older'])
  })
})

describe('visibleOrder', () => {
  it('places pinned rows first, then open sections up to their page limit, skipping closed sections', () => {
    const pinned = [makeEpic({ id: 'p-1' })]
    const sections = [
      { key: 'running', items: [makeEpic({ id: 'r-1' }), makeEpic({ id: 'r-2' }), makeEpic({ id: 'r-3' })] },
      { key: 'completed', items: [makeEpic({ id: 'c-1' })] },
    ]
    const order = visibleOrder(pinned, sections, new Set(['completed']), { running: 2 })
    expect(order.map((e) => e.id)).toEqual(['p-1', 'r-1', 'r-2'])
  })

  it('defaults a section with no explicit limit to PAGE', () => {
    const items = Array.from({ length: PAGE + 5 }, (_, i) => makeEpic({ id: `e-${i}` }))
    const order = visibleOrder([], [{ key: 'draft', items }], new Set(), {})
    expect(order).toHaveLength(PAGE)
  })
})
