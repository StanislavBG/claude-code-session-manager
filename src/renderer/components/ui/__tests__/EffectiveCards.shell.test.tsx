// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { PageShell } from '../../layout/PageShell'
import {
  useEffectiveCards,
  EffectiveCardsToolbar,
  EffectiveCardsRail,
  EffectiveCardsSections,
} from '../EffectiveCards'
import { mergeScopes } from '../../../lib/mergeScopes'
import { settingsSchema } from '../../../lib/settingsSchema'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

const node = mergeScopes([{ scope: 'user', data: { model: 'opus' } }])
const schema = settingsSchema()

function Harness() {
  const cards = useEffectiveCards({ node, schema })
  return createElement(PageShell, {
    header: createElement(EffectiveCardsToolbar, { cards, targetScope: 'user' }),
    subnav: createElement(EffectiveCardsRail, { cards }),
    children: createElement(EffectiveCardsSections, { cards, targetScope: 'user', onOverride: () => {} }),
  })
}

const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement

describe('EffectiveCards on PageShell', () => {
  it('rail renders in subnav, sections in content, toolbar in header', () => {
    act(() => root.render(createElement(Harness)))
    const subnav = q('page-shell-subnav')
    const content = q('page-shell-content')
    const header = q('page-shell-header')
    expect(subnav.querySelectorAll('button').length).toBeGreaterThan(0)
    expect(content.querySelectorAll('section[id^="settings-group-"]').length).toBeGreaterThan(0)
    expect(subnav.querySelector('section')).toBeNull()
    expect(header.querySelector('input[placeholder="search settings…"]')).not.toBeNull()
  })

  it('clicking a rail button scrolls page-shell-content only', () => {
    const calls: Element[] = []
    const spy = vi.fn(function (this: Element) {
      calls.push(this)
    })
    ;(Element.prototype as unknown as { scrollBy: unknown }).scrollBy = spy
    act(() => root.render(createElement(Harness)))
    const content = q('page-shell-content')
    const sections = Array.from(content.querySelectorAll<HTMLElement>('section[id^="settings-group-"]'))
    const last = sections[sections.length - 1]
    // jsdom has no layout: give the target section a non-zero offset so a scroll is needed.
    vi.spyOn(last, 'getBoundingClientRect').mockReturnValue({ top: 400, bottom: 500, left: 0, right: 0, width: 0, height: 100, x: 0, y: 400, toJSON: () => ({}) } as DOMRect)
    const id = last.id.replace('settings-group-', '')
    const btn = Array.from(q('page-shell-subnav').querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.dataset.groupId === id,
    )!
    expect(btn).toBeTruthy()
    act(() => btn.click())
    expect(spy).toHaveBeenCalled()
    expect(calls.every((el) => el === content)).toBe(true)
  })
})
