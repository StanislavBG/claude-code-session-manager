/**
 * epicDraft.test.ts — a 'proposed' Epic reopens with every field it was saved with.
 * Run: timeout 120 npx vitest run src/renderer/lib/__tests__/epicDraft.test.ts
 */
import { describe, it, expect } from 'vitest'
import { draftFieldsFromEpic, hasDraftContent, isEditableDraft } from '../epicDraft'
import { composeEpicIntake } from '../epicIntake'
import { CONTEXT_INJECTION_ORDER, type ContextInjectionKey } from '../contextInjections'
import { NO_AGENT } from '../../components/epics/AgentPicker'
import type { PromptSession } from '../../state/promptSessions'

function epicFrom(
  fields: { title: string; goal: string; referencePaths?: string[]; injections?: Partial<Record<ContextInjectionKey, boolean>> },
  extra: Partial<PromptSession> = {},
): PromptSession {
  const intake = composeEpicIntake({
    title: fields.title,
    goal: fields.goal,
    referencePaths: fields.referencePaths ?? [],
    contextInjections: fields.injections as Record<ContextInjectionKey, boolean> | undefined,
  })
  return { id: 'e1', status: 'proposed', goalText: intake.goalText, sections: intake.sections, ...extra } as unknown as PromptSession
}

const allOff = Object.fromEntries(CONTEXT_INJECTION_ORDER.map((k) => [k, false])) as Record<ContextInjectionKey, boolean>

describe('isEditableDraft', () => {
  it('true for a proposed human Epic', () => {
    expect(isEditableDraft(epicFrom({ title: 't', goal: 'g' }))).toBe(true)
  })
  it('false for a proposed cross-project Epic', () => {
    const e = epicFrom({ title: 't', goal: 'g' }, { source: { producer: 'cross-project-feedback', fromCwd: '/p/a' } } as Partial<PromptSession>)
    expect(isEditableDraft(e)).toBe(false)
  })
  it('false for an active Epic', () => {
    expect(isEditableDraft(epicFrom({ title: 't', goal: 'g' }, { status: 'active' }))).toBe(false)
  })
})

describe('draftFieldsFromEpic round trip', () => {
  it('recovers title, goal, references and injections', () => {
    const inj = { ...allOff, [CONTEXT_INJECTION_ORDER[0]]: true }
    const d = draftFieldsFromEpic(epicFrom({ title: 'My title', goal: 'Do the thing', referencePaths: ['/a/b.png', '/c/d.md'], injections: inj }))
    expect(d.title).toBe('My title')
    expect(d.goal).toBe('Do the thing')
    expect(d.referencePaths).toEqual(['/a/b.png', '/c/d.md'])
    expect(d.injections).toEqual(inj)
  })
  it('handles an empty title', () => {
    const d = draftFieldsFromEpic(epicFrom({ title: '', goal: 'just a goal\n\nsecond para', injections: allOff }))
    expect(d.title).toBe('')
    expect(d.goal).toBe('just a goal\n\nsecond para')
  })
  it('handles zero references and a goal with blank lines', () => {
    const d = draftFieldsFromEpic(epicFrom({ title: 'T', goal: 'a\n\nb\n\n\nc', injections: allOff }))
    expect(d.title).toBe('T')
    expect(d.goal).toBe('a\n\nb\n\n\nc')
    expect(d.referencePaths).toEqual([])
  })
  it('handles references with an empty goal', () => {
    const d = draftFieldsFromEpic(epicFrom({ title: 'T', goal: '', referencePaths: ['/x'], injections: allOff }))
    expect(d).toMatchObject({ title: 'T', goal: '', referencePaths: ['/x'] })
  })
  it('maps agent, tag, model, effort and developLoop', () => {
    const d = draftFieldsFromEpic(epicFrom({ title: 'T', goal: 'g' }, { agentType: 'architect', tag: 'feature', model: 'opus', effort: 'high', developLoop: false } as Partial<PromptSession>))
    expect(d).toMatchObject({ agentName: 'architect', tag: 'feature', model: 'opus', effort: 'high', developLoop: false })
    const bare = draftFieldsFromEpic(epicFrom({ title: 'T', goal: 'g' }))
    expect(bare).toMatchObject({ agentName: NO_AGENT, tag: null, developLoop: true })
  })
})

describe('legacy Epic with no sections', () => {
  it('has no references and takes goal from goalText', () => {
    const e = { id: 'l', status: 'proposed', goalText: 'Old title\n\nOld goal' } as unknown as PromptSession
    const d = draftFieldsFromEpic(e)
    expect(d.referencePaths).toEqual([])
    expect(d.title).toBe('Old title')
    expect(d.goal).toBe('Old goal')
    expect(Object.values(d.injections).every((v) => v === false)).toBe(true)
  })
})

describe('hasDraftContent', () => {
  it('false when blank and no references', () => {
    expect(hasDraftContent({ title: '  ', goal: '\n ', referenceCount: 0 })).toBe(false)
  })
  it('true with any of title, goal or reference', () => {
    expect(hasDraftContent({ title: 'x', goal: '', referenceCount: 0 })).toBe(true)
    expect(hasDraftContent({ title: '', goal: 'x', referenceCount: 0 })).toBe(true)
    expect(hasDraftContent({ title: '', goal: '', referenceCount: 1 })).toBe(true)
  })
})
