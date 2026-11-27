import { describe, it, expect } from 'vitest'
import { saveLoadout, toDraft } from '../AgentDetail'
import type { AgentPersona } from '../../../../../preload/api'

const persona = (tools: string[]) => ({ name: 'a', tools, tags: [], body: '' } as unknown as AgentPersona)

describe('saveLoadout', () => {
  it('undecided persona with a description edit sends no loadout', () => {
    const d = { ...toDraft(persona([])), description: 'x' }
    expect(saveLoadout(d, [])).toBeUndefined()
  })
  it('clearing the last tool of an Equipped persona sends bare', () => {
    const d = { ...toDraft(persona(['Read'])), tools: [] }
    expect(saveLoadout(d, ['Read'])).toBe('bare')
  })
  it('the Bare choice sends bare', () => {
    const d = { ...toDraft(persona([])), loadout: 'bare' as const }
    expect(saveLoadout(d, [])).toBe('bare')
  })
  it('equipped / unbound choices pass through', () => {
    expect(saveLoadout({ ...toDraft(persona([])), loadout: 'equipped', tools: ['Read'] }, [])).toBe('equipped')
    expect(saveLoadout({ ...toDraft(persona([])), loadout: 'unbound', tools: ['*'] }, [])).toBe('unbound')
  })
})
