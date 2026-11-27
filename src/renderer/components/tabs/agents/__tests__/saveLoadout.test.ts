import { describe, it, expect } from 'vitest'
import { saveLoadout, toDraft, withToolEdit, type Draft } from '../AgentDetail'
import type { AgentPersona } from '../../../../../preload/api'

const persona = (tools: string[], loadout?: string) => ({ name: 'a', tools, tags: [], body: '', ...(loadout ? { loadout } : {}) } as unknown as AgentPersona)
const edit = (d: Draft, patch: Partial<Draft>): Draft => ({ ...d, ...withToolEdit(patch) })

describe('saveLoadout', () => {
  it('saved Bare + description edit sends bare', () => {
    const d = { ...toDraft(persona([], 'bare')), description: 'x' }
    expect(saveLoadout(d)).toBe('bare')
  })
  it('saved Undecided + model edit sends no loadout and no tools', () => {
    const d = { ...toDraft(persona([])), model: 'opus' }
    expect(saveLoadout(d)).toBeUndefined()
    expect(d.tools).toEqual([])
  })
  it('Undecided add-then-clear ends bare', () => {
    const d1 = edit(toDraft(persona([])), { tools: ['Read'] })
    expect(saveLoadout(d1)).toBe('equipped')
    expect(saveLoadout(edit(d1, { tools: [] }))).toBe('bare')
  })
  it('Equipped clear-all sends bare', () => {
    expect(saveLoadout(edit(toDraft(persona(['Read'], 'equipped')), { tools: [] }))).toBe('bare')
  })
  it('Unbound choice sends unbound', () => {
    expect(saveLoadout(edit(toDraft(persona([])), { loadout: 'unbound', tools: ['*'] }))).toBe('unbound')
  })
})
