// @vitest-environment jsdom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { SettingsGroupCards, useEffectiveCards } from '../EffectiveCards'
import { mergeScopes } from '../../../lib/mergeScopes'
import { buildSchemaResolver } from '../../../lib/schemaLookup'
import type { Scope } from '../../../lib/scopes'

/**
 * The setting row: ONE control by type writing the selected scope (Toggle / select / text /
 * number), a face-aware source ladder, and a ⋯ menu — no 'Set to:' / 'save →' / status chips.
 */

const schema = buildSchemaResolver({
  type: 'object',
  properties: {
    flag: { type: 'boolean', default: true },
    mode: { type: 'string', enum: ['a', 'b'] },
    picked: { type: 'string', enum: ['x', 'y'], default: 'y' },
    name: { type: 'string' },
    days: { type: 'integer' },
    list: { type: 'array', items: { type: 'string' } },
  },
})

let root: Root | null = null
let host: HTMLDivElement | null = null
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

function Harness({ data, target, onOverride }: { data: Partial<Record<Scope, object>>; target: Scope; onOverride: ReturnType<typeof vi.fn> }) {
  const node = mergeScopes(Object.entries(data).map(([scope, d]) => ({ scope: scope as Scope, data: d })))
  const cards = useEffectiveCards({ node, schema })
  return createElement(SettingsGroupCards, {
    cards,
    groupIds: cards.visibleGroups.map((g) => g.id),
    targetScope: target,
    onOverride: onOverride as unknown as (p: string[], v: unknown, s?: Scope) => void,
  })
}

function render(data: Partial<Record<Scope, object>>, target: Scope = 'user') {
  const onOverride = vi.fn()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(createElement(Harness, { data, target, onOverride })))
  const row = (k: string) => host!.querySelector<HTMLElement>(`[data-testid="setting-card"][data-key="${k}"]`)!
  return { el: host, row, onOverride }
}

function setValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function choose(sel: HTMLSelectElement, label: string) {
  const opt = Array.from(sel.options).find((o) => o.textContent === label)!
  sel.value = opt.value
  sel.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('EffectiveCards setting row', () => {
  it('renders one control per type and none of the old Set to / save / status chips', () => {
    const { el, row } = render({ user: { mode: 'a', name: 'n' } })
    expect(row('flag').querySelectorAll('[role="switch"]').length).toBe(1)
    expect(row('mode').querySelectorAll('select').length).toBe(1)
    expect(row('name').querySelectorAll('input[type="text"]').length).toBe(1)
    expect(row('days').querySelectorAll('input[type="number"]').length).toBe(1)
    expect(row('list').textContent).toContain('Raw JSON')
    expect(el.textContent).not.toMatch(/Set to:|save →|set in user|overriding|using default|not configured/i)
  })

  it('boolean: the Toggle shows the default and writes the flipped value', () => {
    const { row, onOverride } = render({})
    const sw = row('flag').querySelector<HTMLElement>('[role="switch"]')!
    expect(sw.getAttribute('aria-checked')).toBe('true')
    act(() => sw.click())
    expect(onOverride).toHaveBeenCalledWith(['flag'], false, undefined)
  })

  it('enum: unset shows the schema default, or "default" when there is none; choosing default removes the key', () => {
    const { row, onOverride } = render({ project: { mode: 'b' } }, 'project')
    expect(row('picked').querySelector('select')!.selectedOptions[0].textContent).toBe('y')
    const mode = row('mode').querySelector('select')!
    expect(mode.selectedOptions[0].textContent).toBe('b')
    act(() => choose(mode, 'a'))
    expect(onOverride).toHaveBeenLastCalledWith(['mode'], 'a', undefined)
    act(() => root!.unmount())
    host!.remove()
    const fresh = render({})
    const unset = fresh.row('mode').querySelector('select')!
    expect(unset.selectedOptions[0].textContent).toBe('default')
  })

  it('text and number inputs commit on blur, only when changed; clearing removes the key', () => {
    const { row, onOverride } = render({ user: { name: 'old' } })
    const name = row('name').querySelector<HTMLInputElement>('input')!
    act(() => name.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    expect(onOverride).not.toHaveBeenCalled()
    act(() => setValue(name, 'new'))
    act(() => name.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    expect(onOverride).toHaveBeenLastCalledWith(['name'], 'new', undefined)
    const days = row('days').querySelector<HTMLInputElement>('input')!
    act(() => setValue(days, '7'))
    act(() => days.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    expect(onOverride).toHaveBeenLastCalledWith(['days'], 7, undefined)
    act(() => setValue(name, ''))
    act(() => name.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    expect(onOverride).toHaveBeenLastCalledWith(['name'], undefined, undefined)
  })

  it('ladder: Default — User for the user file, all four for a project file', () => {
    const stages = (r: HTMLElement) => Array.from(r.querySelectorAll<HTMLElement>('[data-stage]')).map((s) => s.dataset.stage)
    const home = render({ user: { name: 'x' } }, 'user')
    expect(stages(home.row('name'))).toEqual(['default', 'user'])
    act(() => root!.unmount())
    host!.remove()
    const proj = render({ user: { name: 'x' } }, 'local')
    expect(stages(proj.row('name'))).toEqual(['default', 'user', 'project', 'local'])
  })

  it('⋯ menu: Reset deletes from the winning scope; no Reset when the value is the default', () => {
    const { row, onOverride } = render({ user: { name: 'u' }, local: { name: 'l' }, project: { flag: true } }, 'project')
    act(() => row('name').querySelector<HTMLElement>('[data-testid="setting-row-menu"]')!.click())
    const reset = row('name').querySelector<HTMLElement>('[data-testid="setting-row-reset"]')!
    expect(reset.textContent).toContain('Local')
    act(() => reset.click())
    expect(onOverride).toHaveBeenLastCalledWith(['name'], undefined, 'local')
    act(() => row('flag').querySelector<HTMLElement>('[data-testid="setting-row-menu"]')!.click())
    expect(row('flag').querySelector('[data-testid="setting-row-reset"]')).toBeNull()
    expect(row('flag').querySelector('[data-testid="setting-row-details"]')).not.toBeNull()
  })
})
