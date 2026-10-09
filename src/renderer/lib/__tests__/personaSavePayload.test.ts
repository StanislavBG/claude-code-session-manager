import { describe, expect, it } from 'vitest'
import type { AgentPersona } from '../../../preload/api'
import { toKnownTags, toPersonaSaveInput } from '../personaSavePayload'

const persona: AgentPersona = {
  name: 'dev-lead',
  description: 'Runs one PRD',
  tools: ['Read', 'Edit'],
  model: 'sonnet',
  effort: 'medium',
  color: 'blue',
  tags: ['build'],
  projects: ['*'],
  action: 'Start a PRD',
  actionLabel: 'Dev',
  title: 'Engineering — Software Engineer',
  path: '/home/x/.claude/agents/dev-lead.md',
  body: 'You are dev-lead.',
  overridingProjects: [],
}

describe('personaSavePayload', () => {
  it('keeps effort, title, projects, action and actionLabel when only tags change', () => {
    const out = toPersonaSaveInput(persona, { tags: ['feature'] })
    expect(out.effort).toBe('medium')
    expect(out.title).toBe('Engineering — Software Engineer')
    expect(out.projects).toEqual(['*'])
    expect(out.action).toBe('Start a PRD')
    expect(out.actionLabel).toBe('Dev')
    expect(out.tags).toEqual(['feature'])
    expect(out.name).toBe('dev-lead')
    expect(out.originalName).toBe('dev-lead')
    expect(out.body).toBe('You are dev-lead.')
  })

  it('applies null defaults', () => {
    const out = toPersonaSaveInput({
      ...persona, description: null, model: null, effort: null, color: null, action: null, actionLabel: null, title: null,
    })
    expect(out.description).toBe('')
    expect(out.model).toBe('inherit')
    expect(out.effort).toBeUndefined()
    expect(out.color).toBe('')
    expect(out.title).toBeUndefined()
  })

  it('drops unknown tags', () => {
    expect(toKnownTags(['feature', 'not-a-tag', 'bug'])).toEqual(['feature', 'bug'])
  })

  it('lets overrides.name / originalName win', () => {
    const out = toPersonaSaveInput(persona, { name: 'renamed', originalName: 'old' })
    expect(out.name).toBe('renamed')
    expect(out.originalName).toBe('old')
  })
})
