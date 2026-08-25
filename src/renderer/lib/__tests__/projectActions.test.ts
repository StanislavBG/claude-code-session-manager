import { describe, it, expect } from 'vitest'
import { actionTag, projectActions, resolveProjectAction, ALL_PROJECTS } from '../projectActions'
import type { AgentPersona } from '../../../preload/api'

function persona(over: Partial<AgentPersona> = {}): AgentPersona {
  return {
    name: 'scout',
    description: 'Looks around.',
    tools: [],
    model: null,
    color: null,
    tags: [],
    projects: [],
    action: null,
    actionLabel: null,
    path: '',
    body: '',
    overridingProjects: [],
    ...over,
  }
}

const CWD = '/home/bilko/Projects/alpha'

describe('resolveProjectAction', () => {
  it('is null for a persona with no project scope — most agents are not Actions', () => {
    expect(resolveProjectAction(persona(), CWD)).toBeNull()
  })

  it('resolves a persona scoped to this exact cwd', () => {
    const a = resolveProjectAction(persona({ projects: [CWD], action: 'Do the thing.' }), CWD)
    expect(a).not.toBeNull()
    expect(a!.agentName).toBe('scout')
    expect(a!.action).toBe('Do the thing.')
    expect(a!.scope).toBe('project')
  })

  it('resolves the `*` sentinel in every project', () => {
    const a = resolveProjectAction(persona({ projects: [ALL_PROJECTS], action: 'Sweep.' }), '/anywhere/else')
    expect(a!.scope).toBe('all')
  })

  it('does not leak an Action into a different project', () => {
    expect(resolveProjectAction(persona({ projects: [CWD], action: 'x' }), '/home/bilko/Projects/beta')).toBeNull()
  })

  it('normalizes trailing slashes on both sides — a scope must not miss on cosmetics', () => {
    expect(resolveProjectAction(persona({ projects: [`${CWD}/`], action: 'x' }), `${CWD}//`)).not.toBeNull()
  })

  it('falls back to the description when no action text is set', () => {
    const a = resolveProjectAction(persona({ projects: [CWD] }), CWD)
    expect(a!.action).toBe('Looks around.')
  })

  it('is null when there is neither an action nor a description to open with', () => {
    expect(resolveProjectAction(persona({ projects: [CWD], description: null }), CWD)).toBeNull()
  })

  it('uses actionLabel as the button caption, falling back to the agent name', () => {
    expect(resolveProjectAction(persona({ projects: [CWD], action: 'x', actionLabel: 'Sweep repo' }), CWD)!.label).toBe('Sweep repo')
    expect(resolveProjectAction(persona({ projects: [CWD], action: 'x' }), CWD)!.label).toBe('scout')
  })
})

describe('actionTag', () => {
  it('defaults to discussion — the tag that never assumes /develop should fire', () => {
    expect(actionTag({ tags: [] })).toBe('discussion')
  })

  it('picks TAG_LIBRARY order, not the order the file happens to list them in', () => {
    expect(actionTag({ tags: ['build', 'feature'] })).toBe('feature')
  })

  it('ignores a tag this app does not know', () => {
    // Read path stays permissive by design — an on-disk persona file can carry
    // a stale/foreign tag value even though the write-side schema (PRD 1037)
    // now rejects it, so this simulates that drift with an explicit cast.
    expect(actionTag({ tags: ['not-a-tag'] as unknown as AgentPersona['tags'] })).toBe('discussion')
  })
})

describe('projectActions', () => {
  it('returns nothing without a cwd — Actions are per-project by definition', () => {
    expect(projectActions([persona({ projects: [ALL_PROJECTS], action: 'x' })], null)).toEqual([])
  })

  it('sorts by label case-insensitively, not by persona file order', () => {
    const list = projectActions(
      [
        persona({ name: 'zeta', projects: [CWD], action: 'x' }),
        persona({ name: 'alpha', projects: [CWD], action: 'x' }),
        persona({ name: 'mid', projects: [CWD], action: 'x', actionLabel: 'Beta run' }),
      ],
      CWD,
    )
    expect(list.map((a) => a.label)).toEqual(['alpha', 'Beta run', 'zeta'])
  })
})
