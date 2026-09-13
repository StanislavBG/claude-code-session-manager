import { describe, expect, it } from 'vitest'
import { buildBacklogTree, flattenBacklogNodes, type BacklogRow } from './backlogTree'
import type { PromptSession } from '../state/promptSessions'

function row(overrides: Partial<BacklogRow> & { slug: string }): BacklogRow {
  return {
    title: overrides.slug,
    status: 'pending',
    parallelGroup: 1,
    dependsOn: [],
    epicId: null,
    sourcePromptId: null,
    sourceTabId: null,
    ...overrides,
  }
}

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

const NO_SESSIONS: Record<string, PromptSession> = {}

describe('buildBacklogTree — Epic grouping', () => {
  it('groups rows into one section per Epic', () => {
    const rows = [
      row({ slug: 'a1', epicId: 'epic-a' }),
      row({ slug: 'a2', epicId: 'epic-a' }),
      row({ slug: 'b1', epicId: 'epic-b' }),
    ]
    const sessions = { 'epic-a': session('epic-a', 'Epic A goal'), 'epic-b': session('epic-b', 'Epic B goal') }
    const sections = buildBacklogTree(rows, sessions)
    expect(sections).toHaveLength(2)
    expect(sections.map((s) => s.label).sort()).toEqual(['Epic A goal', 'Epic B goal'])
    const a = sections.find((s) => s.label === 'Epic A goal')!
    expect(a.total).toBe(2)
    expect(flattenBacklogNodes(a.nodes).map((n) => n.row.slug).sort()).toEqual(['a1', 'a2'])
  })

  it('puts unlinked rows in a "No Epic" section, sorted last', () => {
    const rows = [row({ slug: 'orphan' }), row({ slug: 'a1', epicId: 'epic-a' })]
    const sections = buildBacklogTree(rows, { 'epic-a': session('epic-a', 'Epic A') })
    expect(sections.at(-1)!.label).toBe('No Epic')
    expect(sections.at(-1)!.epicId).toBeNull()
  })

  it('rolls up status counts per section', () => {
    const rows = [
      row({ slug: 'a1', epicId: 'epic-a', status: 'completed' }),
      row({ slug: 'a2', epicId: 'epic-a', status: 'pending' }),
      row({ slug: 'a3', epicId: 'epic-a', status: 'pending' }),
    ]
    const sections = buildBacklogTree(rows, { 'epic-a': session('epic-a', 'Epic A') })
    expect(sections[0].counts).toEqual({ completed: 1, pending: 2 })
  })
})

describe('buildBacklogTree — dependency nesting', () => {
  it('nests a 3-deep dependency chain correctly', () => {
    const rows = [
      row({ slug: 'base', epicId: 'e' }),
      row({ slug: 'mid', epicId: 'e', dependsOn: ['base'] }),
      row({ slug: 'top', epicId: 'e', dependsOn: ['mid'] }),
    ]
    const [section] = buildBacklogTree(rows, NO_SESSIONS)
    expect(section.nodes).toHaveLength(1)
    const baseNode = section.nodes[0]
    expect(baseNode.row.slug).toBe('base')
    expect(baseNode.depth).toBe(0)
    expect(baseNode.children).toHaveLength(1)
    const midNode = baseNode.children[0]
    expect(midNode.row.slug).toBe('mid')
    expect(midNode.depth).toBe(1)
    expect(midNode.children).toHaveLength(1)
    const topNode = midNode.children[0]
    expect(topNode.row.slug).toBe('top')
    expect(topNode.depth).toBe(2)
    expect(topNode.children).toHaveLength(0)
  })

  it('marks a row with no dependsOn and no dependents as parallel-eligible', () => {
    const rows = [
      row({ slug: 'lonely', epicId: 'e' }),
      row({ slug: 'base', epicId: 'e' }),
      row({ slug: 'child', epicId: 'e', dependsOn: ['base'] }),
    ]
    const [section] = buildBacklogTree(rows, NO_SESSIONS)
    const lonely = section.nodes.find((n) => n.row.slug === 'lonely')!
    const base = section.nodes.find((n) => n.row.slug === 'base')!
    expect(lonely.parallelEligible).toBe(true)
    // base has a dependent (child), so it is a chain head, not parallel-eligible
    expect(base.parallelEligible).toBe(false)
  })

  it('renders an out-of-section dependency as a root, still recording the cross-epic blocker', () => {
    const rows = [
      row({ slug: 'foreign-base', epicId: 'other' }),
      row({ slug: 'a1', epicId: 'e', dependsOn: ['foreign-base'] }),
    ]
    const sections = buildBacklogTree(rows, NO_SESSIONS)
    const e = sections.find((s) => s.epicId === 'e')!
    expect(e.nodes).toHaveLength(1)
    expect(e.nodes[0].row.slug).toBe('a1')
    expect(e.nodes[0].blockers).toEqual([{ slug: 'foreign-base', status: 'pending', missing: false, needsReview: false }])
  })
})

describe('buildBacklogTree — blockers', () => {
  it('shows a blocked row its blocker and the blocker\'s current status', () => {
    const rows = [
      row({ slug: 'base', epicId: 'e', status: 'running' }),
      row({ slug: 'dependent', epicId: 'e', status: 'pending', dependsOn: ['base'] }),
    ]
    const [section] = buildBacklogTree(rows, NO_SESSIONS)
    const dependent = flattenBacklogNodes(section.nodes).find((n) => n.row.slug === 'dependent')!
    expect(dependent.blocked).toBe(true)
    expect(dependent.blockers).toEqual([{ slug: 'base', status: 'running', missing: false, needsReview: false }])
  })

  it('is not blocked once its blocker is completed', () => {
    const rows = [
      row({ slug: 'base', epicId: 'e', status: 'completed' }),
      row({ slug: 'dependent', epicId: 'e', status: 'pending', dependsOn: ['base'] }),
    ]
    const [section] = buildBacklogTree(rows, NO_SESSIONS)
    const dependent = flattenBacklogNodes(section.nodes).find((n) => n.row.slug === 'dependent')!
    expect(dependent.blocked).toBe(false)
  })

  it('distinctly marks a needs_review blocker', () => {
    const rows = [
      row({ slug: 'base', epicId: 'e', status: 'needs_review' }),
      row({ slug: 'dependent', epicId: 'e', status: 'pending', dependsOn: ['base'] }),
    ]
    const [section] = buildBacklogTree(rows, NO_SESSIONS)
    const dependent = flattenBacklogNodes(section.nodes).find((n) => n.row.slug === 'dependent')!
    expect(dependent.hasNeedsReviewBlocker).toBe(true)
    expect(dependent.blocked).toBe(true)
  })

  it('flags a dependsOn naming a slug that does not exist as a missing dep, not a crash', () => {
    const rows = [row({ slug: 'a1', epicId: 'e', dependsOn: ['ghost-slug'] })]
    const [section] = buildBacklogTree(rows, NO_SESSIONS)
    const a1 = section.nodes[0]
    expect(a1.hasMissingDep).toBe(true)
    expect(a1.blockers).toEqual([{ slug: 'ghost-slug', status: null, missing: true, needsReview: false }])
    // A missing dep still renders as a root — no dangling nesting reference.
    expect(a1.depth).toBe(0)
  })
})

describe('buildBacklogTree — cycles', () => {
  it('renders a 2-cycle as two top-level warning rows instead of hanging or dropping the edge', () => {
    const rows = [
      row({ slug: 'a', epicId: 'e', dependsOn: ['b'] }),
      row({ slug: 'b', epicId: 'e', dependsOn: ['a'] }),
    ]
    const [section] = buildBacklogTree(rows, NO_SESSIONS)
    expect(section.nodes).toHaveLength(2)
    expect(section.nodes.every((n) => n.cycle)).toBe(true)
    expect(section.nodes.every((n) => n.children.length === 0)).toBe(true)
    // blockers are still recorded even though the row is cyclic
    const a = section.nodes.find((n) => n.row.slug === 'a')!
    expect(a.blockers).toEqual([{ slug: 'b', status: 'pending', missing: false, needsReview: false }])
  })

  it('flags a self-referencing dependsOn as a cycle', () => {
    const rows = [row({ slug: 'a', epicId: 'e', dependsOn: ['a'] })]
    const [section] = buildBacklogTree(rows, NO_SESSIONS)
    expect(section.nodes[0].cycle).toBe(true)
  })

  it('does not let a cyclic parent swallow a non-cyclic dependent — the dependent still renders', () => {
    const rows = [
      row({ slug: 'a', epicId: 'e', dependsOn: ['b'] }),
      row({ slug: 'b', epicId: 'e', dependsOn: ['a'] }),
      row({ slug: 'c', epicId: 'e', dependsOn: ['a'] }),
    ]
    const [section] = buildBacklogTree(rows, NO_SESSIONS)
    const allSlugs = flattenBacklogNodes(section.nodes).map((n) => n.row.slug).sort()
    expect(allSlugs).toEqual(['a', 'b', 'c'])
    const c = section.nodes.find((n) => n.row.slug === 'c')!
    expect(c.cycle).toBe(false)
    expect(c.depth).toBe(0)
  })
})

describe('flattenBacklogNodes', () => {
  it('pre-order flattens so a parent is immediately followed by its children', () => {
    const rows = [
      row({ slug: 'base', epicId: 'e' }),
      row({ slug: 'mid', epicId: 'e', dependsOn: ['base'] }),
      row({ slug: 'sibling', epicId: 'e' }),
    ]
    const [section] = buildBacklogTree(rows, NO_SESSIONS)
    const flat = flattenBacklogNodes(section.nodes).map((n) => n.row.slug)
    expect(flat).toEqual(['base', 'mid', 'sibling'])
  })
})
